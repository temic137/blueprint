import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { toBoardProfile, type BoardCard, type BoardId, type BoardProfile } from "./board-types.ts";

export type { BoardCard, BoardId, BoardProfile } from "./board-types.ts";
export { toBoardProfile } from "./board-types.ts";

const BoardCardSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(2).max(120),
  aliases: z.array(z.string().min(1).max(80)).max(24).default([]),
  platformio: z.string().max(80).default(""),
  platform: z.string().min(2).max(80),
  family: z.string().min(2).max(40),
  logicVoltage: z.number().positive().max(24),
  pins: z.array(z.string().min(1).max(40)).min(3).max(120),
  signalPins: z.array(z.string().min(1).max(40)).min(1).max(100),
  visual: z.string().max(80).optional(),
  summary: z.string().min(5).max(400),
  source: z.string().min(2).max(80).default("seed"),
}).strict();

function rootDir() {
  return path.join(process.cwd(), "board-cards");
}

function cacheDir() {
  return path.join(rootDir(), "cache");
}

function catalogDir() {
  return path.join(rootDir(), "catalog");
}

function normalizedIdentity(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function loadJsonCards(directory: string): BoardCard[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".json")).flatMap((file) => {
    try {
      return [BoardCardSchema.parse(JSON.parse(readFileSync(path.join(directory, file), "utf8")))];
    } catch {
      return [];
    }
  });
}

/** Seed + cache cards currently available without a fetch. */
export function listBoardCards(): BoardCard[] {
  const byId = new Map<string, BoardCard>();
  for (const card of [...loadJsonCards(rootDir()), ...loadJsonCards(cacheDir())]) byId.set(card.id, card);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function listCatalogBoardCards(): BoardCard[] {
  return loadJsonCards(catalogDir());
}

export function getBoardCard(id: string): BoardCard | undefined {
  return listBoardCards().find((card) => card.id === id);
}

export function boardProfile(id: string): BoardProfile {
  const card = getBoardCard(id);
  if (!card) throw new Error(`Unknown board card: ${id}`);
  return toBoardProfile(card);
}

/** Lazy map for call sites that still index profiles by id. */
export function boardProfiles(): Record<string, BoardProfile> {
  return Object.fromEntries(listBoardCards().map((card) => [card.id, boardProfile(card.id)]));
}

/** @deprecated use boardProfile / listBoardCards — Proxy so BOARD_PROFILES[id] keeps working without a fixed enum. */
export const BOARD_PROFILES: Record<string, BoardProfile> = new Proxy({} as Record<string, BoardProfile>, {
  get(_target, prop) {
    if (typeof prop !== "string" || prop === "then") return undefined;
    return getBoardCard(prop) ? boardProfile(prop) : undefined;
  },
  ownKeys() {
    return listBoardCards().map((card) => card.id);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== "string" || !getBoardCard(prop)) return undefined;
    return { configurable: true, enumerable: true, value: boardProfile(prop) };
  },
  has(_target, prop) {
    return typeof prop === "string" && Boolean(getBoardCard(prop));
  },
});

export function boardsCatalogForPrompt(limit = 40) {
  const cards = listBoardCards();
  const catalog = listCatalogBoardCards().filter((card) => !cards.some((seed) => seed.id === card.id));
  const lines = [
    ...cards.map((card) => `${card.id}: ${card.name} (${card.logicVoltage}V, ${card.platform}${card.platformio ? `/${card.platformio}` : ""}) — ${card.summary} Pins: ${card.pins.join(", ")}`),
    ...catalog.slice(0, Math.max(0, limit - cards.length)).map((card) => `${card.id}: ${card.name} (catalog — will be fetched on use) — ${card.summary}`),
  ];
  return `${lines.join("\n")}\n\nYou may choose any board above, or another common hobby controller by id/name. Blueprint resolves or fetches a board card before accepting the circuit.`;
}

function scoreCard(card: BoardCard, needle: string) {
  const identities = [card.id, card.name, ...card.aliases].map(normalizedIdentity);
  if (identities.includes(needle)) return 100;
  let best = 0;
  for (const identity of identities) {
    if (!identity) continue;
    if (identity === needle) return 100;
    if (needle.includes(identity) && needle.length > identity.length + 2) {
      // "arduinomega" contains "arduino" — weak, don't beat a better catalog hit
      best = Math.max(best, 25 + Math.min(identity.length, 15));
      continue;
    }
    if (identity.includes(needle) || needle.includes(identity)) {
      best = Math.max(best, 50 + Math.min(identity.length, needle.length));
    }
  }
  return best;
}

