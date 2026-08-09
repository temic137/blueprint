import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArchitecture } from "./build-project.ts";
import { loadComponentManifests } from "./component-manifests.ts";
import { ArchitectureSchema, ProjectPlanSchema, validateHardware } from "./project.ts";
import { ensureBoardCard, toBoardProfile } from "./boards.ts";
import { synthesizeCircuit } from "./synthesize-circuit.ts";

function checkHardware(plan: Parameters<typeof validateHardware>[0]) {
  return validateHardware({
    ...plan,
    boardMeta: plan.boardMeta || toBoardProfile(ensureBoardCard(plan.board)),
  });
}

function plan(raw: unknown) {
  const architecture = ArchitectureSchema.parse(normalizeArchitecture(raw, loadComponentManifests().records));
  return ProjectPlanSchema.parse({ ...architecture, ...synthesizeCircuit(architecture) });
}

test("synthesizes the same valid doorbell netlist every time", () => {
  const raw = { title: "Doorbell", summary: "Sounds a buzzer whenever its button is pressed.", board: "esp32dev", components: [
    { id: "button", type: "pushbutton", name: "Pushbutton", quantity: 1 },
    { id: "buzzer", type: "buzzer", name: "Piezo buzzer", quantity: 1 },
  ], parts: [] };
  const first = plan(raw);
  const second = plan(raw);
  assert.deepEqual(first.connections, second.connections);
  assert.deepEqual(checkHardware(first), []);
  assert.deepEqual(first.connections.map((wire) => `${wire.fromComponent}.${wire.fromPin}->${wire.toComponent}.${wire.toPin}`), [
    "board.GPIO4->button.1", "button.2->board.GND", "board.GPIO13->buzzer.POS", "board.GND->buzzer.NEG",
  ]);
});

test("synthesizes Arduino Uno DHT22 + SSD1306 without LLM wiring", () => {
  const result = plan({
    title: "Temp display",
    summary: "Shows ambient temperature on an OLED.",
    board: "arduino_uno",
    components: [
      { id: "dht22", type: "dht22", name: "DHT22", quantity: 1 },
      { id: "oled", type: "ssd1306", name: "SSD1306", quantity: 1 },
    ],
    parts: [],
  });
  assert.deepEqual(checkHardware(result), []);
  assert.ok(result.connections.some((wire) => wire.toComponent === "dht22" && wire.toPin === "VCC" && ["3V3", "5V", "VIN"].includes(wire.fromPin)));
  assert.ok(result.connections.some((wire) => wire.toComponent === "dht22" && wire.toPin === "DATA" && wire.fromPin.startsWith("D")));
  assert.ok(result.connections.some((wire) => wire.toComponent === "oled" && wire.toPin === "SDA"));
  assert.ok(result.connections.some((wire) => wire.toComponent === "oled" && wire.toPin === "SCL"));
  assert.equal(result.connections.some((wire) => wire.toPin === "VCC" && /^D\d+$/.test(wire.fromPin)), false);
});

test("synthesizes Arduino Uno DHT22 + LCD1602 control bus", () => {
  const result = plan({
    title: "Temp LCD",
    summary: "Shows ambient temperature on a character LCD.",
    board: "arduino_uno",
    components: [
      { id: "dht22", type: "dht22", name: "DHT22", quantity: 1 },
      { id: "lcd", type: "lcd1602", name: "LCD1602", quantity: 1 },
    ],
    parts: [],
  });
  assert.deepEqual(checkHardware(result), []);
  assert.ok(result.connections.some((wire) => wire.toComponent === "lcd" && wire.toPin === "RS"));
  assert.ok(result.connections.some((wire) => wire.toComponent === "lcd" && wire.toPin === "D4"));
});

test("synthesizes the HC-SR04 divider instead of connecting ECHO directly", () => {
  const result = plan({ title: "Range alarm", summary: "Measures distance with an ultrasonic sensor safely.", board: "esp32dev", components: [
    { id: "range", type: "hc_sr04", name: "HC-SR04", quantity: 1 },
    { id: "upper", type: "resistor", name: "1k resistor", quantity: 1 },
    { id: "lower", type: "resistor", name: "2k resistor", quantity: 1 },
  ], parts: [] });
  assert.deepEqual(checkHardware(result), []);
  assert.equal(result.connections.some((wire) => (wire.fromComponent === "range" && wire.fromPin === "ECHO" && wire.toComponent === "board") || (wire.toComponent === "range" && wire.toPin === "ECHO" && wire.fromComponent === "board")), false);
});

