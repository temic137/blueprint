import { completeJson, generationUsage, usageSnapshot } from "./ai.ts";
import { boardPinCompatible, isPowerOrGroundPin } from "./board-types.ts";
import { BOARD_PROFILES, ensureBoardCard, listBoardCards, normalizeBoardPinForBoard, toBoardProfile, type BoardId, type BoardProfile } from "./boards.ts";
import { ensurePartRecord } from "./part-registry.ts";
import { ArchitectureSchema, BuildOutputSchema, COMPONENTS, derivePins, ProjectPlanSchema, ProjectSpecSchema, validateArchitecture, validateHardware, type CircuitDesign, type ComponentRegistryRecord, type ProjectSpec } from "./project.ts";
import { runSafetyGate } from "./safety-gate.ts";
import { synthesizeCircuit } from "./synthesize-circuit.ts";

function firmwareSystemPrompt(profile: BoardProfile) {
  const family = profile.family;
  const servoNote = family === "esp32"
    ? "Directly wired servos use ESP32Servo.h, never Servo.h."
    : "Directly wired servos use Servo.h.";
  const espNotes = family === "esp32"
    ? " Projects with a PCA9685 use Adafruit_PWMServoDriver.h and its assigned I2C pins. For esp32cam, configure the built-in OV2640 with esp_camera.h and the complete AI Thinker pin map."
    : "";
  return `You are Blueprint's embedded firmware engineer. The hardware architecture and validated netlist are final and immutable. Write production-ready PlatformIO Arduino-framework firmware that implements the requested behavior using exactly the supplied board signal assignments.
Never add components, change wiring, choose different pins, or describe a different circuit. Firmware must contain setup() and loop() and initialize every used interface.
PlatformIO must set platform=${profile.platform}, board=${profile.platformio}, and framework=arduino. Never list Arduino itself in lib_deps. ${servoNote}${espNotes}
Board family: ${family}. Logic voltage: ${profile.logicVoltage}V. Use numeric pin literals matching this board (Arduino D2→2, ESP32 GPIO4→4, Pico GP15→15).
Return JSON only with exactly: files {platformioIni,mainCpp}.`;
}

export function normalizeFirmwareDependencies(platformioIni: string) {
  return platformioIni
    .replace(/^(\s*lib_deps\s*=\s*)(?:adafruit\/)?Adafruit BME680(?: Library)?\s*$/gim, "$1adafruit/Adafruit BME680 Library")
    .replace(/^(\s*)(?:adafruit\/)?Adafruit BME680(?: Library)?\s*$/gim, "$1adafruit/Adafruit BME680 Library");
}

export function normalizeFirmwareSource(mainCpp: string) {
  return mainCpp
    .replace(/\.setFilterSize\s*\(/g, ".setIIRFilterSize(")
    .replace(/\.setGasOversampling\s*\(\s*BME680_OS_\d+X\s*\)\s*;/g, ".setGasHeater(320, 150);");
}

const FirmwareOutputSchema = BuildOutputSchema.pick({ files: true }).passthrough();

function normalizedIdentity(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function attachBoardMeta<T extends { board: BoardId; boardMeta?: BoardProfile }>(value: T): T & { boardMeta: BoardProfile } {
  const card = ensureBoardCard(value.board);
  return { ...value, board: card.id, boardMeta: value.boardMeta || toBoardProfile(card) };
}

/** Map messy LLM explanation ids (HC-SR04, "Ultrasonic") onto normalized component ids. Never block generate. */
export function normalizeExplanations(
  raw: unknown,
  components: readonly { id: string; name: string; type?: string }[],
): Array<{ componentId: string; text: string }> {
  const defaults = components.map((component) => ({
    componentId: component.id,
    text: `${component.name} is included to support the requested project behavior.`,
  }));
  if (!raw || typeof raw !== "object" || !components.length) return defaults;
  const list = Array.isArray((raw as { explanations?: unknown }).explanations)
    ? (raw as { explanations: unknown[] }).explanations
    : [];
  if (!list.length) return defaults;
  const byIdentity = new Map<string, string>();
  for (const component of components) {
    for (const identity of [component.id, component.name, component.type]) {
      const key = normalizedIdentity(identity);
      if (key && !byIdentity.has(key)) byIdentity.set(key, component.id);
    }
  }
  const cleaned: Array<{ componentId: string; text: string }> = [];
  const used = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as { componentId?: unknown; text?: unknown };
    const text = String(row.text || "").trim().slice(0, 240);
    if (text.length < 5) continue;
    const rawId = String(row.componentId || "");
    const slug = rawId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const componentId = byIdentity.get(normalizedIdentity(rawId))
      || (slug && components.some((component) => component.id === slug) ? slug : "")
      || byIdentity.get(normalizedIdentity(slug));
    if (!componentId || used.has(componentId)) continue;
    used.add(componentId);
    cleaned.push({ componentId, text });
  }
  return cleaned.length ? cleaned : defaults;
}

export function normalizeArchitecture(raw: unknown, registry: readonly ComponentRegistryRecord[] = []) {
  if (!raw || typeof raw !== "object") return raw;
  const root = raw as Record<string, unknown>;
  const wrapped = [root.project, root.architecture, root.plan].find((candidate) => candidate && typeof candidate === "object" && "components" in candidate) as Record<string, unknown> | undefined;
  const value = (wrapped || root) as { parts?: unknown; components?: unknown };
  const usedIds = new Map<string, number>();
  const boardIdentities = listBoardCards().flatMap((card) => [card.name, card.platformio, card.id, ...card.aliases]).map(normalizedIdentity).filter((identity) => identity.length >= 3);
  const componentCollection = Array.isArray(value.components) ? value.components : value.components && typeof value.components === "object"
    ? Array.isArray((value.components as { items?: unknown }).items) ? (value.components as { items: unknown[] }).items : Object.values(value.components)
    : value.components;
  const rawComponents = Array.isArray(componentCollection) ? componentCollection.filter((component) => {
    if (!component || typeof component !== "object") return true;
    const item = component as { type?: unknown; name?: unknown };
    return ![item.type, item.name].map(normalizedIdentity).filter(Boolean).some((identity) => boardIdentities.some((board) => identity.includes(board) || board.includes(identity)));
  }) : value.components;
  const components = Array.isArray(rawComponents) ? rawComponents.map((component) => {
    if (!component || typeof component !== "object") return component;
    const item = component as { id?: unknown; type?: unknown; name?: unknown; registry?: unknown };
    const { registry: _untrustedRegistry, ...safeItem } = item;
    const identities = [item.type, item.name, item.id].map(normalizedIdentity).filter(Boolean);
    const exact = registry.find((candidate) => [candidate.id, candidate.name, ...candidate.aliases].map(normalizedIdentity).some((identity) => identities.includes(identity)));
    const modelNumbers = [item.type, item.name].flatMap((identity) => String(identity || "").match(/[a-z]+\d[a-z0-9-]*/gi) || []).map(normalizedIdentity);
    const modelMatches = exact ? [] : registry.filter((candidate) => [candidate.id, candidate.name, ...candidate.aliases].map(normalizedIdentity).some((candidateIdentity) => modelNumbers.some((model) => candidateIdentity.includes(model))));
    const fuzzy = exact || modelMatches.length === 1 ? [] : registry.filter((candidate) => [candidate.id, candidate.name, ...candidate.aliases].map(normalizedIdentity).some((candidateIdentity) => candidateIdentity.length >= 4 && identities.some((identity) => identity.includes(candidateIdentity) || candidateIdentity.includes(identity))));
    let record = exact || (modelMatches.length === 1 ? modelMatches[0] : fuzzy.length === 1 ? fuzzy[0] : undefined);
    // ponytail: fetch/cache only when the model named a part (type/name), not bare instance ids
    if (!record && (item.type || item.name)) {
      try { record = ensurePartRecord(item.type || item.name); } catch { /* leave unresolved for schema/safety to reject */ }
    }
    let id = String(item.id || item.type || item.name || "component").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!/^[a-z]/.test(id)) id = `component_${id || "part"}`;
    const count = (usedIds.get(id) || 0) + 1;
    usedIds.set(id, count);
    return {
      ...safeItem,
      ...(record ? { type: record.baseType || undefined, name: record.name, registry: { id: record.id, supportLevel: record.supportLevel, source: record.source, capabilities: record.capabilities, firmware: record.firmware, requirements: record.requirements, pins: record.pins, boardPins: record.boardPins } } : {}),
      name: record?.name || String(item.name || (typeof item.type === "string" ? COMPONENTS[item.type]?.name : "") || item.type || item.id || "Electronic component"),
      quantity: 1,
      id: count === 1 ? id : `${id}_${count}`,
    };
  }) : value.components;
  const componentParts = Array.isArray(components) ? components.map((component) => {
    const item = component as { name?: unknown; quantity?: unknown };
    return `${item.quantity || 1}x ${item.name || "electronic component"}`;
  }) : [];
  const boardCard = ensureBoardCard((value as { board?: unknown }).board || "esp32dev");
  return { ...value, board: boardCard.id, boardMeta: toBoardProfile(boardCard), components, parts: [...new Set([`1x ${boardCard.name}`, ...componentParts])].slice(0, 30) };
}

