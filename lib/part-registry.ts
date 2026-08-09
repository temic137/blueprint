import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverLibraryComponents } from "./library-components.ts";
import { loadComponentManifests, runtimeComponentManifestValues, validateManifestRecord } from "./component-manifests.ts";
import { componentRegistry, searchComponentRegistry, type ComponentRegistryRecord } from "./project.ts";

function cacheDir() {
  return process.env.VERCEL ? path.join("/tmp", "blueprint-part-cache") : path.join(process.cwd(), "part-cards", "cache");
}

function normalizedIdentity(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function loadCachedParts() {
  const directory = cacheDir();
  if (!existsSync(directory)) return { records: [] as ComponentRegistryRecord[], errors: [] as string[] };
  const records: ComponentRegistryRecord[] = [];
  const errors: string[] = [];
  for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
    try {
      records.push(validateManifestRecord(JSON.parse(readFileSync(path.join(directory, file), "utf8"))));
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : "invalid cached manifest"}`);
    }
  }
  return { records, errors };
}

export function writeCachedPart(record: ComponentRegistryRecord) {
  const { visual: _visual, ...serializable } = record;
  const validated = validateManifestRecord(serializable);
  const directory = cacheDir();
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${validated.id}.json`), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return validated;
}

/** Federated parts: built-ins + manifests + library discovery + cache. */
export function allPartRecords() {
  const manifests = loadComponentManifests();
  const libraries = discoverLibraryComponents();
  const cached = loadCachedParts();
  const records = componentRegistry([...manifests.records, ...libraries.records, ...cached.records, ...runtimeComponentManifestValues()]);
  return { records, errors: [...manifests.errors, ...libraries.errors, ...cached.errors], sources: { manifests: manifests.records.length, ...libraries.sources, cache: cached.records.length } };
}

export function resolvePartRecord(raw: unknown): ComponentRegistryRecord | undefined {
  const needle = normalizedIdentity(String(raw || ""));
  if (!needle || needle.length < 2) return undefined;
  const { records } = allPartRecords();
  const exact = records.find((record) => [record.id, record.name, ...record.aliases].map(normalizedIdentity).includes(needle));
  if (exact) return exact;
  const fuzzy = searchComponentRegistry(String(raw || ""), records, 5);
  return fuzzy[0];
}

/**
 * Resolve a part by name. On miss among buildable records, promote a Wokwi/library
 * discovery into part-cards/cache when it has a usable pin contract.
 */
export function ensurePartRecord(raw: unknown): ComponentRegistryRecord {
  const existing = resolvePartRecord(raw);
  if (existing && existing.pins.length && existing.supportLevel !== "visual-only") return existing;
  if (existing && existing.supportLevel === "visual-only") {
    throw new Error(`Part "${raw}" is visual-only — add a datasheet manifest before wiring it.`);
  }
  const query = String(raw || "").trim();
  const libraries = discoverLibraryComponents().records;
  const hit = libraries
    .map((record) => ({
      record,
      score: [record.id, record.name, ...record.aliases].map(normalizedIdentity).some((identity) => identity.includes(normalizedIdentity(query)) || normalizedIdentity(query).includes(identity)) ? 1 : 0,
    }))
    .filter((item) => item.score && item.record.pins.length && item.record.supportLevel !== "visual-only")
    .map((item) => item.record)[0];
  if (!hit) throw new Error(`No part card found for "${query}". Add component-manifests/<id>.json or use a known catalog/Wokwi part.`);
  return writeCachedPart({ ...hit, source: `${hit.source} → part-cards/cache` });
}

export function partsCatalogForPrompt(query: string, limit = 60, complete = false) {
  const { records, errors } = allPartRecords();
  const buildable = records.filter((record) => record.pins.length && record.supportLevel !== "visual-only");
  const selected = complete
    ? buildable.slice(0, limit)
    : searchComponentRegistry(query, buildable, limit);
  return {
    summary: selected.map((record) => `${record.id}: ${record.name}; ${record.baseType ? `type ${record.baseType}` : "exact part; omit type"}; capabilities ${record.capabilities.join(", ") || record.category}`).join("\n"),
    records: selected,
    errors,
    total: records.length,
  };
}
