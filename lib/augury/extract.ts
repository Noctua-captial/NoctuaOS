// Per-post LLM interpretation (v2): decode one tracked trader's post into an
// ARRAY of structured `calls` — one per distinct entity/claim — each carrying a
// subject, subjectType, stance, lifecycle stage, relative size delta, conviction,
// horizon, thesis, catalyst, and target. Extraction is retrieval-augmented: the
// prompt is grounded with the author's semantically-related prior posts/calls
// (via pgvector `searchPosts`, not just exact-ticker matches) and their currently
// OPEN positions, so the model can thread each claim onto the right campaign
// (`positionRef`) instead of re-deriving lifecycle from scratch.
//
// Each market-relevant extraction lays down agent_runs + traces rows (the
// training-data moat) and re-extraction REPLACES a post's calls so pipeline
// improvements reprocess history. The stage then enqueues a single `link` job;
// the link stage reconciles the calls into auguryPositions and fans out the
// per-call backtests. Without a provider key (modelFor throws) it no-ops.
import { and, desc, eq, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, tables } from "@/db";
import { modelFor } from "@/lib/models";
import { enqueue } from "@/lib/augury/jobs";
import { searchPosts } from "@/lib/augury/resolve";
import { addCalendarDaysISO, isoDateUTC, priceAsOf, returnBetween } from "@/lib/augury/market/bars";
import type {
  ExtractedCallItem,
  JobHandler,
  MacroContextData,
  PostContextData,
  ReturnWindows,
  SubjectType,
} from "@/lib/augury/types";

// --- extraction schema -------------------------------------------------------

/** One call within a post's multi-entity extraction set (mirrors ExtractedCallItem). */
const callItemSchema = z.object({
  subject: z
    .string()
    .describe("The entity this call is about: a ticker SYMBOL (uppercase, no $), or a theme/macro label."),
  subjectType: z
    .enum(["ticker", "theme", "macro"])
    .describe("ticker (a specific stock/ETF), theme (industry/investable theme), or macro (a macro/world topic)."),
  stance: z.enum(["bullish", "bearish", "neutral", "hedge"]).describe("Directional bias toward the subject."),
  lifecycleStage: z
    .enum(["watching", "initiating", "entered", "adding", "trimming", "exiting", "closed", "commentary"])
    .describe(
      "What the trader is DOING with the position: watching (interest, no position) | initiating (intent to start) | entered (opened now) | adding (increasing) | trimming (reducing) | exiting (closing) | closed (flat) | commentary (a view, no position action).",
    ),
  sizeDelta: z
    .enum(["starter", "add", "trim", "exit", "none"])
    .describe("Relative position-sizing change: starter (initial) | add | trim | exit | none (no sizing change)."),
  conviction: z.number().min(0).max(1).describe("How strongly the post commits, 0 (idle musing) to 1 (high conviction)."),
  horizon: z
    .enum(["intraday", "swing", "weeks", "months", "long_term", "unspecified"])
    .describe("Trading horizon implied for this subject."),
  thesisSummary: z.string().describe("One or two cold sentences summarizing this specific claim/thesis."),
  catalyst: z.string().nullable().describe("The specific event/driver cited for this subject, or null."),
  targetPrice: z.number().nullable().describe("An explicit numeric price target for a ticker, else null."),
  isMarketRelevant: z.boolean().describe("False if this item carries no real market/trading content."),
  rawQuote: z.string().describe("The verbatim sentence(s) from the post this call is extracted from."),
  positionRef: z
    .number()
    .nullable()
    .describe(
      "If this call advances one of the OPEN POSITIONS listed in the prompt, set it to that position's id; otherwise null to open a new campaign. Only use ids shown above.",
    ),
});

const callSetSchema = z.object({
  calls: z
    .array(callItemSchema)
    .describe("One call per distinct entity/claim the post makes. Empty for a non-market-relevant post."),
});

