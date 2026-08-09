import assert from "node:assert/strict";
import test from "node:test";
import { boardResourceSummary, ChangePlanSchema, connectionsToPreserve, isImplementationClarification, normalizeChangePlan, previewProjectChange, projectImpact, type ChangePlan } from "./change-project.ts";
import type { ProjectSpec } from "./project.ts";

const before = {
  title: "Knob control", summary: "A knob controls a connected output device.", board: "esp32dev",
  components: [{ id: "control", type: "potentiometer", name: "Potentiometer", quantity: 1 }],
  connections: [
    { fromComponent: "board", fromPin: "3V3", toComponent: "control", toPin: "VCC", color: "#ef4444", purpose: "power" },
    { fromComponent: "board", fromPin: "GND", toComponent: "control", toPin: "GND", color: "#111827", purpose: "ground" },
  ],
  parts: ["ESP32", "Potentiometer"], instructions: ["Disconnect power.", "Connect parts.", "Upload firmware."],
  pins: [], files: { platformioIni: "[env:esp32dev]\nplatform=espressif32\nboard=esp32dev\nframework=arduino", mainCpp: "void setup() { Serial.begin(115200); }\nvoid loop() { delay(100); /* original firmware behavior remains active */ }" },
} as ProjectSpec;

function planFields(overrides: Partial<ChangePlan> = {}): ChangePlan {
  return {
    title: before.title,
    summary: before.summary,
    board: before.board,
    components: before.components,
    parts: before.parts,
    connections: before.connections,
    instructions: before.instructions,
    understanding: "Keep the validated hardware.",
    clarificationQuestion: null,
    changeSummary: "Keep the validated hardware and update its behavior.",
    scope: "firmware",
    risk: "low",
    warnings: [],
    ...overrides,
  } as ChangePlan;
}

test("does not reject safe plans merely because their explanation is detailed", () => {
  const plan = planFields({ understanding: "Detailed engineering context. ".repeat(20) });
  assert.equal(ChangePlanSchema.parse(plan).scope, "firmware");
});

test("classifies a firmware-only revision without inventing hardware impact", () => {
  const after = { ...before, files: { ...before.files, mainCpp: before.files.mainCpp.replace("delay(100)", "delay(200)") } };
  const plan = planFields({ understanding: "Slow the existing response without changing hardware.", changeSummary: "Slow the output response" });
  const impact = projectImpact(before, after, plan);
  assert.deepEqual(impact.components, { added: [], removed: [], changed: [] });
  assert.equal(impact.wiringChanges, 0);
  assert.equal(impact.firmwareChanged, true);
  assert.equal(impact.understanding, plan.understanding);
});

test("derives hardware scope and at least medium risk from the actual diff", () => {
  const after = { ...before, components: [...before.components, { id: "display", type: "ssd1306" as const, name: "OLED", quantity: 1 as const }], connections: [...before.connections, { fromComponent: "board", fromPin: "GPIO21", toComponent: "display", toPin: "SDA", color: "#3b82f6", purpose: "display data" }] } as ProjectSpec;
  const mistakenPlan = planFields({ components: after.components, connections: after.connections, understanding: "Add an OLED.", changeSummary: "Added an OLED", scope: "firmware", risk: "low" });
  const impact = projectImpact(before, after, mistakenPlan);
  assert.equal(impact.scope, "hardware");
  assert.equal(impact.risk, "medium");
  assert.equal(impact.wiringChanges, 1);
});

test("preserves every existing connection when a new component is added", () => {
  const plan = planFields({ components: [...before.components, { id: "display", type: "ssd1306", name: "Status OLED", quantity: 1 }], understanding: "Add a display.", changeSummary: "Added display", scope: "hardware", risk: "medium" });
  assert.deepEqual(connectionsToPreserve(before, plan), before.connections);
});

test("reassigns controller pins instead of freezing old GPIOs during a board migration", () => {
  const plan = planFields({ board: "esp32cam", understanding: "Use the camera controller.", changeSummary: "Migrated to ESP32-CAM", scope: "hardware", risk: "medium" });
  assert.deepEqual(connectionsToPreserve(before, plan), []);
});

