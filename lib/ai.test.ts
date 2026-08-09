import test from "node:test";
import assert from "node:assert/strict";
import { aiRequestTimeout, cloudflareModelPool, modelPool, parseModelJson, providerStatus } from "./ai.ts";

test("accepts text and structured model JSON responses", () => {
  assert.deepEqual(parseModelJson('{"ok":true}'), { ok: true });
  assert.deepEqual(parseModelJson({ ok: true }), { ok: true });
  assert.throws(() => parseModelJson(null), /no JSON content/);
});

test("allows larger builder responses without weakening the planning timeout", () => {
  assert.equal(aiRequestTimeout("architect"), 45_000);
  assert.equal(aiRequestTimeout("builder"), 90_000);
});

test("keeps the deprecated Cloudflare provider disabled", () => {
  assert.deepEqual(Object.keys(providerStatus().providers).sort(), ["cloudflare", "groq"]);
  assert.ok(cloudflareModelPool().some((model) => model.startsWith("@cf/")));
  assert.equal(providerStatus().providers.cloudflare.configured, false);
});

test("uses separate multi-model pools for each Blueprint task", () => {
  const architect = modelPool("architect");
  const assistant = modelPool("assistant");
  const change = modelPool("change");
  const firmware = modelPool("firmware");
  for (const pool of [architect, assistant, change, firmware]) assert.ok(pool.length >= 1);
  assert.ok(architect.some((model) => model.includes("gpt-oss") || model.includes("llama")));
  assert.ok(firmware.some((model) => model.includes("gpt-oss") || model.includes("llama")));
  assert.ok(assistant.length < architect.length, "ordinary chat should use a smaller reserved pool");
});

test("architect pool keeps multiple free Groq backups beyond gpt-oss", () => {
  const architect = modelPool("architect");
  assert.ok(architect.length >= 3, "architect needs failover depth");
  assert.ok(
    architect.some((model) => /llama|qwen|gemma|scout/i.test(model)),
    "architect pool should include non-gpt-oss Groq backups",
  );
});
