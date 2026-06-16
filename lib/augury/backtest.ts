// Deterministic, no-lookahead backtests for each extracted call, across fixed
// calendar horizons. For every horizon we compute the stock's adjusted return,
// the S&P 500 return over the same window, and a direction-adjusted alpha, then
// label an outcome. An optional LLM "judge" refines the label/notes when a model
// key exists; it never changes the deterministic numbers and is skipped silently
// without keys. `backtest` is a terminal job stage (enqueues nothing).
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, tables } from "@/db";
import type { BacktestOutcome, BacktestResult, JobHandler, Stance } from "@/lib/augury/types";
import { modelFor } from "@/lib/models";
import {
  addCalendarDaysISO,
  ensureDailyHistory,
  ensureIntradayAround,
  isoDateUTC,
  priceAsOf,
  sp500ReturnBetween,
} from "@/lib/augury/market/bars";

/** Calendar-day horizons evaluated per call. */
const HORIZON_DAYS = [7, 30, 90, 180, 365] as const;
/** Alpha (percentage points) beyond which a directional call counts as right/wrong. */
const OUTCOME_ALPHA_THRESHOLD_PCT = 3;

function normalizeStance(s: string | null): Stance {
  return s === "bullish" || s === "bearish" || s === "neutral" || s === "hedge" ? s : "neutral";
}

/**
 * Direction-adjusted alpha: positive means the call was correct. Bullish keeps
 * (raw − bench); bearish flips it (a falling stock vs the benchmark is a win);
 * neutral/hedge stay undirected (outcome is inconclusive regardless).
 */
function directionAdjustedAlpha(stance: Stance, rawReturnPct: number, benchmarkPct: number): number {
  const a = rawReturnPct - benchmarkPct;
  if (stance === "bullish") return a;
  if (stance === "bearish") return -a;
  return a;
}

function classifyOutcome(stance: Stance, adjustedAlphaPct: number): BacktestOutcome {
  if (stance === "neutral" || stance === "hedge") return "inconclusive";
  if (adjustedAlphaPct > OUTCOME_ALPHA_THRESHOLD_PCT) return "right";
  if (adjustedAlphaPct < -OUTCOME_ALPHA_THRESHOLD_PCT) return "wrong";
  return "partial";
}

// --- optional LLM judge -----------------------------------------------------

const judgeSchema = z.object({
  assessments: z.array(
    z.object({
      horizon: z.string().describe("The horizon label, e.g. \"30d\""),
      outcome: z.enum(["right", "wrong", "partial", "too_early", "inconclusive"]),
      notes: z.string().describe("One-sentence rationale, e.g. right-for-wrong-reason nuance"),
    }),
  ),
});

interface JudgeInput {
  ticker: string;
  stance: Stance;
  thesisSummary: string | null;
  entryDate: string;
  results: BacktestResult[];
}

/**
 * Ask augur_judge to reassess scored horizons (e.g. right-for-wrong-reason →
 * partial) and add notes. Mutates results in place. Best-effort: any failure
 * (no key, bad output) leaves the deterministic outcomes untouched.
 */
async function applyJudge(input: JudgeInput): Promise<void> {
  const scored = input.results.filter((r) => r.outcome !== "too_early" && r.rawReturnPct != null);
  if (scored.length === 0) return;

  try {
    const judge = modelFor("augur_judge"); // throws without any provider key
    const lines = scored
      .map(
        (r) =>
          `- ${r.horizon}: stock ${fmt(r.rawReturnPct)}%, S&P ${fmt(r.benchmarkReturnPct)}%, ` +
          `direction-adjusted alpha ${fmt(r.alphaPct)}%, deterministic outcome "${r.outcome}"`,
      )
      .join("\n");
    const { object } = await generateObject({
      model: judge.model,
      schema: judgeSchema,
      prompt: `A trader made a ${input.stance} call on ${input.ticker} on ${input.entryDate}.
Thesis: ${input.thesisSummary ?? "(none recorded)"}

Per-horizon results (adjusted, benchmark-relative; positive alpha = call worked):
${lines}

For each horizon, return the most accurate outcome and a one-sentence note.
Keep the deterministic label unless nuance clearly warrants a change (e.g. the
move happened but for an unrelated catalyst → "partial"). Use "inconclusive"
only when the call is non-directional or the data is too noisy to judge.`,
    });

    const byHorizon = new Map(object.assessments.map((a) => [a.horizon, a]));
    for (const r of scored) {
      const a = byHorizon.get(r.horizon);
      if (!a) continue;
      r.outcome = a.outcome;
      r.judgeNotes = a.notes;
    }
  } catch {
    // no key or model failure — deterministic outcomes stand
  }
}

