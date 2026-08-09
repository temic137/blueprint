import { NextResponse } from "next/server";
import { getProject } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Invalid project id." }, { status: 400 });
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const url = process.env.COMPILER_SERVICE_URL;
  const secret = process.env.COMPILER_SERVICE_SECRET;
  if (!url || !secret) return NextResponse.json({ error: "Firmware compiler is not configured." }, { status: 503 });

  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ platformioIni: project.files.platformioIni, mainCpp: project.files.mainCpp }),
      signal: AbortSignal.timeout(240_000),
    });
    const result = await response.json() as { ok?: boolean; error?: string; details?: string };
    return NextResponse.json(result, { status: response.ok && result.ok ? 200 : response.status || 422 });
  } catch (error) {
    return NextResponse.json({ error: "Firmware compiler is temporarily unavailable.", details: error instanceof Error ? error.message : "Connection failed." }, { status: 503 });
  }
}
