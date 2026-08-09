import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureBoardCard, toBoardProfile } from "./boards.ts";
import { runSafetyGate } from "./safety-gate.ts";
import type { ProjectPlan } from "./project.ts";

function plan(overrides: Partial<ProjectPlan> = {}): ProjectPlan {
  const board = overrides.board || "arduino_uno";
  return {
    title: "Test doorbell",
    summary: "A button rings a buzzer on an Arduino.",
    components: [
      { id: "button", type: "pushbutton", name: "Pushbutton", quantity: 1 },
      { id: "buzzer", type: "buzzer", name: "Buzzer", quantity: 1 },
    ],
    connections: [
      { fromComponent: "board", fromPin: "D2", toComponent: "button", toPin: "1", color: "#3b82f6", purpose: "button sense" },
      { fromComponent: "board", fromPin: "GND", toComponent: "button", toPin: "2", color: "#111827", purpose: "button ground" },
      { fromComponent: "board", fromPin: "D3", toComponent: "buzzer", toPin: "POS", color: "#f59e0b", purpose: "buzzer drive" },
      { fromComponent: "board", fromPin: "GND", toComponent: "buzzer", toPin: "NEG", color: "#111827", purpose: "buzzer ground" },
    ],
    parts: ["1x Arduino Uno", "1x Pushbutton", "1x Buzzer"],
    instructions: ["Disconnect power before wiring.", "Wire the button to D2.", "Wire the buzzer to D3."],
    ...overrides,
    board,
    boardMeta: overrides.boardMeta || toBoardProfile(ensureBoardCard(board)),
  };
}

test("safety gate accepts a simple Arduino doorbell netlist", () => {
  assert.deepEqual(runSafetyGate(plan()), []);
});

test("safety gate rejects unknown board pins", () => {
  const errors = runSafetyGate(plan({
    connections: [
      { fromComponent: "board", fromPin: "GPIO99", toComponent: "buzzer", toPin: "POS", color: "#f59e0b", purpose: "drive" },
      { fromComponent: "board", fromPin: "GND", toComponent: "buzzer", toPin: "NEG", color: "#111827", purpose: "ground" },
    ],
  }));
  assert.ok(errors.some((error) => /Unknown board pin/.test(error)));
});

test("safety gate rejects VCC-GND board shorts", () => {
  const errors = runSafetyGate(plan({
    connections: [
      { fromComponent: "board", fromPin: "5V", toComponent: "board", toPin: "GND", color: "#ef4444", purpose: "oops" },
      { fromComponent: "board", fromPin: "GND", toComponent: "buzzer", toPin: "NEG", color: "#111827", purpose: "ground" },
    ],
  }));
  assert.ok(errors.some((error) => /Power rail short/.test(error)));
});

test("safety gate requires a series resistor for LEDs", () => {
  const errors = runSafetyGate(plan({
    components: [{ id: "led1", type: "led", name: "LED", quantity: 1 }],
    connections: [
      { fromComponent: "board", fromPin: "D4", toComponent: "led1", toPin: "A", color: "#ef4444", purpose: "led" },
      { fromComponent: "board", fromPin: "GND", toComponent: "led1", toPin: "C", color: "#111827", purpose: "ground" },
    ],
  }));
  assert.ok(errors.some((error) => /series resistor/.test(error)));
});

test("safety gate blocks HC-SR04 ECHO into a 3.3V MCU pin", () => {
  const errors = runSafetyGate(plan({
    board: "esp32dev",
    components: [
      { id: "sonar", type: "hc_sr04", name: "HC-SR04", quantity: 1 },
      { id: "r1", type: "resistor", name: "R1", quantity: 1 },
      { id: "r2", type: "resistor", name: "R2", quantity: 1 },
    ],
    connections: [
      { fromComponent: "board", fromPin: "VIN", toComponent: "sonar", toPin: "VCC", color: "#ef4444", purpose: "power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "sonar", toPin: "GND", color: "#111827", purpose: "ground" },
      { fromComponent: "board", fromPin: "GPIO4", toComponent: "sonar", toPin: "TRIG", color: "#3b82f6", purpose: "trig" },
      { fromComponent: "board", fromPin: "GPIO13", toComponent: "sonar", toPin: "ECHO", color: "#3b82f6", purpose: "echo" },
    ],
  }));
  assert.ok(errors.some((error) => /ECHO/.test(error)));
});

test("safety gate blocks stepper coils on MCU pins", () => {
  const errors = runSafetyGate(plan({
    board: "esp32dev",
    components: [{ id: "motor", type: "stepper_motor", name: "Stepper", quantity: 1 }],
    connections: [
      { fromComponent: "board", fromPin: "GPIO4", toComponent: "motor", toPin: "A+", color: "#3b82f6", purpose: "coil" },
      { fromComponent: "board", fromPin: "GND", toComponent: "motor", toPin: "A-", color: "#111827", purpose: "coil return" },
    ],
  }));
  assert.ok(errors.some((error) => /driver|stepper/i.test(error)));
});
