import { generateText, embed, type LanguageModel, type EmbeddingModel } from "ai";
import { createXai } from "@ai-sdk/xai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

// ---------------------------------------------------------------------------
// MODEL ID CONFIG — verified against provider docs, June 2026.
// If a provider renames a model, correct the string here; nothing else changes.
//
//   xAI        grok-4.3                  flagship — contrarian temperament (Strix)
//   Anthropic  claude-fable-5            Fable 5 — deep research and thesis work
//              claude-opus-4-8           Opus 4.8 — IC synthesis and memo drafting
//              claude-sonnet-4-6         Sonnet 4.6 — fast interactive/monitoring work
//   OpenAI     gpt-5.5                   precision and structure (accounting, audit)
//              gpt-5.5-pro               high-compute reasoning (valuation)
//              text-embedding-3-small    Vault embeddings
//
// Every agent slot is overridable via NOCTUA_MODEL_<AGENT> (uppercase), e.g.
// NOCTUA_MODEL_STRIX=grok-4.1-fast. An override replaces the model ID on
// whichever provider is selected — i.e. the first route in the chain with a
// configured key. (Most deployments run a single provider, so the override
// should apply regardless of which provider's key happens to be present.)
// ---------------------------------------------------------------------------
const IDS = {
  GROK: "grok-4.3",
  FABLE: "claude-fable-5",
  OPUS: "claude-opus-4-8",
  SONNET: "claude-sonnet-4-6",
  GPT: "gpt-5.5",
  GPT_PRO: "gpt-5.5-pro",
  EMBEDDING: "text-embedding-3-small",
} as const;

export const AGENTS = [
  "dossier",
  "thesis",
  "accounting",
  "industry",
  "catalyst",
  "valuation",
  "strix",
  "evidence_auditor",
  "synthesis",
  "nightvision",
  "chat",
  "investigator",
  "logic",
  "embeddings",
] as const;
export type Agent = (typeof AGENTS)[number];
export type LanguageAgent = Exclude<Agent, "embeddings">;

export type Provider = "xai" | "anthropic" | "openai";
export type Route = { provider: Provider; modelId: string };

