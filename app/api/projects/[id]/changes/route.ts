import { NextResponse } from "next/server";
import { previewProjectChange } from "@/lib/change-project";
import { AIProviderError, isRateLimitError } from "@/lib/ai";
import { applyChangePreview, getProject, getProjectPrompt, saveAssistantMessage, saveChangePreview } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as { request?: unknown };
    if (typeof body.request !== "string" || body.request.trim().length < 5 || body.request.length > 800) return NextResponse.json({ error: "Describe the change in 5–800 characters." }, { status: 400 });
    const project = await getProject(id);
    const originalPrompt = await getProjectPrompt(id);
    if (!project || !originalPrompt) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const changeRequest = body.request.trim();
    const preview = await previewProjectChange(project, originalPrompt, changeRequest);
    if ("clarification" in preview) return NextResponse.json({ clarification: preview.clarification });
    const previewId = await saveChangePreview(id, changeRequest, preview.project, preview.impact);
    return NextResponse.json({ previewId, impact: preview.impact, result: { title: preview.project.title, components: preview.project.components.length, connections: preview.project.connections.length } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown change error";
    console.error("Change preview failed:", message);
    const limited = isRateLimitError(error);
    const retryAfterMs = error instanceof AIProviderError ? error.retryAfterMs : 0;
    const invalidWiring = /unsupported endpoint/i.test(message);
    const errorMessage = limited
      ? `Groq is currently rate-limited.${retryAfterMs ? ` Try again in about ${Math.max(1, Math.ceil(retryAfterMs / 1_000))} seconds.` : " Try again after the quota window resets."}`
      : invalidWiring
        ? "Blueprint rejected wiring that used a component or terminal outside the validated project. No changes were made. Please retry the request."
        : message.includes("No changes were made") ? message : `Blueprint could not produce a safe change preview: ${message.slice(0, 260)}`;
    return NextResponse.json({ error: errorMessage, code: limited ? "RATE_LIMIT" : "CHANGE_FAILURE", retryAfterMs }, { status: limited ? 429 : 422 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as { previewId?: unknown };
    if (typeof body.previewId !== "string") return NextResponse.json({ error: "Preview id is required." }, { status: 400 });
    const revision = await applyChangePreview(id, body.previewId);
    await saveAssistantMessage(id, "assistant", "applied", `Applied the approved project change as revision ${String(revision).padStart(2, "0")}.`, { revision });
    return NextResponse.json({ revision });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not apply change.";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