function fmt(n: number | null): string {
  return n == null ? "n/a" : n.toFixed(2);
}

// --- intraday-aware entry ----------------------------------------------------

/** Minutes after the tweet to search for an entry bar (matches ensureIntradayAround's default window). */
const INTRADAY_ENTRY_WINDOW_MIN = 120;

/**
 * Whether a post timestamp carries a time-of-day. A bare calendar date persisted
 * as a timestamptz lands on exactly 00:00:00.000 UTC; any non-midnight instant is
 * treated as an intraday (time-of-day-present) post eligible for an intraday entry.
 */
function hasTimeOfDay(d: Date): boolean {
  return (
    d.getUTCHours() !== 0 ||
    d.getUTCMinutes() !== 0 ||
    d.getUTCSeconds() !== 0 ||
    d.getUTCMilliseconds() !== 0
  );
}

/**
 * Intraday entry price at/just after a tweet: the open (else close) of the first
 * cached 5-min bar with ts >= the post time, within INTRADAY_ENTRY_WINDOW_MIN.
 * No-lookahead — only bars at/after the call qualify, and the upper bound keeps a
 * bar cached for some other post from leaking in. null when no intraday bar is
 * available (keyless provider, after-hours/weekend post), so the caller falls
 * back to the daily as-of close. Best-effort: never throws.
 */
async function intradayEntryPrice(ticker: string, postedAt: Date): Promise<number | null> {
  const tsISO = postedAt.toISOString();
  try {
    await ensureIntradayAround(ticker, tsISO, INTRADAY_ENTRY_WINDOW_MIN); // caches the window; no-op keyless
    const upperISO = new Date(postedAt.getTime() + INTRADAY_ENTRY_WINDOW_MIN * 60_000).toISOString();
    const rows = await db
      .select({ open: tables.intradayBars.open, close: tables.intradayBars.close })
      .from(tables.intradayBars)
      .where(
        and(
          eq(tables.intradayBars.ticker, ticker.toUpperCase()),
          gte(tables.intradayBars.ts, tsISO),
          lte(tables.intradayBars.ts, upperISO),
        ),
      )
      .orderBy(asc(tables.intradayBars.ts))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return r.open ?? r.close ?? null;
  } catch {
    return null; // fall back to the daily as-of close
  }
}

// --- core -------------------------------------------------------------------

/**
 * Backtest a single call across HORIZON_DAYS. Entry is the post's own timestamp
 * (priceAsOf the post date); each horizon evaluates priceAsOf entry+H days. A
 * future or missing eval bar yields "too_early" / "inconclusive". Replaces any
 * prior backtest rows for the call. Returns the computed results.
 */
