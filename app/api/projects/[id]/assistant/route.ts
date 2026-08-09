import { NextResponse } from "next/server";
import { interpretAssistantMessage } from "@/lib/assistant";
import { AIProviderError, isRateLimitError } from "@/lib/ai";
import { previewProjectChange } from "@/lib/change-project";
import { getLatestChangePreview, getProject, getProjectPrompt, listAssistantMessages, saveAssistantMessage, saveChangePreview } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!await getProject(id)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const messages = await listAssistantMessages(id);
  const pending = await getLatestChangePreview(id);
  const pendingIsConversational = messages.some((item) => item.kind === "preview" && item.metadata?.previewId === pending?.id);
  return NextResponse.json({ messages, pendingPreviewId: pendingIsConversational ? pending?.id : null });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json() as { message?: unknown };
    if (typeof body.message !== "string" || body.message.trim().length < 2 || body.message.length > 1200) return NextResponse.json({ error: "Write a message between 2 and 1200 characters." }, { status: 400 });
    const current = await getProject(id);
    const originalPrompt = await getProjectPrompt(id);
    if (!current || !originalPrompt) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    const message = body.message.trim();
    const history = await listAssistantMessages(id);
    const pending = await getLatestChangePreview(id);
    const pendingIsConversational = history.some((item) => item.kind === "preview" && item.metadata?.previewId === pending?.id);
    const base = pending && pendingIsConversational ? pending.spec : current;
    const last = history.at(-1);
    const previous = history.at(-2);
    const retryingSavedMessage = last?.role === "assistant" && last.kind === "error" && last.metadata?.code === "RATE_LIMIT" && previous?.role === "user" && previous.content === message;
    if (!retryingSavedMessage) await saveAssistantMessage(id, "user", "message", message);
    const decision = await interpretAssistantMessage(base, originalPrompt, message, history);
    if (decision.intent !== "change") {
      const metadata = decision.intent === "clarify" ? { pendingDecision: { originalRequest: message, question: decision.reply, source: "assistant" } } : undefined;
      const response = await saveAssistantMessage(id, "assistant", decision.intent, decision.reply, metadata);
      return NextResponse.json({ type: decision.intent, message: response });
    }
    const planned = await previewProjectChange(base, originalPrompt, decision.changeRequest);
    if ("clarification" in planned) {
      const response = await saveAssistantMessage(id, "assistant", "clarify", planned.clarification.question, { pendingDecision: { originalRequest: decision.changeRequest, question: planned.clarification.question, understanding: planned.clarification.understanding, source: "change-planner" } });
      return NextResponse.json({ type: "clarify", message: response });
    }
    const previewId = await saveChangePreview(id, decision.changeRequest, planned.project, planned.impact);
    const result = { title: planned.project.title, components: planned.project.components.length, connections: planned.project.connections.length };
    const response = await saveAssistantMessage(id, "assistant", "preview", `${decision.reply} ${planned.impact.summary}`.trim(), { previewId, impact: planned.impact, result });
    return NextResponse.json({ type: "preview", message: response });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The assistant could not respond.";
    console.error("Assistant failed:", message);
    const limited = isRateLimitError(error);
    const retryAfterMs = error instanceof AIProviderError ? error.retryAfterMs : 0;
    const wait = retryAfterMs ? ` Try again in about ${Math.max(1, Math.ceil(retryAfterMs / 1_000))} seconds.` : " Try again after Groq's reset window.";
    const safeMessage = limited ? `Groq is temporarily rate-limited. Your message is saved and will not be duplicated.${wait}` : `Blueprint could not respond safely: ${message.slice(0, 280)}`;
    if (await getProject(id)) await saveAssistantMessage(id, "assistant", "error", safeMessage, limited ? { code: "RATE_LIMIT", retryable: true, retryAfterMs } : { code: "ASSISTANT_FAILURE", retryable: true });
    return NextResponse.json({ error: safeMessage, code: limited ? "RATE_LIMIT" : "ASSISTANT_FAILURE", retryAfterMs }, { status: limited ? 429 : 422 });
  }
}
