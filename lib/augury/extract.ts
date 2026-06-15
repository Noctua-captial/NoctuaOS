// Per-post LLM interpretation: turn one tracked trader's post into a single
// structured `call` (stance, lifecycle stage, conviction, horizon, thesis),
// threading it onto the author's prior calls so a position's lifecycle —
// watching → entered → added → trimmed → exited — is reconstructed over time.
//
// Pattern mirrors `classifyUntagged` in lib/signals/news.ts: resolve the model
// via modelFor(...) (which THROWS when no provider key is set), and on any
// failure skip silently (no-op). Each successful, market-relevant extraction
// also lays down a `traces` + `agent_runs` row — extending the training-data
// moat — and enqueues a `backtest` job for the new call.
import { and, desc, eq, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, tables } from "@/db";
import { modelFor } from "@/lib/models";
import { enqueue } from "@/lib/augury/jobs";
import type { ExtractedCall, JobHandler, ReturnWindows } from "@/lib/augury/types";

// --- extraction schema -------------------------------------------------------

/**
 * The LLM extraction output for a single post. Mirrors `ExtractedCall` in
 * lib/augury/types.ts (and the plan's `callSchema`); the field names map 1:1
 * onto the `calls` columns (isUpdateOfCallId → calls.isUpdateOf, etc.).
 */
export const callSchema = z.object({
  isMarketRelevant: z
    .boolean()
    .describe("False if the post is personal, social, or has no market/trading content."),
  ticker: z
    .string()
    .nullable()
    .describe("The single primary ticker the call is about, uppercase and without a leading $. Null if none."),
  stance: z
    .enum(["bullish", "bearish", "neutral", "hedge"])
    .describe("Directional bias the post expresses toward the ticker."),
  lifecycleStage: z
    .enum(["watching", "initiating", "entered", "adding", "trimming", "exiting", "closed", "commentary"])
    .describe(
      "Position lifecycle: watching (interest, no position) | initiating (intent to start) | entered (opened now) | adding (increasing) | trimming (reducing) | exiting (closing) | closed (flat) | commentary (market view, no position action).",
    ),
  conviction: z
    .number()
    .min(0)
    .max(1)
    .describe("Strength of conviction the post conveys, 0 (idle musing) to 1 (high conviction)."),
  horizon: z
    .enum(["intraday", "swing", "weeks", "months", "long_term", "unspecified"])
    .describe("Trading horizon implied by the post."),
  thesisSummary: z.string().describe("One or two cold sentences summarizing the actual claim/thesis."),
  catalyst: z.string().nullable().describe("The specific event or driver cited, or null."),
  targetPrice: z.number().nullable().describe("A numeric price target if explicitly stated, else null."),
  isUpdateOfCallId: z
    .number()
    .nullable()
    .describe("If this post updates one of the PRIOR CALLS listed in the prompt, set it to that call's id; else null."),
  rawQuote: z.string().describe("The verbatim sentence(s) from the post the call is extracted from."),
});

const EXTRACT_SYSTEM = `You are Augur, the interpretation engine inside Noctua OS. You decode a tracked market commentator's social posts into one structured trading "call". You reconstruct position lifecycles across a trader's posting history: distinguish merely watching a name from initiating, entering, adding to, trimming, exiting, or fully closing a position, versus non-actionable market commentary. Be cold, precise, and literal — never invent a position the text does not support, and never let what the stock did afterwards color the trader's stated intent. Output strictly the requested schema.`;

const MAX_POST_CHARS = 1200;
const MAX_PARENT_CHARS = 240;
const MAX_THESIS_CHARS = 140;
const PRIOR_FETCH_LIMIT = 40;
const PRIOR_PROMPT_LIMIT = 12;

// --- helpers -----------------------------------------------------------------

function parseReturns(raw: string | null): ReturnWindows | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReturnWindows;
  } catch {
    return null;
  }
}

