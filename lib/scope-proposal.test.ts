import assert from "node:assert/strict";
import test from "node:test";
import { complexityRejectMessage, isComplexityValidationFailure, looksBeyondCircuitScope } from "./scope-proposal.ts";

test("looksBeyondCircuitScope allows simple hardware and rejects ML-scale ideas", () => {
  assert.equal(looksBeyondCircuitScope("Build a doorbell with a button and buzzer"), false);
  assert.equal(looksBeyondCircuitScope("Create a circuit that translates sign language to words"), true);
  assert.equal(looksBeyondCircuitScope("Train a neural network for gesture recognition on ESP32"), true);
});

test("isComplexityValidationFailure detects component cap overrun", () => {
  assert.equal(isComplexityValidationFailure(["components: Too big: expected array to have <=12 items"]), true);
  assert.equal(isComplexityValidationFailure(["components: too many parts (18); Blueprint allows at most 12 component instances."]), true);
  assert.equal(isComplexityValidationFailure(["Unknown board pin on arduino_uno: D99"]), false);
});

test("complexityRejectMessage is explicit and actionable", () => {
  const message = complexityRejectMessage("sign language / ML");
  assert.match(message, /I can't build this/i);
  assert.match(message, /simple/i);
  assert.match(message, /sign language \/ ML/);
});
