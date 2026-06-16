// Options backtest + structure-selection scorecard — the moat for the options
// branch. For every structure (open marked-to-model, closed realized) it scores
// the structure's P&L against TWO benchmarks: the capital it put at risk, and
// what simply holding the underlying would have done over the same window
// (direction-adjusted). The overlay's alpha is the gap. Aggregated by structure
// type × vol regime, it answers the only question that matters: did the
// strategist's choice actually pay, and in which regimes? Mirrors Augury's
// backtest → scorecard pattern. Keyless and deterministic.
import { and, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { computeOptionsBook } from "@/lib/options/book";

const WIN_PCT = 5; // structurePnlPct beyond ±5% of capital at risk is a definitive call

export type VolRegime = "cheap" | "fair" | "rich" | "unknown";

function regimeFromVrp(vrp: number | null | undefined): VolRegime {
  if (vrp == null || !Number.isFinite(vrp)) return "unknown";
  if (vrp >= 0.08) return "rich";
  if (vrp <= -0.08) return "cheap";
  return "fair";
}

type Record = {
  structureId: number;
  ticker: string;
  strategy: string;
  regime: VolRegime;
  evalDate: string;
  evalUnderlying: number | null;
  structureValue: number | null; // per-lot $ mark/exit
  structurePnlPct: number | null;
  stockOnlyPnlPct: number | null;
  overlayAlphaPct: number | null;
  outcome: "right" | "wrong" | "partial" | "inconclusive";
};

function classify(pnlPct: number | null): Record["outcome"] {
  if (pnlPct == null) return "inconclusive";
  if (pnlPct > WIN_PCT) return "right";
  if (pnlPct < -WIN_PCT) return "wrong";
  return "partial";
}

export type BacktestSummary = { evaluated: number; scorecards: number };

/**
 * Recompute the per-structure backtest points and rebuild the scorecards.
 * Run after closes, or on a schedule once the book has history.
 */
export async function runOptionsBacktests(): Promise<BacktestSummary> {
  const [book, closed] = await Promise.all([
    computeOptionsBook(),
    db.select().from(tables.optionStructures).where(eq(tables.optionStructures.status, "closed")),
  ]);

  // Vol regime at entry comes from the originating directive's VRP, when linked.
  const directiveIds = [
    ...new Set(
      [...book.open, ...closed]
        .map((s) => ("directiveId" in s ? (s as { directiveId: number | null }).directiveId : null))
        .filter((x): x is number => x != null),
    ),
  ];
  const regimeByStructure = new Map<number, VolRegime>();
  if (directiveIds.length > 0) {
    const dirs = await db.select().from(tables.directives).where(inArray(tables.directives.id, directiveIds));
    const vrpByDirective = new Map<number, number | null>();
    for (const d of dirs) {
      try {
        const inputs = JSON.parse(d.inputs) as { garch?: { vrp?: number | null } | null };
        vrpByDirective.set(d.id, inputs.garch?.vrp ?? null);
      } catch {
        vrpByDirective.set(d.id, null);
      }
    }
    for (const s of closed) if (s.directiveId != null) regimeByStructure.set(s.id, regimeFromVrp(vrpByDirective.get(s.directiveId)));
  }

  const today = new Date().toISOString().slice(0, 10);
  const records: Record[] = [];

  // Open structures: marked to model.
  for (const s of book.open) {
    const dirMult = s.direction === "bearish" ? -1 : 1;
    const stockOnly =
      s.entryUnderlying != null && s.entryUnderlying > 0 && s.currentUnderlying != null
        ? (s.currentUnderlying / s.entryUnderlying - 1) * 100 * dirMult
        : null;
    const overlay = s.pnlPct != null && stockOnly != null ? s.pnlPct - stockOnly : null;
    records.push({
      structureId: s.id,
      ticker: s.ticker,
      strategy: s.strategy,
      regime: regimeByStructure.get(s.id) ?? "unknown",
      evalDate: today,
      evalUnderlying: s.currentUnderlying,
      structureValue: s.currentValuePerLot,
      structurePnlPct: s.pnlPct,
      stockOnlyPnlPct: stockOnly,
      overlayAlphaPct: overlay,
      outcome: classify(s.pnlPct),
    });
  }

  // Closed structures: realized.
  for (const s of closed) {
    const capitalAtRisk = (s.maxLoss ?? 0) * s.qty;
    const structurePnlPct = s.realizedPnl != null && capitalAtRisk > 0 ? (s.realizedPnl / capitalAtRisk) * 100 : null;
    const dirMult = s.direction === "bearish" ? -1 : 1;
    const stockOnly =
      s.entryUnderlying != null && s.entryUnderlying > 0 && s.exitUnderlying != null
        ? (s.exitUnderlying / s.entryUnderlying - 1) * 100 * dirMult
        : null;
    const overlay = structurePnlPct != null && stockOnly != null ? structurePnlPct - stockOnly : null;
    records.push({
      structureId: s.id,
      ticker: s.ticker,
      strategy: s.strategy,
      regime: regimeByStructure.get(s.id) ?? "unknown",
      evalDate: s.closedAt?.toISOString().slice(0, 10) ?? today,
      evalUnderlying: s.exitUnderlying,
      structureValue: s.exitNetValue,
      structurePnlPct,
      stockOnlyPnlPct: stockOnly,
      overlayAlphaPct: overlay,
      outcome: classify(structurePnlPct),
    });
  }

  // Persist one backtest row per structure for this eval (replace prior same-day rows).
  for (const r of records) {
    await db
      .delete(tables.optionBacktests)
      .where(and(eq(tables.optionBacktests.structureId, r.structureId), eq(tables.optionBacktests.evalDate, r.evalDate)));
    await db.insert(tables.optionBacktests).values({
      structureId: r.structureId,
      ticker: r.ticker,
      evalDate: r.evalDate,
      evalUnderlying: r.evalUnderlying,
      structureValue: r.structureValue,
      structurePnlPct: r.structurePnlPct,
      stockOnlyPnlPct: r.stockOnlyPnlPct,
      overlayAlphaPct: r.overlayAlphaPct,
      outcome: r.outcome,
      notes: `${r.strategy} · regime ${r.regime}`,
    });
  }

  // Aggregate scorecards by strategy × regime, plus per-strategy, per-regime, overall.
  type Bucket = { right: number; scored: number; alpha: number[]; pnl: number[]; n: number };
  const groups = new Map<string, Bucket>();
  const add = (strategy: string, regime: string, r: Record) => {
    const key = `${strategy}|${regime}`;
    const b = groups.get(key) ?? { right: 0, scored: 0, alpha: [], pnl: [], n: 0 };
    b.n += 1;
    if (r.outcome === "right") b.right += 1;
    if (r.outcome === "right" || r.outcome === "wrong" || r.outcome === "partial") b.scored += 1;
    if (r.overlayAlphaPct != null) b.alpha.push(r.overlayAlphaPct);
    if (r.structurePnlPct != null) b.pnl.push(r.structurePnlPct);
    groups.set(key, b);
  };
  for (const r of records) {
    add(r.strategy, r.regime, r);
    add(r.strategy, "*", r);
    add("*", r.regime, r);
    add("*", "*", r);
  }
  const mean = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

  // Rebuild the materialized scorecard table.
  await db.delete(tables.optionScorecards);
  let scorecards = 0;
  for (const [key, b] of groups) {
    const [strategy, regime] = key.split("|");
    await db.insert(tables.optionScorecards).values({
      strategy,
      volRegime: regime,
      hitRate: b.scored > 0 ? b.right / b.scored : null,
      avgOverlayAlphaPct: mean(b.alpha),
      avgStructurePnlPct: mean(b.pnl),
      sampleSize: b.n,
      data: JSON.stringify({ right: b.right, scored: b.scored }),
    });
    scorecards += 1;
  }

  return { evaluated: records.length, scorecards };
}
