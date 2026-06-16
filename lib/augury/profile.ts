// Per-author playbook synthesis. Aggregates a tracked trader's structured
// `calls` against their `backtests` into a materialized `authorScorecards` row:
// overall hit-rate and benchmark-relative alpha, slices by horizon / stance /
// sector, conviction calibration (stated conviction vs realized hit-rate), and
// a synthesized narrative playbook (edges, weaknesses, tells).
//
// The narrative is optional and grounded: it cites real post ids and falls back
// to a deterministic stats-only summary when no provider key is configured
// (modelFor throws → caught), mirroring lib/signals/news.ts's silent-skip ethos.
import { eq, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, tables } from "@/db";
import { modelFor } from "@/lib/models";
import { vaultContext } from "@/lib/vault";
import type {
  AuthorPlaybook,
  ConvictionCalibrationBucket,
  PositionScorecard,
  SliceStat,
  JobHandler,
} from "@/lib/augury/types";

type CallRow = typeof tables.calls.$inferSelect;
type BacktestRow = typeof tables.backtests.$inferSelect;
type PositionRow = typeof tables.auguryPositions.$inferSelect;

const CONVICTION_BUCKETS = ["0.0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0"] as const;
const REPRESENTATIVE_CALLS = 8;

const PROFILE_SYSTEM = `You are Augur, profiling a tracked market commentator for Noctua OS. From their realized track record — hit-rate, benchmark-relative alpha, and slices by horizon/stance/sector — and a sample of representative calls, you write a cold, institutional playbook: the recurring reasoning patterns and setups where they are reliably right (edges), where they are reliably wrong (weaknesses), their typical horizon, and their tells. Ground every claim in the supplied stats and calls. No hype, no exclamation points.`;

const narrativeSchema = z.object({
  summary: z
    .string()
    .describe("2-4 cold sentences: recurring reasoning patterns, favored setups, typical horizon, and tells."),
  edges: z.array(z.string()).max(5).describe("Recurring setups/conditions where this author tends to be RIGHT."),
  weaknesses: z.array(z.string()).max(5).describe("Recurring setups/conditions where this author tends to be WRONG."),
});

// --- numeric helpers ---------------------------------------------------------

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function round(x: number | null, dp: number): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** right = 1, partial = 0.5, wrong = 0; everything else (too_early/inconclusive/null) is unscored. */
function hitValue(outcome: string | null): number | null {
  switch (outcome) {
    case "right":
      return 1;
    case "partial":
      return 0.5;
    case "wrong":
      return 0;
    default:
      return null;
  }
}

/** One call after scoring against its conclusive backtests. */
interface ScoredCall {
  call: CallRow;
  hit: number; // call-level hit in [0,1], mean of its conclusive backtests' hit values
  avgAlpha: number | null; // mean of its conclusive backtests' alphaPct
  sector: string;
}

function sliceStats<T>(
  items: T[],
  keyOf: (t: T) => string,
  hitOf: (t: T) => number,
  alphaOf: (t: T) => number | null,
): Record<string, SliceStat> {
  const groups = new Map<string, { hits: number[]; alphas: number[] }>();
  for (const it of items) {
    const k = keyOf(it);
    let g = groups.get(k);
    if (!g) {
      g = { hits: [], alphas: [] };
      groups.set(k, g);
    }
    g.hits.push(hitOf(it));
    const a = alphaOf(it);
    if (a != null) g.alphas.push(a);
  }
  const out: Record<string, SliceStat> = {};
  for (const [k, g] of groups) {
    out[k] = {
      hitRate: round(mean(g.hits), 4),
      avgAlphaPct: round(mean(g.alphas), 2),
      n: g.hits.length,
    };
  }
  return out;
}

function bestWorstSlice(slices: Record<string, SliceStat>): { best: string | null; worst: string | null } {
  const ranked = Object.entries(slices)
    .filter(([, s]) => s.n >= 2 && s.hitRate != null)
    .sort((a, b) => (b[1].hitRate as number) - (a[1].hitRate as number));
  if (ranked.length === 0) return { best: null, worst: null };
  return { best: ranked[0][0], worst: ranked[ranked.length - 1][0] };
}