export async function backtestCall(callId: number): Promise<BacktestResult[]> {
  const rows = await db
    .select({
      ticker: tables.calls.ticker,
      stance: tables.calls.stance,
      thesisSummary: tables.calls.thesisSummary,
      postedAt: tables.posts.postedAt,
      ingestedAt: tables.posts.ingestedAt,
    })
    .from(tables.calls)
    .innerJoin(tables.posts, eq(tables.calls.postId, tables.posts.id))
    .where(eq(tables.calls.id, callId))
    .limit(1);
  const call = rows[0];
  if (!call) throw new Error(`backtestCall: call ${callId} not found`);

  const ticker = call.ticker ? call.ticker.toUpperCase() : null;
  const entryAt = call.postedAt ?? call.ingestedAt ?? null;
  if (!ticker || !entryAt) return []; // nothing to score without a ticker + entry date

  const stance = normalizeStance(call.stance);
  const entryDateISO = isoDateUTC(entryAt);
  const todayISO = isoDateUTC(new Date());

  // Ensure history from just before entry through the longest horizon (+ buffer).
  await ensureDailyHistory(
    ticker,
    addCalendarDaysISO(entryDateISO, -10),
    addCalendarDaysISO(entryDateISO, HORIZON_DAYS[HORIZON_DAYS.length - 1] + 15),
  );

  // Entry price: when the post carries an intraday time-of-day, enter at/just
  // after the tweet via the intraday bar; otherwise — or when no intraday bar is
  // available (keyless provider, after-hours/weekend post) — fall back to the
  // daily as-of close. No-lookahead either way; this is the deterministic
  // baseline price applied across every horizon below.
  let entryPrice: number | null = null;
  if (call.postedAt && hasTimeOfDay(call.postedAt)) {
    entryPrice = await intradayEntryPrice(ticker, call.postedAt);
  }
  if (entryPrice == null) {
    entryPrice = await priceAsOf(ticker, entryDateISO);
  }

  const results: BacktestResult[] = [];
  for (const h of HORIZON_DAYS) {
    const evalDateISO = addCalendarDaysISO(entryDateISO, h);
    const horizon = `${h}d`;
    let evalPrice: number | null = null;
    let rawReturnPct: number | null = null;
    let benchmarkReturnPct: number | null = null;
    let alphaPct: number | null = null;
    let outcome: BacktestOutcome;

    if (evalDateISO > todayISO) {
      outcome = "too_early"; // horizon hasn't elapsed yet
    } else {
      evalPrice = await priceAsOf(ticker, evalDateISO);
      if (entryPrice == null || evalPrice == null || entryPrice === 0) {
        outcome = "inconclusive"; // missing price data
      } else {
        rawReturnPct = ((evalPrice - entryPrice) / entryPrice) * 100;
        benchmarkReturnPct = await sp500ReturnBetween(entryDateISO, evalDateISO);
        alphaPct = directionAdjustedAlpha(stance, rawReturnPct, benchmarkReturnPct ?? 0);
        outcome = classifyOutcome(stance, alphaPct);
      }
    }

    results.push({
      callId,
      ticker,
      horizon,
      entryDate: entryDateISO,
      entryPrice,
      evalDate: evalDateISO,
      evalPrice,
      rawReturnPct,
      benchmarkReturnPct,
      alphaPct,
      outcome,
      judgeNotes: null,
    });
  }

  await applyJudge({ ticker, stance, thesisSummary: call.thesisSummary, entryDate: entryDateISO, results });

  // Replace any prior rows for this call (no composite unique to upsert against).
  await db.delete(tables.backtests).where(eq(tables.backtests.callId, callId));
  await db.insert(tables.backtests).values(
    results.map((r) => ({
      callId: r.callId,
      ticker: r.ticker,
      horizon: r.horizon,
      entryDate: r.entryDate,
      entryPrice: r.entryPrice,
      evalDate: r.evalDate,
      evalPrice: r.evalPrice,
      rawReturnPct: r.rawReturnPct,
      benchmarkReturnPct: r.benchmarkReturnPct,
      alphaPct: r.alphaPct,
      outcome: r.outcome,
      judgeNotes: r.judgeNotes,
    })),
  );

  return results;
}

/** `backtest` stage: score the call across horizons. Terminal (enqueues nothing). */
export const backtestHandler: JobHandler = async (payload: { callId: number }) => {
  await backtestCall(payload.callId);
};