export function normalizeBoardPin(pin: unknown, board: BoardId = "esp32dev") {
  return normalizeBoardPinForBoard(board, pin);
}

/** Map model pin aliases (pin1, +, anode, …) onto a part's catalog pin list. */
export function normalizeComponentPin(pin: unknown, pins: readonly string[] | null | undefined) {
  if (typeof pin !== "string" || !pin.trim()) return pin;
  if (!pins?.length) return pin;
  if (pins.includes(pin)) return pin;
  const raw = pin.trim();
  const upper = raw.toUpperCase().replace(/\s+/g, "");
  const caseHit = pins.find((candidate) => candidate.toUpperCase() === upper);
  if (caseHit) return caseHit;

  const aliasNumber = raw.match(/^(?:pin|p|terminal|leg|pad)[_\s-]*(\d+)$/i);
  const bareNumber = !aliasNumber ? raw.match(/^(\d+)$/) : null;
  const number = aliasNumber?.[1] || bareNumber?.[1];
  if (number) {
    if (pins.includes(number)) return number;
    const sideHits = pins.filter((candidate) => candidate === `${number}.l` || candidate === `${number}.r` || candidate.startsWith(`${number}.`));
    // ponytail: 6mm buttons expose 1.l/1.r; pin1→1.l. Bare "2" stays unmatched if both .l/.r exist so we don't double-map onto one leg.
    if (aliasNumber && sideHits.length) return sideHits.find((candidate) => candidate.endsWith(".l")) || sideHits[0]!;
    if (bareNumber && sideHits.length === 1) return sideHits[0]!;
    if (pins.every((candidate) => !/^\d/.test(candidate))) {
      const index = Number(number) - 1;
      if (index >= 0 && index < pins.length) return pins[index]!;
    }
  }

  const prefer = (...names: string[]) => names.find((name) => pins.includes(name));
  if (["+", "POSITIVE", "POS", "ANODE", "SIG", "SIGNAL", "OUT", "IN"].includes(upper)) {
    return prefer("POS", "A", "SIG", "OUT", "IN", "VCC", "VDD") || raw;
  }
  if (["-", "NEGATIVE", "NEG", "CATHODE", "GND", "GROUND", "VSS"].includes(upper)) {
    return prefer("NEG", "C", "GND", "VSS") || raw;
  }
  if (["VCC", "VDD", "VIN", "5V", "3V3", "3.3V", "POWER"].includes(upper)) {
    return prefer("VCC", "VDD", "VIN", "5V", "3V3") || raw;
  }
  if (["A", "ANODE"].includes(upper)) return prefer("A", "POS") || raw;
  if (["C", "CATHODE"].includes(upper)) return prefer("C", "NEG", "GND") || raw;
  return raw;
}

function pinsForComponent(architecture: ReturnType<typeof ArchitectureSchema.parse>, owner: string) {
  if (owner === "board") return null;
  const component = architecture.components.find((item) => item.id === owner);
  if (!component) return null;
  return COMPONENTS[component.type || component.id]?.pins || component.registry?.pins || null;
}

export function normalizeBuild(raw: unknown, architecture: ReturnType<typeof ArchitectureSchema.parse>) {
  if (!raw || typeof raw !== "object" || !("connections" in raw) || !Array.isArray(raw.connections)) return raw;
  const boardAliases = new Set(["board", ...listBoardCards().flatMap((card) => [card.id, card.name, card.platformio, ...card.aliases]).map(normalizedIdentity)]);
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const component of architecture.components) for (const identity of [component.id, component.name, component.type, component.registry?.id]) {
    const normalized = normalizedIdentity(identity);
    if (!normalized || ambiguous.has(normalized)) continue;
    const existing = aliases.get(normalized);
    if (existing && existing !== component.id) { aliases.delete(normalized); ambiguous.add(normalized); }
    else aliases.set(normalized, component.id);
  }
  const connections = raw.connections.map((connection) => {
    if (!connection || typeof connection !== "object") return connection;
    const wire = connection as { fromComponent?: unknown; fromPin?: unknown; toComponent?: unknown; toPin?: unknown };
    const owner = (value: unknown) => {
      if (typeof value !== "string") return value;
      const normalized = normalizedIdentity(value);
      return boardAliases.has(normalized) ? "board" : aliases.get(normalized) || value;
    };
    const fromComponent = owner(wire.fromComponent);
    const toComponent = owner(wire.toComponent);
    return {
      ...wire,
      fromComponent,
      fromPin: fromComponent === "board"
        ? normalizeBoardPin(wire.fromPin, architecture.board)
        : normalizeComponentPin(wire.fromPin, pinsForComponent(architecture, String(fromComponent))),
      toComponent,
      toPin: toComponent === "board"
        ? normalizeBoardPin(wire.toPin, architecture.board)
        : normalizeComponentPin(wire.toPin, pinsForComponent(architecture, String(toComponent))),
    };
  });
  const seen = new Set<string>();
  const deduped = connections.filter((connection) => {
    if (!connection || typeof connection !== "object") return true;
    const wire = connection as { fromComponent?: unknown; fromPin?: unknown; toComponent?: unknown; toPin?: unknown };
    const key = [`${wire.fromComponent}.${wire.fromPin}`, `${wire.toComponent}.${wire.toPin}`].sort().join("--");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...raw, connections: deduped };
}

