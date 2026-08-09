import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePartRecord, resolvePartRecord } from "./part-registry.ts";

test("resolvePartRecord finds built-in parts without caching", () => {
  const part = resolvePartRecord("DHT22");
  assert.ok(part);
  assert.equal(part!.id, "dht22");
});

test("ensurePartRecord returns curated manifest parts", () => {
  const part = ensurePartRecord("VL53L0X");
  assert.ok(part.pins.length);
  assert.match(part.id, /vl53l0x/i);
});
