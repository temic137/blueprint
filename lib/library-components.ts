import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { COMPONENTS, type ComponentRegistryRecord } from "./project.ts";

const title = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

function familyFor(pins: readonly string[]) {
  const has = (...required: string[]) => required.every((pin) => pins.includes(pin));
  if (has("VCC", "GND", "SDA", "SCL")) return "generic_i2c_module";
  if (has("VCC", "GND", "SCK", "MISO", "MOSI", "CS")) return "generic_spi_module";
  if (has("VCC", "GND", "TX", "RX")) return "generic_uart_module";
  if (has("VCC", "GND", "OUT")) return "generic_digital_sensor";
  return "";
}

function wokwiRecords(root: string) {
  const directory = path.join(root, "@wokwi", "elements", "dist", "esm");
  const knownTags = new Set(Object.values(COMPONENTS).map((component) => component.tag).filter(Boolean));
  return readdirSync(directory).filter((file) => file.endsWith("-element.js") && !file.includes(".spec.")).flatMap((file): ComponentRegistryRecord[] => {
    const slug = file.replace(/-element\.js$/, "");
    const tag = `wokwi-${slug}`;
    if (knownTags.has(tag)) return [];
    const source = readFileSync(path.join(directory, file), "utf8");
    const pinBlock = source.match(/pinInfo\s*=\s*\[([\s\S]*?)\];/)?.[1] || "";
    const pins = [...pinBlock.matchAll(/name:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
    const baseType = familyFor(pins);
    return [{
      id: `wokwi_${slug.replaceAll("-", "_")}`,
      name: title(slug), aliases: [slug], category: "library component",
      capabilities: baseType ? [`${baseType.replace(/^generic_|_module$/g, "")}`] : [],
      supportLevel: baseType ? "generic-family" : "visual-only",
      source: "@wokwi/elements", baseType, pins,
      description: baseType ? `Discovered from Wokwi Elements and mapped to the validated ${COMPONENTS[baseType]!.name} interface` : "Visual discovered from Wokwi Elements; electrical behavior is not validated",
      visual: tag,
    }];
  });
}

function symbolRecords(root: string) {
  const declaration = readFileSync(path.join(root, "schematic-symbols", "dist", "index.d.ts"), "utf8");
  const catalog = declaration.slice(declaration.indexOf("declare const _default:"), declaration.indexOf("\n};", declaration.indexOf("declare const _default:")));
  const names = [...catalog.matchAll(/^    ([a-z][a-z0-9_]+):/gm)].map((match) => match[1]!)
    .map((name) => name.replace(/_(?:down|horz|left|right|up|vert)$/, ""));
  return [...new Set(names)].map((name): ComponentRegistryRecord => ({
    id: `symbol_${name}`, name: title(name), aliases: [name.replaceAll("_", " ")], category: "schematic symbol",
    capabilities: [], supportLevel: "visual-only", source: "schematic-symbols", baseType: "", pins: [],
    description: "Generic schematic symbol; no manufacturer pinout or firmware metadata",
  }));
}

export function discoverLibraryComponents(root = path.join(process.cwd(), "node_modules")) {
  const errors: string[] = [];
  const load = (source: string, reader: () => ComponentRegistryRecord[]) => {
    try { return reader(); } catch (error) { errors.push(`${source}: ${error instanceof Error ? error.message : "could not read library"}`); return []; }
  };
  const wokwi = load("@wokwi/elements", () => wokwiRecords(root));
  const symbols = load("schematic-symbols", () => symbolRecords(root));
  return { records: [...wokwi, ...symbols], errors, sources: { wokwi: wokwi.length, schematicSymbols: symbols.length } };
}