const POWER_PINS = new Set(["3V3", "5V", "VIN", "VSYS", "VBUS", "GND"]);
const INPUT_PULLUP_TYPES = new Set(["pushbutton", "switch"]);
const DIGITAL_OUTPUT_TYPES = new Set(["buzzer", "led", "rgb_led", "relay"]);

function boardSignalPins(connections: ProjectSpec["connections"]) {
  return [...new Set(connections.flatMap((wire) => {
    const pins: string[] = [];
    if (wire.fromComponent === "board") pins.push(wire.fromPin);
    if (wire.toComponent === "board") pins.push(wire.toPin);
    return pins;
  }).filter((pin) => pin && !POWER_PINS.has(pin)))];
}

function fileErrors(platformioIni: string, mainCpp: string, hasDirectServo: boolean, hasPca9685: boolean, board: BoardId, connections: ProjectSpec["connections"]) {
  const errors: string[] = [];
  const profile = BOARD_PROFILES[board];
  if (!profile) {
    errors.push(`Unknown board card: ${board}`);
    return errors;
  }
  if (profile.family === "raspberrypi" || profile.platform === "linux_arm") {
    if (mainCpp.length < 40) errors.push("host sketch is too short");
    return errors;
  }
  if (profile.platform && profile.platform !== "unknown") {
    if (!new RegExp(`platform\\s*=\\s*${profile.platform}`).test(platformioIni)) errors.push(`platformioIni must use ${profile.platform}`);
  }
  if (profile.platformio && !new RegExp(`board\\s*=\\s*${profile.platformio}`).test(platformioIni)) errors.push(`platformioIni must use ${profile.platformio}`);
  if (!/void\s+setup\s*\(/.test(mainCpp) || !/void\s+loop\s*\(/.test(mainCpp)) errors.push("mainCpp needs setup() and loop()");
  if (/^\s*Arduino\s*$/m.test(platformioIni)) errors.push("Do not list Arduino as a library dependency");
  if (hasDirectServo) {
    if (profile.family === "esp32" && (!mainCpp.includes("ESP32Servo.h") || mainCpp.includes("<Servo.h>"))) errors.push("Direct-servo firmware must use ESP32Servo.h, not Servo.h");
    if (profile.family !== "esp32" && !mainCpp.includes("Servo.h")) errors.push("Direct-servo firmware must use Servo.h");
  }
  if (profile.family === "esp32") {
    if (hasPca9685 && !mainCpp.includes("Adafruit_PWMServoDriver.h")) errors.push("PCA9685 firmware must use Adafruit_PWMServoDriver.h.");
    if (board === "esp32cam") {
      if (!mainCpp.includes("esp_camera.h") || !/esp_camera_init\s*\(/.test(mainCpp)) errors.push("ESP32-CAM firmware must include esp_camera.h and initialize the OV2640 camera.");
      const requiredCameraFields = ["pin_d0", "pin_d7", "pin_xclk", "pin_pclk", "pin_vsync", "pin_href"];
      if (requiredCameraFields.some((field) => !mainCpp.includes(field))) errors.push("ESP32-CAM firmware must configure the complete AI Thinker OV2640 pin map.");
      if (!/esp_camera_fb_get\s*\(|startCameraServer\s*\(/.test(mainCpp)) errors.push("ESP32-CAM firmware must capture frames or start a camera server.");
    }
  }
  for (const pin of boardSignalPins(connections)) {
    const literal = pinLiteral(board, pin);
    if (!/^\d+$/.test(literal) && !/^A\d+$/.test(literal)) continue;
    if (!new RegExp(`\\b${literal}\\b`).test(mainCpp)) errors.push(`Firmware must use wired signal ${pin}.`);
  }
  return errors;
}

function connectionKey(connection: ProjectSpec["connections"][number]) {
  return [`${connection.fromComponent}.${connection.fromPin}`, `${connection.toComponent}.${connection.toPin}`].sort().join("--");
}

function pinConstName(pin: string) {
  return pin.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function pinLiteral(board: BoardId, pin: string) {
  if (pin.startsWith("GPIO")) return pin.slice(4);
  if (BOARD_PROFILES[board]?.family === "arduino" && pin.startsWith("D")) return pin.slice(1);
  if (BOARD_PROFILES[board]?.family === "arduino" && pin.startsWith("A")) return pin;
  if (BOARD_PROFILES[board]?.family === "pico" && pin.startsWith("GP")) return pin.slice(2);
  return pin;
}

function componentOnBoardPin(plan: ReturnType<typeof ProjectPlanSchema.parse>, pin: string) {
  for (const wire of plan.connections) {
    if (wire.fromComponent === "board" && wire.fromPin === pin) {
      return plan.components.find((component) => component.id === wire.toComponent);
    }
    if (wire.toComponent === "board" && wire.toPin === pin) {
      return plan.components.find((component) => component.id === wire.fromComponent);
    }
  }
  return undefined;
}

function pinModeForSignal(plan: ReturnType<typeof ProjectPlanSchema.parse>, pin: string, purposes: string[]) {
  const purpose = purposes.join(" ");
  if (/i2c|spi|uart|serial/i.test(purpose)) return null;
  const type = componentOnBoardPin(plan, pin)?.type || componentOnBoardPin(plan, pin)?.id || "";
  if (INPUT_PULLUP_TYPES.has(type)) return "INPUT_PULLUP";
  if (DIGITAL_OUTPUT_TYPES.has(type)) return "OUTPUT";
  const input = /input|button|echo|motion|sensor|receive|miso/i.test(purpose) && !/output|trigger|control|dac|pwm|step|direction|clock|mosi|drive/i.test(purpose);
  if (input && /button|switch|pull.?up/i.test(purpose)) return "INPUT_PULLUP";
  return input ? "INPUT" : "OUTPUT";
}

function boardPinForComponent(plan: ReturnType<typeof ProjectPlanSchema.parse>, componentId: string, componentPin: string) {
  for (const wire of plan.connections) {
    if (wire.fromComponent === "board" && wire.toComponent === componentId && wire.toPin === componentPin) return wire.fromPin;
    if (wire.toComponent === "board" && wire.fromComponent === componentId && wire.fromPin === componentPin) return wire.toPin;
  }
  return undefined;
}

function boardPinFromTerminal(plan: ReturnType<typeof ProjectPlanSchema.parse>, componentId: string, componentPin: string) {
  const direct = boardPinForComponent(plan, componentId, componentPin);
  if (direct) return direct;
  const queue: string[] = [];
  for (const wire of plan.connections) {
    if (wire.fromComponent === componentId && wire.fromPin === componentPin) queue.push(wire.toComponent);
    if (wire.toComponent === componentId && wire.toPin === componentPin) queue.push(wire.fromComponent);
  }
  const seen = new Set([componentId]);
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const wire of plan.connections) {
      if (/\b(power|ground|gnd|vcc|3v3|5v|vin)\b/i.test(wire.purpose)) continue;
      const next = wire.fromComponent === current ? wire.toComponent : wire.toComponent === current ? wire.fromComponent : "";
      if (!next || seen.has(next)) continue;
      if (next === "board") {
        const pin = wire.fromComponent === "board" ? wire.fromPin : wire.toPin;
        if (!POWER_PINS.has(pin)) return pin;
      }
      queue.push(next);
    }
  }
  return undefined;
}

function signalBoardPinForComponent(plan: ReturnType<typeof ProjectPlanSchema.parse>, componentId: string) {
  const seen = new Set([componentId]);
  const queue = [componentId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const wire of plan.connections) {
      if (/\b(power|ground|gnd|vcc|3v3|5v|vin)\b/i.test(wire.purpose)) continue;
      const next = wire.fromComponent === current ? wire.toComponent : wire.toComponent === current ? wire.fromComponent : "";
      if (!next) continue;
      if (next === "board") {
        const pin = wire.fromComponent === "board" ? wire.fromPin : wire.toPin;
        if (!POWER_PINS.has(pin)) return pin;
      }
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return undefined;
}

function arduinoPinExpr(board: BoardId, pin: string) {
  // Arduino accepts numeric digitals and A0-style tokens as bare C identifiers.
  return pinLiteral(board, pin);
}

/** Pin-consistent PlatformIO sketch from an accepted netlist. Exported for tests. */
export function deterministicFirmware(plan: ReturnType<typeof ProjectPlanSchema.parse>, idea: string) {
  const profile = BOARD_PROFILES[plan.board] || (plan.boardMeta ? plan.boardMeta : undefined);
  const bluetoothAudio = /bluetooth/i.test(idea)
    && plan.components.some((component) => component.registry?.id === "pam8403_module")
    && profile?.family === "esp32";
  if (bluetoothAudio && profile) return {
    platformioIni: `[env:${profile.platformio}]\nplatform = ${profile.platform}\nboard = ${profile.platformio}\nframework = arduino\nmonitor_speed = 115200\nlib_deps =\n  https://github.com/pschatzmann/ESP32-A2DP.git\n  https://github.com/pschatzmann/arduino-audio-tools.git\n`,
    mainCpp: `#include <Arduino.h>\n#include "AudioTools.h"\n#include "BluetoothA2DPSink.h"\n\n// The ESP32 internal DAC sends left audio on GPIO25 and right audio on GPIO26.\nconstexpr int LEFT_DAC_PIN = 25;\nconstexpr int RIGHT_DAC_PIN = 26;\nAnalogAudioStream audioOutput;\nBluetoothA2DPSink bluetoothSink(audioOutput);\n\nvoid setup() {\n  Serial.begin(115200);\n  bluetoothSink.start("Blueprint Speaker");\n}\n\nvoid loop() {\n  delay(1000);\n}\n`,
  };
  if (!profile) throw new Error(`Unknown board card: ${plan.board}`);
  if (profile.family === "raspberrypi" || profile.platform === "linux_arm") {
    return {
      platformioIni: `; Raspberry Pi / Linux host project — not PlatformIO MCU firmware.\n; Board: ${profile.name}\n`,
      mainCpp: `// GPIO host sketch placeholder for ${profile.name}.\n// Circuit netlist is the source of truth; run with your preferred Pi GPIO library.\n#include <stdio.h>\nint main() {\n  printf("Blueprint circuit for ${profile.name}\\n");\n  return 0;\n}\n`,
    };
  }

  // ponytail: common simple projects get real behavior in the fallback, not just delay(100)
  const dht = plan.components.find((component) => component.type === "dht22");
  const oled = plan.components.find((component) => component.type === "ssd1306");
  const lcd = plan.components.find((component) => component.type === "lcd1602" || component.type === "lcd2004");
  const alertLed = plan.components.find((component) => component.type === "led");
  const alertLedPin = alertLed ? signalBoardPinForComponent(plan, alertLed.id) : undefined;
  const dhtData = dht ? boardPinForComponent(plan, dht.id, "DATA") : undefined;
  if (dht && dhtData && (oled || lcd)) {
    const dataLit = pinLiteral(plan.board, dhtData);
    if (oled) {
      const sda = boardPinForComponent(plan, oled.id, "SDA");
      const scl = boardPinForComponent(plan, oled.id, "SCL");
      const sdaLit = sda ? pinLiteral(plan.board, sda) : profile.family === "arduino" ? "A4" : "21";
      const sclLit = scl ? pinLiteral(plan.board, scl) : profile.family === "arduino" ? "A5" : "22";
      const wireBegin = profile.family === "esp32"
        ? `  Wire.begin(${sdaLit}, ${sclLit});`
        : "  Wire.begin();";
      const readsHumidity = /\bhumidity\b/i.test(idea);
      const reading = readsHumidity ? "humidity" : "celsius";
      const readMethod = readsHumidity ? "readHumidity" : "readTemperature";
      const readingLabel = readsHumidity ? "Humidity %" : "Temp C";
      const alertThreshold = Number(idea.match(readsHumidity
        ? /humidity\D{0,35}(?:above|over|exceeds?|threshold)?\D{0,10}(\d+(?:\.\d+)?)/i
        : /temperature\D{0,35}(?:above|over|exceeds?|threshold)?\D{0,10}(\d+(?:\.\d+)?)/i)?.[1] || 0);
      const ledDeclaration = alertLedPin ? `\nconstexpr int ALERT_LED_PIN = ${pinLiteral(plan.board, alertLedPin)};` : "";
      const ledSetup = alertLedPin ? "\n  pinMode(ALERT_LED_PIN, OUTPUT);" : "";
      const ledLoop = alertLedPin && alertThreshold
        ? `\n  digitalWrite(ALERT_LED_PIN, ${reading} > ${alertThreshold} ? HIGH : LOW);`
        : "";
      return {
        platformioIni: `[env:${profile.platformio}]\nplatform = ${profile.platform}\nboard = ${profile.platformio}\nframework = arduino\nmonitor_speed = 115200\nlib_deps =\n  adafruit/DHT sensor library\n  adafruit/Adafruit Unified Sensor\n  adafruit/Adafruit SSD1306\n  adafruit/Adafruit GFX Library\n`,
        mainCpp: `#include <Arduino.h>\n#include <Wire.h>\n#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\n#include <DHT.h>\n\nconstexpr int DHT_PIN = ${dataLit};${ledDeclaration}\n// I2C uses board pins ${sdaLit} (SDA) and ${sclLit} (SCL).\nDHT dht(DHT_PIN, DHT22);\nAdafruit_SSD1306 display(128, 64, &Wire, -1);\n\nvoid setup() {\n  Serial.begin(115200);\n${wireBegin}\n  dht.begin();${ledSetup}\n  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {\n    Serial.println("SSD1306 not found");\n  }\n  display.clearDisplay();\n  display.setTextColor(SSD1306_WHITE);\n  display.setTextSize(2);\n  display.setCursor(0, 0);\n  display.println("${readingLabel}");\n  display.display();\n}\n\nvoid loop() {\n  float ${reading} = dht.${readMethod}();\n  if (isnan(${reading})) {\n    Serial.println("DHT read failed");\n    delay(2000);\n    return;\n  }\n  Serial.print("${readingLabel}: ");\n  Serial.println(${reading});${ledLoop}\n  display.clearDisplay();\n  display.setCursor(0, 0);\n  display.println("${readingLabel}");\n  display.println(${reading}, 1);\n  display.display();\n  delay(2000);\n}\n`,
      };
    }
    // Character LCD (parallel HD44780-style) — use LiquidCrystal with wired RS/E/D4-D7 when present.
    const rs = boardPinForComponent(plan, lcd!.id, "RS");
    const en = boardPinForComponent(plan, lcd!.id, "E");
    const d4 = boardPinForComponent(plan, lcd!.id, "D4");
    const d5 = boardPinForComponent(plan, lcd!.id, "D5");
    const d6 = boardPinForComponent(plan, lcd!.id, "D6");
    const d7 = boardPinForComponent(plan, lcd!.id, "D7");
    if (rs && en && d4 && d5 && d6 && d7) {
      const cols = lcd!.type === "lcd2004" ? 20 : 16;
      const rows = lcd!.type === "lcd2004" ? 4 : 2;
      return {
        platformioIni: `[env:${profile.platformio}]\nplatform = ${profile.platform}\nboard = ${profile.platformio}\nframework = arduino\nmonitor_speed = 115200\nlib_deps =\n  adafruit/DHT sensor library\n  adafruit/Adafruit Unified Sensor\n`,
        mainCpp: `#include <Arduino.h>\n#include <LiquidCrystal.h>\n#include <DHT.h>\n\nconstexpr int DHT_PIN = ${dataLit};\nDHT dht(DHT_PIN, DHT22);\nLiquidCrystal lcd(${arduinoPinExpr(plan.board, rs)}, ${arduinoPinExpr(plan.board, en)}, ${arduinoPinExpr(plan.board, d4)}, ${arduinoPinExpr(plan.board, d5)}, ${arduinoPinExpr(plan.board, d6)}, ${arduinoPinExpr(plan.board, d7)});\n\nvoid setup() {\n  Serial.begin(115200);\n  dht.begin();\n  lcd.begin(${cols}, ${rows});\n  lcd.print("Temp C");\n}\n\nvoid loop() {\n  float celsius = dht.readTemperature();\n  if (isnan(celsius)) {\n    Serial.println("DHT read failed");\n    delay(2000);\n    return;\n  }\n  Serial.println(celsius);\n  lcd.setCursor(0, 1);\n  lcd.print(celsius, 1);\n  lcd.print(" C   ");\n  delay(2000);\n}\n`,
      };
    }
  }

  const ultrasonic = plan.components.find((component) => component.type === "hc_sr04");
  const distanceBuzzer = plan.components.find((component) => component.type === "buzzer");
  const trigPin = ultrasonic ? boardPinFromTerminal(plan, ultrasonic.id, "TRIG") : undefined;
  const echoPin = ultrasonic ? boardPinFromTerminal(plan, ultrasonic.id, "ECHO") : undefined;
  const buzzerPin = distanceBuzzer ? signalBoardPinForComponent(plan, distanceBuzzer.id) : undefined;
  if (ultrasonic && distanceBuzzer && trigPin && echoPin && buzzerPin && /\b(distance|closer|approach)\b/i.test(idea)) {
    const far = Number(idea.match(/\b(?:at|within|from|start\D{0,12})(\d{2,3})\s*cm/i)?.[1] || 200);
    const near = Number(idea.match(/\b(\d{1,2})\s*cm\s*(?:or closer|and below|minimum|nearest)/i)?.[1] || 20);
    return {
      platformioIni: `[env:${profile.platformio}]\nplatform = ${profile.platform}\nboard = ${profile.platformio}\nframework = arduino\nmonitor_speed = 115200\n`,
      mainCpp: `#include <Arduino.h>\n\nconstexpr int TRIG_PIN = ${pinLiteral(plan.board, trigPin)};\nconstexpr int ECHO_PIN = ${pinLiteral(plan.board, echoPin)};\nconstexpr int BUZZER_PIN = ${pinLiteral(plan.board, buzzerPin)};\nconstexpr float FAR_CM = ${far}.0;\nconstexpr float NEAR_CM = ${near}.0;\n\nvoid setup() {\n  pinMode(TRIG_PIN, OUTPUT);\n  pinMode(ECHO_PIN, INPUT);\n  pinMode(BUZZER_PIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(TRIG_PIN, LOW);\n  delayMicroseconds(2);\n  digitalWrite(TRIG_PIN, HIGH);\n  delayMicroseconds(10);\n  digitalWrite(TRIG_PIN, LOW);\n  const unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);\n  const float distanceCm = duration * 0.0343f / 2.0f;\n\n  if (duration == 0 || distanceCm > FAR_CM) {\n    noTone(BUZZER_PIN);\n    delay(50);\n  } else if (distanceCm <= NEAR_CM) {\n    tone(BUZZER_PIN, 1800);\n    delay(50);\n  } else {\n    const unsigned long intervalMs = map((long)distanceCm, (long)NEAR_CM, (long)FAR_CM, 80, 1000);\n    tone(BUZZER_PIN, 1500);\n    delay(40);\n    noTone(BUZZER_PIN);\n    delay(intervalMs - 40);\n  }\n}\n`,
    };
  }

  const signals = new Map<string, string[]>();
  for (const wire of plan.connections) {
    const pin = wire.fromComponent === "board" ? wire.fromPin : wire.toComponent === "board" ? wire.toPin : "";
    if (pin && !POWER_PINS.has(pin)) signals.set(pin, [...(signals.get(pin) || []), wire.purpose]);
  }
  const modes = new Map<string, string>();
  for (const [pin, purposes] of signals) {
    const mode = pinModeForSignal(plan, pin, purposes);
    if (mode) modes.set(pin, mode);
  }
  const declarations = [...signals].map(([pin, purposes]) => `constexpr int PIN_${pinConstName(pin)} = ${pinLiteral(plan.board, pin)}; // ${purposes.join(", ")}`);
  const setup = [...modes].map(([pin, mode]) => `  pinMode(PIN_${pinConstName(pin)}, ${mode});`);
  const inputPins = [...modes].filter(([, mode]) => mode === "INPUT_PULLUP" || mode === "INPUT").map(([pin]) => pin);
  const outputPins = [...modes].filter(([, mode]) => mode === "OUTPUT").map(([pin]) => pin);
  const hasSpecialLoop = plan.board === "esp32cam" || plan.components.some((component) => component.type === "pca9685" || component.type === "servo");
  const photoresistor = plan.components.find((component) => component.type === "photoresistor");
  const photoPin = photoresistor ? boardPinForComponent(plan, photoresistor.id, "AO") : undefined;
  const lightThreshold = Number(idea.match(/\b(?:threshold|reading|below)\D{0,20}(\d{2,4})/i)?.[1] || 500);
  // ponytail: preserve analog threshold behavior in provider fallback; digital bridging cannot represent it.
  const digitalLoop = photoPin && alertLedPin && /\b(dark|daylight|light)\b/i.test(idea)
    ? [
      `  const int lightReading = analogRead(PIN_${pinConstName(photoPin)});`,
      `  digitalWrite(PIN_${pinConstName(alertLedPin)}, lightReading < ${lightThreshold} ? HIGH : LOW);`,
      "  delay(50);",
    ].join("\n")
    // Simple active-low digital bridge covers doorbell/button→buzzer|LED; complex buses stay idle baseline.
    : !hasSpecialLoop && inputPins.length && outputPins.length
    ? [
      "  bool active = false;",
      ...inputPins.map((pin) => `  active = active || digitalRead(PIN_${pinConstName(pin)}) == LOW;`),
      ...outputPins.map((pin) => `  digitalWrite(PIN_${pinConstName(pin)}, active ? HIGH : LOW);`),
      "  delay(10);",
    ].join("\n")
    : "  delay(100);";
  const hasPca9685 = plan.components.some((component) => component.type === "pca9685") && profile.family === "esp32";
  const boardSignal = (purpose: RegExp) => plan.connections.find((wire) => purpose.test(wire.purpose) && (wire.fromComponent === "board" || wire.toComponent === "board"));
  const boardPinNumber = (wire: ProjectSpec["connections"][number] | undefined, fallback: number) => {
    const raw = wire?.fromComponent === "board" ? wire.fromPin : wire?.toPin;
    if (!raw) return fallback;
    const digits = raw.replace(/\D/g, "");
    return Number(digits) || fallback;
  };
  const pcaSetup = hasPca9685 ? `\n  Wire.begin(${boardPinNumber(boardSignal(/I2C data/i), 21)}, ${boardPinNumber(boardSignal(/I2C clock/i), 22)});\n  pwm.begin();\n  pwm.setPWMFreq(50);` : "";
  const pcaLoop = hasPca9685 ? `\n  // Hold each validated PCA9685 servo channel near its center position.\n  for (uint8_t channel = 0; channel < ${plan.components.filter((component) => component.type === "servo").length}; ++channel) pwm.setPWM(channel, 0, 375);` : "";
  const cameraSetup = plan.board === "esp32cam" ? `\n  camera_config_t config = {};\n  config.pin_d0=5; config.pin_d1=18; config.pin_d2=19; config.pin_d3=21;\n  config.pin_d4=36; config.pin_d5=39; config.pin_d6=34; config.pin_d7=35;\n  config.pin_xclk=0; config.pin_pclk=22; config.pin_vsync=25; config.pin_href=23;\n  config.pin_sccb_sda=26; config.pin_sccb_scl=27; config.pin_pwdn=32; config.pin_reset=-1;\n  config.xclk_freq_hz=20000000; config.pixel_format=PIXFORMAT_JPEG;\n  config.frame_size=FRAMESIZE_QVGA; config.jpeg_quality=12; config.fb_count=1;\n  if (esp_camera_init(&config) != ESP_OK) Serial.println("Camera initialization failed");` : "";
  const cameraLoop = plan.board === "esp32cam" ? `\n  camera_fb_t* frame = esp_camera_fb_get();\n  if (frame) esp_camera_fb_return(frame);` : "";
  const extraIncludes = `${plan.board === "esp32cam" ? "#include <esp_camera.h>\n" : ""}${hasPca9685 ? "#include <Wire.h>\n#include <Adafruit_PWMServoDriver.h>\nAdafruit_PWMServoDriver pwm;\n" : ""}`;
  const libDeps = hasPca9685 ? "\nlib_deps =\n  adafruit/Adafruit PWM Servo Driver Library" : "";
  const loopBody = hasPca9685 || plan.board === "esp32cam" ? `${pcaLoop}${cameraLoop}\n  delay(100);` : `\n${digitalLoop}`;
  return {
    platformioIni: `[env:${profile.platformio}]\nplatform = ${profile.platform}\nboard = ${profile.platformio}\nframework = arduino\nmonitor_speed = 115200${libDeps}\n`,
    mainCpp: `#include <Arduino.h>\n${extraIncludes}\n// Firmware generated from Blueprint's accepted netlist.\n${declarations.join("\n")}\n\nvoid setup() {\n  Serial.begin(115200);\n${setup.join("\n")}${pcaSetup}${cameraSetup}\n}\n\nvoid loop() {${loopBody}\n}\n`,
  };
}

function boardPinsFor(architecture: ReturnType<typeof ArchitectureSchema.parse>, componentId: string, pin: string) {
  const component = architecture.components.find((item) => item.id === componentId);
  if (!component) return undefined;
  return COMPONENTS[component.type || component.id]?.boardPins?.[pin] || component.registry?.boardPins?.[pin];
}

function profileFor(architecture: ReturnType<typeof ArchitectureSchema.parse>) {
  return architecture.boardMeta || toBoardProfile(ensureBoardCard(architecture.board));
}

function preferredPowerRail(profile: BoardProfile, allowed: readonly string[]) {
  for (const pin of ["5V", "VIN", "VSYS", "3V3", "GND"]) {
    if (profile.pins.includes(pin) && boardPinCompatible(profile, allowed, pin)) return pin;
  }
  return allowed.find((pin) => profile.pins.includes(pin));
}

function isPowerFamilyAllowlist(allowed: readonly string[]) {
  return allowed.length > 0 && allowed.every((pin) => isPowerOrGroundPin(pin));
}

/** Drop invalid board wires when the same component terminal already has a compatible wire. */
export function removeInvalidDirectDuplicates(architecture: ReturnType<typeof ArchitectureSchema.parse>, connections: ProjectSpec["connections"]) {
  const profile = profileFor(architecture);
  const direct = (wire: ProjectSpec["connections"][number]) => {
    const component = wire.fromComponent === "board" ? wire.toComponent : wire.toComponent === "board" ? wire.fromComponent : null;
    const pin = wire.fromComponent === "board" ? wire.toPin : wire.toComponent === "board" ? wire.fromPin : null;
    const boardPin = wire.fromComponent === "board" ? wire.fromPin : wire.toComponent === "board" ? wire.toPin : null;
    const allowed = component && pin ? boardPinsFor(architecture, component, pin) : undefined;
    return component && pin && boardPin && allowed ? { terminal: `${component}.${pin}`, boardPin, allowed } : null;
  };
  const compatible = (item: { allowed: readonly string[]; boardPin: string }) => boardPinCompatible(profile, item.allowed, item.boardPin);
  const valid = new Set(connections.flatMap((wire) => {
    const item = direct(wire);
    return item && compatible(item) ? [item.terminal] : [];
  }));
  return connections.filter((wire) => {
    const item = direct(wire);
    return !item || compatible(item) || !valid.has(item.terminal);
  });
}

/**
 * Deterministic fix for the usual LLM power mistake: VCC/GND wired to a digital pin.
 * Rewrites power-family terminals onto a real board rail; does not invent signal wiring.
 */
export function repairMiswiredPowerPins(architecture: ReturnType<typeof ArchitectureSchema.parse>, connections: ProjectSpec["connections"]) {
  const profile = profileFor(architecture);
  return connections.map((wire) => {
    const component = wire.fromComponent === "board" ? wire.toComponent : wire.toComponent === "board" ? wire.fromComponent : null;
    const pin = wire.fromComponent === "board" ? wire.toPin : wire.toComponent === "board" ? wire.fromPin : null;
    const boardPin = wire.fromComponent === "board" ? wire.fromPin : wire.toComponent === "board" ? wire.toPin : null;
    if (!component || !pin || !boardPin) return wire;
    const allowed = boardPinsFor(architecture, component, pin);
    if (!allowed?.length || !isPowerFamilyAllowlist(allowed)) return wire;
    if (boardPinCompatible(profile, allowed, boardPin)) return wire;
    const rail = preferredPowerRail(profile, allowed);
    if (!rail || rail === boardPin) return wire;
    const purpose = rail === "GND" ? "ground" : /power/i.test(wire.purpose) ? wire.purpose : `${pin} power`;
    const color = rail === "GND" ? "#111827" : "#ef4444";
    return wire.fromComponent === "board"
      ? { ...wire, fromPin: rail, purpose, color }
      : { ...wire, toPin: rail, purpose, color };
  });
}

/** Normalize + auto-repair LLM netlists so power-rail mistakes don't kill generate. */
export function sanitizeLlmConnections(architecture: ReturnType<typeof ArchitectureSchema.parse>, connections: ProjectSpec["connections"]) {
  const remapped = remapUnknownComponentIds(architecture, connections);
  const powered = repairMiswiredPowerPins(architecture, remapped);
  const cleaned = removeInvalidDirectDuplicates(architecture, powered);
  const seen = new Set<string>();
  return cleaned.filter((wire) => {
    const key = [`${wire.fromComponent}.${wire.fromPin}`, `${wire.toComponent}.${wire.toPin}`].sort().join("--");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function remapUnknownComponentIds(architecture: ReturnType<typeof ArchitectureSchema.parse>, connections: ProjectSpec["connections"]) {
  const selected = new Set(architecture.components.map((component) => component.id));
  const unknown = new Map<string, Set<string>>();
  for (const wire of connections) for (const [owner, pin] of [[wire.fromComponent, wire.fromPin], [wire.toComponent, wire.toPin]] as const) {
    if (owner !== "board" && !selected.has(owner)) unknown.set(owner, new Set([...(unknown.get(owner) || []), pin]));
  }
  const replacements = new Map<string, string>();
  for (const [owner, pins] of unknown) {
    const candidates = architecture.components.filter((component) => {
      const definitionPins = COMPONENTS[component.type || component.id]?.pins || component.registry?.pins;
      return definitionPins && [...pins].every((pin) => definitionPins.includes(pin));
    });
    if (candidates.length === 1) replacements.set(owner, candidates[0]!.id);
  }
  return connections.map((wire) => ({ ...wire, fromComponent: replacements.get(wire.fromComponent) || wire.fromComponent, toComponent: replacements.get(wire.toComponent) || wire.toComponent }));
}

export async function buildProject(idea: string, architectureInput: unknown, usageStart: ReturnType<typeof usageSnapshot>, requiredConnections: ProjectSpec["connections"] = [], complete: typeof completeJson = completeJson, deadlineAt = Date.now() + 90_000, prewired?: { connections: ProjectSpec["connections"]; instructions: string[]; explanations?: CircuitDesign["explanations"] }): Promise<ProjectSpec> {
  const architecture = attachBoardMeta(ArchitectureSchema.parse(architectureInput));
  const architectureErrors = validateArchitecture(architecture);
  if (architectureErrors.length) throw new Error(`Unsafe component plan: ${architectureErrors.join(" ")}`);
  const synthesized = prewired
    ? { connections: prewired.connections, instructions: prewired.instructions }
    : synthesizeCircuit(architecture, requiredConnections);
  const plan = ProjectPlanSchema.parse({ ...architecture, ...synthesized });
  const safetyErrors = runSafetyGate(plan);
  if (safetyErrors.length) throw new Error(`Safety gate failed: ${safetyErrors.join(" ")}`);
  const hardwareErrors = validateHardware(plan);
  if (hardwareErrors.length) throw new Error(`${prewired ? "LLM circuit" : "Deterministic circuit synthesis"} failed: ${hardwareErrors.join(" ")}`);

  const withMeta = (files: { platformioIni: string; mainCpp: string }, instructions: string[]) => ProjectSpecSchema.parse({
    ...plan,
    explanations: prewired?.explanations,
    instructions,
    pins: derivePins(plan),
    files,
    generation: generationUsage(usageStart),
  });

  const selectedCatalog = architecture.components.map((component) => {
    const definition = component.type ? COMPONENTS[component.type] : undefined;
    const pins = definition?.pins || component.registry?.pins || [];
    const boardPins = definition?.boardPins || component.registry?.boardPins;
    const direct = boardPins ? Object.entries(boardPins).map(([pin, choices]) => `${pin}->${choices.join("/") || "never directly to MCU"}`).join(", ") : "follow voltage and pin roles";
    return `${component.id}: ${component.name}; ${component.type ? `base type ${component.type}` : `exact registry part ${component.registry?.id}`}; ${definition?.description || component.registry?.requirements?.join("; ")}; pins ${pins.join(", ")}; direct board constraints ${direct}; firmware ${component.registry?.firmware || definition?.firmware || "Arduino core"}; requirements ${component.registry?.requirements?.join("; ") || "standard validated family rules"}`;
  }).join("\n");
  const messages = [
    { role: "system" as const, content: firmwareSystemPrompt(architecture.boardMeta) },
    { role: "user" as const, content: `Project behavior:\n${idea}\n\nController:\n${JSON.stringify(architecture.boardMeta)}\n\nComponents:\n${selectedCatalog}\n\nValidated immutable netlist:\n${JSON.stringify(plan.connections)}` },
  ];
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: unknown;
    try {
      response = await complete("firmware", feedback ? [...messages, { role: "user", content: feedback }] : messages, 2400, attempt, deadlineAt);
    } catch (error) {
      const attemptProviderErrors = [error instanceof Error ? error.message : "The circuit-builder response could not be read."];
      feedback = `The previous provider response was unusable: ${attemptProviderErrors[0]} Return the complete corrected JSON.`;
      continue;
    }
    const build = FirmwareOutputSchema.safeParse(response);
    if (build.success) {
      build.data.files.platformioIni = normalizeFirmwareDependencies(build.data.files.platformioIni);
      build.data.files.mainCpp = normalizeFirmwareSource(build.data.files.mainCpp);
    }
    const errors = build.success
      ? fileErrors(build.data.files.platformioIni, build.data.files.mainCpp, plan.components.some((component) => component.type === "servo") && !plan.components.some((component) => component.type === "pca9685"), plan.components.some((component) => component.type === "pca9685"), architecture.board, plan.connections)
      : build.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    if (build.success && plan.components.some((component) => component.type === "photoresistor") && /\b(dark|daylight|light)\b/i.test(idea) && !/\banalogRead\s*\(/.test(build.data.files.mainCpp)) {
      errors.push("Photoresistor threshold behavior must use analogRead().");
    }
    if (build.success && plan.components.some((component) => component.type === "dht22") && /\bhumidity\b/i.test(idea) && !/\breadHumidity\s*\(/.test(build.data.files.mainCpp)) {
      errors.push("Humidity behavior must use DHT readHumidity().");
    }
    if (build.success && plan.components.some((component) => component.type === "led") && /\b(above|below|over|under|threshold)\b/i.test(idea) && !/\bdigitalWrite\s*\(/.test(build.data.files.mainCpp)) {
      errors.push("Threshold alert firmware must drive the wired LED.");
    }
    if (build.success && plan.components.some((component) => component.type === "hc_sr04") && plan.components.some((component) => component.type === "buzzer") && /\b(distance|closer|approach)\b/i.test(idea)) {
      if (!/\bpulseIn\s*\(/.test(build.data.files.mainCpp)) errors.push("Distance warning firmware must measure the HC-SR04 echo pulse.");
      if (!/\btone\s*\(/.test(build.data.files.mainCpp)) errors.push("Distance warning firmware must drive the buzzer.");
    }
    if (build.success && !errors.length) {
      return withMeta(build.data.files, [...plan.instructions, "Firmware implements the project behavior on the accepted netlist."]);
    }
    feedback = `Correct these firmware errors without changing hardware or pin assignments:\n${errors.join("\n")}\nReturn the complete corrected JSON.`;
  }
  const files = deterministicFirmware(plan, idea);
  const errors = fileErrors(files.platformioIni, files.mainCpp, false, false, architecture.board, plan.connections);
  if (plan.components.some((component) => component.type === "photoresistor") && /\b(dark|daylight|light)\b/i.test(idea) && !/\banalogRead\s*\(/.test(files.mainCpp)) {
    errors.push("Photoresistor threshold fallback must use analogRead().");
  }
  if (plan.components.some((component) => component.type === "dht22") && /\bhumidity\b/i.test(idea) && !/\breadHumidity\s*\(/.test(files.mainCpp)) {
    errors.push("Humidity fallback must use DHT readHumidity().");
  }
  if (plan.components.some((component) => component.type === "led") && /\b(above|below|over|under|threshold)\b/i.test(idea) && !/\bdigitalWrite\s*\(/.test(files.mainCpp)) {
    errors.push("Threshold fallback must drive the wired LED.");
  }
  if (plan.components.some((component) => component.type === "hc_sr04") && plan.components.some((component) => component.type === "buzzer") && /\b(distance|closer|approach)\b/i.test(idea)) {
    if (!/\bpulseIn\s*\(/.test(files.mainCpp)) errors.push("Distance warning fallback must measure the HC-SR04 echo pulse.");
    if (!/\btone\s*\(/.test(files.mainCpp)) errors.push("Distance warning fallback must drive the buzzer.");
  }
  if (errors.length) throw new Error(`Deterministic firmware fallback failed: ${errors.join(" ")}`);
  const fallbackNote = /BluetoothA2DPSink/.test(files.mainCpp)
    ? "The AI firmware provider was unavailable, so Blueprint supplied deterministic Bluetooth audio firmware for the validated circuit."
    : /DHT\.h|Adafruit_SSD1306|LiquidCrystal/.test(files.mainCpp)
      ? "The AI firmware provider was unavailable, so Blueprint supplied deterministic sensor/display firmware for the validated circuit."
      : "The AI firmware provider was unavailable, so Blueprint supplied a compilable safe baseline without full project behavior.";
  return withMeta(files, [...plan.instructions, fallbackNote]);
}

/** Normalize an LLM circuit design and return architecture + prewired netlist for buildProject. */
export function normalizeCircuitDesign(raw: unknown, registry: readonly ComponentRegistryRecord[] = []) {
  const normalized = normalizeArchitecture(raw, registry) as Record<string, unknown>;
  const boardCard = ensureBoardCard(normalized.board);
  const board = boardCard.id;
  const boardMeta = toBoardProfile(boardCard);
  // ponytail: don't Zod-parse here — oversized component lists must reach the generate route for scope negotiation, not crash as a raw Zod dump
  const architectureForNormalize = {
    title: String(normalized.title || "Project"),
    summary: String(normalized.summary || "Generated circuit project."),
    board,
    boardMeta,
    components: Array.isArray(normalized.components) ? normalized.components : [],
    parts: Array.isArray(normalized.parts) ? normalized.parts : [`1x ${boardCard.name}`, "parts"],
  } as ReturnType<typeof ArchitectureSchema.parse>;
  const rawConnections = Array.isArray(normalized.connections)
    ? (normalizeBuild({ connections: normalized.connections }, architectureForNormalize) as { connections: ProjectSpec["connections"] }).connections
    : [];
  // ponytail: LLM often wires VCC→D2; fix rails here instead of hoping the model repairs itself
  const connections = sanitizeLlmConnections(architectureForNormalize, rawConnections);
  const defaultColor = (purpose: string) => /gnd|ground/i.test(purpose) ? "#111827" : /vcc|power|vin|5v|3v3/i.test(purpose) ? "#ef4444" : "#3b82f6";
  const colored = connections.map((wire) => ({
    ...wire,
    color: /^#[0-9a-fA-F]{6}$/.test(wire.color) ? wire.color : defaultColor(wire.purpose),
  }));
  return {
    architecture: architectureForNormalize,
    connections: colored,
    instructions: Array.isArray(normalized.instructions) ? normalized.instructions : ["Disconnect power before wiring.", "Follow the pin table.", "Power on and test."],
    explanations: Array.isArray(normalized.explanations) ? normalized.explanations : [],
  };
}
