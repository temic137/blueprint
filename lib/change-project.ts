import { z } from "zod";
import { completeJson, isRateLimitError, usageSnapshot } from "./ai.ts";
import { buildProject, normalizeArchitecture } from "./build-project.ts";
import { BOARD_PROFILES, boardsCatalogForPrompt, ensureBoardCard, toBoardProfile } from "./boards.ts";
import { registryCatalogForPrompt } from "./component-manifests.ts";
import { ArchitectureSchema, catalogLimitationsForPrompt, validateArchitecture, validateIntentCoverage, type ProjectSpec } from "./project.ts";
import { ensureKitDependencies } from "./supported-kit.ts";

const connectionSchema = z.object({
  fromComponent: z.string(), fromPin: z.string(), toComponent: z.string(), toPin: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), purpose: z.string().min(2).max(100),
}).strict();

export const ChangePlanSchema = ArchitectureSchema.extend({
  understanding: z.string().min(5).max(1800),
  clarificationQuestion: z.string().min(5).max(800).nullable(),
  changeSummary: z.string().min(5).max(800),
  scope: z.enum(["firmware", "hardware", "project"]),
  risk: z.enum(["low", "medium", "high"]),
  warnings: z.array(z.string().min(3).max(800)).max(8),
  connections: z.array(connectionSchema).min(2).max(50).optional(),
  instructions: z.array(z.string().min(3).max(300)).min(3).max(20).optional(),
  explanations: z.array(z.object({
    componentId: z.string().regex(/^[a-z][a-z0-9_]*$/),
    text: z.string().min(5).max(240),
  }).strict()).max(20).optional(),
}).strict();
export type ChangePlan = z.infer<typeof ChangePlanSchema>;

const CHANGE_PROMPT = `You are Blueprint's engineering change planner. Revise an existing low-voltage maker project in response to one user change request.
Preserve every unaffected behavior and component. Every component must use a record from the registry below. For each registry record, use its stated base component type in the type field and its exact product name in the name field. A replacement must include every dependency needed to use it safely; never pretend unlike parts are interchangeable. If the requested hardware is unsupported, preserve the current architecture and explain that limitation in warnings.
First state your plain-language understanding of the request. Never guess when a word, number, component, or intended behavior could reasonably mean two different things. In that case set clarificationQuestion to one short, specific question and otherwise preserve the current architecture. Set clarificationQuestion to null only when the request is clear enough to implement.
Choose scope "firmware" when no hardware must change, "hardware" when parts or wiring must change, and "project" for a substantial change of purpose. Risk is low for behavior-only changes, medium for ordinary low-voltage hardware changes, and high when the request cannot be implemented safely.
Preserve the current board unless the change requires replacing it. Choose board from the board catalog (Arduino, Pico, ESP32, Raspberry Pi, …) when a swap is needed. Choose safe conventional pins yourself; ask the user only about intended behavior or genuine external constraints, never GPIO pick-lists.
Select the resulting board and components only. Include required drivers and supporting parts, but do not design wiring: Blueprint's deterministic circuit engine assigns pins, power, ground, buses, passives, and connections after this plan is accepted.
Return JSON with: title, summary, board, components [{id,type,name,quantity}], parts, understanding, clarificationQuestion, changeSummary, scope, risk, warnings.

Installed Wokwi visuals that are intentionally unavailable (never select them; explain the matching limitation to the user):
${catalogLimitationsForPrompt()}`;

export function normalizeChangePlan(raw: unknown, registry: Parameters<typeof normalizeArchitecture>[1] = []) {
  const normalized = normalizeArchitecture(raw, registry);
  if (!normalized || typeof normalized !== "object") return normalized;
  const value = normalized as Record<string, unknown>;
  const warningValues = Array.isArray(value.warnings) ? value.warnings : typeof value.warnings === "string" ? [value.warnings] : [];
  const warnings = warningValues.map((warning) => typeof warning === "string" ? warning.trim() : "").filter((warning) => warning.length >= 3).slice(0, 8);
  const text = (candidate: unknown, fallback: string) => typeof candidate === "string" && candidate.trim() ? candidate.trim() : fallback;
  const clarificationQuestion = typeof value.clarificationQuestion === "string" && value.clarificationQuestion.trim() ? value.clarificationQuestion.trim() : null;
  return {
    title: value.title,
    summary: value.summary,
    board: value.board,
    boardMeta: value.boardMeta,
    components: value.components,
    parts: value.parts,
    understanding: text(value.understanding, text(value.changeSummary, "Apply the requested project change.")),
    clarificationQuestion,
    changeSummary: text(value.changeSummary, text(value.summary, "Applied the requested project change.")),
    scope: ["firmware", "hardware", "project"].includes(String(value.scope)) ? value.scope : "hardware",
    risk: ["low", "medium", "high"].includes(String(value.risk)) ? value.risk : "medium",
    warnings,
  };
}

