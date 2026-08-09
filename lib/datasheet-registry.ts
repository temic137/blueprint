import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { completeJson } from "./ai.ts";
import { addRuntimeComponentManifest, validateManifestRecord } from "./component-manifests.ts";
import { saveComponentManifest } from "./db.ts";
import { COMPONENTS, searchRegistryRecords, type ComponentRegistryRecord } from "./project.ts";
import { allPartRecords, writeCachedPart } from "./part-registry.ts";

const MAX_DATASHEET_BYTES = 8 * 1024 * 1024;
// Keep the extraction prompt below the free Groq models' common TPM ceilings.
const MAX_DATASHEET_TEXT = 20_000;

export const DatasheetExtractionSchema = z.object({
  name: z.string().min(2).max(120),
  aliases: z.array(z.string().min(2).max(80)).max(12).default([]),
  category: z.string().min(2).max(50),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(12),
  interface: z.enum(["i2c", "spi", "uart", "digital_sensor", "analog_sensor", "digital_actuator", "other"]),
  pins: z.array(z.string().min(1).max(40)).min(2).max(40),
  supplyVoltageMin: z.number().nonnegative().max(60).nullable(),
  supplyVoltageMax: z.number().positive().max(60).nullable(),
  moduleReady: z.boolean(),
  description: z.string().min(10).max(500),
  firmware: z.string().max(300).nullable(),
  requirements: z.array(z.string().min(3).max(240)).max(10),
  evidence: z.array(z.string().min(3).max(200)).min(2).max(10),
}).strict().superRefine((value, context) => {
  if (value.supplyVoltageMin !== null && value.supplyVoltageMax !== null && value.supplyVoltageMin > value.supplyVoltageMax) {
    context.addIssue({ code: "custom", path: ["supplyVoltageMin"], message: "Minimum supply voltage exceeds maximum." });
  }
});

export type DatasheetExtraction = z.infer<typeof DatasheetExtractionSchema>;

function machineName(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/i(?:Â)?²c/gi, "i2c").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function normalizeDatasheetExtraction(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const interfaceMap: Record<string, DatasheetExtraction["interface"]> = {
    i2c: "i2c", i_2_c: "i2c", spi: "spi", uart: "uart",
    digital_sensor: "digital_sensor", analog_sensor: "analog_sensor",
    digital_actuator: "digital_actuator", other: "other",
  };
  const interfaceNames = (Array.isArray(value.interface) ? value.interface : [value.interface]).map(machineName);
  const interfaceName = ["i2c", "spi", "uart", "digital_sensor", "analog_sensor", "digital_actuator", "other"]
    .find((supported) => interfaceNames.some((candidate) => candidate === supported || candidate.split("_").includes(supported))) || "other";
  const list = (field: string) => Array.isArray(value[field]) ? value[field] : [];
  return {
    ...value,
    aliases: list("aliases"),
    capabilities: list("capabilities").map(machineName).filter(Boolean).map((capability) => CAPABILITY_ALIASES[capability] || capability),
    interface: interfaceMap[interfaceName] || "other",
    pins: list("pins").map((pin) => String(pin).trim()).filter(Boolean),
    requirements: list("requirements"),
    evidence: list("evidence"),
  };
}

const FAMILY: Record<DatasheetExtraction["interface"], string> = {
  i2c: "generic_i2c_module",
  spi: "generic_spi_module",
  uart: "generic_uart_module",
  digital_sensor: "generic_digital_sensor",
  analog_sensor: "generic_analog_sensor",
  digital_actuator: "generic_digital_actuator",
  other: "",
};

const CAPABILITY_ALIASES: Record<string, string> = {
  temperature: "temperature_sensing",
  humidity: "humidity_sensing",
  barometer: "pressure_sensing",
  pressure: "pressure_sensing",
  voc: "air_quality_sensing",
  air_quality: "air_quality_sensing",
  distance: "distance_measurement",
  range: "distance_measurement",
  motion: "motion_detection",
};

function slug(value: string) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 70);
  return /^[a-z]/.test(result) ? result : `part_${result || "datasheet"}`;
}

function privateAddress(address: string) {
  if (address === "::1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  const parts = address.split(".").map(Number);
  return isIP(address) === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168));
}

async function assertSafeUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Datasheet links must use HTTPS.");
  if (url.username || url.password || url.port) throw new Error("Datasheet links cannot contain credentials or custom ports.");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Datasheet link resolves to a private or unsafe network address.");
  return url;
}

