import { z } from "zod";
import { completeJson } from "./ai.ts";
import { registryCatalogForPrompt } from "./component-manifests.ts";
import { type ProjectSpec } from "./project.ts";
import type { AssistantMessage } from "./db.ts";

const AnswerSchema = z.object({
  intent: z.literal("answer"),
  reply: z.string().min(10).max(3000),
}).strict();

const ClarifySchema = z.object({
  intent: z.literal("clarify"),
  reply: z.string().min(5).max(800),
}).strict();

const ChangeSchema = z.object({
  intent: z.literal("change"),
  reply: z.string().min(10).max(1200),
  changeRequest: z.string().min(10).max(1800),
}).strict();

export const AssistantDecisionSchema = z.discriminatedUnion("intent", [AnswerSchema, ClarifySchema, ChangeSchema]);
export type AssistantDecision = z.infer<typeof AssistantDecisionSchema>;

const ASSISTANT_PROMPT = `You are Blueprint's conversational electronics assistant. Understand the user's meaning from the whole conversation, not from keywords or fixed phrases.

The current project is your primary context; it may be a pending preview the user is reviewing. You may answer general electronics questions, but connect them to this project whenever useful. Treat the latest user message as part of the ongoing dialogue: it may answer a question, approve or reject a proposal, alter one detail of a proposal, ask a follow-up question, or start a new topic.

For technical answers, inspect the exact stored components, endpoint-to-endpoint connections, and firmware instead of relying on a typical circuit from memory. If you use a formula, calculate it and make sure the component placement described in prose matches the formula and the stored wiring. If the project does not contain enough evidence for a claim, say what is unknown rather than inventing it. Keep the answer focused on the question.

Choose exactly one intent:
- answer: the user wants information, comparison, diagnosis, advice, or is declining/postponing a change. Do not alter the project.
- clarify: the user's desired behavior or a real external constraint is genuinely unresolved. Ask one or two short, specific questions. Do not ask them to choose GPIO pins, ordinary power wiring, standard supporting parts, libraries, or other implementation details a competent engineer can safely choose from the validated catalog. Do not force the user to use technical terminology.
- change: the user currently authorizes an alteration. This includes context-dependent approval of a concrete earlier proposal, regardless of wording. Return a standalone changeRequest that an engineer could execute without seeing the conversation.

For a changeRequest, resolve references from the conversation and project. State what is added, removed, replaced, or modified; the intended behavior; important values already agreed upon; dependencies discussed; and what existing behavior must remain. Do not design the circuit here—the engineering planner will do that and may ask its own safety clarification.

For recommendations and comparisons, choose the best sensible default from the current project's requirements and explain the decisive tradeoff. Do not ask what "best" or "recommend" means when the project provides enough context to make a useful recommendation.

When the user answers a clarification about a requested change and supplies the missing requirement, continue that change once it is clear unless they explicitly postpone or reject it. Do not turn their answer into general advice or ask them to reconfirm the same decision.

Never treat general agreement as authorization when there is no concrete change under discussion. Never turn a hypothetical question or recommendation request into a change. Never claim that a change has already been applied; Blueprint will first build and validate a preview.
An answer must answer the user now. Never use answer to promise that Blueprint will build, prepare, apply, implement, add, remove, replace, update, or change the project later; use change for that.

For answer return exactly {"intent":"answer","reply":"..."}.
For clarify return exactly {"intent":"clarify","reply":"..."}.
For change return exactly {"intent":"change","reply":"...","changeRequest":"..."}.
Return JSON only.`;

export function projectContext(project: ProjectSpec, includeFirmware = false) {
  const { files, generation: _generation, ...fullContext } = project;
  const context = includeFirmware ? fullContext : {
    title: project.title,
    summary: project.summary,
    board: project.board,
    boardMeta: project.boardMeta ? {
      name: project.boardMeta.name,
      family: project.boardMeta.family,
      logicVoltage: project.boardMeta.logicVoltage,
    } : undefined,
    components: project.components,
    connections: project.connections,
  };
  return JSON.stringify({
    ...context,
    firmware: includeFirmware ? files : { platformio: files.platformioIni.slice(0, 800), mainCppCharacters: files.mainCpp.length },
  });
}

type Complete = typeof completeJson;

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const text = value.map(textValue).filter(Boolean).join("; ");
    return text || undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["changeRequest", "change_request", "request", "description", "summary"]) {
    const text = textValue(record[key]);
    if (text) return text;
  }
  const text = Object.entries(record)
    .map(([key, item]) => {
      const valueText = textValue(item);
      return valueText ? `${key.replaceAll("_", " ")}: ${valueText}` : "";
    })
    .filter(Boolean)
    .join("; ");
  return text || undefined;
}

function normalizeDecision(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const root = raw as Record<string, unknown>;
  const wrapped = ["decision", "response", "result"].map((key) => root[key]).find((value) => value && typeof value === "object" && !Array.isArray(value));
  const decision = (wrapped || root) as Record<string, unknown>;
  if (decision.intent !== "change") return decision;
  const candidate = decision.changeRequest ?? decision.change_request ?? decision.request ?? decision.change;
  const changeRequest = textValue(candidate);
  if (!changeRequest) return decision;
  const normalized: Record<string, unknown> = { ...decision, changeRequest };
  delete normalized.change_request;
  delete normalized.request;
  delete normalized.change;
  return normalized;
}