function parseNews(raw: string | null): { title: string }[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as { title: string }[]) : [];
  } catch {
    return [];
  }
}

function fmtPct(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}

function normalizeTicker(t: string | null): string | null {
  if (!t) return null;
  const clean = t.trim().replace(/^\$/, "").toUpperCase();
  return clean.length ? clean : null;
}

/** Map the extraction onto lib/athena's shared signal taxonomy (traces.signalCategory). */
function signalCategoryFor(c: ExtractedCall): string {
  if (!c.isMarketRelevant) return "noise";
  if (c.catalyst) return "catalyst";
  if (c.stance === "bullish") return "thesis_support";
  if (c.stance === "bearish") return "thesis_contradiction";
  return "noise";
}

/** Direction-signed conviction in [-1, 1] for traces.confidenceChange. */
function confidenceChangeFor(c: ExtractedCall): number {
  const mag = Math.max(0, Math.min(1, c.conviction ?? 0));
  if (c.stance === "bullish") return mag;
  if (c.stance === "bearish") return -mag;
  return 0;
}

/** Backward-looking, as-of-the-post market context. Forward windows (+1d/+5d/+30d) are
 *  deliberately omitted to keep the interpretation pass free of look-ahead bias. */
function contextBlock(pc: typeof tables.postContext.$inferSelect | undefined): string {
  if (!pc) return "No point-in-time market context is on record for this post.";
  const lines: string[] = [];
  const r = parseReturns(pc.returns);
  if (r) lines.push(`Trailing return into the post (adjusted): -5d ${fmtPct(r["-5d"])}, -1d ${fmtPct(r["-1d"])}`);
  if (pc.marketRegime) lines.push(`Market regime: ${pc.marketRegime}`);
  if (pc.vix != null) lines.push(`VIX: ${pc.vix.toFixed(1)}`);
  if (pc.sectorMovePct != null) lines.push(`Sector ETF move: ${fmtPct(pc.sectorMovePct)}`);
  const news = parseNews(pc.newsSnapshot);
  if (news.length) lines.push(`Headlines around the post: ${news.slice(0, 3).map((n) => n.title).join(" | ")}`);
  return lines.length ? lines.join("\n") : "No point-in-time market context is on record for this post.";
}

// --- core --------------------------------------------------------------------

/**
 * Interpret a single post into a structured call. Idempotent: one call per
 * post — if a call already exists for `postId`, this is a no-op. Without a
 * provider key (modelFor throws) or on any LLM failure, returns silently
 * having recorded nothing. Non-market-relevant posts also record nothing.
 */
