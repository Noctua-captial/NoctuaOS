import type { LanguageModel } from "ai";
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
// NOCTUA_MODEL_STRIX=grok-4.1-fast. An override replaces the model ID on the
// agent's preferred provider; key-based fallback still uses the defaults below.
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
  "options_strategist",
  "augur_extract",
  "augur_judge",
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
  // The Options Strategist only ever polishes deterministic structure prose,
  // never invents numbers — same discipline as the Oracle's synthesis polish.
  options_strategist: [openai(IDS.GPT_PRO), anthropic(IDS.OPUS), xai(IDS.GROK)],
  augur_extract: [anthropic(IDS.FABLE), openai(IDS.GPT), xai(IDS.GROK)],
  augur_judge: [openai(IDS.GPT), anthropic(IDS.FABLE), xai(IDS.GROK)],
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

export function modelFor(agent: LanguageAgent): { model: LanguageModel; modelId: string } {
  const chain = ROUTING[agent];
  const override = process.env[overrideEnvVar(agent)];
  for (let i = 0; i < chain.length; i++) {
    const route = chain[i];
    if (!hasKey(route.provider)) continue;
    const modelId = i === 0 && override ? override : route.modelId;
    return { model: instantiate({ provider: route.provider, modelId }), modelId };
  }
  throw new Error(
    "No API key configured. Add XAI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to .env.local and restart the dev server.",
  );
}

export function getProviderStatus(): { provider: Provider; envVar: string; configured: boolean }[] {
  return (Object.keys(PROVIDER_ENV) as Provider[]).map((provider) => ({
    provider,
    envVar: PROVIDER_ENV[provider],
    configured: hasKey(provider),
  }));
}
