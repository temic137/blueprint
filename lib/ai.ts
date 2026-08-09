import Groq from "groq-sdk";

export type AIStage = "architect" | "change" | "assistant" | "builder" | "firmware";
type Message = { role: "system" | "user"; content: string };
type Usage = { calls: number; inputTokens: number; outputTokens: number; providers: string[]; models: string[] };
type Quota = { remainingRequests?: number; remainingTokens?: number; resetRequests?: string; resetTokens?: string };
type ModelHealth = { quota: Quota; cooldownUntil: number; lastUsed: number; successes: number; failures: number };
type AIState = { usage: Usage; groqQuota: Quota; modelHealth: Record<string, ModelHealth> };

const globalAI = globalThis as unknown as { blueprintAI?: Partial<AIState> };
const state = globalAI.blueprintAI ||= {};
state.usage ||= { calls: 0, inputTokens: 0, outputTokens: 0, providers: [], models: [] };
state.groqQuota ||= {};
state.modelHealth ||= {};
const aiState = state as AIState;

const DEFAULT_CLOUDFLARE_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
];

function cloudflareConfigured() {
  return false;
}

export function cloudflareModelPool() {
  const fromList = configuredModels("CLOUDFLARE_AI_MODELS");
  const single = process.env.CLOUDFLARE_AI_MODEL?.trim();
  return [...new Set(fromList?.length ? fromList : single ? [single, ...DEFAULT_CLOUDFLARE_MODELS] : DEFAULT_CLOUDFLARE_MODELS)];
}

// Groq free-tier limits are per model — keep diverse backups so one TPM window does not block generate.
const DEFAULT_MODELS: Record<AIStage, string[]> = {
  architect: [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
  ],
  change: [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
  ],
  assistant: [
    "llama-3.1-8b-instant",
    "openai/gpt-oss-20b",
  ],
  builder: [
    "llama-3.1-8b-instant",
    "openai/gpt-oss-20b",
  ],
  firmware: [
    "llama-3.3-70b-versatile",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
  ],
};

function configuredModels(name: string) {
  return process.env[name]?.split(",").map((value) => value.trim()).filter(Boolean);
}

export function modelPool(stage: AIStage) {
  const configured = stage === "architect" ? configuredModels("GROQ_ARCHITECT_MODELS")
    : stage === "change" ? configuredModels("GROQ_CHANGE_MODELS") || configuredModels("GROQ_ARCHITECT_MODELS")
      : stage === "firmware" ? configuredModels("GROQ_FIRMWARE_MODELS") || configuredModels("GROQ_BUILDER_MODELS")
        : configuredModels("GROQ_ASSISTANT_MODELS") || configuredModels("GROQ_BUILDER_MODELS");
  return [...new Set(configured?.length ? configured : DEFAULT_MODELS[stage])];
}

export function aiRequestTimeout(stage: AIStage) {
  const configured = Number(process.env[stage === "architect" || stage === "change" ? "AI_ARCHITECT_TIMEOUT_MS" : "AI_BUILDER_TIMEOUT_MS"]);
  return Number.isFinite(configured) && configured >= 1_000 ? configured : stage === "assistant" || stage === "builder" ? 90_000 : stage === "firmware" ? 30_000 : 45_000;
}

function health(model: string) {
  return aiState.modelHealth[model] ||= { quota: {}, cooldownUntil: 0, lastUsed: 0, successes: 0, failures: 0 };
}

