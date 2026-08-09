import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { discoverLibraryComponents } from "./library-components.ts";
import { BOARD_PINS, COMPONENTS, componentRegistry, searchRegistryRecords, type ComponentRegistryRecord } from "./project.ts";

let runtimeManifests: ComponentRegistryRecord[] = [];

export function setRuntimeComponentManifests(values: unknown[]) {
  runtimeManifests = values.flatMap((value) => {
    try { return [validateManifestRecord(value)]; } catch { return []; }
  });
}

export function addRuntimeComponentManifest(value: unknown) {
  const record = validateManifestRecord(value);
  runtimeManifests = [...runtimeManifests.filter((item) => item.id !== record.id), record];
}

export function runtimeComponentManifestValues() {
  return runtimeManifests;
}

export const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(2).max(120),
  aliases: z.array(z.string().min(2).max(80)).max(20).default([]),
  category: z.string().min(2).max(50),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(20),
  supportLevel: z.enum(["generic-family", "datasheet-derived"]),
  source: z.string().min(3).max(500),
  baseType: z.string().optional(),
  pins: z.array(z.string().min(1).max(40)).min(1).max(40).optional(),
  boardPins: z.record(z.string(), z.array(z.string())).optional(),
  description: z.string().min(5).max(500),
  firmware: z.string().max(500).optional(),
  requirements: z.array(z.string().min(3).max(300)).max(12).optional(),
}).strict().superRefine((manifest, context) => {
  if (!manifest.baseType && !manifest.pins?.length) context.addIssue({ code: "custom", path: ["pins"], message: "Exact components require pins." });
});

export function validateManifestRecord(raw: unknown): ComponentRegistryRecord {
  const manifest = ManifestSchema.parse(raw);
  const definition = manifest.baseType ? COMPONENTS[manifest.baseType] : undefined;
  if (manifest.baseType && !definition) throw new Error(`baseType ${manifest.baseType} is not a validated family`);
  const pins = manifest.pins || definition?.pins || [];
  const boardPins = manifest.boardPins || definition?.boardPins;
  for (const [pin, choices] of Object.entries(boardPins || {})) {
    if (!pins.includes(pin)) throw new Error(`boardPins references unknown component pin ${pin}`);
    if (choices.some((choice) => !/^[A-Za-z0-9._+/-]+$/.test(choice))) throw new Error(`boardPins contains invalid terminal for ${pin}`);
  }
  return { ...manifest, baseType: manifest.baseType || "", pins, boardPins, visual: definition?.tag };
}

function loadCachedPartRecords() {
  const directory = path.join(process.cwd(), "part-cards", "cache");
  if (!existsSync(directory)) return [] as ComponentRegistryRecord[];
  return readdirSync(directory).filter((file) => file.endsWith(".json")).flatMap((file) => {
    try {
      return [validateManifestRecord(JSON.parse(readFileSync(path.join(directory, file), "utf8")))];
    } catch {
      return [];
    }
  });
}

export function loadComponentManifests(directory = path.join(process.cwd(), "component-manifests")) {
  const records: ComponentRegistryRecord[] = [];
  const errors: string[] = [];
  let files: string[] = [];
  try { files = readdirSync(directory).filter((file) => file.endsWith(".json")); } catch { return { records, errors }; }
  for (const file of files) {
    try {
      const record = validateManifestRecord(JSON.parse(readFileSync(path.join(directory, file), "utf8")));
      if (componentRegistry().some((item) => item.id === record.id) || records.some((item) => item.id === record.id)) throw new Error(`duplicate registry id ${record.id}`);
      records.push(record);
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : "invalid manifest"}`);
    }
  }
  return { records, errors };
}

export function registryCatalogForPrompt(query: string, limit = 18, complete = false) {
  const manifests = loadComponentManifests();
  const libraries = discoverLibraryComponents();
  const cached = loadCachedPartRecords();
  const records = [...manifests.records, ...libraries.records, ...cached, ...runtimeManifests];
  const allBuildable = componentRegistry(records).filter((record) => record.pins.length && ["validated", "generic-family", "datasheet-derived"].includes(record.supportLevel));
  const selected = complete ? allBuildable.slice(0, limit) : searchRegistryRecords(query, allBuildable, limit);
  return {
    text: selected.map((record) => `${record.id}: ${record.name}; ${record.baseType ? `use component type ${record.baseType}` : "exact registry part: omit component type"}; support ${record.supportLevel}; capabilities ${record.capabilities.join(", ") || "general"}; pins ${record.pins.join(", ")}; ${record.description}${record.firmware ? `; firmware ${record.firmware}` : ""}${record.requirements?.length ? `; requirements ${record.requirements.join("; ")}` : ""}`).join("\n"),
    summary: selected.map((record) => `${record.id}: ${record.name}; ${record.baseType ? `type ${record.baseType}` : "exact part; omit type"}; capabilities ${record.capabilities.join(", ") || record.category}`).join("\n"),
    records: selected,
    errors: [...manifests.errors, ...libraries.errors],
    total: componentRegistry(records).length,
  };
}

export function federatedComponentRegistry() {
  const manifests = loadComponentManifests();
  const libraries = discoverLibraryComponents();
  const cached = loadCachedPartRecords();
  return {
    records: componentRegistry([...manifests.records, ...libraries.records, ...cached]),
    errors: [...manifests.errors, ...libraries.errors],
    sources: { manifests: manifests.records.length, cache: cached.length, ...libraries.sources },
  };
}

// keep BOARD_PINS import used for diagnostics if needed
void BOARD_PINS;