test("synthesizes bridge audio through connectors without grounding speakers", () => {
  const result = plan({ title: "Bluetooth speaker", summary: "Receives Bluetooth audio and drives two passive speakers.", board: "esp32dev", components: [
    { id: "amp", type: "pam8403_module", name: "PAM8403", quantity: 1 },
    { id: "left", type: "speaker_4ohm", name: "Speaker", quantity: 1 },
    { id: "right", type: "speaker_4ohm", name: "Speaker", quantity: 1 },
    { id: "left_connector", type: "jst_xh_2pin", name: "JST-XH", quantity: 1 },
    { id: "right_connector", type: "jst_xh_2pin", name: "JST-XH", quantity: 1 },
  ], parts: [] });
  assert.deepEqual(checkHardware(result), []);
  assert.equal(result.connections.length, 12);
  assert.equal(result.connections.some((wire) => [wire.fromComponent, wire.toComponent].includes("left") && [wire.fromPin, wire.toPin].includes("GND")), false);
  assert.ok(result.connections.some((wire) => wire.fromComponent === "board" && wire.fromPin === "GPIO25" && wire.toComponent === "amp" && wire.toPin === "LIN"));
});

test("synthesizes shared I2C, sensor, servo, and storage interfaces without GPIO conflicts", () => {
  const result = plan({ title: "Robot logger", summary: "Reads motion and temperature, moves a servo, displays and stores readings.", board: "esp32dev", components: [
    { id: "temperature", type: "dht22", name: "DHT22", quantity: 1 },
    { id: "motion", type: "pir", name: "PIR", quantity: 1 },
    { id: "display", type: "ssd1306", name: "OLED", quantity: 1 },
    { id: "imu", type: "mpu6050", name: "MPU6050", quantity: 1 },
    { id: "servo", type: "servo", name: "SG90", quantity: 1 },
    { id: "storage", type: "microsd", name: "microSD", quantity: 1 },
  ], parts: [] });
  assert.deepEqual(checkHardware(result), []);
  const i2cPins = result.connections.filter((wire) => /I2C/i.test(wire.purpose)).map((wire) => wire.fromPin);
  assert.deepEqual([...new Set(i2cPins)].sort(), ["GPIO21", "GPIO22"]);
});

test("expands a camera project to multiple servos through a PCA9685 and regulated supply", () => {
  const result = plan({ title: "Camera arm", summary: "Captures images while controlling an arm and forearm servo.", board: "esp32cam", components: [
    { id: "driver", type: "pca9685", name: "PCA9685 servo driver", quantity: 1 },
    { id: "supply", type: "servo_power_supply", name: "Regulated 5V servo supply", quantity: 1 },
    { id: "arm", type: "servo", name: "Arm servo", quantity: 1 },
    { id: "forearm", type: "servo", name: "Forearm servo", quantity: 1 },
  ], parts: [] });
  assert.deepEqual(checkHardware(result), []);
  assert.ok(result.connections.some((wire) => wire.fromComponent === "board" && wire.fromPin === "GPIO13" && wire.toComponent === "driver" && wire.toPin === "SDA"));
  assert.ok(result.connections.some((wire) => wire.fromComponent === "board" && wire.fromPin === "GPIO14" && wire.toComponent === "driver" && wire.toPin === "SCL"));
  assert.ok(result.connections.some((wire) => wire.fromComponent === "driver" && wire.fromPin === "CH0" && wire.toComponent === "arm" && wire.toPin === "PWM"));
  assert.ok(result.connections.some((wire) => wire.fromComponent === "driver" && wire.fromPin === "CH1" && wire.toComponent === "forearm" && wire.toPin === "PWM"));
  assert.equal(result.connections.some((wire) => [wire.fromComponent, wire.toComponent].includes("supply") && [wire.fromComponent, wire.toComponent].includes("board") && ![wire.fromPin, wire.toPin].includes("GND")), false);
});

test("synthesizes stepper power, driver logic, and all four motor coils", () => {
  const result = plan({ title: "Positioning motor", summary: "Moves a bipolar stepper motor to controlled positions.", board: "esp32dev", components: [
    { id: "motor", type: "stepper_motor", name: "Stepper motor", quantity: 1 },
    { id: "driver", type: "a4988", name: "A4988", quantity: 1 },
    { id: "supply", type: "external_dc_supply", name: "12V supply", quantity: 1 },
  ], parts: [] });
  assert.deepEqual(checkHardware(result), []);
  assert.equal(result.connections.filter((wire) => wire.fromComponent === "driver" && wire.toComponent === "motor").length, 4);
});

test("fails deterministically when the selected board has insufficient compatible pins", () => {
  const architecture = ArchitectureSchema.parse(normalizeArchitecture({ title: "Too many controls", summary: "Uses more controls than the selected camera board exposes.", board: "esp32cam", components: [
    { id: "one", type: "pushbutton", name: "Button one", quantity: 1 },
    { id: "two", type: "pushbutton", name: "Button two", quantity: 1 },
    { id: "three", type: "pushbutton", name: "Button three", quantity: 1 },
  ], parts: [] }));
  assert.throws(() => synthesizeCircuit(architecture), /no free terminal.*exceeds the board's I\/O capacity/i);
});