export function isImplementationClarification(question: string) {
  return /\b(?:gpio|io\s*\d+|which\s+pin|pin\s+(?:number|assignment|should|to\s+use)|vin|3v3|resistor\s+value|library|wire\s+it)\b/i.test(question);
}

export function boardResourceSummary(project: ProjectSpec) {
  const profile = project.boardMeta || BOARD_PROFILES[project.board];
  if (!profile) throw new Error(`Unknown board card: ${project.board}`);
  const signalPins = [...profile.signalPins];
  const used = [...new Set(project.connections.flatMap((wire) => [wire.fromComponent === "board" ? wire.fromPin : "", wire.toComponent === "board" ? wire.toPin : ""]).filter((pin) => signalPins.includes(pin)))];
  return { board: profile.name, signalPins, usedSignalPins: used, freeSignalPins: signalPins.filter((pin) => !used.includes(pin)), note: "Blueprint chooses implementation pins. Shared buses may reuse compatible signal pins." };
}

function connectionKey(connection: ProjectSpec["connections"][number]) {
  return [`${connection.fromComponent}.${connection.fromPin}`, `${connection.toComponent}.${connection.toPin}`].sort().join("--");
}

export function projectImpact(before: ProjectSpec, after: ProjectSpec, plan: ChangePlan) {
  const oldComponents = new Map(before.components.map((component) => [component.id, component]));
  const newComponents = new Map(after.components.map((component) => [component.id, component]));
  const added = after.components.filter((component) => !oldComponents.has(component.id)).map((component) => component.name);
  const removed = before.components.filter((component) => !newComponents.has(component.id)).map((component) => component.name);
  const changed = after.components.flatMap((component) => {
    const previous = oldComponents.get(component.id);
    return previous && (previous.type !== component.type || previous.name !== component.name) ? [`${previous.name} → ${component.name}`] : [];
  });
  if (before.board !== after.board) changed.unshift(`MCU1: ${before.boardMeta?.name || BOARD_PROFILES[before.board]?.name || before.board} → ${after.boardMeta?.name || BOARD_PROFILES[after.board]?.name || after.board}`);
  const beforeWires = new Set(before.connections.map(connectionKey));
  const afterWires = new Set(after.connections.map(connectionKey));
  const wiringChanges = [...beforeWires].filter((wire) => !afterWires.has(wire)).length + [...afterWires].filter((wire) => !beforeWires.has(wire)).length;
  const hardwareChanged = Boolean(before.board !== after.board || added.length || removed.length || changed.length || wiringChanges);
  const scope = plan.scope === "project" ? "project" : hardwareChanged ? "hardware" : "firmware";
  const risk = plan.risk === "high" ? "high" : hardwareChanged || plan.risk === "medium" ? "medium" : "low";
  const warnings = [...new Set([
    ...plan.warnings,
  ])];
  return {
    summary: plan.changeSummary,
    understanding: plan.understanding,
    scope,
    risk,
    warnings,
    components: { added, removed, changed },
    wiringChanges,
    firmwareChanged: before.files.mainCpp !== after.files.mainCpp || before.files.platformioIni !== after.files.platformioIni,
  };
}

export type ChangeImpact = ReturnType<typeof projectImpact>;

export function connectionsToPreserve(current: ProjectSpec, plan: ChangePlan) {
  const plannedTypes = new Map(plan.components.map((component) => [component.id, component.type]));
  const currentHasServoDriver = current.components.some((component) => component.type === "pca9685");
  const plannedHasServoDriver = plan.components.some((component) => component.type === "pca9685");
  const servoTopologyChanged = currentHasServoDriver !== plannedHasServoDriver;
  const stableIds = new Set(current.components.filter((component) => plannedTypes.get(component.id) === component.type && !(servoTopologyChanged && component.type === "servo")).map((component) => component.id));
  const boardChanged = current.board !== plan.board;
  return current.connections.filter((connection) =>
    (!boardChanged || (connection.fromComponent !== "board" && connection.toComponent !== "board"))
    &&
    (connection.fromComponent === "board" || stableIds.has(connection.fromComponent))
    && (connection.toComponent === "board" || stableIds.has(connection.toComponent)));
}