/** Resolve against seed + cache only (no fetch). */
export function resolveBoardCard(raw: unknown): BoardCard | undefined {
  const needle = normalizedIdentity(String(raw || ""));
  if (!needle) return undefined;
  const ranked = listBoardCards().map((card) => ({ card, score: scoreCard(card, needle) })).filter((item) => item.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  return ranked[0]?.card;
}

function writeCachedCard(card: BoardCard) {
  const directory = cacheDir();
  mkdirSync(directory, { recursive: true });
  const parsed = BoardCardSchema.parse({ ...card, source: card.source || "cache" });
  writeFileSync(path.join(directory, `${parsed.id}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

function fetchFromCatalog(raw: string): BoardCard | undefined {
  const needle = normalizedIdentity(raw);
  const ranked = listCatalogBoardCards().map((card) => ({ card, score: scoreCard(card, needle) })).filter((item) => item.score > 0);
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0]?.card;
}

function fetchFromWokwi(raw: string): BoardCard | undefined {
  const needle = normalizedIdentity(raw);
  const directory = path.join(process.cwd(), "node_modules", "@wokwi", "elements", "dist", "esm");
  if (!existsSync(directory)) return undefined;
  const controllers = readdirSync(directory)
    .filter((file) => file.endsWith("-element.js") && /arduino|pico|esp32|pi-|franzininho|nano-rp2040/i.test(file))
    .map((file) => {
      const slug = file.replace(/-element\.js$/, "");
      const tag = `wokwi-${slug}`;
      const source = readFileSync(path.join(directory, file), "utf8");
      const pinBlock = source.match(/pinInfo\s*=\s*\[([\s\S]*?)\];/)?.[1] || "";
      const pins = [...pinBlock.matchAll(/name:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
      return { slug, tag, pins };
    });
  const hit = controllers
    .map((item) => ({ item, score: scoreCard({ id: item.slug.replaceAll("-", "_"), name: item.slug, aliases: [item.slug, item.tag], platformio: "", platform: "unknown", family: "other", logicVoltage: 3.3, pins: item.pins, signalPins: item.pins.filter((pin) => !/^(GND|3V3|5V|VIN|VSYS|VBUS)$/i.test(pin)), summary: item.slug, source: "wokwi" }, needle) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (!hit || hit.item.pins.length < 3) return undefined;
  const id = hit.item.slug.replaceAll("-", "_");
  const power = hit.item.pins.filter((pin) => /^(GND|3V3|3\.3V|5V|VIN|VSYS|VBUS)$/i.test(pin));
  const signals = hit.item.pins.filter((pin) => !power.includes(pin));
  const family = /arduino/i.test(id) ? "arduino" : /pico|rp2040/i.test(id) ? "pico" : /esp32/i.test(id) ? "esp32" : "other";
  return BoardCardSchema.parse({
    id,
    name: hit.item.slug.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    aliases: [hit.item.slug, hit.item.tag],
    platformio: "",
    platform: family === "arduino" ? "atmelavr" : family === "esp32" ? "espressif32" : family === "pico" ? "raspberrypi" : "unknown",
    family,
    logicVoltage: family === "arduino" ? 5 : 3.3,
    pins: [...new Set([...power.map((pin) => pin.toUpperCase().replace("3.3V", "3V3")), ...signals])],
    signalPins: signals,
    visual: hit.item.tag,
    summary: `Discovered from Wokwi Elements (${hit.item.tag}); pin names come from the visual pinInfo.`,
    source: "wokwi-fetch",
  });
}

/**
 * Resolve a board by name/id. On miss: fetch from catalog or Wokwi, cache, return.
 * Throws if nothing can be grounded.
 */
export function ensureBoardCard(raw: unknown): BoardCard {
  const query = String(raw || "").trim();
  if (!query) throw new Error("Board name is required.");
  const needle = normalizedIdentity(query);
  const rankedSeed = listBoardCards()
    .map((card) => ({ card, score: scoreCard(card, needle) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
  const bestSeed = rankedSeed[0];
  if (bestSeed && bestSeed.score >= 100) return bestSeed.card;

  const catalogHit = fetchFromCatalog(query);
  if (catalogHit) {
    const catalogScore = scoreCard(catalogHit, needle);
    if (!bestSeed || catalogScore > bestSeed.score) return writeCachedCard(catalogHit);
  }

  const wokwi = fetchFromWokwi(query);
  if (wokwi) {
    const wokwiScore = scoreCard(wokwi, needle);
    if (!bestSeed || wokwiScore > bestSeed.score) return writeCachedCard(wokwi);
  }

  if (bestSeed) return bestSeed.card;
  throw new Error(`No board card found for "${query}". Add board-cards/catalog/<id>.json or use a known controller name.`);
}

/** Prefer resolved id; otherwise fetch; optional soft fallback only when allowed. */
export function resolveBoardId(raw: unknown, fallback?: string): BoardId {
  try {
    return ensureBoardCard(raw).id;
  } catch (error) {
    if (fallback) {
      const card = getBoardCard(fallback) || resolveBoardCard(fallback);
      if (card) return card.id;
    }
    throw error;
  }
}