function durationMs(value?: string) {
  if (!value) return 0;
  const match = value.match(/(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  return match ? (Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 1_000 : 0;
}

function estimatedRequestTokens(messages: Message[], maxTokens: number) {
  return Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 3) + maxTokens;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function header(error: unknown, name: string) {
  const headers = (error as { headers?: Headers | Record<string, string> } | null)?.headers;
  if (!headers) return undefined;
  const get = (headers as { get?: unknown }).get;
  return typeof get === "function" ? (get as (name: string) => string | null).call(headers, name) || undefined : (headers as Record<string, string>)[name] || (headers as Record<string, string>)[name.toLowerCase()];
}

export class AIProviderError extends Error {
  code: "RATE_LIMIT" | "TIMEOUT" | "PERMISSION" | "PROVIDER";
  model: string;
  retryAfterMs: number;
  constructor(code: "RATE_LIMIT" | "TIMEOUT" | "PERMISSION" | "PROVIDER", message: string, model: string, retryAfterMs = 0) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
    this.model = model;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRateLimitError(error: unknown): error is AIProviderError {
  return error instanceof AIProviderError ? error.code === "RATE_LIMIT" : /\b429\b|rate.?limit|quota/i.test(error instanceof Error ? error.message : String(error));
}

function retryAfterFromMessage(message: string) {
  const match = message.match(/try again in (?:about )?(\d+(?:\.\d+)?)\s*s/i);
  return match ? Math.ceil(Number(match[1]) * 1_000) : 0;
}

function providerError(provider: string, model: string, timeout: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;
  const timedOut = (error instanceof Error && error.name === "TimeoutError") || /abort(?:ed)?.*timeout|timed? out/i.test(message);
  const rateLimited = status === 429 || /\b429\b|rate.?limit|quota/i.test(message);
  const permission = status === 403 || /permission|not enabled|blocked.*model|model_not_found|does not exist|do not have access/i.test(message);
  const retryAfterMs = Number(header(error, "retry-after") || 0) * 1_000 || retryAfterFromMessage(message);
  const code = rateLimited ? "RATE_LIMIT" : timedOut ? "TIMEOUT" : permission ? "PERMISSION" : "PROVIDER";
  return new AIProviderError(code, timedOut ? `${provider} ${model} timed out after ${timeout / 1_000} seconds.` : `${provider} ${model} failed: ${message}`, model, retryAfterMs);
}

function rankModels(stage: AIStage, models: string[]) {
  const pool = modelPool(stage);
  return [...models].sort((left, right) => {
    const a = health(left);
    const b = health(right);
    const aTokens = a.quota.remainingTokens ?? Number.MAX_SAFE_INTEGER;
    const bTokens = b.quota.remainingTokens ?? Number.MAX_SAFE_INTEGER;
    const aRequests = a.quota.remainingRequests ?? Number.MAX_SAFE_INTEGER;
    const bRequests = b.quota.remainingRequests ?? Number.MAX_SAFE_INTEGER;
    return bTokens - aTokens || bRequests - aRequests || a.lastUsed - b.lastUsed || pool.indexOf(left) - pool.indexOf(right);
  });
}

function availableModels(stage: AIStage, requiredTokens = 0) {
  const now = Date.now();
  const pool = modelPool(stage);
  for (const model of pool) {
    const modelHealth = health(model);
    if (modelHealth.quota.remainingTokens !== undefined && modelHealth.quota.remainingTokens < requiredTokens) {
      modelHealth.cooldownUntil = Math.max(modelHealth.cooldownUntil, modelHealth.lastUsed + durationMs(modelHealth.quota.resetTokens));
    }
  }
  const ready = pool.filter((model) => health(model).cooldownUntil <= now);
  if (!ready.length) {
    const next = pool.map((model) => ({ model, wait: Math.max(1_000, health(model).cooldownUntil - now) })).sort((a, b) => a.wait - b.wait)[0]!;
    throw new AIProviderError("RATE_LIMIT", `All compatible Groq models for ${stage} are cooling down.`, next.model, next.wait);
  }
  return rankModels(stage, ready);
}

export function parseModelJson(content: unknown) {
  if (content && typeof content === "object") return content;
  if (typeof content !== "string") throw new Error("Model returned no JSON content.");
  const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(clean) as unknown; }
  catch { throw new Error(`Model returned invalid JSON: ${clean.slice(0, 180)}`); }
}

function recordCall(provider: string, model: string) {
  aiState.usage.calls++;
  aiState.usage.providers.push(provider);
  aiState.usage.models.push(model);
}

function recordTokens(inputTokens = 0, outputTokens = 0) {
  aiState.usage.inputTokens += inputTokens;
  aiState.usage.outputTokens += outputTokens;
}

async function groqCompletion(stage: AIStage, model: string, messages: Message[], maxTokens: number, deadlineAt = Number.POSITIVE_INFINITY) {
  const remaining = deadlineAt - Date.now();
  if (remaining < 1_000) throw new AIProviderError("TIMEOUT", `Blueprint's ${stage} operation reached its overall time limit.`, model);
  const timeout = Math.min(aiRequestTimeout(stage), remaining);
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout, maxRetries: 0 });
  const modelHealth = health(model);
  modelHealth.lastUsed = Date.now();
  let completion;
  const request = (jsonMode: boolean) => {
    recordCall("Groq", model);
    return groq.chat.completions.create({
      model, messages, temperature: 0, max_completion_tokens: maxTokens, ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    }).withResponse();
  };
  try {
    completion = await request(true);
  } catch (error) {
    if (/json_validate_failed/i.test(error instanceof Error ? error.message : String(error))) {
      try { completion = await request(false); }
      catch (retryError) {
        const failure = providerError("Groq", model, timeout, retryError);
        modelHealth.failures++;
        modelHealth.cooldownUntil = Date.now() + (failure.retryAfterMs || (failure.code === "PERMISSION" ? 60 * 60_000 : failure.code === "RATE_LIMIT" ? 15_000 : 2_000));
        throw failure;
      }
    } else {
      const failure = providerError("Groq", model, timeout, error);
      modelHealth.failures++;
      modelHealth.cooldownUntil = Date.now() + (failure.retryAfterMs || (failure.code === "PERMISSION" ? 60 * 60_000 : failure.code === "RATE_LIMIT" ? 15_000 : 2_000));
      throw failure;
    }
  }
  const { data, response } = completion;
  const integer = (name: string) => { const value = response.headers.get(name); return value ? Number.parseInt(value, 10) : undefined; };
  const quota = {
    remainingRequests: integer("x-ratelimit-remaining-requests"), remainingTokens: integer("x-ratelimit-remaining-tokens"),
    resetRequests: response.headers.get("x-ratelimit-reset-requests") || undefined, resetTokens: response.headers.get("x-ratelimit-reset-tokens") || undefined,
  };
  aiState.groqQuota = quota;
  modelHealth.quota = quota;
  modelHealth.successes++;
  if (quota.remainingRequests === 0 || quota.remainingTokens === 0) modelHealth.cooldownUntil = Date.now() + Math.max(durationMs(quota.resetRequests), durationMs(quota.resetTokens), 1_000);
  recordTokens(data.usage?.prompt_tokens, data.usage?.completion_tokens);
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error(`${model} returned an empty response.`);
  return parseModelJson(content);
}

async function cloudflareCompletion(stage: AIStage, model: string, messages: Message[], maxTokens: number, deadlineAt = Number.POSITIVE_INFINITY) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new AIProviderError("PROVIDER", "Cloudflare Workers AI is not configured.", model);
  const remaining = deadlineAt - Date.now();
  if (remaining < 1_000) throw new AIProviderError("TIMEOUT", `Blueprint's ${stage} operation reached its overall time limit.`, model);
  const timeout = Math.min(aiRequestTimeout(stage), remaining);
  const modelHealth = health(`cf:${model}`);
  modelHealth.lastUsed = Date.now();
  recordCall("Cloudflare", model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: { choices?: Array<{ message?: { content?: string } }>; errors?: Array<{ message?: string }>; error?: { message?: string } };
    try { payload = JSON.parse(text) as typeof payload; }
    catch { throw new Error(text.slice(0, 180) || `HTTP ${response.status}`); }
    if (!response.ok) {
      const detail = payload.errors?.[0]?.message || payload.error?.message || text.slice(0, 180) || `HTTP ${response.status}`;
      throw Object.assign(new Error(detail), { status: response.status });
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${model} returned an empty response.`);
    modelHealth.successes++;
    return parseModelJson(content);
  } catch (error) {
    const failure = providerError("Cloudflare", model, timeout, error);
    modelHealth.failures++;
    modelHealth.cooldownUntil = Date.now() + (failure.retryAfterMs || (failure.code === "RATE_LIMIT" ? 15_000 : 2_000));
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

async function completeViaGroq(stage: AIStage, messages: Message[], maxTokens: number, deadlineAt: number) {
  if (!process.env.GROQ_API_KEY) throw new AIProviderError("PROVIDER", "Groq is not configured. Set GROQ_API_KEY and restart Blueprint.", "groq");
  const tried = new Set<string>();
  let lastError: unknown;
  let waitedForQuota = false;
  const requiredTokens = estimatedRequestTokens(messages, maxTokens);
  while (tried.size < modelPool(stage).length) {
    let model: string;
    try {
      model = availableModels(stage, requiredTokens).find((candidate) => !tried.has(candidate)) || "";
    } catch (error) {
      if (!waitedForQuota && error instanceof AIProviderError && error.code === "RATE_LIMIT"
        && error.retryAfterMs <= 10_000 && Date.now() + error.retryAfterMs + 100 < deadlineAt) {
        waitedForQuota = true;
        await wait(error.retryAfterMs + 100);
        continue;
      }
      lastError = error;
      break;
    }
    if (!model) break;
    tried.add(model);
    try {
      return await groqCompletion(stage, model, messages, maxTokens, deadlineAt);
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error)) {
        const retryAfterMs = error instanceof AIProviderError ? error.retryAfterMs : 0;
        if (!waitedForQuota && retryAfterMs > 0 && retryAfterMs <= 10_000 && Date.now() + retryAfterMs + 100 < deadlineAt) {
          waitedForQuota = true;
          tried.delete(model);
          await wait(retryAfterMs + 100);
          continue;
        }
        break;
      }
      if (!(error instanceof AIProviderError && (error.code === "PERMISSION" || error.code === "PROVIDER"))) {
        throw error;
      }
    }
  }
  if (lastError instanceof AIProviderError) throw lastError;
  throw lastError instanceof Error ? lastError : new Error(`All Groq models failed for ${stage}.`);
}

async function completeViaCloudflare(stage: AIStage, messages: Message[], maxTokens: number, deadlineAt: number) {
  if (!cloudflareConfigured()) throw new AIProviderError("PROVIDER", "Cloudflare Workers AI is not configured.", "cloudflare");
  let lastError: unknown;
  for (const model of cloudflareModelPool()) {
    const key = `cf:${model}`;
    if (health(key).cooldownUntil > Date.now()) continue;
    try {
      return await cloudflareCompletion(stage, model, messages, maxTokens, deadlineAt);
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) && !(error instanceof AIProviderError && (error.code === "PERMISSION" || error.code === "PROVIDER"))) {
        throw error;
      }
    }
  }
  if (lastError instanceof AIProviderError) throw lastError;
  throw lastError instanceof Error ? lastError : new Error(`All Cloudflare models failed for ${stage}.`);
}

export async function completeJson(stage: AIStage, messages: Message[], maxTokens: number, _attempt = 0, deadlineAt = Number.POSITIVE_INFINITY) {
  if (!process.env.GROQ_API_KEY && !cloudflareConfigured()) {
    throw new Error("Groq is not configured. Set GROQ_API_KEY, then restart Blueprint.");
  }
  let lastError: unknown;
  if (process.env.GROQ_API_KEY) {
    try {
      return await completeViaGroq(stage, messages, maxTokens, deadlineAt);
    } catch (error) {
      lastError = error;
      // Only fall through on quota / model access problems — keep real circuit bugs loud.
      if (!isRateLimitError(error) && !(error instanceof AIProviderError && (error.code === "PERMISSION" || error.code === "PROVIDER"))) {
        throw error;
      }
    }
  }
  if (cloudflareConfigured()) {
    try {
      return await completeViaCloudflare(stage, messages, maxTokens, deadlineAt);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof AIProviderError) throw lastError;
  throw lastError instanceof Error ? lastError : new Error(`All AI providers failed for ${stage}.`);
}

export function generationUsage(start: Usage) {
  return {
    calls: aiState.usage.calls - start.calls,
    inputTokens: aiState.usage.inputTokens - start.inputTokens,
    outputTokens: aiState.usage.outputTokens - start.outputTokens,
    providers: [...new Set(aiState.usage.providers.slice(start.providers.length))],
    models: [...new Set(aiState.usage.models.slice(start.models.length))],
  };
}

export function usageSnapshot(): Usage {
  return { ...aiState.usage, providers: [...aiState.usage.providers], models: [...aiState.usage.models] };
}

export function providerStatus() {
  const session = usageSnapshot();
  const stages = { architect: modelPool("architect"), change: modelPool("change"), assistant: modelPool("assistant"), firmware: modelPool("firmware") };
  const healthView = Object.fromEntries(Object.entries(aiState.modelHealth).map(([model, value]) => [model, { ...value, coolingDown: value.cooldownUntil > Date.now() }]));
  return {
    estimate: { calls: 1, tokens: 4500 },
    session: { ...session, providers: [...new Set(session.providers)], models: [...new Set(session.models)] },
    groqQuota: aiState.groqQuota,
    providers: {
      groq: {
        configured: Boolean(process.env.GROQ_API_KEY), architectModels: stages.architect, builderModels: stages.assistant,
        changeModels: stages.change, assistantModels: stages.assistant, firmwareModels: stages.firmware,
        modelHealth: healthView,
      },
      cloudflare: {
        configured: cloudflareConfigured(),
        models: cloudflareConfigured() ? cloudflareModelPool() : [],
        modelHealth: Object.fromEntries(Object.entries(healthView).filter(([model]) => model.startsWith("cf:"))),
      },
    },
  };
}
