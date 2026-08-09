import assert from "node:assert/strict";
import test from "node:test";
import { toBoardProfile } from "./board-types.ts";
import { ensureBoardCard } from "./boards.ts";
import { deterministicFirmware, normalizeFirmwareDependencies, normalizeFirmwareSource } from "./build-project.ts";
import { ProjectPlanSchema } from "./project.ts";

function plan(board: string, components: Array<{ id: string; type: string; name: string }>, connections: Array<{ fromComponent: string; fromPin: string; toComponent: string; toPin: string; purpose: string }>) {
  const card = ensureBoardCard(board);
  return ProjectPlanSchema.parse({
    title: "Test circuit",
    summary: "Firmware unit fixture for netlist-driven sketches.",
    board: card.id,
    boardMeta: toBoardProfile(card),
    components: components.map((component) => ({ ...component, quantity: 1 })),
    connections: connections.map((wire) => ({ ...wire, color: "#3b82f6" })),
    parts: [`1x ${card.name}`, "parts"],
    instructions: ["Wire the circuit.", "Upload the sketch.", "Test the behavior."],
  });
}

test("normalizes the BME680 library to its PlatformIO registry identity", () => {
  const ini = "[env:esp32dev]\nlib_deps = Adafruit BME680\n";
  assert.match(normalizeFirmwareDependencies(ini), /adafruit\/Adafruit BME680 Library/);
});

test("normalizes hallucinated BME680 calls to the installed Adafruit API", () => {
  const source = "bme.setGasOversampling(BME680_OS_2X);\nbme.setFilterSize(BME680_FILTER_SIZE_3);";
  const normalized = normalizeFirmwareSource(source);
  assert.match(normalized, /setGasHeater\(320, 150\)/);
  assert.match(normalized, /setIIRFilterSize\(BME680_FILTER_SIZE_3\)/);
});

test("Arduino doorbell baseline uses Uno platform and drives buzzer from button", () => {
  const files = deterministicFirmware(plan("arduino_uno", [
    { id: "btn1", type: "pushbutton", name: "Pushbutton" },
    { id: "buz1", type: "buzzer", name: "Buzzer" },
  ], [
    { fromComponent: "board", fromPin: "GND", toComponent: "btn1", toPin: "1", purpose: "ground" },
    { fromComponent: "board", fromPin: "D2", toComponent: "btn1", toPin: "2", purpose: "button input" },
    { fromComponent: "board", fromPin: "D3", toComponent: "buz1", toPin: "POS", purpose: "buzzer drive" },
    { fromComponent: "board", fromPin: "GND", toComponent: "buz1", toPin: "NEG", purpose: "ground" },
  ]), "hands-free doorbell");

  assert.match(files.platformioIni, /platform\s*=\s*atmelavr/);
  assert.match(files.platformioIni, /board\s*=\s*uno/);
  assert.match(files.mainCpp, /constexpr int PIN_D2 = 2/);
  assert.match(files.mainCpp, /constexpr int PIN_D3 = 3/);
  assert.match(files.mainCpp, /pinMode\(PIN_D2, INPUT_PULLUP\)/);
  assert.match(files.mainCpp, /pinMode\(PIN_D3, OUTPUT\)/);
  assert.match(files.mainCpp, /digitalRead\(PIN_D2\) == LOW/);
  assert.match(files.mainCpp, /digitalWrite\(PIN_D3,/);
});

test("ESP32 LED baseline uses espressif32 and GPIO literals", () => {
  const files = deterministicFirmware(plan("esp32dev", [
    { id: "btn1", type: "pushbutton", name: "Pushbutton" },
    { id: "led1", type: "led", name: "LED" },
  ], [
    { fromComponent: "board", fromPin: "GND", toComponent: "btn1", toPin: "1", purpose: "ground" },
    { fromComponent: "board", fromPin: "GPIO4", toComponent: "btn1", toPin: "2", purpose: "button input" },
    { fromComponent: "board", fromPin: "GPIO5", toComponent: "led1", toPin: "A", purpose: "led drive" },
    { fromComponent: "board", fromPin: "GND", toComponent: "led1", toPin: "C", purpose: "ground" },
  ]), "button LED");

  assert.match(files.platformioIni, /platform\s*=\s*espressif32/);
  assert.match(files.mainCpp, /constexpr int PIN_GPIO4 = 4/);
  assert.match(files.mainCpp, /constexpr int PIN_GPIO5 = 5/);
  assert.match(files.mainCpp, /digitalWrite\(PIN_GPIO5,/);
});

test("Pico baseline uses raspberrypi platform and GP pin literals", () => {
  const files = deterministicFirmware(plan("pico", [
    { id: "btn1", type: "pushbutton", name: "Pushbutton" },
    { id: "led1", type: "led", name: "LED" },
  ], [
    { fromComponent: "board", fromPin: "GND", toComponent: "btn1", toPin: "1", purpose: "ground" },
    { fromComponent: "board", fromPin: "GP15", toComponent: "btn1", toPin: "2", purpose: "button input" },
    { fromComponent: "board", fromPin: "GP16", toComponent: "led1", toPin: "A", purpose: "led drive" },
    { fromComponent: "board", fromPin: "GND", toComponent: "led1", toPin: "C", purpose: "ground" },
  ]), "pico button led");

  assert.match(files.platformioIni, /platform\s*=\s*raspberrypi/);
  assert.match(files.mainCpp, /constexpr int PIN_GP15 = 15/);
  assert.match(files.mainCpp, /constexpr int PIN_GP16 = 16/);
});
