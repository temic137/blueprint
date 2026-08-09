import assert from "node:assert/strict";
import test from "node:test";
import { ArchitectureSchema, validateArchitecture, validateHardware } from "./project.ts";
import { ensureBoardCard, toBoardProfile } from "./boards.ts";
import { synthesizeCircuit } from "./synthesize-circuit.ts";
import { ensureKitDependencies, matchKitTemplate } from "./supported-kit.ts";

test("matches ultrasonic parking to a kit template without the LLM", () => {
  const hit = matchKitTemplate("Build an ultrasonic parking sensor.");
  assert.equal(hit?.id, "ultrasonic_parking");
  assert.equal(hit?.architecture.board, "arduino_uno");
  assert.ok(hit?.architecture.components.some((component) => component.type === "hc_sr04"));
});

test("kit ultrasonic template synthesizes a valid circuit", () => {
  const hit = matchKitTemplate("ultrasonic parking sensor");
  assert.ok(hit);
  const { explanations: _explanations, ...fields } = hit!.architecture;
  void _explanations;
  const architecture = ArchitectureSchema.parse({
    ...fields,
    boardMeta: toBoardProfile(ensureBoardCard(fields.board)),
  });
  assert.deepEqual(validateArchitecture(architecture), []);
  const wired = { ...architecture, ...synthesizeCircuit(architecture) };
  assert.deepEqual(validateHardware({
    ...wired,
    boardMeta: architecture.boardMeta,
  }), []);
});

test("ensureKitDependencies adds missing HC-SR04 divider resistors", () => {
  const filled = ensureKitDependencies({
    title: "Range",
    summary: "Distance sensor only.",
    board: "arduino_uno",
    components: [{ id: "range", type: "hc_sr04", name: "HC-SR04", quantity: 1 }],
    parts: ["1x Arduino Uno", "1x HC-SR04"],
  });
  assert.equal(filled.components.filter((component) => component.type === "resistor").length, 2);
  assert.deepEqual(validateArchitecture(filled), []);
});