function recoveredChangeRequest(history: AssistantMessage[], pendingIndex: number, pendingDecision: Record<string, unknown>) {
  const originalRequest = textValue(pendingDecision.originalRequest);
  if (!originalRequest) return undefined;
  const followUp = history
    .slice(pendingIndex + 1)
    .filter((item) => item.role === "user")
    .map((item) => item.content.trim())
    .filter(Boolean)
    .slice(-5)
    .join(" ");
  const discussed = [...history.slice(pendingIndex + 1)]
    .reverse()
    .find((item) => item.role === "assistant" && item.kind === "answer")?.content.trim();
  return [
    `Implement this requested project change: ${originalRequest}.`,
    followUp ? `Requirements confirmed afterward: ${followUp}.` : "",
    discussed ? `Engineering interpretation already discussed: ${discussed}.` : "",
    "Preserve every current project behavior and component not explicitly replaced.",
  ].filter(Boolean).join(" ").slice(0, 1800);
}

function promisesPendingProjectChange(decision: AssistantDecision) {
  return decision.intent === "answer"
    && /\b(?:i|we)\s*(?:will|'ll|can)\s+(?:build|prepare|apply|implement|add|remove|replace|update|change|modify|proceed)\b/i.test(decision.reply);
}

export async function interpretAssistantMessage(
  project: ProjectSpec,
  originalPrompt: string,
  message: string,
  history: AssistantMessage[],
  complete: Complete = completeJson,
): Promise<AssistantDecision> {
  const deadlineAt = Date.now() + 30_000;
  const usefulHistory = history.filter((item) => item.kind !== "error");
  if (usefulHistory.at(-1)?.role === "user" && usefulHistory.at(-1)?.content.trim() === message.trim()) usefulHistory.pop();
  const recentConversation = usefulHistory.slice(-6)
    .map((item) => `${item.role.toUpperCase()} (${item.kind}): ${item.content.slice(0, 800)}`)
    .join("\n");
  const pendingIndex = history.findLastIndex((item) => item.role === "assistant" && item.kind === "clarify" && item.metadata?.pendingDecision);
  const pendingDecision = pendingIndex >= 0 ? history[pendingIndex]!.metadata?.pendingDecision as Record<string, unknown> | undefined : undefined;
  const includeFirmware = /firmware|code|program|compile|library|setup\s*\(|loop\s*\(|main\.cpp|platformio/i.test(message);
  const needsRegistry = /\b(?:available|supported?|catalog|registry|component|part|module|sensor|motor|driver|camera|display)\b/i.test(message);
  const registry = needsRegistry
    ? registryCatalogForPrompt(`${message}\n${recentConversation}\n${project.components.map((component) => component.name).join(" ")}`)
    : { text: "Not loaded because this question does not require component discovery." };
  const messages = [
    {
      role: "system" as const,
      content: `${ASSISTANT_PROMPT}\n\nRelevant component registry:\n${registry.text}`,
    },
    {
      role: "user" as const,
      content: `Original idea:\n${originalPrompt}\n\nCurrent validated project:\n${projectContext(project, includeFirmware)}\n\nPending decision to resolve, if any:\n${pendingDecision ? JSON.stringify(pendingDecision) : "None."}\n\nRecent conversation (oldest to newest):\n${recentConversation || "No earlier messages."}\n\nNew user message:\n${message}`,
    },
  ];
  let errors: string[] = [];
  let receivedResponse = false;
  let lastProviderError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const correction = attempt
        ? [{ role: "user" as const, content: `Your previous response was unusable: ${errors.join("; ")}. Re-read the dialogue, infer the user's current intent semantically, and return only the required JSON.` }]
        : [];
      const raw = await complete("assistant", [...messages, ...correction], 600, attempt, deadlineAt);
      receivedResponse = true;
      const normalized = normalizeDecision(raw);
      const parsed = AssistantDecisionSchema.safeParse(normalized);
      if (parsed.success) {
        if (pendingDecision && promisesPendingProjectChange(parsed.data)) {
          const recovered = ChangeSchema.safeParse({
            intent: "change",
            reply: parsed.data.reply,
            changeRequest: recoveredChangeRequest(history, pendingIndex, pendingDecision),
          });
          if (recovered.success) return recovered.data;
        }
        return parsed.data;
      }
      const malformedChange = normalized && typeof normalized === "object" && !Array.isArray(normalized)
        ? normalized as Record<string, unknown>
        : undefined;
      if (malformedChange?.intent === "change" && pendingDecision) {
        const recovered = ChangeSchema.safeParse({
          intent: "change",
          reply: textValue(malformedChange.reply) || "I’ll prepare this as a validated project preview.",
          changeRequest: recoveredChangeRequest(history, pendingIndex, pendingDecision),
        });
        if (recovered.success) return recovered.data;
      }
      errors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    } catch (error) {
      lastProviderError = error;
      errors = [error instanceof Error ? error.message : "The model response could not be read."];
    }
  }
  if (!receivedResponse && lastProviderError) throw lastProviderError;
  throw new Error(`No model produced a valid assistant response: ${errors.join(" ")}`);
}