async function fetchBytes(raw: string, redirects = 0): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: string }> {
  if (redirects > 3) throw new Error("Datasheet link redirected too many times.");
  const url = await assertSafeUrl(raw);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Blueprint component registry/1.0", Accept: "application/pdf,text/html,text/plain" } });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Datasheet redirect did not provide a destination.");
    return fetchBytes(new URL(location, url).toString(), redirects + 1);
  }
  if (!response.ok) throw new Error(`Datasheet download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_DATASHEET_BYTES) throw new Error("Datasheet is larger than 8 MB.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Datasheet response had no content.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DATASHEET_BYTES) { await reader.cancel(); throw new Error("Datasheet is larger than 8 MB."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { bytes, contentType: response.headers.get("content-type") || "", finalUrl: url.toString() };
}

function usefulExcerpt(text: string) {
  const clean = text.replace(/\u0000/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  const relevant = clean.split("\n").filter((line) => /pin|terminal|supply|voltage|absolute maximum|i2c|i²c|spi|uart|serial|logic level|operating condition|vcc|vdd|gnd|ground|sda|scl|mosi|miso|clock|input|output/i.test(line));
  return `${clean.slice(0, 8_000)}\n\nRELEVANT DATASHEET LINES:\n${relevant.join("\n")}`.slice(0, MAX_DATASHEET_TEXT);
}

async function pdfText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  let length = 0;
  for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 80); pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = `PAGE ${pageNumber}\n${content.items.map((item) => "str" in item ? item.str : "").join(" ")}`;
    pages.push(text);
    length += text.length;
    if (length > MAX_DATASHEET_TEXT * 3) break;
  }
  return pages.join("\n");
}

export async function readDatasheet(rawUrl: string) {
  const resource = await fetchBytes(rawUrl);
  // Some component sites incorrectly return HTML as application/pdf. Trust the
  // file signature, not the server label; valid PDFs place %PDF near the start.
  const isPdf = new TextDecoder("ascii").decode(resource.bytes.slice(0, 1024)).includes("%PDF-");
  const rawText = isPdf
    ? await pdfText(resource.bytes)
    : new TextDecoder().decode(resource.bytes).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  const text = usefulExcerpt(rawText);
  if (text.replace(/\s/g, "").length < 500) throw new Error("The datasheet did not contain enough readable text. Scanned-image PDFs are not supported yet.");
  return { text, finalUrl: resource.finalUrl };
}

export function manifestFromExtraction(partNumber: string, source: string, raw: unknown): ComponentRegistryRecord {
  const extraction = DatasheetExtractionSchema.parse(normalizeDatasheetExtraction(raw));
  const baseType = extraction.moduleReady ? FAMILY[extraction.interface] : "";
  if (!baseType) throw new Error("This datasheet describes a raw or unsupported part, not a safely reusable low-voltage module. Blueprint will suggest validated alternatives instead.");
  const definition = COMPONENTS[baseType]!;
  const max = extraction.supplyVoltageMax;
  if (max !== null && max > 5.5) throw new Error(`The part requires up to ${max}V, outside Blueprint's directly supported module range.`);
  const boardPins = Object.fromEntries(Object.entries(definition.boardPins || {}).map(([pin, choices]) => [pin, pin === "VCC" && max !== null && max <= 3.6 ? ["3V3"] : choices]));
  return validateManifestRecord({
    id: slug(partNumber || extraction.name),
    name: extraction.name,
    aliases: [...new Set([partNumber, ...extraction.aliases].filter((value) => value && value.toLowerCase() !== extraction.name.toLowerCase()))],
    category: extraction.category,
    capabilities: extraction.capabilities,
    supportLevel: "datasheet-derived",
    source,
    baseType,
    pins: [...definition.pins],
    boardPins,
    description: extraction.description,
    ...(extraction.firmware ? { firmware: extraction.firmware } : {}),
    requirements: [...extraction.requirements, ...extraction.evidence.map((item) => `Datasheet evidence: ${item}`)].slice(0, 12),
  });
}

export function suggestValidatedAlternatives(query: string, limit = 5) {
  const records = allPartRecords().records.filter((record) => record.pins.length && ["validated", "generic-family", "datasheet-derived"].includes(record.supportLevel));
  return searchRegistryRecords(query, records, limit);
}

export async function ingestDatasheet(datasheetUrl: string, partNumber = "", deadlineAt = Date.now() + 60_000) {
  const { text, finalUrl } = await readDatasheet(datasheetUrl);
  const extraction = await completeJson("architect", [{ role: "system", content: `Extract a conservative electrical manifest from the supplied datasheet text. Never use memory to fill missing facts. This system only auto-enables complete low-voltage breakout modules, not bare ICs, motors, mains parts, batteries, chargers, or high-current loads. Canonical interface values: i2c, spi, uart, digital_sensor, analog_sensor, digital_actuator, other. moduleReady is true only when the document describes a directly usable module with power conditioning/logic levels suitable for a microcontroller. Pins must list the real documented terminal labels. Evidence must contain short paraphrases of exact facts present in the text. Use null for unknown voltages. Return one JSON object with exactly these keys: name, aliases, category, capabilities, interface, pins, supplyVoltageMin, supplyVoltageMax, moduleReady, description, firmware, requirements, evidence.` }, { role: "user", content: `Requested part: ${partNumber || "not supplied"}\nSource: ${finalUrl}\n\n${text}` }], 1200, 0, deadlineAt);
  try {
    const record = writeCachedPart(manifestFromExtraction(partNumber, finalUrl, extraction));
    addRuntimeComponentManifest(record);
    await saveComponentManifest(record.id, record);
    return { record, alternatives: [] as ComponentRegistryRecord[] };
  } catch (error) {
    return { record: null, alternatives: suggestValidatedAlternatives(`${partNumber} ${(extraction as { category?: string; capabilities?: string[] }).category || ""} ${((extraction as { capabilities?: string[] }).capabilities || []).join(" ")}`), error: error instanceof Error ? error.message : "The datasheet could not be validated." };
  }
}
