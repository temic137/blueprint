import { NextResponse } from "next/server";
import { providerStatus } from "@/lib/ai";
import { federatedComponentRegistry } from "@/lib/component-manifests";

export const runtime = "nodejs";

export async function GET() {
  const { records, errors, sources } = federatedComponentRegistry();
  return NextResponse.json({
    ...providerStatus(),
    registry: {
      total: records.length,
      validated: records.filter((record) => record.supportLevel === "validated").length,
      genericFamilies: records.filter((record) => record.supportLevel === "generic-family").length,
      datasheetDerived: records.filter((record) => record.supportLevel === "datasheet-derived").length,
      visualOnly: records.filter((record) => record.supportLevel === "visual-only").length,
      errors: errors.length,
      sources,
    },
  });
}
