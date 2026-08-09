import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeArchitecture } from "./build-project.ts";
import { ensureBoardCard, listBoardCards, toBoardProfile } from "./boards.ts";
import { loadComponentManifests, registryCatalogForPrompt } from "./component-manifests.ts";
import { discoverLibraryComponents } from "./library-components.ts";
import { ArchitectureSchema, COMPONENTS, componentRegistry, searchComponentRegistry, unsupportedRequestedParts, validateHardware, validateIntentCoverage } from "./project.ts";

function boardIdentities() {
  return listBoardCards().flatMap((card) => [card.id, card.name, card.platformio, ...card.aliases]);
}

test("loads a datasheet manifest and finds it through ordinary aliases", () => {
  const { records, errors } = loadComponentManifests();
  assert.deepEqual(errors, []);
  const match = searchComponentRegistry("laser ToF range sensor", records, 3);
  assert.equal(match[0]?.id, "vl53l0x");
  assert.equal(match[0]?.baseType, "generic_i2c_module");
  assert.equal(match.some((record) => record.id === "potentiometer"), false);
  assert.ok(componentRegistry(records).length > records.length);
});

test("resolves an exact registry part to trusted electrical metadata", () => {
  const records = loadComponentManifests().records;
  const raw = {
    title: "Laser range alarm",
    summary: "Measures distance with a time-of-flight sensor.",
    board: "esp32dev",
    components: [{ id: "range", type: "vl53l0x", name: "ToF sensor", quantity: 1, registry: { id: "forged" } }],
    parts: ["ESP32", "VL53L0X"],
  };
  const parsed = ArchitectureSchema.parse(normalizeArchitecture(raw, records));
  assert.equal(parsed.components[0]?.type, "generic_i2c_module");
  assert.equal(parsed.components[0]?.name, "VL53L0X time-of-flight distance sensor");
  assert.equal(parsed.components[0]?.registry?.id, "vl53l0x");
  assert.equal(parsed.components[0]?.registry?.supportLevel, "datasheet-derived");
  assert.deepEqual(validateIntentCoverage("Measure distance with a ToF sensor", parsed), []);
});

test("normalizes verbose model types and removes a duplicated controller component", () => {
  const records = registryCatalogForPrompt("Bluetooth speaker", 60, true).records;
  const normalized = normalizeArchitecture({
    title: "Bluetooth speaker", summary: "Receives Bluetooth audio and plays it through a passive speaker.", board: "esp32dev",
    components: [
      { id: "controller", type: "microcontroller", name: "ESP32 DevKit V1", quantity: 1 },
      { id: "amplifier", type: "PAM8403 amplifier module", name: "Stereo amplifier", quantity: 1 },
      { id: "speaker", type: "passive loudspeaker component", name: "4 ohm speaker", quantity: 1 },
    ], parts: [],
  }, records);
  assert.equal((normalized as { components: unknown[] }).components.length, 2, JSON.stringify(normalized));
  assert.deepEqual((normalized as { components: Array<{ type?: string; registry?: { id: string } }> }).components.map((component) => [component.type, component.registry?.id]), [[undefined, "pam8403_module"], [undefined, "speaker_4ohm"]], JSON.stringify(normalized));
  const parsed = ArchitectureSchema.parse(normalized);
  assert.equal(parsed.components.length, 2);
  assert.deepEqual(parsed.components.map((component) => component.registry?.id), ["pam8403_module", "speaker_4ohm"]);
});

test("normalizes wrapped and keyed component-plan JSON", () => {
  const records = registryCatalogForPrompt("doorbell", 60, true).records;
  const parsed = ArchitectureSchema.parse(normalizeArchitecture({ project: {
    title: "Simple doorbell", summary: "Sounds a buzzer when its button is pressed.", board: "esp32dev",
    components: {
      input: { id: "door button", type: "pushbutton", name: "Button" },
      output: { id: "door buzzer", type: "buzzer", name: "Buzzer" },
    },
  } }, records));
  assert.deepEqual(parsed.components.map((component) => [component.id, component.type, component.quantity]), [["door_button", "pushbutton", 1], ["door_buzzer", "buzzer", 1]]);
  assert.deepEqual(parsed.parts, ["1x ESP32 DevKit V1", "1x pushbutton", "1x piezo buzzer"]);
});

