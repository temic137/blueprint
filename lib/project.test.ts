import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildProject, deterministicFirmware, normalizeArchitecture, normalizeBoardPin, normalizeBuild, normalizeCircuitDesign, normalizeComponentPin, normalizeExplanations, remapUnknownComponentIds, removeInvalidDirectDuplicates, sanitizeLlmConnections } from "./build-project.ts";
import { loadComponentManifests } from "./component-manifests.ts";

test("normalizes common ESP32 board-label aliases at the model boundary", () => {
  assert.equal(normalizeBoardPin("5V"), "VIN");
  assert.equal(normalizeBoardPin("3.3V"), "3V3");
  assert.equal(normalizeBoardPin("ground"), "GND");
  assert.equal(normalizeBoardPin("IO 21"), "GPIO21");
  assert.equal(normalizeBoardPin("D4"), "D4");
});

test("normalizes messy explanation componentIds onto real part ids", () => {
  const components = [
    { id: "hc_sr04_1", type: "hc_sr04", name: "HC-SR04 ultrasonic sensor" },
    { id: "resistor_1", type: "resistor", name: "1k resistor" },
  ];
  const cleaned = normalizeExplanations({
    explanations: [
      { componentId: "HC-SR04", text: "Measures distance to parked cars." },
      { componentId: "1kΩ Resistor", text: "Forms half of the echo divider." },
      { componentId: "!!!", text: "bad" },
    ],
  }, components);
  assert.deepEqual(cleaned.map((row) => row.componentId), ["hc_sr04_1", "resistor_1"]);
});

test("normalizes model pin1/pin2 aliases onto catalog part pins", () => {
  assert.equal(normalizeComponentPin("pin1", ["1", "2"]), "1");
  assert.equal(normalizeComponentPin("pin2", ["1", "2"]), "2");
  assert.equal(normalizeComponentPin("pin1", ["POS", "NEG"]), "POS");
  assert.equal(normalizeComponentPin("pin2", ["POS", "NEG"]), "NEG");
  assert.equal(normalizeComponentPin("+", ["POS", "NEG"]), "POS");
  assert.equal(normalizeComponentPin("anode", ["A", "C"]), "A");
  assert.equal(normalizeComponentPin("pin1", ["1.l", "2.l", "1.r", "2.r"]), "1.l");
  assert.equal(normalizeComponentPin("2", ["1.l", "2.l", "1.r", "2.r"]), "2");
});
import { usageSnapshot } from "./ai.ts";
import { ensureBoardCard, toBoardProfile } from "./boards.ts";
import { ArchitectureSchema, assemblySteps, billOfMaterials, COMPONENTS, componentReferences, derivePins, humanizeProjectText, pinAssignments, projectDiff, ProjectPlanSchema, ProjectSpecSchema, schematicLayout, validateArchitecture, validateHardware, validateIntentCoverage, wireLane, WOKWI_ELEMENT_EXCLUSIONS } from "./project.ts";

test("normalizeBuild remaps pin1/pin2 wires for doorbell parts", () => {
  const architecture = ArchitectureSchema.parse(normalizeArchitecture({
    title: "Doorbell", summary: "Button rings a buzzer on Arduino.", board: "arduino_uno",
    components: [
      { id: "pushbutton1", type: "pushbutton", name: "Pushbutton", quantity: 1 },
      { id: "buzzer1", type: "buzzer", name: "Buzzer", quantity: 1 },
    ],
    parts: ["1x Arduino Uno", "1x Pushbutton", "1x Buzzer"],
  }));
  const normalized = normalizeBuild({ connections: [
    { fromComponent: "board", fromPin: "D2", toComponent: "pushbutton1", toPin: "pin1", color: "#3b82f6", purpose: "button input" },
    { fromComponent: "board", fromPin: "GND", toComponent: "pushbutton1", toPin: "pin2", color: "#111827", purpose: "ground" },
    { fromComponent: "board", fromPin: "D3", toComponent: "buzzer1", toPin: "pin1", color: "#f59e0b", purpose: "buzzer drive" },
    { fromComponent: "board", fromPin: "GND", toComponent: "buzzer1", toPin: "pin2", color: "#111827", purpose: "ground" },
  ] }, architecture) as { connections: Array<{ toPin: string }> };
  assert.deepEqual(normalized.connections.map((wire) => wire.toPin), ["1", "2", "POS", "NEG"]);
});

function checkHardware(plan: Parameters<typeof validateHardware>[0]) {
  return validateHardware({
    ...plan,
    boardMeta: plan.boardMeta || toBoardProfile(ensureBoardCard(plan.board)),
  });
}

test("rejects an architecture that omits an explicitly requested capability", () => {
  const parts = [{ id: "motion", type: "pir", name: "PIR", quantity: 1 }] as const;
  assert.deepEqual(validateIntentCoverage("Build a motion-tracking camera", { board: "esp32dev", components: parts }), ["The requested camera capability is missing from the architecture."]);
  assert.deepEqual(validateIntentCoverage("Build a motion-tracking camera", { board: "esp32cam", components: parts }), []);
});