test("plans a camera-controller migration without asking the user to choose pins", async () => {
  const architecture = planFields({
    title: "Motion-tracking camera",
    summary: "Tracks motion and captures images using the built-in OV2640 camera.",
    board: "esp32cam",
    components: [{ id: "motion", type: "pir", name: "PIR motion sensor", quantity: 1 }],
    parts: ["1x AI Thinker ESP32-CAM with OV2640", "1x PIR motion sensor"],
    connections: [
      { fromComponent: "board", fromPin: "3V3", toComponent: "motion", toPin: "VCC", color: "#ef4444", purpose: "power" },
      { fromComponent: "board", fromPin: "GND", toComponent: "motion", toPin: "GND", color: "#111827", purpose: "ground" },
      { fromComponent: "board", fromPin: "GPIO13", toComponent: "motion", toPin: "OUT", color: "#3b82f6", purpose: "motion" },
    ],
    instructions: ["Disconnect power before wiring.", "Wire the PIR to the camera board.", "Power on and test motion capture."],
    understanding: "Replace the controller with ESP32-CAM and preserve motion tracking behavior.",
    changeSummary: "Added camera capability",
    scope: "hardware",
    risk: "medium",
  });
  const result = await previewProjectChange(before, "Build a motion-tracking camera", "Replace the controller with an ESP32-CAM so the project actually has a camera; choose safe pins for me.", async () => architecture, async (_current, _prompt, _request, plan) => ({ project: { ...before, board: plan.board }, impact: projectImpact(before, { ...before, board: plan.board }, plan) }));
  assert.equal("clarification" in result, false);
  if (!("clarification" in result)) assert.equal(result.project.board, "esp32cam");
});

test("retries a malformed change-plan response before building", async () => {
  let calls = 0;
  const complete = async () => {
    calls++;
    if (calls === 1) throw new Error("Model returned invalid JSON");
    return planFields({ understanding: "Keep the hardware and adjust its behavior.", changeSummary: "Adjusted behavior" });
  };
  const expectedPlan = planFields({ understanding: "Keep the hardware and adjust its behavior.", changeSummary: "Adjusted behavior" });
  const expected = { project: before, impact: projectImpact(before, before, expectedPlan) };
  const build = async () => expected;
  const result = await previewProjectChange(before, "Build a knob control", "Adjust the response", complete as never, build as never);
  assert.equal(calls, 2);
  assert.deepEqual(result, expected);
});

test("normalizes optional change metadata instead of rejecting a valid architecture", () => {
  const normalized = normalizeChangePlan({ ...before, warnings: null, scope: null, risk: "unexpected", understanding: null, changeSummary: null });
  const parsed = ChangePlanSchema.parse(normalized);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.scope, "hardware");
  assert.equal(parsed.risk, "medium");
  assert.match(parsed.changeSummary, /knob controls/i);
});

test("rejects GPIO and pin-selection questions as implementation details", () => {
  assert.equal(isImplementationClarification("Which GPIO pin should the new servo use?"), true);
  assert.equal(isImplementationClarification("Should both servos move together or independently?"), false);
});

test("repairs an implementation-detail clarification instead of showing it to the user", async () => {
  let calls = 0;
  const complete = async () => {
    calls++;
    return planFields({
      understanding: "Add another controlled output.",
      clarificationQuestion: calls === 1 ? "Which GPIO pin should Blueprint use?" : null,
      changeSummary: "Updated the output behavior",
      warnings: [],
    });
  };
  const expectedPlan = planFields({ understanding: "Add another controlled output.", clarificationQuestion: null, changeSummary: "Updated the output behavior" });
  const result = await previewProjectChange(before, "Build a knob control", "Update the output behavior and choose the implementation details", complete as never, (async () => ({ project: before, impact: projectImpact(before, before, expectedPlan) })) as never);
  assert.equal(calls, 2);
  assert.equal("clarification" in result, false);
});

test("reports board signal capacity before complex camera changes reach firmware", async () => {
  const cameraProject = { ...before, board: "esp32cam" as const };
  assert.deepEqual(boardResourceSummary(cameraProject).freeSignalPins, ["GPIO13", "GPIO14"]);
});

test("ignores model-authored wiring so deterministic topology remains authoritative", async () => {
  const shorted = planFields({
    understanding: "Break the circuit on purpose.",
    changeSummary: "Unsafe short",
    scope: "hardware",
    risk: "high",
    connections: [
      { fromComponent: "board", fromPin: "3V3", toComponent: "board", toPin: "GND", color: "#ef4444", purpose: "oops" },
      { fromComponent: "board", fromPin: "GND", toComponent: "control", toPin: "GND", color: "#111827", purpose: "ground" },
    ],
  });
  let receivedConnections: ChangePlan["connections"];
  const result = await previewProjectChange(before, "Build a knob control", "Keep the same safe behavior", async () => shorted, (async (_current: ProjectSpec, _prompt: string, _request: string, plan: ChangePlan) => {
    receivedConnections = plan.connections;
    return { project: before, impact: projectImpact(before, before, plan) };
  }) as never);
  assert.equal("clarification" in result, false);
  assert.equal(receivedConnections, undefined);
});
