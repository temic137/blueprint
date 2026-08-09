import { NextResponse } from "next/server";
import { federatedComponentRegistry } from "@/lib/component-manifests";
import { searchRegistryRecords } from "@/lib/project";
import { ingestDatasheet } from "@/lib/datasheet-registry";
import { discoverAndIngestDigiKeyPart } from "@/lib/digikey";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() || "";
  const limit = Math.min(50, Math.max(1, Number.parseInt(searchParams.get("limit") || "20", 10) || 20));
  const { records: all, errors, sources } = federatedComponentRegistry();
  const records = query ? searchRegistryRecords(query, all, limit) : all.slice(0, limit);
  return NextResponse.json({
    records,
    errors,
    stats: {
      total: all.length,
      validated: all.filter((record) => record.supportLevel === "validated").length,
      genericFamilies: all.filter((record) => record.supportLevel === "generic-family").length,
      datasheetDerived: all.filter((record) => record.supportLevel === "datasheet-derived").length,
      visualOnly: all.filter((record) => record.supportLevel === "visual-only").length,
      sources,
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { datasheetUrl?: unknown; partNumber?: unknown; query?: unknown };
    const datasheetUrl = String(body.datasheetUrl || "").trim();
    const partNumber = String(body.partNumber || "").trim().slice(0, 120);
    const query = String(body.query || "").trim().slice(0, 120);
    if (!datasheetUrl && !query) return NextResponse.json({ error: "A query or datasheetUrl is required." }, { status: 400 });
    const result = datasheetUrl ? await ingestDatasheet(datasheetUrl, partNumber) : await discoverAndIngestDigiKeyPart(query);
    if (!result.record) return NextResponse.json({ error: result.error, alternatives: result.alternatives }, { status: 422 });
    return NextResponse.json({ record: result.record, cached: true }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not import this datasheet." }, { status: 422 });
  }
}