export const PROVIDER_ENV: Record<Provider, string> = {
  xai: "XAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const xai = (modelId: string): Route => ({ provider: "xai", modelId });
const anthropic = (modelId: string): Route => ({ provider: "anthropic", modelId });
const openai = (modelId: string): Route => ({ provider: "openai", modelId });

/** Preferred route first; remaining entries are the key-availability fallback chain. */
export const ROUTING: Record<Agent, Route[]> = {
  dossier: [anthropic(IDS.FABLE), openai(IDS.GPT), xai(IDS.GROK)],
  thesis: [anthropic(IDS.FABLE), openai(IDS.GPT), xai(IDS.GROK)],
  accounting: [openai(IDS.GPT), anthropic(IDS.FABLE), xai(IDS.GROK)],
  industry: [anthropic(IDS.FABLE), openai(IDS.GPT), xai(IDS.GROK)],
  catalyst: [anthropic(IDS.FABLE), openai(IDS.GPT), xai(IDS.GROK)],
  valuation: [openai(IDS.GPT_PRO), anthropic(IDS.FABLE), xai(IDS.GROK)],
  strix: [xai(IDS.GROK), anthropic(IDS.FABLE), openai(IDS.GPT)],
  evidence_auditor: [openai(IDS.GPT), anthropic(IDS.FABLE), xai(IDS.GROK)],
  synthesis: [anthropic(IDS.OPUS), openai(IDS.GPT_PRO), xai(IDS.GROK)],
  nightvision: [anthropic(IDS.SONNET), openai(IDS.GPT), xai(IDS.GROK)],
  chat: [anthropic(IDS.SONNET), openai(IDS.GPT), xai(IDS.GROK)],
  investigator: [anthropic(IDS.FABLE), openai(IDS.GPT), xai(IDS.GROK)],
  logic: [openai(IDS.GPT_PRO), anthropic(IDS.OPUS), xai(IDS.GROK)],
  embeddings: [openai(IDS.EMBEDDING)],
};

export function overrideEnvVar(agent: Agent): string {
  return `NOCTUA_MODEL_${agent.toUpperCase()}`;
}

function hasKey(provider: Provider): boolean {
  return Boolean(process.env[PROVIDER_ENV[provider]]);
}

function instantiate(route: Route): LanguageModel {
  const apiKey = process.env[PROVIDER_ENV[route.provider]];
  switch (route.provider) {
    case "xai":
      return createXai({ apiKey })(route.modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(route.modelId);
    case "openai":
      return createOpenAI({ apiKey })(route.modelId);
  }
}

/** Resolve which route an agent will actually use, without instantiating the
 *  model. Returns null when no provider in the chain has a configured key. */
export function resolveRoute(
  agent: Agent,
): { provider: Provider; modelId: string; preferred: boolean; usedOverride: boolean } | null {
  const chain = ROUTING[agent];
  const override = process.env[overrideEnvVar(agent)];
  for (let i = 0; i < chain.length; i++) {
    const route = chain[i];
    if (!hasKey(route.provider)) continue;
    return {
      provider: route.provider,
      modelId: override || route.modelId,
      preferred: i === 0,
      usedOverride: Boolean(override),
    };
  }
  return null;
}

export function modelFor(agent: LanguageAgent): { model: LanguageModel; modelId: string } {
  const resolved = resolveRoute(agent);
  if (!resolved) {
    throw new Error(
      "No API key configured. Add XAI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to .env.local and restart the dev server.",
    );
  }
  return {
    model: instantiate({ provider: resolved.provider, modelId: resolved.modelId }),
    modelId: resolved.modelId,
  };
}

/** The embedding model the Vault should use, resolved through the router
 *  (ROUTING.embeddings) instead of being hardcoded. Null when unavailable. */
export function embeddingModelFor(): { model: EmbeddingModel; modelId: string } | null {
  const resolved = resolveRoute("embeddings");
  if (!resolved || resolved.provider !== "openai") return null; // only OpenAI embeddings wired today
  const apiKey = process.env[PROVIDER_ENV.openai];
  return { model: createOpenAI({ apiKey }).textEmbedding(resolved.modelId), modelId: resolved.modelId };
}

export function getProviderStatus(): { provider: Provider; envVar: string; configured: boolean }[] {
  return (Object.keys(PROVIDER_ENV) as Provider[]).map((provider) => ({
    provider,
    envVar: PROVIDER_ENV[provider],
    configured: hasKey(provider),
  }));
}

// ---------------------------------------------------------------------------
// Live health probe — validates that configured model IDs actually resolve at
// the provider, instead of only checking for the presence of an API key. A
// renamed or retired model fails here at /api/health/models or in /lab, rather
// than mid-investigation after 20+ successful calls.
// ---------------------------------------------------------------------------

export type ModelHealth = {
  provider: Provider;
  modelId: string;
  kind: "language" | "embedding";
  ok: boolean;
  latencyMs: number;
  error?: string;
};

const HEALTH_TIMEOUT_MS = Number(process.env.NOCTUA_HEALTH_TIMEOUT_MS ?? 12_000);
const HEALTH_CACHE_MS = Number(process.env.NOCTUA_HEALTH_CACHE_MS ?? 60_000);
let healthCache: { at: number; data: ModelHealth[] } | null = null;

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Never echo a key back; collapse to a short, safe reason.
  return raw.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 200);
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function probeLanguage(provider: Provider, modelId: string): Promise<ModelHealth> {
  const start = Date.now();
  try {
    await withTimeout((signal) =>
      generateText({
        model: instantiate({ provider, modelId }),
        prompt: "ping",
        maxOutputTokens: 1,
        maxRetries: 0,
        abortSignal: signal,
      }),
    );
    return { provider, modelId, kind: "language", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { provider, modelId, kind: "language", ok: false, latencyMs: Date.now() - start, error: sanitizeError(err) };
  }
}

async function probeEmbedding(): Promise<ModelHealth | null> {
  const e = embeddingModelFor();
  if (!e) return null;
  const start = Date.now();
  try {
    await withTimeout((signal) => embed({ model: e.model, value: "ping", maxRetries: 0, abortSignal: signal }));
    return { provider: "openai", modelId: e.modelId, kind: "embedding", ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { provider: "openai", modelId: e.modelId, kind: "embedding", ok: false, latencyMs: Date.now() - start, error: sanitizeError(err) };
  }
}

/** Probe every distinct (provider, model) pair that a configured provider could
 *  actually run. Results are cached briefly so repeated /lab visits are cheap. */
export async function checkModelHealth(force = false): Promise<ModelHealth[]> {
  if (!force && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
    return healthCache.data;
  }

  const pairs = new Map<string, { provider: Provider; modelId: string }>();
  for (const agent of AGENTS) {
    if (agent === "embeddings") continue;
    const override = process.env[overrideEnvVar(agent)];
    for (const route of ROUTING[agent]) {
      if (!hasKey(route.provider)) continue;
      pairs.set(`${route.provider}:${route.modelId}`, route);
    }
    // Also probe the override target on whichever provider is selected.
    const resolved = resolveRoute(agent);
    if (resolved && override) pairs.set(`${resolved.provider}:${resolved.modelId}`, resolved);
  }

  const [language, embedding] = await Promise.all([
    Promise.all([...pairs.values()].map((p) => probeLanguage(p.provider, p.modelId))),
    probeEmbedding(),
  ]);

  const data = [...language, ...(embedding ? [embedding] : [])].sort((a, b) =>
    a.provider === b.provider ? a.modelId.localeCompare(b.modelId) : a.provider.localeCompare(b.provider),
  );
  healthCache = { at: Date.now(), data };
  return data;
}