test("requires the complete supported PCA9685 servo-power topology", () => {
  const servo = { id: "arm", type: "servo", name: "Arm servo", quantity: 1 } as const;
  const driver = { id: "driver", type: "pca9685", name: "PCA9685", quantity: 1 } as const;
  const supply = { id: "supply", type: "servo_power_supply", name: "5V supply", quantity: 1 } as const;
  assert.match(validateArchitecture({ components: [servo, driver] }).join(" "), /regulated 5V/);
  assert.deepEqual(validateArchitecture({ components: [servo, driver, supply] }), []);
  assert.match(validateArchitecture({ components: [supply] }).join(" "), /only be selected with a PCA9685/);
});

test("validates PIR and servo wiring on camera-safe ESP32-CAM pins", () => {
  const plan = ProjectPlanSchema.parse({ title: "Motion camera", summary: "Tracks detected movement with a camera and servo.", board: "esp32cam", components: [{ id: "motion", type: "pir", name: "PIR", quantity: 1 }, { id: "pan", type: "servo", name: "Pan servo", quantity: 1 }], parts: ["ESP32-CAM", "PIR", "Servo"], instructions: ["Disconnect power.", "Connect the circuit.", "Upload and test."], connections: [
    { fromComponent: "board", fromPin: "VIN", toComponent: "motion", toPin: "VCC", color: "#ef4444", purpose: "sensor power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "motion", toPin: "GND", color: "#111827", purpose: "sensor ground" },
    { fromComponent: "board", fromPin: "GPIO13", toComponent: "motion", toPin: "OUT", color: "#3b82f6", purpose: "motion input" },
    { fromComponent: "board", fromPin: "VIN", toComponent: "pan", toPin: "VCC", color: "#ef4444", purpose: "servo power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "pan", toPin: "GND", color: "#111827", purpose: "servo ground" },
    { fromComponent: "board", fromPin: "GPIO14", toComponent: "pan", toPin: "PWM", color: "#f59e0b", purpose: "pan control" },
  ] });
  assert.deepEqual(checkHardware(plan), []);
  assert.match(checkHardware({ ...plan, connections: plan.connections.map((wire) => wire.fromPin === "GPIO14" ? { ...wire, fromPin: "GPIO27" } : wire) })[0] || "", /board\.GPIO27/);
});

test("accepts DHT22 + SSD1306 on Arduino Uno with 5V rails and digital I2C pins", () => {
  const plan = ProjectPlanSchema.parse({
    title: "Temp display",
    summary: "Shows ambient temperature on a small OLED.",
    board: "arduino_uno",
    components: [
      { id: "dht22_1", type: "dht22", name: "DHT22", quantity: 1 },
      { id: "ssd1306_1", type: "ssd1306", name: "SSD1306 OLED", quantity: 1 },
    ],
    parts: ["Arduino Uno", "DHT22", "SSD1306"],
    instructions: ["Disconnect power before wiring.", "Wire the sensor and display.", "Upload and read temperature."],
    connections: [
      { fromComponent: "board", fromPin: "5V", toComponent: "dht22_1", toPin: "VCC", color: "#ef4444", purpose: "sensor power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "dht22_1", toPin: "GND", color: "#111827", purpose: "sensor ground" },
      { fromComponent: "board", fromPin: "D2", toComponent: "dht22_1", toPin: "DATA", color: "#3b82f6", purpose: "sensor data" },
      { fromComponent: "board", fromPin: "5V", toComponent: "ssd1306_1", toPin: "VCC", color: "#ef4444", purpose: "display power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "ssd1306_1", toPin: "GND", color: "#111827", purpose: "display ground" },
      { fromComponent: "board", fromPin: "A4", toComponent: "ssd1306_1", toPin: "SDA", color: "#3b82f6", purpose: "I2C data" },
      { fromComponent: "board", fromPin: "A5", toComponent: "ssd1306_1", toPin: "SCL", color: "#f59e0b", purpose: "I2C clock" },
    ],
  });
  assert.deepEqual(checkHardware(plan), []);
});

test("sanitizes LLM DHT22 VCC→D2 mistakes before hardware validation", () => {
  const architecture = ArchitectureSchema.parse({
    title: "Temp display",
    summary: "Shows ambient temperature on an LCD.",
    board: "arduino_uno",
    boardMeta: toBoardProfile(ensureBoardCard("arduino_uno")),
    components: [
      { id: "dht22", type: "dht22", name: "DHT22", quantity: 1 },
      { id: "lcd", type: "ssd1306", name: "OLED", quantity: 1 },
    ],
    parts: ["Arduino Uno", "DHT22", "OLED"],
  });
  const dirty = [
    { fromComponent: "board", fromPin: "D2", toComponent: "dht22", toPin: "VCC", color: "#ef4444", purpose: "bad power" },
    { fromComponent: "board", fromPin: "5V", toComponent: "dht22", toPin: "VCC", color: "#ef4444", purpose: "sensor power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "dht22", toPin: "GND", color: "#111827", purpose: "sensor ground" },
    { fromComponent: "board", fromPin: "D3", toComponent: "dht22", toPin: "DATA", color: "#3b82f6", purpose: "sensor data" },
    { fromComponent: "board", fromPin: "5V", toComponent: "lcd", toPin: "VCC", color: "#ef4444", purpose: "display power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "lcd", toPin: "GND", color: "#111827", purpose: "display ground" },
    { fromComponent: "board", fromPin: "A4", toComponent: "lcd", toPin: "SDA", color: "#3b82f6", purpose: "I2C data" },
    { fromComponent: "board", fromPin: "A5", toComponent: "lcd", toPin: "SCL", color: "#f59e0b", purpose: "I2C clock" },
  ];
  const cleaned = sanitizeLlmConnections(architecture, dirty);
  const dhtPower = cleaned.filter((wire) => (wire.toComponent === "dht22" && wire.toPin === "VCC") || (wire.fromComponent === "dht22" && wire.fromPin === "VCC"));
  assert.equal(dhtPower.length, 1);
  assert.equal(dhtPower[0]?.fromComponent === "board" ? dhtPower[0].fromPin : dhtPower[0]?.toPin, "5V");
  assert.equal(cleaned.some((wire) => wire.toComponent === "dht22" && wire.toPin === "VCC" && wire.fromPin === "D2"), false);
  assert.deepEqual(checkHardware({
    ...architecture,
    instructions: ["Disconnect power before wiring.", "Wire the circuit.", "Upload firmware."],
    connections: cleaned,
  }), []);

  const onlyBadPower = sanitizeLlmConnections(architecture, [
    { fromComponent: "board", fromPin: "D2", toComponent: "dht22", toPin: "VCC", color: "#ef4444", purpose: "bad" },
    { fromComponent: "board", fromPin: "GND", toComponent: "dht22", toPin: "GND", color: "#111827", purpose: "gnd" },
    { fromComponent: "board", fromPin: "D3", toComponent: "dht22", toPin: "DATA", color: "#3b82f6", purpose: "data" },
    { fromComponent: "board", fromPin: "5V", toComponent: "lcd", toPin: "VCC", color: "#ef4444", purpose: "power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "lcd", toPin: "GND", color: "#111827", purpose: "gnd" },
    { fromComponent: "board", fromPin: "A4", toComponent: "lcd", toPin: "SDA", color: "#3b82f6", purpose: "sda" },
    { fromComponent: "board", fromPin: "A5", toComponent: "lcd", toPin: "SCL", color: "#f59e0b", purpose: "scl" },
  ]);
  assert.ok(onlyBadPower.some((wire) => wire.toComponent === "dht22" && wire.toPin === "VCC" && wire.fromPin === "5V"));

  const fromNormalize = normalizeCircuitDesign({
    title: "Temp",
    summary: "Temperature on a display.",
    board: "arduino_uno",
    components: architecture.components,
    parts: architecture.parts,
    connections: dirty,
    instructions: ["Disconnect power before wiring.", "Wire it.", "Test."],
  });
  assert.deepEqual(checkHardware({
    ...fromNormalize.architecture,
    boardMeta: toBoardProfile(ensureBoardCard("arduino_uno")),
    instructions: fromNormalize.instructions,
    connections: fromNormalize.connections,
  }), []);
});

test("shows readable names and actual destinations in pin assignments", () => {
  const rows = pinAssignments({
    board: "esp32dev",
    boardMeta: toBoardProfile(ensureBoardCard("esp32dev")),
    components: [
      { id: "c5", type: "hc_sr04", name: "Ultrasonic Distance Sensor", quantity: 1 },
      { id: "c6", type: "resistor", name: "1kΩ Divider Resistor", quantity: 1 },
    ],
    connections: [
      { fromComponent: "board", fromPin: "VIN", toComponent: "c5", toPin: "VCC", color: "#ef4444", purpose: "sensor_power" },
      { fromComponent: "c5", fromPin: "ECHO", toComponent: "c6", toPin: "1", color: "#f59e0b", purpose: "echo_signal" },
    ],
  });
  assert.deepEqual(rows, [
    { component: "U1 — Ultrasonic Distance Sensor", pin: "VCC", connectedTo: "MCU1 — ESP32 DevKit V1", connectedPin: "VIN", purpose: "sensor power" },
    { component: "U1 — Ultrasonic Distance Sensor", pin: "ECHO", connectedTo: "R1 — 1kΩ Divider Resistor", connectedPin: "1", purpose: "echo signal" },
  ]);
});

test("uses stable engineering references across BOM, assembly, and prose", () => {
  const sample = {
    components: [
      { id: "c5", type: "hc_sr04", name: "HC_SR04", quantity: 1 },
      { id: "c6", type: "resistor", name: "Res1k", quantity: 1 },
      { id: "c7", type: "resistor", name: "Res2k", quantity: 1 },
    ],
    connections: [{ fromComponent: "c5", fromPin: "ECHO", toComponent: "c6", toPin: "1", color: "#f59e0b", purpose: "echo divider" }],
  } as const;
  assert.deepEqual(componentReferences(sample).map(({ ref, name }) => ({ ref, name })), [
    { ref: "U1", name: "HC-SR04 ultrasonic sensor" },
    { ref: "R1", name: "1kΩ resistor" },
    { ref: "R2", name: "2kΩ resistor" },
  ]);
  assert.equal(billOfMaterials(sample).length, 4);
  assert.match(assemblySteps(sample)[1]!.text, /U1 — HC-SR04 ultrasonic sensor pin ECHO.*R1 — 1kΩ resistor pin 1/);
  assert.equal(humanizeProjectText("Connect c5 to c6, not c7.", sample), "Connect U1 (HC-SR04 ultrasonic sensor) to R1 (1kΩ resistor), not R2 (2kΩ resistor).");
});

test("deduplicates identical BOM items while retaining every reference", () => {
  const rows = billOfMaterials({ components: [{ id: "left", type: "servo", name: "SG90 servo", quantity: 1 }, { id: "right", type: "servo", name: "SG90 servo", quantity: 1 }] });
  assert.deepEqual(rows.at(-1), { ref: "M1, M2", quantity: 2, component: "SG90 servo", type: "SG90 servo", purpose: "position-controlled actuator", support: "validated" });
});

test("summarizes revision changes from project data", () => {
  const base = ProjectSpecSchema.parse({ title: "Test", summary: "A sufficiently long test project.", board: "esp32dev", components: [{ id: "buzzer", type: "buzzer", name: "Buzzer", quantity: 1 }], connections: [{ fromComponent: "board", fromPin: "GPIO4", toComponent: "buzzer", toPin: "POS", color: "#ef4444", purpose: "tone" }, { fromComponent: "board", fromPin: "GND", toComponent: "buzzer", toPin: "NEG", color: "#111827", purpose: "ground" }], parts: ["ESP32", "Buzzer"], instructions: ["One", "Two", "Three"], pins: [], files: { platformioIni: "[env:esp32dev]\nplatform = espressif32", mainCpp: "void setup() { pinMode(4, OUTPUT); }\nvoid loop() { digitalWrite(4, HIGH); delay(100); digitalWrite(4, LOW); delay(100); }" } });
  const changed = { ...base, files: { ...base.files, mainCpp: `${base.files.mainCpp}\n// changed` } };
  assert.deepEqual(projectDiff(base, changed), { components: { added: [], removed: [], changed: [] }, wiringChanges: 0, firmwareChanged: true });
});

test("removes an invalid direct-board duplicate when the same terminal has a valid wire", () => {
  const architecture = ArchitectureSchema.parse({ title: "Doorbell", summary: "A button sounds a buzzer when pressed.", board: "esp32dev", components: [{ id: "c2", type: "buzzer", name: "Buzzer", quantity: 1 }], parts: ["ESP32", "Buzzer"] });
  const connections = [
    { fromComponent: "board", fromPin: "3V3", toComponent: "c2", toPin: "POS", color: "#ef4444", purpose: "incorrect buzzer power" },
    { fromComponent: "board", fromPin: "GPIO4", toComponent: "c2", toPin: "POS", color: "#8b5cf6", purpose: "buzzer tone" },
    { fromComponent: "board", fromPin: "GND", toComponent: "c2", toPin: "NEG", color: "#111827", purpose: "ground" },
  ];
  assert.deepEqual(removeInvalidDirectDuplicates(architecture, connections), connections.slice(1));
});

test("normalizes model-provided component instance ids before validation", () => {
  const normalized = normalizeArchitecture({ board: "AI Thinker ESP32-CAM", components: [{ id: "Door Button" }, { id: "Door-Buzzer" }, { id: "Door Buzzer" }], parts: ["ESP32 DevKit V1", "PAM8403", "JST-XH", "Speaker"] }) as { board: string; components: Array<{ id: string }>; parts: string[] };
  assert.deepEqual(normalized.components.map((component) => component.id), ["door_button", "door_buzzer", "door_buzzer_2"]);
  assert.equal(normalized.board, "esp32cam");
  assert.deepEqual(normalized.parts, ["1x AI Thinker ESP32-CAM with OV2640", "1x Door Button", "1x Door-Buzzer", "1x Door Buzzer"]);
});

test("keeps BOM prose out of the electrical graph and resolves component names to stable ids", () => {
  const architecture = ArchitectureSchema.parse(normalizeArchitecture({
    title: "Audio alert", summary: "Produces an audible alert from a validated buzzer.", board: "esp32dev",
    components: [{ id: "alarm_output", type: "buzzer", name: "Piezo Buzzer", quantity: 1 }],
    parts: [{ name: "PAM8403", quantity: 1, notes: "unselected suggestion" }, { name: "JST-XH", quantity: 1, notes: "unselected suggestion" }],
  }));
  assert.equal(architecture.parts.some((part) => /PAM8403|JST-XH/.test(part)), false);
  const normalized = normalizeBuild({ connections: [
    { fromComponent: "ESP32 DevKit V1", fromPin: "GPIO4", toComponent: "Piezo Buzzer", toPin: "POS", color: "#3b82f6", purpose: "alarm output" },
    { fromComponent: "Piezo Buzzer", fromPin: "NEG", toComponent: "board", toPin: "GND", color: "#111827", purpose: "ground" },
  ], instructions: ["Disconnect power.", "Connect the buzzer.", "Upload firmware."], files: { platformioIni: "[env:esp32dev]\nplatform=espressif32", mainCpp: "void setup(){pinMode(4,OUTPUT);} void loop(){digitalWrite(4,HIGH);delay(100);}" } }, architecture) as { connections: Array<{ fromComponent: string; toComponent: string }> };
  assert.deepEqual(normalized.connections.map((wire) => [wire.fromComponent, wire.toComponent]), [["board", "alarm_output"], ["alarm_output", "board"]]);
});

test("remaps an invented component id when its terminal set identifies one selected part", () => {
  const architecture = ArchitectureSchema.parse({ title: "Range alarm", summary: "Measures range with an ultrasonic sensor.", board: "esp32dev", components: [{ id: "c1", type: "hc_sr04", name: "Ultrasonic sensor", quantity: 1 }, { id: "r1", type: "resistor", name: "Divider R1", quantity: 1 }, { id: "r2", type: "resistor", name: "Divider R2", quantity: 1 }], parts: ["ESP32", "HC-SR04", "Two resistors"] });
  const connections = [{ fromComponent: "board", fromPin: "VIN", toComponent: "c7", toPin: "VCC", color: "#ef4444", purpose: "sensor power" }];
  assert.equal(remapUnknownComponentIds(architecture, connections)[0]?.toComponent, "c1");
});

test("requires separate resistors for LEDs and HC-SR04 dividers", () => {
  const components = [{ id: "sensor", type: "hc_sr04" }, { id: "status", type: "led" }, { id: "r1", type: "resistor" }, { id: "r2", type: "resistor" }];
  assert.match(validateArchitecture({ components })[0] || "", /at least 3 resistor/);
  assert.deepEqual(validateArchitecture({ components: [...components, { id: "r3", type: "resistor" }] }), []);
});

test("rejects a stray motor supply that no selected driver can use", () => {
  assert.match(validateArchitecture({ components: [{ id: "amp", type: "pam8403_module" }, { id: "supply", type: "external_dc_supply" }] })[0] || "", /only be selected with a stepper driver/);
});

test("circuit building retries the next model after a provider failure", async () => {
  const architecture = ArchitectureSchema.parse({ title: "Doorbell", summary: "A button sounds a buzzer when pressed.", board: "esp32dev", components: [{ id: "button", type: "pushbutton", name: "Button", quantity: 1 }, { id: "buzzer", type: "buzzer", name: "Buzzer", quantity: 1 }], parts: ["ESP32", "Button", "Buzzer"] });
  const output = {
    connections: [
      { fromComponent: "board", fromPin: "GPIO33", toComponent: "button", toPin: "1", color: "#f59e0b", purpose: "button input" },
      { fromComponent: "board", fromPin: "GND", toComponent: "button", toPin: "2", color: "#111827", purpose: "button ground" },
      { fromComponent: "board", fromPin: "GPIO32", toComponent: "buzzer", toPin: "POS", color: "#3b82f6", purpose: "buzzer output" },
      { fromComponent: "board", fromPin: "GND", toComponent: "buzzer", toPin: "NEG", color: "#111827", purpose: "buzzer ground" },
    ],
    instructions: ["Disconnect all power.", "Connect the button and buzzer.", "Upload the firmware."],
    files: { platformioIni: "[env:esp32dev]\nplatform=espressif32\nboard=esp32dev\nframework=arduino", mainCpp: "#include <Arduino.h>\nconst int BUTTON=4, BUZZER=13;\nvoid setup(){pinMode(BUTTON,INPUT_PULLUP);pinMode(BUZZER,OUTPUT);}\nvoid loop(){digitalWrite(BUZZER,!digitalRead(BUTTON));delay(10);}" },
  };
  let calls = 0;
  const complete = async () => { calls++; if (calls === 1) throw new Error("model_not_found"); return output; };
  const start = usageSnapshot();
  const project = await buildProject("Create a doorbell.", architecture, { ...start, calls: start.calls - 1 }, [], complete as never);
  assert.equal(calls, 2);
  assert.deepEqual(checkHardware(project), []);
});

test("returns a deterministic firmware baseline when every firmware provider fails", async () => {
  const architecture = ArchitectureSchema.parse({ title: "Doorbell", summary: "A button sounds a buzzer when pressed.", board: "esp32dev", components: [{ id: "buzzer", type: "buzzer", name: "Buzzer", quantity: 1 }], parts: ["ESP32", "Buzzer"] });
  let calls = 0;
  const start = usageSnapshot();
  const project = await buildProject("Create a doorbell.", architecture, { ...start, calls: start.calls - 1 }, [], (async () => { throw new Error(["Groq 120b quota", "Groq 20b JSON"][calls++]!); }) as never);
  assert.equal(calls, 2);
  assert.match(project.files.mainCpp, /Firmware generated from Blueprint's accepted netlist/);
  assert.match(project.instructions.at(-1) || "", /firmware provider was unavailable/);
});

test("builds an Arduino circuit from an LLM netlist without topology synthesis", async () => {
  const architecture = ArchitectureSchema.parse({
    title: "Arduino doorbell",
    summary: "A pushbutton rings a buzzer on an Arduino Uno.",
    board: "arduino_uno",
    components: [
      { id: "button", type: "pushbutton", name: "Pushbutton", quantity: 1 },
      { id: "buzzer", type: "buzzer", name: "Buzzer", quantity: 1 },
    ],
    parts: ["1x Arduino Uno", "1x Pushbutton", "1x Buzzer"],
  });
  const start = usageSnapshot();
  let firmwareCalls = 0;
  const project = await buildProject(
    "Build a simple doorbell with a button and buzzer.",
    architecture,
    { ...start, calls: start.calls - 1 },
    [],
    (async () => {
      firmwareCalls++;
      return {
        files: {
          platformioIni: "[env:uno]\nplatform = atmelavr\nboard = uno\nframework = arduino\n",
          mainCpp: "#include <Arduino.h>\nconstexpr int PIN_D2 = 2;\nconstexpr int PIN_D3 = 3;\nvoid setup(){ pinMode(PIN_D2, INPUT_PULLUP); pinMode(PIN_D3, OUTPUT); }\nvoid loop(){ digitalWrite(PIN_D3, digitalRead(PIN_D2) == LOW ? HIGH : LOW); }\n",
        },
      };
    }) as never,
    Date.now() + 30_000,
    {
      connections: [
        { fromComponent: "board", fromPin: "D2", toComponent: "button", toPin: "1", color: "#3b82f6", purpose: "button sense" },
        { fromComponent: "board", fromPin: "GND", toComponent: "button", toPin: "2", color: "#111827", purpose: "button ground" },
        { fromComponent: "board", fromPin: "D3", toComponent: "buzzer", toPin: "POS", color: "#f59e0b", purpose: "buzzer drive" },
        { fromComponent: "board", fromPin: "GND", toComponent: "buzzer", toPin: "NEG", color: "#111827", purpose: "buzzer ground" },
      ],
      instructions: ["Disconnect power before wiring.", "Wire the button to D2 and GND.", "Wire the buzzer to D3 and GND."],
      explanations: [
        { componentId: "button", text: "Lets you press to request a ring." },
        { componentId: "buzzer", text: "Makes the audible doorbell sound." },
      ],
    },
  );
  assert.equal(firmwareCalls, 1);
  assert.equal(project.board, "arduino_uno");
  assert.match(project.files.platformioIni, /board\s*=\s*uno/);
  assert.match(project.files.platformioIni, /platform\s*=\s*atmelavr/);
  assert.match(project.files.mainCpp, /digitalWrite/);
  assert.equal(project.explanations?.length, 2);
  assert.deepEqual(checkHardware(project), []);
});

test("deterministic DHT22 + SSD1306 firmware reads temperature onto the display", () => {
  const plan = ProjectPlanSchema.parse({
    title: "Temp",
    summary: "Shows temperature on an OLED.",
    board: "arduino_uno",
    boardMeta: toBoardProfile(ensureBoardCard("arduino_uno")),
    components: [
      { id: "dht22", type: "dht22", name: "DHT22", quantity: 1 },
      { id: "oled", type: "ssd1306", name: "OLED", quantity: 1 },
    ],
    parts: ["Uno", "DHT22", "OLED"],
    instructions: ["Disconnect power.", "Wire.", "Upload."],
    connections: [
      { fromComponent: "board", fromPin: "5V", toComponent: "dht22", toPin: "VCC", color: "#ef4444", purpose: "power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "dht22", toPin: "GND", color: "#111827", purpose: "gnd" },
      { fromComponent: "board", fromPin: "D2", toComponent: "dht22", toPin: "DATA", color: "#3b82f6", purpose: "data" },
      { fromComponent: "board", fromPin: "5V", toComponent: "oled", toPin: "VCC", color: "#ef4444", purpose: "power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "oled", toPin: "GND", color: "#111827", purpose: "gnd" },
      { fromComponent: "board", fromPin: "A4", toComponent: "oled", toPin: "SDA", color: "#3b82f6", purpose: "I2C data" },
      { fromComponent: "board", fromPin: "A5", toComponent: "oled", toPin: "SCL", color: "#f59e0b", purpose: "I2C clock" },
    ],
  });
  const files = deterministicFirmware(plan, "Show temperature on an OLED");
  assert.match(files.mainCpp, /DHT\.h/);
  assert.match(files.mainCpp, /readTemperature/);
  assert.match(files.mainCpp, /Adafruit_SSD1306/);
  assert.match(files.platformioIni, /DHT sensor library/);
});

test("keeps camera and PCA9685 initialization in the deterministic firmware fallback", async () => {
  const architecture = ArchitectureSchema.parse({ title: "Camera arm", summary: "Captures images while moving an arm and forearm.", board: "esp32cam", components: [
    { id: "driver", type: "pca9685", name: "PCA9685", quantity: 1 },
    { id: "supply", type: "servo_power_supply", name: "Regulated 5V supply", quantity: 1 },
    { id: "arm", type: "servo", name: "Arm servo", quantity: 1 },
    { id: "forearm", type: "servo", name: "Forearm servo", quantity: 1 },
  ], parts: ["ESP32-CAM", "PCA9685", "5V supply", "2x servo"] });
  const start = usageSnapshot();
  const project = await buildProject("Build a camera arm with two servos.", architecture, { ...start, calls: start.calls - 1 }, [], (async () => { throw new Error("provider unavailable"); }) as never);
  assert.match(project.files.mainCpp, /esp_camera_init/);
  assert.match(project.files.mainCpp, /Adafruit_PWMServoDriver/);
  assert.match(project.files.mainCpp, /Wire\.begin\(13, 14\)/);
  assert.match(project.files.platformioIni, /Adafruit PWM Servo Driver Library/);
  assert.deepEqual(checkHardware(project), []);
});

test("returns working Bluetooth audio firmware when every firmware provider fails", async () => {
  const raw = { title: "Bluetooth Speaker", summary: "Receives Bluetooth audio and plays it through a speaker.", board: "esp32dev", components: [
    { id: "amp", type: "pam8403_module", name: "PAM8403", quantity: 1 },
    { id: "speaker", type: "speaker_4ohm", name: "4-ohm speaker", quantity: 1 },
  ], parts: [] };
  const architecture = ArchitectureSchema.parse(normalizeArchitecture(raw, loadComponentManifests().records));
  let calls = 0;
  const start = usageSnapshot();
  const project = await buildProject("Create a Bluetooth speaker.", architecture, { ...start, calls: start.calls - 1 }, [], (async () => { calls++; throw new Error("provider unavailable"); }) as never);
  assert.equal(calls, 2);
  assert.match(project.files.mainCpp, /BluetoothA2DPSink/);
  assert.match(project.files.mainCpp, /GPIO25.*GPIO26/);
  assert.match(project.files.platformioIni, /ESP32-A2DP/);
  assert.match(project.instructions.at(-1) || "", /Bluetooth audio firmware/);
  assert.deepEqual(checkHardware(project), []);
});

test("builds camera firmware and reassigns external signals on ESP32-CAM", async () => {
  const architecture = ArchitectureSchema.parse({ title: "Motion camera", summary: "Tracks movement and captures images with a camera.", board: "esp32cam", components: [{ id: "motion", type: "pir", name: "PIR", quantity: 1 }, { id: "pan", type: "servo", name: "Pan servo", quantity: 1 }], parts: ["ESP32-CAM", "PIR", "Servo"] });
  const output = {
    connections: [
      { fromComponent: "board", fromPin: "VIN", toComponent: "motion", toPin: "VCC", color: "#ef4444", purpose: "sensor power" }, { fromComponent: "board", fromPin: "GND", toComponent: "motion", toPin: "GND", color: "#111827", purpose: "sensor ground" }, { fromComponent: "board", fromPin: "GPIO13", toComponent: "motion", toPin: "OUT", color: "#3b82f6", purpose: "motion input" },
      { fromComponent: "board", fromPin: "VIN", toComponent: "pan", toPin: "VCC", color: "#ef4444", purpose: "servo power" }, { fromComponent: "board", fromPin: "GND", toComponent: "pan", toPin: "GND", color: "#111827", purpose: "servo ground" }, { fromComponent: "board", fromPin: "GPIO14", toComponent: "pan", toPin: "PWM", color: "#f59e0b", purpose: "pan control" },
    ],
    instructions: ["Disconnect all power.", "Connect the PIR and servo to the listed safe pins.", "Upload the firmware and test camera capture."],
    files: { platformioIni: "[env:esp32cam]\nplatform=espressif32\nboard=esp32cam\nframework=arduino\nlib_deps=madhephaestus/ESP32Servo", mainCpp: "#include <Arduino.h>\n#include <esp_camera.h>\n#include <ESP32Servo.h>\nServo pan; const int PIR=13;\nvoid setup(){camera_config_t config={}; config.pin_d0=5; config.pin_d1=18; config.pin_d2=19; config.pin_d3=21; config.pin_d4=36; config.pin_d5=39; config.pin_d6=34; config.pin_d7=35; config.pin_xclk=0; config.pin_pclk=22; config.pin_vsync=25; config.pin_href=23; config.pin_sccb_sda=26; config.pin_sccb_scl=27; config.pin_pwdn=32; config.pin_reset=-1; esp_camera_init(&config); pinMode(PIR,INPUT); pan.attach(14);}\nvoid loop(){if(digitalRead(PIR)){camera_fb_t* frame=esp_camera_fb_get(); if(frame) esp_camera_fb_return(frame);} delay(100);}" },
  };
  const start = usageSnapshot();
  let calls = 0;
  const incomplete = { ...output, files: { ...output.files, mainCpp: "#include <esp_camera.h>\n#include <ESP32Servo.h>\nvoid setup(){camera_config_t config={}; esp_camera_init(&config);}\nvoid loop(){delay(100);}" } };
  const project = await buildProject("Build a motion-tracking camera", architecture, { ...start, calls: start.calls - 1 }, [], (async () => ++calls === 1 ? incomplete : output) as never);
  assert.equal(calls, 2);
  assert.equal(project.board, "esp32cam");
  assert.deepEqual(checkHardware(project), []);
});

const plan = {
  title: "Light alarm",
  summary: "Sounds a buzzer when the room becomes dark.",
  board: "esp32dev",
  components: [
    { id: "light1", type: "photoresistor", name: "Light sensor", quantity: 1 },
    { id: "buzzer1", type: "buzzer", name: "Buzzer", quantity: 1 },
  ],
  connections: [
    { fromComponent: "board", fromPin: "3V3", toComponent: "light1", toPin: "VCC", color: "#ef4444", purpose: "power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "light1", toPin: "GND", color: "#111827", purpose: "ground" },
    { fromComponent: "board", fromPin: "GPIO34", toComponent: "light1", toPin: "AO", color: "#3b82f6", purpose: "light level" },
    { fromComponent: "board", fromPin: "GPIO27", toComponent: "buzzer1", toPin: "POS", color: "#8b5cf6", purpose: "tone output" },
    { fromComponent: "buzzer1", fromPin: "NEG", toComponent: "board", toPin: "GND", color: "#111827", purpose: "ground" },
  ],
  parts: ["ESP32 DevKit V1", "Light sensor", "Buzzer"],
  instructions: ["Disconnect power.", "Build the circuit.", "Check the wiring.", "Upload firmware."],
} as const;

test("validates any catalog component selected by the model", () => {
  const parsed = ProjectPlanSchema.parse(plan);
  assert.deepEqual(checkHardware(parsed), []);
  assert.equal(derivePins(parsed).length, 5);
});

test("rejects an unsafe pin at the circuit boundary", () => {
  const unsafe = ProjectPlanSchema.parse({ ...plan, connections: plan.connections.map((wire, index) => index === 2 ? { ...wire, fromPin: "GPIO99" } : wire) });
  assert.deepEqual(checkHardware(unsafe), ["Unsupported endpoint: board.GPIO99"]);
});

test("rejects parts mentioned in assembly but missing from the diagram", () => {
  const missing = ProjectPlanSchema.parse({ ...plan, instructions: ["Disconnect power.", "Add a 1k resistor between the buzzer and GPIO27.", "Check wiring.", "Upload firmware."] });
  assert.deepEqual(checkHardware(missing), ["Instructions require a resistor that is missing from the component diagram."]);
});

test("rejects invented component ids before wiring generation", () => {
  const architecture = { title: "Unknown hardware", summary: "A project containing an unknown electronic module.", board: "esp32dev", components: [{ id: "invented_driver", name: "Invented driver", quantity: 1 }], parts: ["ESP32", "Invented driver"] };
  assert.equal(ArchitectureSchema.safeParse(architecture).success, false);
  assert.equal(ArchitectureSchema.safeParse({ ...architecture, components: [{ id: "servo", name: "Legacy servo", quantity: 1 }] }).success, true);
});

test("validates a stepper motor through its driver and external supply", () => {
  const stepper = ProjectPlanSchema.parse({
    title: "Stepper control", summary: "Controls one bipolar stepper motor safely through an A4988 driver.", board: "esp32dev",
    components: [
      { id: "motor", type: "stepper_motor", name: "Stepper motor", quantity: 1 },
      { id: "driver", type: "a4988", name: "A4988 driver", quantity: 1 },
      { id: "supply", type: "external_dc_supply", name: "12V motor supply", quantity: 1 },
    ],
    connections: [
      { fromComponent: "board", fromPin: "3V3", toComponent: "driver", toPin: "VDD", color: "#ef4444", purpose: "driver logic power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "driver", toPin: "GND", color: "#111827", purpose: "shared ground" },
      { fromComponent: "board", fromPin: "GPIO25", toComponent: "driver", toPin: "STEP", color: "#3b82f6", purpose: "step signal" },
      { fromComponent: "board", fromPin: "GPIO26", toComponent: "driver", toPin: "DIR", color: "#8b5cf6", purpose: "direction signal" },
      { fromComponent: "supply", fromPin: "NEG", toComponent: "board", toPin: "GND", color: "#111827", purpose: "shared supply ground" },
      { fromComponent: "supply", fromPin: "POS", toComponent: "driver", toPin: "VMOT", color: "#ef4444", purpose: "motor power" },
      { fromComponent: "driver", fromPin: "1A", toComponent: "motor", toPin: "A+", color: "#f59e0b", purpose: "coil A" },
      { fromComponent: "driver", fromPin: "1B", toComponent: "motor", toPin: "A-", color: "#3b82f6", purpose: "coil A" },
      { fromComponent: "driver", fromPin: "2A", toComponent: "motor", toPin: "B+", color: "#8b5cf6", purpose: "coil B" },
      { fromComponent: "driver", fromPin: "2B", toComponent: "motor", toPin: "B-", color: "#14b8a6", purpose: "coil B" },
    ],
    parts: ["ESP32 DevKit V1", "Stepper motor", "A4988 driver", "12V motor supply"],
    instructions: ["Disconnect power.", "Connect the driver logic and motor coils.", "Connect the external supply with a shared ground.", "Upload firmware."],
  });
  assert.deepEqual(checkHardware(stepper), []);
  assert.deepEqual(validateArchitecture({ components: [{ id: "motor", type: "stepper_motor" }] }), ["Each stepper motor requires exactly one A4988 driver component."]);
});

test("distributes busy schematic wires into distinct routing lanes", () => {
  const lanes = Array.from({ length: 12 }, (_, index) => wireLane(index, 12, 300, 800));
  assert.equal(new Set(lanes).size, 12);
  assert.ok(lanes.every((lane) => lane > 300 && lane < 800));
});

test("reserves extra schematic space for large stepper motor drawings", () => {
  const layout = schematicLayout([{ id: "sensor" }, { id: "motor", type: "stepper_motor" }, { id: "supply" }]);
  assert.deepEqual(layout.tops, [28, 178, 478]);
  assert.equal(layout.height, 648);
});

test("accounts for every visual shipped by Wokwi Elements", () => {
  const declarations = readFileSync("node_modules/@wokwi/elements/dist/esm/react-types.d.ts", "utf8");
  const installed = [...declarations.matchAll(/'(wokwi-[^']+)'/g)].map((match) => match[1]);
  const supported = new Set(Object.values(COMPONENTS).flatMap((component) => component.tag ? [component.tag] : []));
  const uncovered = [...new Set(installed)].filter((tag) => !supported.has(tag) && !(tag in WOKWI_ELEMENT_EXCLUSIONS));
  assert.deepEqual(uncovered, []);
});