function modeHorizon(scored: ScoredCall[]): string | null {
  const counts = new Map<string, number>();
  for (const s of scored) {
    const h = s.call.horizon ?? "unspecified";
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = -1;
  for (const [h, n] of counts) {
    if (n > bestN) {
      best = h;
      bestN = n;
    }
  }
  return best;
}

// --- position-aware (campaign) scoring --------------------------------------

/** Outcome of one campaign (Position), derived from its linked calls' backtests. */
interface ScoredPosition {
  hit: number | null; // right=1, partial=0.5, wrong=0; null when no conclusive backtest
  alphaPct: number | null; // benchmark-relative, direction-adjusted (from the chosen backtest)
  outcome: string | null;
}

/** Signed day distance between two ISO dates (a − b), Infinity when unparseable. */
function dayDistISO(aISO: string, bISO: string): number {
  const a = Date.parse(`${aISO.slice(0, 10)}T00:00:00.000Z`);
  const b = Date.parse(`${bISO.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return (a - b) / 86_400_000;
}

/** The conclusive backtest whose eval date sits closest to the campaign anchor. */
function nearestConclusive(rows: BacktestRow[], anchorISO: string): BacktestRow | null {
  let best: BacktestRow | null = null;
  let bestDist = Infinity;
  for (const b of rows) {
    if (hitValue(b.outcome) == null || b.evalDate == null) continue;
    const dist = Math.abs(dayDistISO(b.evalDate, anchorISO));
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}

/**
 * Score a campaign "did it work, entry → exit/now, benchmark-relative" from the
 * linked calls' (already direction-adjusted, no-lookahead) backtests. Anchored at
 * the position's close (or today, for open campaigns), we take the entry call's
 * horizon whose eval date lands nearest that anchor — i.e. how the opening thesis
 * had played out by the time they exited / by now — falling back to the nearest
 * conclusive backtest across all the campaign's calls. Returns nulls when nothing
 * is conclusive yet (e.g. a young campaign, or a theme/macro subject with no
 * priceable backtests), so the campaign is counted but left unscored.
 */
function scorePositionOutcome(
  position: PositionRow,
  linkedCallIds: number[],
  btByCall: Map<number, BacktestRow[]>,
  nowISO: string,
): ScoredPosition {
  const anchorISO = position.closedAt ? position.closedAt.toISOString().slice(0, 10) : nowISO;

  const entryCallId =
    position.firstCallId != null && linkedCallIds.includes(position.firstCallId)
      ? position.firstCallId
      : linkedCallIds.length
        ? Math.min(...linkedCallIds)
        : null;

  let chosen = entryCallId != null ? nearestConclusive(btByCall.get(entryCallId) ?? [], anchorISO) : null;
  if (!chosen) {
    const allRows = linkedCallIds.flatMap((id) => btByCall.get(id) ?? []);
    chosen = nearestConclusive(allRows, anchorISO);
  }
  if (!chosen) return { hit: null, alphaPct: null, outcome: null };
  return { hit: hitValue(chosen.outcome), alphaPct: chosen.alphaPct ?? null, outcome: chosen.outcome };
}

// --- core --------------------------------------------------------------------

/**
 * Recompute an author's scorecard + playbook and upsert it. Terminal job (no
 * downstream enqueue). Returns the synthesized playbook, or null for an unknown
 * author id.
 */
export async function buildPlaybook(authorId: number): Promise<AuthorPlaybook | null> {
  if (!Number.isFinite(authorId)) return null;

  const [author] = await db
    .select({ handle: tables.authors.handle })
    .from(tables.authors)
    .where(eq(tables.authors.id, authorId))
    .limit(1);
  const handle = author?.handle ?? `author#${authorId}`;

  const calls = await db.select().from(tables.calls).where(eq(tables.calls.authorId, authorId));

  // Backtests for this author's calls, grouped by callId.
  const callIds = calls.map((c) => c.id);
  const backtests = callIds.length
    ? await db.select().from(tables.backtests).where(inArray(tables.backtests.callId, callIds))
    : [];
  const btByCall = new Map<number, BacktestRow[]>();
  for (const b of backtests) {
    const list = btByCall.get(b.callId);
    if (list) list.push(b);
    else btByCall.set(b.callId, [b]);
  }

  // Sector lookup via companies (calls.ticker → companies.sector).
  const tickers = [...new Set(calls.map((c) => c.ticker).filter((t): t is string => t != null).map((t) => t.toUpperCase()))];
  const companies = tickers.length
    ? await db
        .select({ ticker: tables.companies.ticker, sector: tables.companies.sector })
        .from(tables.companies)
        .where(inArray(tables.companies.ticker, tickers))
    : [];
  const sectorByTicker = new Map(companies.map((c) => [c.ticker.toUpperCase(), c.sector ?? "Unknown"]));

  // Score each call against its conclusive backtests. byHorizon is computed at
  // the backtest (call × horizon) grain; everything else at the call grain.
  const scored: ScoredCall[] = [];
  const horizonSamples: { horizon: string; hit: number; alpha: number | null }[] = [];
  for (const call of calls) {
    const list = btByCall.get(call.id) ?? [];
    const conclusive = list.filter((b) => hitValue(b.outcome) != null);
    for (const b of conclusive) {
      horizonSamples.push({ horizon: b.horizon, hit: hitValue(b.outcome) as number, alpha: b.alphaPct ?? null });
    }
    if (conclusive.length === 0) continue;
    const hit = mean(conclusive.map((b) => hitValue(b.outcome) as number)) as number;
    const avgAlpha = mean(conclusive.map((b) => b.alphaPct).filter((a): a is number => a != null));
    scored.push({
      call,
      hit,
      avgAlpha,
      sector: (call.ticker ? sectorByTicker.get(call.ticker.toUpperCase()) : null) ?? "Unknown",
    });
  }

  const sampleSize = scored.length;
  const hitRate = round(mean(scored.map((s) => s.hit)), 4);
  const avgAlphaPct = round(mean(scored.map((s) => s.avgAlpha).filter((a): a is number => a != null)), 2);

  const byHorizon = sliceStats(horizonSamples, (s) => s.horizon, (s) => s.hit, (s) => s.alpha);
  const byStance = sliceStats(scored, (s) => s.call.stance, (s) => s.hit, (s) => s.avgAlpha);
  const bySector = sliceStats(scored, (s) => s.sector, (s) => s.hit, (s) => s.avgAlpha);

  // Conviction calibration: stated conviction bucket vs realized hit-rate.
  const calibration: ConvictionCalibrationBucket[] = [];
  for (let i = 0; i < CONVICTION_BUCKETS.length; i++) {
    const inBucket = scored.filter((s) => {
      const conv = s.call.conviction;
      if (conv == null) return false;
      const idx = Math.min(CONVICTION_BUCKETS.length - 1, Math.floor(conv * CONVICTION_BUCKETS.length));
      return idx === i;
    });
    if (inBucket.length === 0) continue;
    calibration.push({
      bucket: CONVICTION_BUCKETS[i],
      predicted: round(mean(inBucket.map((s) => s.call.conviction as number)), 3) as number,
      realizedHitRate: round(mean(inBucket.map((s) => s.hit)), 4),
      n: inBucket.length,
    });
  }

  // Position-aware (campaign) track record: read this author's first-class
  // Positions and score each from its linked calls' backtests (entry → exit/now,
  // benchmark-relative). Counts span every position; hit-rate/alpha aggregate the
  // scored (conclusive) ones. Communicates with the `link` stage only via the DB.
  const positions = await db
    .select()
    .from(tables.auguryPositions)
    .where(eq(tables.auguryPositions.authorId, authorId));

  const callsByPosition = new Map<number, number[]>();
  for (const c of calls) {
    if (c.positionId == null) continue;
    const list = callsByPosition.get(c.positionId);
    if (list) list.push(c.id);
    else callsByPosition.set(c.positionId, [c.id]);
  }

  const nowISO = new Date().toISOString().slice(0, 10);
  const positionHits: number[] = [];
  const positionAlphas: number[] = [];
  let scoredPositions = 0;
  const bySubjectType: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const p of positions) {
    bySubjectType[p.subjectType] = (bySubjectType[p.subjectType] ?? 0) + 1;
    byStage[p.currentStage ?? "unspecified"] = (byStage[p.currentStage ?? "unspecified"] ?? 0) + 1;
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

    const sp = scorePositionOutcome(p, callsByPosition.get(p.id) ?? [], btByCall, nowISO);
    if (sp.hit != null) {
      scoredPositions += 1;
      positionHits.push(sp.hit);
      if (sp.alphaPct != null) positionAlphas.push(sp.alphaPct);
    }
  }
  const positionScorecard: PositionScorecard = {
    totalPositions: positions.length,
    scoredPositions,
    hitRate: round(mean(positionHits), 4),
    avgAlphaPct: round(mean(positionAlphas), 2),
    bySubjectType,
    byStage,
    byStatus,
  };

  // Representative calls for grounding the narrative: largest |alpha| first, so the
  // model sees the author's biggest hits and misses. Their post ids become the citations.
  const representative = [...scored]
    .sort((a, b) => Math.abs(b.avgAlpha ?? 0) - Math.abs(a.avgAlpha ?? 0))
    .slice(0, REPRESENTATIVE_CALLS);
  const citedPostIds = representative.map((s) => s.call.postId);

  // Deterministic fallback narrative (used as-is when no provider key).
  const stanceRank = bestWorstSlice(byStance);
  const sectorRank = bestWorstSlice(bySector);
  const horizonMode = modeHorizon(scored);
  const fallbackSummary =
    sampleSize === 0
      ? `@${handle}: no backtested calls on record yet — insufficient data to characterize an edge.`
      : `@${handle}: ${sampleSize} scored call${sampleSize === 1 ? "" : "s"}, ${
          hitRate != null ? `${(hitRate * 100).toFixed(0)}% hit-rate` : "hit-rate n/a"
        }, ${avgAlphaPct != null ? `${fmtSigned(avgAlphaPct)}% avg alpha` : "alpha n/a"}.${
          stanceRank.best ? ` Strongest on ${stanceRank.best} calls.` : ""
        }${sectorRank.best && sectorRank.best !== "Unknown" ? ` Best sector: ${sectorRank.best}.` : ""}${
          horizonMode ? ` Typical horizon: ${horizonMode}.` : ""
        }`;
  const fallbackEdges: string[] = [];
  if (stanceRank.best) fallbackEdges.push(`${stanceRank.best} calls (highest realized hit-rate by stance)`);
  if (sectorRank.best && sectorRank.best !== "Unknown") fallbackEdges.push(`${sectorRank.best} names`);
  const fallbackWeaknesses: string[] = [];
  if (stanceRank.worst && stanceRank.worst !== stanceRank.best)
    fallbackWeaknesses.push(`${stanceRank.worst} calls (lowest realized hit-rate by stance)`);
  if (sectorRank.worst && sectorRank.worst !== "Unknown" && sectorRank.worst !== sectorRank.best)
    fallbackWeaknesses.push(`${sectorRank.worst} names`);

  let summary = fallbackSummary;
  let edges = fallbackEdges;
  let weaknesses = fallbackWeaknesses;

  // Optional grounded synthesis. Skipped silently without keys or on failure.
  if (sampleSize > 0) {
    try {
      const m = modelFor("augur_extract"); // throws when no provider key — keep deterministic fallback

      // Best-effort Vault grounding for the most-traded ticker (FTS works keyless; tolerate empty/failure).
      let vaultBlock = "";
      const topTicker = mostCommonTicker(scored);
      if (topTicker) {
        try {
          vaultBlock = await vaultContext(topTicker, [`${topTicker} thesis`, `${topTicker} risks`], 2);
        } catch {
          vaultBlock = "";
        }
      }

      const repBlock = representative
        .map((s) => {
          const c = s.call;
          return `#${c.id} post ${c.postId} [${c.ticker ?? "?"}] ${c.stance}/${c.lifecycleStage}, ${
            c.horizon ?? "unspecified"
          }, conviction ${c.conviction ?? "?"} → hit ${s.hit.toFixed(2)}, alpha ${
            s.avgAlpha != null ? `${fmtSigned(round(s.avgAlpha, 1) as number)}%` : "n/a"
          }: ${(c.thesisSummary ?? "").slice(0, 160)}`;
        })
        .join("\n");

      const prompt = `${vaultBlock ? `${vaultBlock}\n\n========\n\n` : ""}TRACK RECORD for @${handle}
Overall: ${sampleSize} scored calls, hit-rate ${hitRate != null ? (hitRate * 100).toFixed(0) + "%" : "n/a"}, avg alpha ${
        avgAlphaPct != null ? fmtSigned(avgAlphaPct) + "%" : "n/a"
      }.
By stance: ${sliceLine(byStance)}
By horizon: ${sliceLine(byHorizon)}
By sector: ${sliceLine(bySector)}
Conviction calibration: ${
        calibration.length
          ? calibration.map((c) => `${c.bucket}: predicted ${c.predicted}, realized ${c.realizedHitRate ?? "n/a"} (n=${c.n})`).join("; ")
          : "n/a"
      }
Positions (campaigns): ${positionScorecard.totalPositions} total, ${positionScorecard.scoredPositions} scored, hit-rate ${
        positionScorecard.hitRate != null ? (positionScorecard.hitRate * 100).toFixed(0) + "%" : "n/a"
      }, avg alpha ${
        positionScorecard.avgAlphaPct != null ? fmtSigned(positionScorecard.avgAlphaPct) + "%" : "n/a"
      }; by type ${countLine(bySubjectType)}; by stage ${countLine(byStage)}.

REPRESENTATIVE CALLS (biggest hits and misses)
${repBlock}

Write the playbook. Ground edges/weaknesses in the slices and representative calls above.`;

      const { object } = await generateObject({
        model: m.model,
        system: PROFILE_SYSTEM,
        schema: narrativeSchema,
        prompt,
      });
      summary = object.summary;
      edges = object.edges;
      weaknesses = object.weaknesses;
    } catch {
      // keep deterministic fallback
    }
  }

  const playbook: AuthorPlaybook = {
    authorId,
    handle,
    summary,
    citedPostIds,
    hitRate,
    avgAlphaPct,
    sampleSize,
    byHorizon,
    byStance,
    bySector,
    convictionCalibration: calibration,
    edges,
    weaknesses,
    positionScorecard,
  };

  // Upsert against the v2 unique(authorId) index — one scorecard per author.
  const values = {
    authorId,
    hitRate,
    avgAlphaPct,
    sampleSize,
    byHorizon: JSON.stringify(byHorizon),
    byStance: JSON.stringify(byStance),
    bySector: JSON.stringify(bySector),
    convictionCalibration: JSON.stringify(calibration),
    playbook: JSON.stringify(playbook), // includes positionScorecard (additive)
    updatedAt: new Date(),
  };
  await db
    .insert(tables.authorScorecards)
    .values(values)
    .onConflictDoUpdate({
      target: tables.authorScorecards.authorId,
      set: {
        hitRate: values.hitRate,
        avgAlphaPct: values.avgAlphaPct,
        sampleSize: values.sampleSize,
        byHorizon: values.byHorizon,
        byStance: values.byStance,
        bySector: values.bySector,
        convictionCalibration: values.convictionCalibration,
        playbook: values.playbook,
        updatedAt: values.updatedAt,
      },
    });

  return playbook;
}

function fmtSigned(x: number): string {
  return `${x >= 0 ? "+" : ""}${x}`;
}

function sliceLine(slices: Record<string, SliceStat>): string {
  const entries = Object.entries(slices);
  if (entries.length === 0) return "n/a";
  return entries
    .map(([k, s]) => `${k} ${s.hitRate != null ? (s.hitRate * 100).toFixed(0) + "%" : "n/a"} (n=${s.n})`)
    .join(", ");
}

function countLine(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "n/a";
  return entries.map(([k, n]) => `${k} ${n}`).join(", ");
}

function mostCommonTicker(scored: ScoredCall[]): string | null {
  const counts = new Map<string, number>();
  for (const s of scored) {
    if (!s.call.ticker) continue;
    const t = s.call.ticker.toUpperCase();
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [t, n] of counts) {
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}

/** Job handler for `profile` jobs. Payload: { authorId }. Terminal. */
export const profileHandler: JobHandler = async (payload: { authorId: number }) => {
  await buildPlaybook(Number(payload?.authorId));
};
