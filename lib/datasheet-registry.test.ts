import assert from "node:assert/strict";
import test from "node:test";
import { manifestFromExtraction, readDatasheet, suggestValidatedAlternatives } from "./datasheet-registry.ts";

const i2cModule = {
  name: "Example I2C temperature module",
  aliases: ["EX123"],
  category: "sensor",
  capabilities: ["temperature_sensing"],
  interface: "i2c" as const,
  pins: ["VCC", "GND", "SDA", "SCL"],
  supplyVoltageMin: 2.7,
  supplyVoltageMax: 3.6,
  moduleReady: true,
  description: "A low-voltage temperature breakout module using an I2C interface.",
  firmware: "Example/EX123",
  requirements: ["Use the documented I2C address"],
  evidence: ["The operating supply range is 2.7V to 3.6V", "The terminal table lists VCC, GND, SDA and SCL"],
};

test("turns a supported module datasheet extraction into a validated reusable manifest", () => {
  const record = manifestFromExtraction("EX123", "https://example.com/ex123.pdf", i2cModule);
  assert.equal(record.id, "ex123");
  assert.equal(record.baseType, "generic_i2c_module");
  assert.equal(record.supportLevel, "datasheet-derived");
  assert.deepEqual(record.pins, ["VCC", "GND", "SDA", "SCL"]);
  assert.deepEqual(record.boardPins?.VCC, ["3V3"]);
  assert.match(record.requirements?.join(" ") || "", /Datasheet evidence/);
});

test("normalizes harmless model formatting at the manifest boundary", () => {
  const record = manifestFromExtraction("EX123", "https://example.com/ex123", {
    ...i2cModule,
    capabilities: ["Temperature sensing"],
    interface: "IÂ²C",
    requirements: null,
  });
  assert.equal(record.baseType, "generic_i2c_module");
  assert.deepEqual(record.capabilities, ["temperature_sensing"]);
});

test("chooses a deterministic supported interface when a module offers several", () => {
  const record = manifestFromExtraction("EX123", "https://example.com/ex123", {
    ...i2cModule,
    interface: ["i2c", "spi"],
    capabilities: ["temperature", "humidity"],
  });
  assert.equal(record.baseType, "generic_i2c_module");
  assert.deepEqual(record.capabilities, ["temperature_sensing", "humidity_sensing"]);
});

test("does not promote raw chips or unsupported electrical topologies", () => {
  assert.throws(() => manifestFromExtraction("RAW123", "https://example.com/raw.pdf", { ...i2cModule, interface: "other", moduleReady: false }), /raw or unsupported part/);
});

test("blocks private datasheet addresses before making a request", async () => {
  await assert.rejects(() => readDatasheet("https://127.0.0.1/private.pdf"), /private or unsafe/);
});

test("returns useful validated alternatives for unsupported requests", () => {
  const alternatives = suggestValidatedAlternatives("unknown ultrasonic distance sensor");
  assert.ok(alternatives.some((record) => record.id === "hc_sr04"));
});