export async function extractPost(postId: number): Promise<void> {
  if (!Number.isFinite(postId)) return;

  const [post] = await db.select().from(tables.posts).where(eq(tables.posts.id, postId)).limit(1);
  if (!post) return;

  // Idempotency guard: one structured call per post. Safe re-runs / retries.
  const already = await db
    .select({ id: tables.calls.id })
    .from(tables.calls)
    .where(eq(tables.calls.postId, postId))
    .limit(1);
  if (already[0]) return;

  // Subject ticker(s) for this post — drives both prior-call lookup and the prompt.
  const mentions = await db
    .select({ ticker: tables.tickerMentions.ticker })
    .from(tables.tickerMentions)
    .where(eq(tables.tickerMentions.postId, postId));

  // postContext is built by the market slice — tolerate it being absent.
  const [pc] = await db
    .select()
    .from(tables.postContext)
    .where(eq(tables.postContext.postId, postId))
    .limit(1);

  const candidateTickers = [
    ...new Set(
      [...mentions.map((m) => m.ticker), pc?.ticker ?? null]
        .map((t) => normalizeTicker(t))
        .filter((t): t is string => t != null),
    ),
  ];

  // Author handle (for prompt + trace framing).
  const [author] = await db
    .select({ handle: tables.authors.handle })
    .from(tables.authors)
    .where(eq(tables.authors.id, post.authorId))
    .limit(1);
  const handle = author?.handle ?? `author#${post.authorId}`;

  // Prior calls by this author on the same ticker(s), chronologically before this post,
  // so the model can thread the position lifecycle via isUpdateOfCallId.
  const priorRaw = candidateTickers.length
    ? await db
        .select({
          id: tables.calls.id,
          ticker: tables.calls.ticker,
          stance: tables.calls.stance,
          lifecycleStage: tables.calls.lifecycleStage,
          horizon: tables.calls.horizon,
          thesisSummary: tables.calls.thesisSummary,
          postedAt: tables.posts.postedAt,
        })
        .from(tables.calls)
        .innerJoin(tables.posts, eq(tables.calls.postId, tables.posts.id))
        .where(and(eq(tables.calls.authorId, post.authorId), inArray(tables.calls.ticker, candidateTickers)))
        .orderBy(desc(tables.posts.postedAt))
        .limit(PRIOR_FETCH_LIMIT)
    : [];
  const thisPostedMs = post.postedAt ? post.postedAt.getTime() : null;
  const prior = priorRaw
    .filter((p) => thisPostedMs == null || (p.postedAt ? p.postedAt.getTime() < thisPostedMs : true))
    .slice(0, PRIOR_PROMPT_LIMIT);
  const priorIds = new Set(prior.map((p) => p.id));

  // Thread context: parent (reply) and quoted post text, when from the same store.
  const threadParts: string[] = [];
  if (post.replyToId) {
    const [parent] = await db
      .select({ text: tables.posts.text })
      .from(tables.posts)
      .where(eq(tables.posts.platformPostId, post.replyToId))
      .limit(1);
    if (parent?.text) threadParts.push(`In reply to: "${parent.text.slice(0, MAX_PARENT_CHARS)}"`);
  }
  if (post.quotedPostId) {
    const [quoted] = await db
      .select({ text: tables.posts.text })
      .from(tables.posts)
      .where(eq(tables.posts.platformPostId, post.quotedPostId))
      .limit(1);
    if (quoted?.text) threadParts.push(`Quoting: "${quoted.text.slice(0, MAX_PARENT_CHARS)}"`);
  }

  const priorBlock = prior.length
    ? prior
        .map(
          (p) =>
            `#${p.id} [${p.ticker ?? "?"}] ${p.lifecycleStage}/${p.stance}, ${p.horizon ?? "unspecified"} horizon, ${
              p.postedAt ? p.postedAt.toISOString().slice(0, 10) : "?"
            }: ${(p.thesisSummary ?? "").slice(0, MAX_THESIS_CHARS)}`,
        )
        .join("\n")
    : "none on record.";

  const prompt = `POST METADATA
Author: @${handle}
Posted at: ${post.postedAt ? post.postedAt.toISOString() : "unknown"}
Tickers detected in this post: ${candidateTickers.length ? candidateTickers.join(", ") : "none detected"}

POST TEXT
"""
${post.text.slice(0, MAX_POST_CHARS)}
"""
${threadParts.length ? `\nTHREAD CONTEXT\n${threadParts.join("\n")}\n` : ""}
POINT-IN-TIME MARKET CONTEXT (as of the post; no forward data)
${contextBlock(pc)}

PRIOR CALLS ON RECORD (this author, same ticker(s) — thread the lifecycle off these)
${priorBlock}

TASK
Decode this post into exactly one structured call:
- Set isMarketRelevant=false for personal/social/off-topic posts; then nothing else matters.
- Pick the single primary ticker (uppercase, no $), or null if the post names none.
- Choose lifecycleStage precisely from the definitions in the schema — base it on what the trader says they are DOING with the position, not on sentiment alone.
- If this post updates one of the PRIOR CALLS above (same position, later in time), set isUpdateOfCallId to that call's id; otherwise null. Only use ids shown above.
- conviction reflects how strongly the post commits, not how confident you are.
- rawQuote must be copied verbatim from POST TEXT.`;

  let extraction: ExtractedCall;
  let modelId: string;
  try {
    const m = modelFor("augur_extract"); // throws when no provider key — silent skip
    modelId = m.modelId;
    const { object } = await generateObject({
      model: m.model,
      system: EXTRACT_SYSTEM,
      schema: callSchema,
      prompt,
    });
    extraction = object;
  } catch {
    return; // no keys or model failure — record nothing, like classifyUntagged
  }

  // Record nothing for non-market posts (noise). Market-relevant commentary with
  // no ticker is still kept as a (non-backtestable) call, per design judgment.
  if (!extraction.isMarketRelevant) return;

  const ticker = normalizeTicker(extraction.ticker);

  // Resolve a companyId for the trace/agent_run rows when the ticker is known.
  let companyId: number | null = null;
  if (ticker) {
    const [company] = await db
      .select({ id: tables.companies.id })
      .from(tables.companies)
      .where(eq(tables.companies.ticker, ticker))
      .limit(1);
    companyId = company?.id ?? null;
  }

  // Only thread onto a prior call we actually showed the model (guards hallucinated ids).
  const isUpdateOf =
    extraction.isUpdateOfCallId != null && priorIds.has(extraction.isUpdateOfCallId)
      ? extraction.isUpdateOfCallId
      : null;

  const [callRow] = await db
    .insert(tables.calls)
    .values({
      authorId: post.authorId,
      postId: post.id,
      ticker,
      stance: extraction.stance,
      lifecycleStage: extraction.lifecycleStage,
      conviction: extraction.conviction,
      horizon: extraction.horizon,
      thesisSummary: extraction.thesisSummary,
      catalyst: extraction.catalyst,
      // postContext exposes no price column; as-of price lookups belong to the
      // market/backtest slice (dailyBars), so leave the reference price null here.
      priceRefAtPost: null,
      targetPrice: extraction.targetPrice,
      stopRef: null,
      isUpdateOf,
      rawQuote: extraction.rawQuote,
      extractorModel: modelId,
    })
    .returning();

  // Training-data moat: log the agent run (full extraction) and a research trace.
  const inputSummary = `Post ${post.id} by @${handle}${ticker ? ` on ${ticker}` : ""}: "${post.text.slice(0, 160)}"`;
  await db.insert(tables.agentRuns).values({
    companyId,
    ticker,
    agent: "augur_extract",
    model: modelId,
    inputSummary,
    output: JSON.stringify(extraction),
  });

  await db.insert(tables.traces).values({
    researcher: "AugurExtract",
    ticker,
    companyId,
    currentQuestion: `What is @${handle} signaling about ${ticker ?? "the market"} in this post?`,
    actionTaken: `Extracted a structured ${extraction.stance}/${extraction.lifecycleStage} call from the post via augur_extract, threading it against prior calls.`,
    sourceType: "social_post",
    informationSeen: extraction.rawQuote,
    interpretation: extraction.thesisSummary,
    signalCategory: signalCategoryFor(extraction),
    confidenceChange: confidenceChangeFor(extraction),
    nextAction: ticker
      ? "Backtest this call across horizons once price history is available."
      : "Await a follow-up that names a specific ticker before backtesting.",
    reasoningPattern: `Thread a trader's posts into one position lifecycle: a ${extraction.lifecycleStage} (${extraction.stance}, ${extraction.horizon}) signal ${
      isUpdateOf != null ? `updates prior call #${isUpdateOf}` : "opens a new line"
    }.`,
  });

  // Backtests key on a non-null ticker; only enqueue when we have one.
  if (ticker && callRow?.id != null) {
    await enqueue("backtest", { callId: callRow.id });
  }
}

/** Job handler for `extract` jobs. Payload: { postId }. */
export const extractHandler: JobHandler = async (payload: { postId: number }) => {
  await extractPost(Number(payload?.postId));
};
