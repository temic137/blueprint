import { NextResponse } from "next/server";
import { listRecentProjects } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ projects: await listRecentProjects() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load recent projects." }, { status: 500 });
  }
}