const EXTRACT_SYSTEM = `You are Augur, the interpretation engine inside Noctua OS. You decode a tracked market commentator's post into structured trading "calls" — ONE per distinct entity or claim (a post can touch several tickers/themes at once). For each, you reconstruct the position lifecycle over the trader's history: distinguish merely watching a name from initiating, entering, adding, trimming, exiting, or fully closing a position, versus non-actionable commentary. You ground each call in the author's OPEN positions and their semantically-related prior calls supplied below, threading the claim onto the right campaign when one exists. Be cold, precise, and literal — never invent a position the text does not support, and never let what the stock did afterwards color the trader's stated intent. Output strictly the requested schema.`;

const MAX_POST_CHARS = 1400;
const MAX_PARENT_CHARS = 240;
const MAX_THESIS_CHARS = 140;
const PRIOR_PROMPT_LIMIT = 12;
const OPEN_POSITION_LIMIT = 15;
const RELATED_FETCH_LIMIT = 50;
const SEARCH_LIMIT = 12;
const MAX_ENTITY_CONTEXT_LINES = 6;

// --- helpers -----------------------------------------------------------------

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fmtPct(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}

function normalizeTicker(t: string): string | null {
  const clean = t.trim().replace(/^\$/, "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  return clean.length >= 1 && clean.length <= 8 ? clean : null;
}

/** Persisted subject string for a call. Tickers → symbol; themes/macro → trimmed label (calls.ticker doubles as the subject column). */
function subjectForCall(subjectType: SubjectType, subject: string): string | null {
  if (subjectType === "ticker") {
    return normalizeTicker(subject) ?? (subject.trim() ? subject.trim().toUpperCase().slice(0, 12) : null);
  }
  const v = subject.trim().replace(/\s+/g, " ");
  return v.length ? v.slice(0, 120) : null;
}

/** Map an extraction onto lib/athena's shared signal taxonomy (traces.signalCategory). */
function signalCategoryFor(c: ExtractedCallItem): string {
  if (!c.isMarketRelevant) return "noise";
  if (c.catalyst) return "catalyst";
  if (c.stance === "bullish") return "thesis_support";
  if (c.stance === "bearish") return "thesis_contradiction";
  return "noise";
}

/** Direction-signed conviction in [-1, 1] for traces.confidenceChange. */
function confidenceChangeFor(c: ExtractedCallItem): number {
  const mag = Math.max(0, Math.min(1, c.conviction ?? 0));
  if (c.stance === "bullish") return mag;
  if (c.stance === "bearish") return -mag;
  return 0;
}

/** Backward-looking, as-of-the-post subject context (forward windows omitted to avoid look-ahead). */
function subjectContextBlock(pc: PostContextData | null): string {
  if (!pc) return "No subject-stock context is on record for this post.";
  const lines: string[] = [];
  const r = pc.returns;
  if (r) lines.push(`Subject trailing return into the post (adjusted): -5d ${fmtPct(r["-5d"])}, -1d ${fmtPct(r["-1d"])}`);
  if (pc.marketRegime) lines.push(`Market regime: ${pc.marketRegime}`);
  if (pc.vix != null) lines.push(`VIX: ${pc.vix.toFixed(1)}`);
  if (pc.sectorMovePct != null) lines.push(`Sector ETF move: ${fmtPct(pc.sectorMovePct)}`);
  if (pc.newsSnapshot?.length) {
    lines.push(`Headlines around the post: ${pc.newsSnapshot.slice(0, 3).map((n) => n.title).join(" | ")}`);
  }
  return lines.length ? lines.join("\n") : "No subject-stock context is on record for this post.";
}

function readPostContext(row: typeof tables.postContext.$inferSelect | undefined): PostContextData | null {
  if (!row) return null;
  return {
    ticker: row.ticker ?? null,
    returns: parseJson<ReturnWindows>(row.returns, { "-5d": null, "-1d": null, "+1d": null, "+5d": null, "+30d": null }),
    marketRegime: (row.marketRegime as PostContextData["marketRegime"]) ?? null,
    vix: row.vix ?? null,
    sectorMovePct: row.sectorMovePct ?? null,
    newsSnapshot: parseJson<PostContextData["newsSnapshot"]>(row.newsSnapshot, []),
  };
}

function macroBlock(m: MacroContextData | null): string {
  if (!m) return "No macro/world context is on record for this date.";
  if (m.worldDigest) return m.worldDigest;
  const bits: string[] = [];
  if (m.sp500 != null) bits.push(`S&P 500 ${m.sp500.toFixed(0)}`);
  if (m.vix != null) bits.push(`VIX ${m.vix.toFixed(1)}`);
  if (m.regime) bits.push(`regime ${m.regime}`);
  return bits.length ? bits.join("; ") : "No macro/world context is on record for this date.";
}

// --- core --------------------------------------------------------------------

/**
 * Interpret a post into an array of structured calls, retrieval-augmented and
 * threaded onto the author's open positions. Re-runnable: replaces the post's
 * existing calls (and their backtests). Records nothing and enqueues nothing
 * without a provider key (modelFor throws) or on LLM failure. Enqueues a single
 * `link` job when calls changed.
 */
export async function extractPost(postId: number): Promise<void> {
  if (!Number.isFinite(postId)) return;

  const [post] = await db.select().from(tables.posts).where(eq(tables.posts.id, postId)).limit(1);
  if (!post) return;

  const [author] = await db
    .select({ handle: tables.authors.handle })
    .from(tables.authors)
    .where(eq(tables.authors.id, post.authorId))
    .limit(1);
  const handle = author?.handle ?? `author#${post.authorId}`;
  const thisPostedMs = post.postedAt ? post.postedAt.getTime() : null;
  const dateISO = isoDateUTC(post.postedAt ?? post.ingestedAt ?? new Date());

  // Resolved entities (subjects/comparisons) drive what to extract + retrieval.
  const entities = await db
    .select({ entityType: tables.postEntities.entityType, value: tables.postEntities.value, role: tables.postEntities.role })
    .from(tables.postEntities)
    .where(eq(tables.postEntities.postId, postId));
  const tickerSubjects = [
    ...new Set(entities.filter((e) => e.entityType === "ticker").map((e) => e.value.toUpperCase())),
  ];

  // Point-in-time context: the subject stock + the shared macro/world row.
  const [pcRow] = await db
    .select()
    .from(tables.postContext)
    .where(eq(tables.postContext.postId, postId))
    .limit(1);
  const pc = readPostContext(pcRow);
  const [macroRow] = await db
    .select()
    .from(tables.macroContext)
    .where(eq(tables.macroContext.date, dateISO))
    .limit(1);
  const macro: MacroContextData | null = macroRow
    ? {
        date: macroRow.date,
        sp500: macroRow.sp500 ?? null,
        sp500Return5dPct: macroRow.sp500Return5dPct ?? null,
        vix: macroRow.vix ?? null,
        rates: parseJson<MacroContextData["rates"]>(macroRow.rates, null),
        regime: (macroRow.regime as MacroContextData["regime"]) ?? null,
        worldDigest: macroRow.worldDigest ?? null,
      }
    : null;

  // Per-entity, point-in-time price/return lines for each resolved ticker.
  const entityLines: string[] = [];
  for (const t of tickerSubjects.slice(0, MAX_ENTITY_CONTEXT_LINES)) {
    try {
      const p0 = await priceAsOf(t, dateISO);
      const r5 = await returnBetween(t, addCalendarDaysISO(dateISO, -7), dateISO);
      if (p0 != null || r5 != null) {
        entityLines.push(`${t}: ${p0 != null ? `$${p0.toFixed(2)}` : "price n/a"} (5d ${fmtPct(r5)})`);
      }
    } catch {
      // best-effort per-entity grounding
    }
  }

  // Thread context: reply parent + quoted post (same store).
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

  // Retrieval augmentation #1: the author's OPEN/WATCHING positions, prioritizing
  // those on the referenced subjects (positionRef candidates).
  const openPositions = await db
    .select()
    .from(tables.auguryPositions)
    .where(and(eq(tables.auguryPositions.authorId, post.authorId), inArray(tables.auguryPositions.status, ["watching", "open"])))
    .orderBy(desc(tables.auguryPositions.updatedAt))
    .limit(40);
  const referencedLower = new Set(entities.map((e) => e.value.toLowerCase()));
  const rankedPositions = [...openPositions].sort(
    (a, b) => (referencedLower.has(b.subject.toLowerCase()) ? 1 : 0) - (referencedLower.has(a.subject.toLowerCase()) ? 1 : 0),
  );
  const shownPositions = rankedPositions.slice(0, OPEN_POSITION_LIMIT);
  const shownPositionIds = new Set(shownPositions.map((p) => p.id));

  // Retrieval augmentation #2: semantically-related prior posts (pgvector/ILIKE)
  // and exact-subject prior calls — merged, dated before this post.
  const hits = await searchPosts(post.text ?? "", { authorId: post.authorId, limit: SEARCH_LIMIT });
  const relatedPostIds = hits.map((h) => h.postId).filter((id) => id !== postId);

  const priorByPost = relatedPostIds.length
    ? await db
        .select({
          id: tables.calls.id,
          ticker: tables.calls.ticker,
          subjectType: tables.calls.subjectType,
          stance: tables.calls.stance,
          lifecycleStage: tables.calls.lifecycleStage,
          horizon: tables.calls.horizon,
          thesisSummary: tables.calls.thesisSummary,
          postedAt: tables.posts.postedAt,
        })
        .from(tables.calls)
        .innerJoin(tables.posts, eq(tables.calls.postId, tables.posts.id))
        .where(and(eq(tables.calls.authorId, post.authorId), inArray(tables.calls.postId, relatedPostIds)))
        .limit(RELATED_FETCH_LIMIT)
    : [];
  const priorBySubject = tickerSubjects.length
    ? await db
        .select({
          id: tables.calls.id,
          ticker: tables.calls.ticker,
          subjectType: tables.calls.subjectType,
          stance: tables.calls.stance,
          lifecycleStage: tables.calls.lifecycleStage,
          horizon: tables.calls.horizon,
          thesisSummary: tables.calls.thesisSummary,
          postedAt: tables.posts.postedAt,
        })
        .from(tables.calls)
        .innerJoin(tables.posts, eq(tables.calls.postId, tables.posts.id))
        .where(and(eq(tables.calls.authorId, post.authorId), inArray(tables.calls.ticker, tickerSubjects)))
        .orderBy(desc(tables.posts.postedAt))
        .limit(RELATED_FETCH_LIMIT)
    : [];

  const priorById = new Map<number, (typeof priorByPost)[number]>();
  for (const c of [...priorByPost, ...priorBySubject]) priorById.set(c.id, c);
  const prior = [...priorById.values()]
    .filter((p) => thisPostedMs == null || (p.postedAt ? p.postedAt.getTime() < thisPostedMs : true))
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
    .slice(0, PRIOR_PROMPT_LIMIT);

  // --- assemble the prompt ----------------------------------------------------
  const entitiesBlock = entities.length
    ? entities.map((e) => `${e.entityType}:${e.value} (${e.role})`).join(", ")
    : "none resolved";

  const positionsBlock = shownPositions.length
    ? shownPositions
        .map(
          (p) =>
            `#${p.id} [${p.subjectType}:${p.subject}] ${p.status}/${p.currentStage ?? "?"}${
              p.direction ? `, ${p.direction}` : ""
            }${p.peakConviction != null ? `, peak conv ${p.peakConviction.toFixed(2)}` : ""}`,
        )
        .join("\n")
    : "none open.";

  const priorBlock = prior.length
    ? prior
        .map(
          (p) =>
            `[${p.ticker ?? "?"} ${p.subjectType ?? "ticker"}] ${p.lifecycleStage}/${p.stance}, ${
              p.horizon ?? "unspecified"
            }, ${p.postedAt ? p.postedAt.toISOString().slice(0, 10) : "?"}: ${(p.thesisSummary ?? "").slice(0, MAX_THESIS_CHARS)}`,
        )
        .join("\n")
    : "none on record.";

  const prompt = `POST METADATA
Author: @${handle}
Posted at: ${post.postedAt ? post.postedAt.toISOString() : "unknown"}
Resolved entities: ${entitiesBlock}

POST TEXT
"""
${(post.text ?? "").slice(0, MAX_POST_CHARS)}
"""
${threadParts.length ? `\nTHREAD CONTEXT\n${threadParts.join("\n")}\n` : ""}
POINT-IN-TIME CONTEXT (as of the post; no forward data)
${subjectContextBlock(pc)}
Macro/world: ${macroBlock(macro)}${entityLines.length ? `\nPer-entity (as-of): ${entityLines.join(" | ")}` : ""}

OPEN POSITIONS (this author — set positionRef to advance one of these; else null to open new)
${positionsBlock}

RELATED PRIOR CALLS (semantically retrieved + same-subject; thread the lifecycle off these)
${priorBlock}

TASK
Decode this post into an ARRAY of structured calls — one per distinct entity/claim:
- Emit no calls (empty array) for a personal/social/off-topic post.
- For each entity, set subjectType and a precise lifecycleStage based on what the trader says they are DOING, not sentiment alone.
- sizeDelta captures relative sizing (starter/add/trim/exit/none); use "none" for pure commentary or watching.
- If a call advances one of the OPEN POSITIONS above, set positionRef to that position's id; otherwise null. Only use ids shown.
- conviction reflects how strongly the post commits, not your confidence.
- rawQuote must be copied verbatim from POST TEXT.`;

  // --- run the model ----------------------------------------------------------
  let calls: ExtractedCallItem[];
  let modelId: string;
  try {
    const m = modelFor("augur_extract"); // throws when no provider key — silent skip
    modelId = m.modelId;
    const { object } = await generateObject({
      model: m.model,
      system: EXTRACT_SYSTEM,
      schema: callSetSchema,
      prompt,
    });
    calls = object.calls as ExtractedCallItem[];
  } catch {
    return; // no keys or model failure — record nothing
  }

  const relevant = calls.filter((c) => c.isMarketRelevant);

  // Replace the post's existing calls (and their backtests) so re-runs reprocess.
  const existing = await db.select({ id: tables.calls.id }).from(tables.calls).where(eq(tables.calls.postId, postId));
  const existingIds = existing.map((r) => r.id);
  if (existingIds.length) {
    await db.delete(tables.backtests).where(inArray(tables.backtests.callId, existingIds));
    await db.delete(tables.calls).where(eq(tables.calls.postId, postId));
  }

  // Companies lookup for trace/agent_run framing on ticker calls.
  const insertTickers = [
    ...new Set(
      relevant
        .filter((c) => c.subjectType === "ticker")
        .map((c) => subjectForCall("ticker", c.subject))
        .filter((t): t is string => t != null),
    ),
  ];
  const companyByTicker = new Map<string, number>();
  if (insertTickers.length) {
    const companies = await db
      .select({ id: tables.companies.id, ticker: tables.companies.ticker })
      .from(tables.companies)
      .where(inArray(tables.companies.ticker, insertTickers));
    for (const c of companies) companyByTicker.set(c.ticker.toUpperCase(), c.id);
  }

  // Insert the N new calls.
  const insertedCallIds: number[] = [];
  for (const c of relevant) {
    const subjectStored = subjectForCall(c.subjectType as SubjectType, c.subject);
    if (!subjectStored) continue; // unusable subject — skip
    const isTicker = c.subjectType === "ticker";
    const positionId = c.positionRef != null && shownPositionIds.has(c.positionRef) ? c.positionRef : null;

    let priceRefAtPost: number | null = null;
    if (isTicker) {
      try {
        priceRefAtPost = await priceAsOf(subjectStored, dateISO);
      } catch {
        priceRefAtPost = null;
      }
    }

    const [row] = await db
      .insert(tables.calls)
      .values({
        authorId: post.authorId,
        postId: post.id,
        ticker: subjectStored, // subject: symbol (ticker) or label (theme/macro)
        subjectType: c.subjectType,
        stance: c.stance,
        lifecycleStage: c.lifecycleStage,
        sizeDelta: c.sizeDelta,
        conviction: c.conviction,
        horizon: c.horizon,
        thesisSummary: c.thesisSummary,
        catalyst: c.catalyst,
        priceRefAtPost,
        targetPrice: c.targetPrice,
        stopRef: null,
        isUpdateOf: null, // lifecycle is now threaded through auguryPositions (link stage)
        positionId, // tentative hint; the link stage finalizes/creates
        rawQuote: c.rawQuote,
        extractorModel: modelId,
      })
      .returning({ id: tables.calls.id });
    if (row?.id != null) insertedCallIds.push(row.id);
  }

  // Training-data moat: one agent_run for the extraction set + one trace per call.
  if (relevant.length) {
    const primary = relevant[0];
    const primaryTicker = primary.subjectType === "ticker" ? subjectForCall("ticker", primary.subject) : null;
    await db.insert(tables.agentRuns).values({
      companyId: primaryTicker ? companyByTicker.get(primaryTicker) ?? null : null,
      ticker: primaryTicker,
      agent: "augur_extract",
      model: modelId,
      inputSummary: `Post ${post.id} by @${handle}: "${(post.text ?? "").slice(0, 160)}" → ${relevant.length} call(s)`,
      output: JSON.stringify({ calls: relevant }),
    });

    for (const c of relevant) {
      const isTicker = c.subjectType === "ticker";
      const subj = subjectForCall(c.subjectType as SubjectType, c.subject);
      const companyId = isTicker && subj ? companyByTicker.get(subj) ?? null : null;
      await db.insert(tables.traces).values({
        researcher: "AugurExtract",
        ticker: isTicker ? subj : null,
        companyId,
        currentQuestion: `What is @${handle} signaling about ${c.subject} in this post?`,
        actionTaken: `Extracted a ${c.stance}/${c.lifecycleStage} call (${c.subjectType}) on ${c.subject} via augur_extract, threaded against open positions.`,
        sourceType: "social_post",
        informationSeen: c.rawQuote,
        interpretation: c.thesisSummary,
        signalCategory: signalCategoryFor(c),
        confidenceChange: confidenceChangeFor(c),
        nextAction:
          isTicker && subj
            ? "Reconcile into the trader's position, then backtest across horizons."
            : "Track this theme/macro stance qualitatively at the position level.",
        reasoningPattern: `Multi-entity decode: a ${c.lifecycleStage} (${c.stance}, ${c.horizon}) ${c.subjectType} signal${
          c.positionRef != null && shownPositionIds.has(c.positionRef) ? ` advancing position #${c.positionRef}` : " opening a new line"
        }.`,
      });
    }
  }

  // Hand off to the link stage to reconcile positions (which fans out backtests).
  if (insertedCallIds.length || existingIds.length) {
    await enqueue("link", { postId });
  }
}

/** Job handler for `extract` jobs. Payload: { postId }. */
export const extractHandler: JobHandler = async (payload: { postId: number }) => {
  await extractPost(Number(payload?.postId));
};
