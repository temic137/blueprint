import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AIProviderError, completeJson, isRateLimitError, usageSnapshot } from "@/lib/ai";
import { buildProject, normalizeArchitecture, normalizeExplanations } from "@/lib/build-project";
import { ensureBoardCard, toBoardProfile } from "@/lib/boards";
import { registryCatalogForPrompt, setRuntimeComponentManifests } from "@/lib/component-manifests";
import { ArchitectureSchema, catalogLimitationsForPrompt, unsupportedRequestedParts, validateArchitecture, validateHardware, validateIntentCoverage } from "@/lib/project";
import { ingestDatasheet, suggestValidatedAlternatives } from "@/lib/datasheet-registry";
import { discoverAndIngestDigiKeyPart, hasDigiKeyCredentials } from "@/lib/digikey";
import { listComponentManifestValues, saveProject } from "@/lib/db";
import { complexityRejectMessage, isComplexityValidationFailure, looksBeyondCircuitScope } from "@/lib/scope-proposal";
import { synthesizeCircuit } from "@/lib/synthesize-circuit";
import {
  ensureKitDependencies,
  isKitBoard,
  kitCatalogForPrompt,
  matchKitTemplate,
  outOfKitMessage,
} from "@/lib/supported-kit";

export const runtime = "nodejs";

const ARCHITECT_PROMPT = `You are Blueprint's electronics architect for a small low-voltage project.

Allowed boards ONLY: arduino_uno, esp32dev, pico. Prefer arduino_uno for simple wired sensors. Use esp32dev only for Wi-Fi/Bluetooth. Use pico for RP2040.

Use only parts from the validated component registry supplied below. Use each registry ID as the component type. Hard limit: at most 12 parts. HC-SR04 needs two resistors. Each LED needs one resistor. Do NOT invent wiring — Blueprint wires the project. Give each part id like sensor_1 (lowercase a-z, 0-9, underscore).

Preserve every behavior and confirmed decision in the user brief. The title and summary must describe that exact project. Never invent an opposite stop condition or discard thresholds, ranges, timing, or monotonic behavior such as "faster as it gets closer."

Return JSON only: title, summary, board, components [{id,type,name,quantity}], parts, explanations [{componentId,text}] with componentId matching components[].id.

Unavailable visuals:
${catalogLimitationsForPrompt()}`;

function rejectComplexity(reason: string) {
  return NextResponse.json({ error: complexityRejectMessage(reason), code: "TOO_COMPLEX" }, { status: 422 });
}

function rejectOutOfKit(parts: { name: string }[]) {
  return NextResponse.json({ error: outOfKitMessage(parts), code: "OUT_OF_KIT" }, { status: 422 });
}

async function finishProject(
  prompt: string,
  architectureInput: ReturnType<typeof ArchitectureSchema.parse>,
  explanations: Array<{ componentId: string; text: string }>,
  usageStart: ReturnType<typeof usageSnapshot>,
  deadlineAt: number,
) {
  const filled = ensureKitDependencies(architectureInput);
  const architecture = ArchitectureSchema.parse(filled);
  if (!isKitBoard(architecture.board)) {
    return rejectOutOfKit([{ name: architecture.board }]);
  }
  const archErrors = [...validateArchitecture(architecture), ...validateIntentCoverage(prompt, architecture)];
  if (archErrors.length) {
    return NextResponse.json({ error: `Parts list still invalid after kit fixes: ${archErrors.join(" ")}` }, { status: 422 });
  }

  const boardMeta = toBoardProfile(ensureBoardCard(architecture.board));
  const withBoard = { ...architecture, boardMeta };
  let wiring: ReturnType<typeof synthesizeCircuit>;
  try {
    wiring = synthesizeCircuit(withBoard);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wiring engine failed.";
    return NextResponse.json({ error: `Blueprint could not wire this parts list: ${message}`, code: "WIRING_FAILURE" }, { status: 422 });
  }

  const hardwareErrors = validateHardware({
    ...withBoard,
    connections: wiring.connections,
    instructions: wiring.instructions,
    parts: architecture.parts,
  });
  if (hardwareErrors.length) {
    return NextResponse.json({ error: `Wiring engine produced an invalid circuit: ${hardwareErrors.join(" ")}` }, { status: 500 });
  }

  const project = await buildProject(prompt, withBoard, usageStart, [], completeJson, deadlineAt, {
    connections: wiring.connections,
    instructions: wiring.instructions,
    explanations: explanations.length ? explanations : normalizeExplanations({}, architecture.components),
  });
  const id = randomUUID();
  await saveProject(id, prompt, project);
  return NextResponse.json({ id });
}