export async function buildPlannedProject(current: ProjectSpec, originalPrompt: string, request: string, plan: ChangePlan, usageStart = usageSnapshot(), deadlineAt = Date.now() + 75_000) {
  const behavior = [
    `Original idea: ${originalPrompt}`,
    `Requested revision: ${request}`,
    `Required resulting behavior: ${plan.summary}`,
    "Preserve every unaffected component and connection. Add or rebuild only the hardware directly affected by this revision.",
  ].join("\n");
  const architecture = ArchitectureSchema.parse(ensureKitDependencies({
    title: plan.title,
    summary: plan.summary,
    board: plan.board,
    components: plan.components,
    parts: plan.parts,
  }));
  const withBoard = { ...architecture, boardMeta: plan.boardMeta || toBoardProfile(ensureBoardCard(plan.board)) };
  const revised = await buildProject(behavior, withBoard, usageStart, connectionsToPreserve(current, plan), completeJson, deadlineAt);
  return { project: revised, impact: projectImpact(current, revised, plan) };
}

export async function previewProjectChange(current: ProjectSpec, originalPrompt: string, request: string, complete: typeof completeJson = completeJson, build: typeof buildPlannedProject = buildPlannedProject) {
  const usageStart = usageSnapshot();
  const deadlineAt = Date.now() + 75_000;
  const registry = registryCatalogForPrompt(`${request}\n${originalPrompt}\n${current.components.map((component) => component.name).join(" ")}`, 60, true);
  const currentArchitecture = {
    title: current.title,
    summary: current.summary,
    board: current.board,
    components: current.components,
    parts: current.parts,
    connections: current.connections,
    instructions: current.instructions,
    explanations: current.explanations,
  };
  const messages = [
    { role: "system" as const, content: `${CHANGE_PROMPT}\n\nBoard catalog:\n${boardsCatalogForPrompt()}\n\nAvailable component registry:\n${registry.summary}` },
    { role: "user" as const, content: `Original project idea:\n${originalPrompt}\n\nCurrent validated project:\n${JSON.stringify(currentArchitecture)}\n\nCurrent board resource budget:\n${JSON.stringify(boardResourceSummary(current))}\n\nRequested change:\n${request}` },
  ];
  let plan: ChangePlan | undefined;
  let feedback = "";
  let lastErrors: string[] = [];
  let receivedResponse = false;
  let lastProviderError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    let raw: unknown;
    try {
      raw = await complete("change", feedback ? [...messages, { role: "user", content: feedback }] : messages, 1800, attempt, deadlineAt);
      receivedResponse = true;
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      lastProviderError = error;
      lastErrors = [error instanceof Error ? error.message : "The change-plan response could not be read."];
      feedback = `The previous provider response was unusable: ${lastErrors[0]} Return the complete corrected JSON.`;
      continue;
    }
    const parsed = ChangePlanSchema.safeParse(normalizeChangePlan(raw, registry.records));
    lastErrors = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    if (parsed.success) {
      if (parsed.data.clarificationQuestion && isImplementationClarification(parsed.data.clarificationQuestion)) {
        lastErrors.push("Do not ask the user to select GPIO pins, routine power rails, resistor values, libraries, or wiring. Choose the supported engineering default yourself and return clarificationQuestion as null.");
      }
      lastErrors.push(...validateArchitecture(parsed.data));
      lastErrors.push(...validateIntentCoverage(request, parsed.data));
      const previous = new Map(current.components.map((component) => [component.id, component]));
      for (const component of parsed.data.components) {
        const replaced = previous.get(component.id);
        if (!replaced || replaced.type === component.type) continue;
        const newName = component.name.toLowerCase();
        const staleTerms = replaced.name.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3 && !newName.includes(term));
        const staleText = `${parsed.data.title} ${parsed.data.summary}`.toLowerCase();
        if (staleTerms.some((term) => staleText.includes(term))) lastErrors.push(`Update the title and summary so they no longer name the replaced component "${replaced.name}".`);
        if (component.type === "rotary_encoder" && staleText.includes("analog")) lastErrors.push("A rotary encoder is digital, so the title and summary must not describe it as analog.");
      }
      if (!lastErrors.length) { plan = parsed.data; break; }
    }
    feedback = `Correct these change-plan errors:\n${lastErrors.join("\n")}\nReturn the complete corrected component plan. Do not return wiring.`;
  }
  if (!plan && !receivedResponse && lastProviderError) throw lastProviderError;
  if (!plan && lastErrors.some((error) => /supported component type|unsupported component/i.test(error))) throw new Error("The requested hardware is not yet in Blueprint's validated component catalog. No changes were made.");
  if (!plan) throw new Error(`No model produced a valid change plan: ${lastErrors.join(" ")}`);
  if (plan.clarificationQuestion) return { clarification: { understanding: plan.understanding, question: plan.clarificationQuestion } };
  return build(current, originalPrompt, request, plan, usageStart, deadlineAt);
}
