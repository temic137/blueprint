import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { boardPinCompatible, boardsCatalogForPrompt, ensureBoardCard, getBoardCard, listBoardCards, normalizeBoardPinForBoard, resolveBoardId } from "./boards.ts";

test("seed boards load from JSON cards, not a TypeScript enum", () => {
  const ids = listBoardCards().map((card) => card.id);
  assert.ok(ids.includes("esp32dev"));
  assert.ok(ids.includes("arduino_uno"));
  assert.ok(ids.includes("pico"));
  // Pi lives in catalog/cache, not as a TypeScript enum member
  assert.ok(!ids.includes("raspberry_pi_4") || getBoardCard("raspberry_pi_4")?.source !== "seed");
});

test("ensureBoardCard fetches Raspberry Pi 4 from catalog into cache", () => {
  const cacheFile = path.join(process.cwd(), "board-cards", "cache", "raspberry_pi_4.json");
  if (existsSync(cacheFile)) rmSync(cacheFile);
  const card = ensureBoardCard("Raspberry Pi 4");
  assert.equal(card.id, "raspberry_pi_4");
  assert.ok(card.signalPins.includes("BCM17"));
  assert.ok(existsSync(cacheFile));
  assert.equal(resolveBoardId("raspi"), "raspberry_pi_4");
  assert.equal(getBoardCard("raspberry_pi_4")?.name, "Raspberry Pi 4 Model B");
});

test("ensureBoardCard fetches Arduino Mega from catalog", () => {
  const cacheFile = path.join(process.cwd(), "board-cards", "cache", "arduino_mega.json");
  if (existsSync(cacheFile)) rmSync(cacheFile);
  const card = ensureBoardCard("Arduino Mega");
  assert.equal(card.id, "arduino_mega");
  assert.ok(card.pins.includes("D53"));
  assert.ok(existsSync(cacheFile));
});

test("normalizeBoardPinForBoard maps power aliases per board family", () => {
  assert.equal(normalizeBoardPinForBoard("arduino_uno", "5V"), "5V");
  assert.equal(normalizeBoardPinForBoard("esp32dev", "5V"), "VIN");
  assert.equal(normalizeBoardPinForBoard("pico", "VIN"), "VSYS");
  ensureBoardCard("raspberry_pi_4");
  assert.equal(normalizeBoardPinForBoard("raspberry_pi_4", "BCM17"), "BCM17");
});

test("boardPinCompatible accepts Arduino digital pins for ESP GPIO allowlists", () => {
  assert.equal(boardPinCompatible("arduino_uno", ["GPIO4", "GPIO13"], "D4"), true);
  assert.equal(boardPinCompatible("esp32dev", ["GPIO4", "GPIO13"], "D4"), false);
});

test("boardPinCompatible treats 3V3 allowlists as multi-board logic power, not ESP-only", () => {
  // Catalog says 3V3 → Uno 5V / VIN still OK for typical breadboard modules.
  assert.equal(boardPinCompatible("arduino_uno", ["3V3"], "5V"), true);
  assert.equal(boardPinCompatible("arduino_uno", ["3V3"], "VIN"), true);
  // 5V-only parts must not silently accept 3V3 (HC-SR04 / NeoPixel class).
  assert.equal(boardPinCompatible("arduino_uno", ["VIN"], "3V3"), false);
  assert.equal(boardPinCompatible("arduino_uno", ["VIN"], "5V"), true);
  // Empty allowlist = must not attach to board.
  assert.equal(boardPinCompatible("arduino_uno", [], "5V"), false);
});

test("boardsCatalogForPrompt lists seeds and mentions catalog fetch", () => {
  const catalog = boardsCatalogForPrompt();
  assert.match(catalog, /^esp32dev:/m);
  assert.match(catalog, /raspberry_pi_4:/);
  assert.match(catalog, /fetch/i);
});