export async function POST(request: Request) {
  const usageStart = usageSnapshot();
  const deadlineAt = Date.now() + 90_000;
  try {
    const body = await request.json() as { prompt?: unknown; resolvedPrompt?: unknown };
    const clarifiedPrompt = typeof body.resolvedPrompt === "string" ? body.resolvedPrompt.trim() : "";
    const wasClarified = clarifiedPrompt.length >= 10;
    const rawPrompt = wasClarified
      ? clarifiedPrompt
      : typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (rawPrompt.length < 10 || rawPrompt.length > 1000) {
      return NextResponse.json({ error: "Describe the project in 10–1000 characters." }, { status: 400 });
    }
    const prompt = rawPrompt;
    setRuntimeComponentManifests(await listComponentManifestValues());

    if (looksBeyondCircuitScope(prompt)) {
      return rejectComplexity("the brief asks for ML, translation, computer vision, apps, or other product-scale work");
    }

    let importedNewPart = false;
    const datasheetLinks = [...prompt.matchAll(/https:\/\/[^\s)\]}]+/gi)].map((match) => match[0]!);
    for (const datasheetUrl of datasheetLinks.slice(0, 2)) {
      const nearbyPart = prompt.slice(Math.max(0, prompt.indexOf(datasheetUrl) - 80), prompt.indexOf(datasheetUrl)).match(/[A-Za-z][A-Za-z0-9-]{3,}\s*$/)?.[0]?.trim() || "";
      const imported = await ingestDatasheet(datasheetUrl, nearbyPart);
      if (!imported.record) return NextResponse.json({ error: imported.error, code: "DATASHEET_UNSUPPORTED", alternatives: imported.alternatives }, { status: 422 });
      importedNewPart = true;
    }

    // 1) Registry lookup and optional trusted discovery.
    // Resolve explicit part numbers before choosing a template or spending the architect call.
    let registry = registryCatalogForPrompt(prompt, 40);
    const kit = kitCatalogForPrompt();
    const knownBoards = [...kit.boards.split("\n").map((line) => line.split(":")[0]!), "arduino", "uno", "esp32", "pico"];
    let unsupported = unsupportedRequestedParts(prompt, registry.records, knownBoards);
    const discoveryErrors: string[] = [];
    if (unsupported.length && hasDigiKeyCredentials()) {
      for (const part of unsupported.slice(0, 2)) {
        try {
          const imported = await discoverAndIngestDigiKeyPart(part, Math.min(deadlineAt, Date.now() + 40_000));
          if (!imported.record && imported.error) discoveryErrors.push(imported.error);
          if (imported.record) importedNewPart = true;
        } catch (error) {
          discoveryErrors.push(error instanceof Error ? error.message : `Could not search DigiKey for ${part}.`);
        }
      }
      registry = registryCatalogForPrompt(prompt, 40);
      unsupported = unsupportedRequestedParts(prompt, registry.records, knownBoards);
    }
    if (unsupported.length) {
      const alternatives = suggestValidatedAlternatives(prompt);
      const discovery = hasDigiKeyCredentials() ? discoveryErrors.join(" ") : "Automatic DigiKey search is unavailable until DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET are added to .env.";
      const suggestion = alternatives.length ? ` Closest validated alternatives: ${alternatives.map((part) => part.name).join(", ")}.` : "";
      return NextResponse.json({ error: `Blueprint does not yet have a validated electrical record for: ${unsupported.join(", ")}. ${discovery}${suggestion}`, code: "OUT_OF_KIT", alternatives }, { status: 422 });
    }

    // Newly imported parts go through the architect so a broad starter template
    // cannot silently omit the component the user explicitly requested.
    const hasBehaviorDetails = /\b(when|until|above|below|over|under|faster|slower|between|after|before|degrees?|percent|random)\b|[%\d]/i.test(prompt);
    const template = !importedNewPart && !wasClarified && !hasBehaviorDetails ? matchKitTemplate(prompt) : undefined;
    if (template) {
      const { explanations: templateExplanations, ...templateFields } = template.architecture;
      const architecture = ArchitectureSchema.parse(templateFields);
      return finishProject(prompt, architecture, templateExplanations, usageStart, deadlineAt);
    }

    const messages = [{
      role: "system" as const,
      content: `${ARCHITECT_PROMPT}\n\nBoard catalog:\n${kit.boards}\n\nValidated component registry:\n${registry.text}`,
    }, { role: "user" as const, content: prompt }];

    let architecture: ReturnType<typeof ArchitectureSchema.parse> | undefined;
    let explanations: Array<{ componentId: string; text: string }> = [];
    let feedback = "";
    let lastErrors: string[] = [];
    let receivedResponse = false;
    let lastProviderError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: unknown;
      try {
        raw = await completeJson("architect", feedback ? [...messages, { role: "user", content: feedback }] : messages, 1400, attempt, deadlineAt);
        receivedResponse = true;
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        lastProviderError = error;
        lastErrors = [error instanceof Error ? error.message : "The architecture response could not be read."];
        feedback = `Unusable response: ${lastErrors[0]} Return board + kit parts only.`;
        continue;
      }

      const normalized = normalizeArchitecture(raw, registry.records);
      const componentCount = Array.isArray((normalized as { components?: unknown[] }).components)
        ? (normalized as { components: unknown[] }).components.length
        : 0;
      if (componentCount > 12) return rejectComplexity(`the design needed ${componentCount} parts (limit is 12)`);

      const { explanations: _ignored, ...architectureFields } = (normalized && typeof normalized === "object")
        ? normalized as Record<string, unknown>
        : {};
      void _ignored;
      const parsed = ArchitectureSchema.safeParse(architectureFields);
      lastErrors = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      if (parsed.success) {
        if (!isKitBoard(parsed.data.board)) lastErrors.push(`Board ${parsed.data.board} is outside the supported board set.`);
        const filled = ensureKitDependencies(parsed.data);
        lastErrors.push(...validateArchitecture(filled), ...validateIntentCoverage(prompt, filled));
        if (!lastErrors.length) {
          architecture = ArchitectureSchema.parse(filled);
          explanations = normalizeExplanations(raw, architecture.components);
          break;
        }
      }
      if (isComplexityValidationFailure(lastErrors)) return rejectComplexity(lastErrors.join("; "));
      feedback = `Fix these kit/architecture errors (board + kit parts only):\n${lastErrors.join("\n")}`;
    }

    if (!architecture && !receivedResponse && lastProviderError) throw lastProviderError;
    if (!architecture) {
      const rateLimited = lastErrors.some((error) => isRateLimitError(new Error(error)))
        || (lastProviderError ? isRateLimitError(lastProviderError) : false);
      if (rateLimited) {
        throw lastProviderError && isRateLimitError(lastProviderError)
          ? lastProviderError
          : new AIProviderError("RATE_LIMIT", lastErrors[0] || "Architect models are rate-limited.", "architect", 30_000);
      }
      if (isComplexityValidationFailure(lastErrors)) return rejectComplexity(lastErrors.join("; "));
      return NextResponse.json({ error: `No model produced a valid kit parts list: ${lastErrors.join(" ")}` }, { status: 422 });
    }

    return finishProject(prompt, architecture, explanations, usageStart, deadlineAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown generation error";
    console.error("Generation failed:", message);
    const limited = isRateLimitError(error);
    const retryAfterMs = error instanceof AIProviderError ? error.retryAfterMs : 0;
    const rateMessage = `AI providers are temporarily rate-limited.${retryAfterMs ? ` Try again in about ${Math.max(1, Math.ceil(retryAfterMs / 1_000))} seconds.` : " Wait for the reset window, then try again."}`;
    return NextResponse.json({
      error: limited ? rateMessage : `Blueprint could not produce a valid project: ${message.slice(0, 240)}`,
      code: limited ? "RATE_LIMIT" : "GENERATION_FAILURE",
      retryAfterMs,
    }, { status: limited ? 429 : 500 });
  }
}
