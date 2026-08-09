import { NextResponse } from "next/server";
import { getProject, listRevisions, restoreRevision } from "@/lib/db";
import { projectDiff, ProjectSpecSchema } from "@/lib/project";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await getProject(id);
  if (!current) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  return NextResponse.json({ revisions: (await listRevisions(id)).map((revision) => ({
    revision: revision.revision,
    request: revision.change_request,
    summary: revision.summary,
    createdAt: revision.created_at,
    details: projectDiff(current, ProjectSpecSchema.parse(JSON.parse(revision.spec))),
  })) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as { revision?: unknown };
    if (!Number.isInteger(body.revision) || Number(body.revision) < 1) return NextResponse.json({ error: "Valid revision number required." }, { status: 400 });
    const revision = await restoreRevision(id, Number(body.revision));
    return NextResponse.json({ revision });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Restore failed." }, { status: 409 });
  }
}
