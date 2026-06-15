// Shared AI generation helpers: retry-on-schema-failure, output-token caps,
// and per-call telemetry (tokens + latency). The Vercel AI SDK already retries
// transient *API* errors via `maxRetries`, but it does NOT retry
// `NoObjectGeneratedError` (the model returning JSON that fails schema
// validation). A single such failure would otherwise abort a ~30-call Athena
// run, so we add an outer retry specifically for that class of error.
import { generateObject, NoObjectGeneratedError, type LanguageModel } from "ai";
import type { z } from "zod";

export type RunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type RunMeta = {
  usage: RunUsage;
  latencyMs: number;
  attempts: number;
  modelId?: string;
};

/** Default cap on generated tokens. Bounds cost/latency for the expensive
 *  Opus/GPT-Pro agents whose output was previously unbounded. Override per call
 *  or globally via NOCTUA_MAX_OUTPUT_TOKENS. */
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.NOCTUA_MAX_OUTPUT_TOKENS ?? 8000);
/** Extra attempts on schema-validation failure (on top of the first attempt). */
const DEFAULT_OBJECT_RETRIES = Number(process.env.NOCTUA_OBJECT_RETRIES ?? 2);
/** SDK-level retries for transient provider/API errors (rate limits, 5xx). */
const API_RETRIES = Number(process.env.NOCTUA_API_RETRIES ?? 2);

export function emptyUsage(): RunUsage {
  return { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };
}

/** Accumulate token usage across several calls (e.g. the research tree / debate). */
export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  const sum = (x?: number, y?: number) =>
    x == null && y == null ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
  };
}

function backoffMs(attempt: number): number {
  // 400ms, 1600ms, 3600ms … plus jitter
  return 400 * attempt * attempt + Math.floor(Math.random() * 250);
}

/**
 * `generateObject` with bounded output, transient-API retry (via the SDK), and
 * an outer retry on `NoObjectGeneratedError`. Returns the parsed object plus
 * telemetry. Destructure as `const { object, meta } = await generateObjectRetry(...)`.
 */
export async function generateObjectRetry<T>(opts: {
  model: LanguageModel;
  modelId?: string;
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  retries?: number;
}): Promise<{ object: T; meta: RunMeta }> {
  const retries = opts.retries ?? DEFAULT_OBJECT_RETRIES;
  const start = Date.now();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const result = await generateObject({
        model: opts.model,
        schema: opts.schema,
        system: opts.system,
        prompt: opts.prompt,
        maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: opts.temperature,
        maxRetries: API_RETRIES,
      });
      return {
        object: result.object,
        meta: {
          usage: {
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            totalTokens: result.usage?.totalTokens,
          },
          latencyMs: Date.now() - start,
          attempts: attempt,
          modelId: opts.modelId,
        },
      };
    } catch (err) {
      lastErr = err;
      // Only retry the "model produced unparseable/invalid JSON" case here;
      // transient API errors are already retried inside the SDK.
      if (attempt <= retries && NoObjectGeneratedError.isInstance(err)) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