test("validates exact manifest components without adding TypeScript component cases", () => {
  const records = loadComponentManifests().records;
  const architecture = ArchitectureSchema.parse(normalizeArchitecture({
    title: "Stereo output", summary: "Drives a passive speaker through a stereo amplifier.", board: "esp32dev",
    components: [
      { id: "amp", type: "pam8403_module", name: "PAM8403", quantity: 1 },
      { id: "left", type: "speaker_4ohm", name: "Speaker", quantity: 1 },
    ], parts: [],
  }, records));
  assert.equal(architecture.components[0]?.type, undefined);
  assert.deepEqual(architecture.components[0]?.registry?.pins, ["VCC", "GND", "LIN", "RIN", "LOUT+", "LOUT-", "ROUT+", "ROUT-"]);
  const project = { ...architecture, instructions: ["Disconnect power.", "Wire the amplifier.", "Upload firmware."], connections: [
    { fromComponent: "board", fromPin: "VIN", toComponent: "amp", toPin: "VCC", color: "#ef4444", purpose: "amplifier power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "amp", toPin: "GND", color: "#111827", purpose: "shared ground" },
    { fromComponent: "board", fromPin: "GPIO25", toComponent: "amp", toPin: "LIN", color: "#3b82f6", purpose: "left audio" },
    { fromComponent: "board", fromPin: "GPIO26", toComponent: "amp", toPin: "RIN", color: "#8b5cf6", purpose: "right audio" },
    { fromComponent: "amp", fromPin: "LOUT+", toComponent: "left", toPin: "POS", color: "#f59e0b", purpose: "speaker positive" },
    { fromComponent: "amp", fromPin: "LOUT-", toComponent: "left", toPin: "NEG", color: "#14b8a6", purpose: "speaker negative" },
  ] };
  assert.deepEqual(validateHardware(project), []);
  const unsafe = { ...project, connections: [...project.connections, { fromComponent: "board", fromPin: "GPIO4", toComponent: "left", toPin: "POS", color: "#3b82f6", purpose: "unsafe direct drive" }] };
  assert.match(validateHardware(unsafe).join(" "), /left\.POS must connect to .*not GPIO4/);
});

test("generic I2C family is validated with its exact four-pin contract", () => {
  const project = {
    title: "Range sensor",
    summary: "Reads distance over I2C from a sensor breakout.",
    board: "esp32dev" as const,
    boardMeta: toBoardProfile(ensureBoardCard("esp32dev")),
    components: [{ id: "range", type: "generic_i2c_module", name: "VL53L0X", quantity: 1 }],
    parts: ["ESP32", "VL53L0X"],
    instructions: ["Disconnect power.", "Wire the module.", "Verify the wiring."],
    connections: [
      { fromComponent: "board", fromPin: "3V3", toComponent: "range", toPin: "VCC", color: "#ef4444", purpose: "power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "range", toPin: "GND", color: "#111827", purpose: "ground" },
      { fromComponent: "board", fromPin: "GPIO21", toComponent: "range", toPin: "SDA", color: "#3b82f6", purpose: "I2C data" },
      { fromComponent: "board", fromPin: "GPIO22", toComponent: "range", toPin: "SCL", color: "#f59e0b", purpose: "I2C clock" },
    ],
  };
  assert.deepEqual(validateHardware(project), []);
});

test("manifest loader rejects malformed, duplicate, and unsafe family records", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "blueprint-registry-"));
  try {
    writeFileSync(path.join(directory, "broken.json"), "{not json");
    writeFileSync(path.join(directory, "unsafe.json"), JSON.stringify({ id: "unsafe", name: "Unsafe part", aliases: [], category: "sensor", capabilities: ["sensing"], supportLevel: "datasheet-derived", source: "test source", baseType: "invented_pinout", description: "Must not load" }));
    writeFileSync(path.join(directory, "duplicate.json"), JSON.stringify({ id: "dht22", name: "Duplicate DHT", aliases: [], category: "sensor", capabilities: ["temperature_sensing"], supportLevel: "datasheet-derived", source: "test source", baseType: "generic_digital_sensor", description: "Must not shadow a built-in record" }));
    const result = loadComponentManifests(directory);
    assert.equal(result.records.length, 0);
    assert.equal(result.errors.length, 3);
    assert.match(result.errors.join(" "), /invalid|baseType|duplicate/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retrieved prompt is bounded and communicates the safe base family", () => {
  const result = registryCatalogForPrompt("VL53L0X laser distance", 5);
  assert.match(result.text, /vl53l0x:.*use component type generic_i2c_module/i);
  assert.ok(result.summary.length < result.text.length);
  assert.doesNotMatch(result.summary, /pins VCC/i);
  assert.ok(result.records.length <= 5);
});

test("rejects unknown explicit part numbers before spending builder calls", () => {
  const records = registryCatalogForPrompt("audio", 60, true).records;
  assert.deepEqual(unsupportedRequestedParts("Use a PAM8403 with JST-XH connectors and an ESP32", records, boardIdentities()), []);
  assert.deepEqual(unsupportedRequestedParts("Use an XYZ9876 amplifier", records, boardIdentities()), ["XYZ9876"]);
});

test("requires both an amplifier and loudspeaker for an audio project", () => {
  const records = loadComponentManifests().records;
  const architecture = ArchitectureSchema.parse(normalizeArchitecture({ title: "Bluetooth speaker", summary: "Receives Bluetooth audio and plays it through a speaker.", board: "esp32dev", components: [
    { id: "amp", type: "pam8403_module", name: "PAM8403", quantity: 1 },
  ], parts: [] }, records));
  assert.deepEqual(validateIntentCoverage("Create a Bluetooth speaker", architecture), ["The requested loudspeaker capability is missing from the architecture."]);
});

test("internal planning retrieval includes unnamed Wokwi components", () => {
  const result = registryCatalogForPrompt("Create a simple doorbell", 60, true);
  const ids = new Set(result.records.map((record) => record.id));
  assert.ok(ids.has("buzzer"));
  assert.ok(ids.has("pushbutton"));
  assert.ok(ids.has("pir"));
  assert.ok(ids.has("hc_sr04"));
  for (const [id, component] of Object.entries(COMPONENTS)) if (component.tag) assert.ok(ids.has(id), `Missing internally retrieved Wokwi component ${id}`);
  assert.equal(result.records.some((record) => record.supportLevel === "visual-only"), false);
});

test("discovers installed component libraries without treating symbols as pinouts", () => {
  const result = discoverLibraryComponents();
  assert.deepEqual(result.errors, []);
  assert.ok(result.sources.wokwi > 0);
  assert.ok(result.sources.schematicSymbols > 50);
  assert.equal(result.records.find((record) => record.id === "symbol_laser_diode")?.supportLevel, "visual-only");
  assert.equal(result.records.find((record) => record.id === "wokwi_arduino_uno")?.source, "@wokwi/elements");
});

test("maps a newly discovered Wokwi I2C module to the safe generic family", () => {
  const root = mkdtempSync(path.join(tmpdir(), "blueprint-libraries-"));
  try {
    const wokwi = path.join(root, "@wokwi", "elements", "dist", "esm");
    const symbols = path.join(root, "schematic-symbols", "dist");
    mkdirSync(wokwi, { recursive: true });
    mkdirSync(symbols, { recursive: true });
    writeFileSync(path.join(wokwi, "new-range-element.js"), "class NewRange { pinInfo = [{name: 'VCC'}, {name: 'GND'}, {name: 'SDA'}, {name: 'SCL'}]; }");
    writeFileSync(path.join(symbols, "index.d.ts"), "declare const _default: {\n    resistor_right: unknown;\n};");
    const record = discoverLibraryComponents(root).records.find((item) => item.id === "wokwi_new_range");
    assert.equal(record?.baseType, "generic_i2c_module");
    assert.equal(record?.supportLevel, "generic-family");
    assert.deepEqual(record?.pins, ["VCC", "GND", "SDA", "SCL"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
