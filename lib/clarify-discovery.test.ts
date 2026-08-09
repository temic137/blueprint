import assert from "node:assert/strict";
import test from "node:test";
import { clarifyProject } from "./clarify.ts";

test("defers unknown exact part numbers to automatic component discovery", async () => {
  assert.deepEqual(await clarifyProject("Build an environmental monitor using BME9999"), {
    status: "READY_TO_BUILD",
    prompt: "Build an environmental monitor using BME9999",
  });
});
