// The Derivatives Desk book — the options analog of computeBookQuant. Marks
// every open structure to model off the live chain (or Black-Scholes when a
// contract has gone dark), aggregates PORTFOLIO greeks (net delta, beta-
// weighted dollar delta, gamma, vega-by-tenor, theta), and totals premium at
// risk. Keyless and null-safe; a dark underlying degrades to entry marks, never
// a fabricated P&L. Greeks reuse the desk convention: vega per vol POINT,
// theta per CALENDAR day, all per structure-lot then scaled by qty.
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { fetchChain, type OptionChain } from "@/lib/signals/options";
import { getQuote } from "@/lib/market";
import { getPortfolio, OPTIONS_MANDATE } from "@/lib/quant";
import { blackScholes } from "@/lib/options/bs";

const MULTIPLIER = 100;

type StructureRow = typeof tables.optionStructures.$inferSelect;
type LegRow = typeof tables.optionLegs.$inferSelect;

export type LegView = {
  right: "C" | "P";
  action: "long" | "short";
  strike: number;
  expiry: string;
  qty: number;
  entryMid: number | null;
  currentMid: number | null;
  marked: "live" | "model" | "entry";
};

export type StructureGreeksView = { delta: number; gamma: number; vega: number; theta: number };

export type OpenStructureView = {
  id: number;
  companyId: number | null;
  ticker: string;
  strategy: string;
  direction: string | null;
  expiry: string | null;
  dte: number | null;
  qty: number;
  netDebit: number | null; // per-lot $
  maxLoss: number | null;
  maxGain: number | null;
  breakevens: number[];
  pop: number | null;
  entryUnderlying: number | null;
  currentUnderlying: number | null;
  currentValuePerLot: number | null; // $ to close one lot now
  pnlUsd: number | null; // total over all lots
  pnlPct: number | null; // vs capital at risk
  capitalAtRisk: number; // maxLoss × qty
  greeksPerLot: StructureGreeksView | null;
  legs: LegView[];
  breakevenDistancePct: number | null; // nearest breakeven vs current underlying
};

export type ClosedStructureView = {
  id: number;
  ticker: string;
  strategy: string;
  qty: number;
  netDebit: number | null;
  realizedPnl: number | null;
  closedAt: string | null;
};

export type OptionsBook = {
  navUsd: number;
  open: OpenStructureView[];
  closed: ClosedStructureView[];
  greeks: {
    netDeltaShares: number; // underlying-equivalent shares
    netDeltaUsd: number; // dollar delta
    betaWeightedDeltaUsd: number; // dollar delta × beta-to-SPY
    netGammaShares: number;
    vegaUsd: number; // $ per vol point
    thetaUsd: number; // $ per calendar day
  };
  vegaByTenor: { tenor: string; vegaUsd: number }[];
  premiumAtRiskUsd: number;
  premiumAtRiskPct: number;
  byUnderlying: { ticker: string; premiumAtRiskUsd: number; vegaUsd: number }[];
  shortGammaNearExpiry: number;
};

function parseJsonArray(s: string | null): number[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function daysToExpiry(expiry: string, asOf: string): number {
  const exp = Date.parse(`${expiry.slice(0, 10)}T21:00:00Z`);
  const ref = Date.parse(asOf) || Date.now();
  return (exp - ref) / 86_400_000;
}

const sign = (action: string): number => (action === "long" ? 1 : -1);

function tenorBucket(dte: number): string {
  if (dte <= 30) return "≤30d";
  if (dte <= 90) return "30–90d";
  return ">90d";
}

/** Latest persisted beta for a ticker (no recompute); 1 when none on file. */
async function betaFor(ticker: string): Promise<number> {
  const rows = await db
    .select({ data: tables.quantSnapshots.data })
    .from(tables.quantSnapshots)
    .where(eq(tables.quantSnapshots.ticker, ticker.toUpperCase()))
    .orderBy(desc(tables.quantSnapshots.createdAt))
    .limit(1);
  if (!rows[0]) return 1;
  try {
    const beta = (JSON.parse(rows[0].data) as { beta?: number | null }).beta;
    return typeof beta === "number" && Number.isFinite(beta) ? beta : 1;
  } catch {
    return 1;
  }
}

/** Mark + greek one leg using the live chain, else Black-Scholes, else entry. */
function markLeg(
  leg: LegRow,
  chain: OptionChain | null,
  underlying: number | null,
  asOf: string,
): { mid: number | null; greeks: StructureGreeksView; marked: LegView["marked"] } {
  const s = sign(leg.action) * leg.qty;
  const right: "C" | "P" = leg.right === "P" ? "P" : "C";
  const found =
    chain?.contracts.find(
      (c) => c.type === right && c.strike === leg.strike && c.expiry === leg.expiry,
    ) ?? null;

  if (found && found.mid != null) {
    const years = Math.max(daysToExpiry(leg.expiry, asOf) / 365, 1 / 365);
    const bs =
      found.iv != null && found.iv > 0 && underlying != null
        ? blackScholes(right, underlying, leg.strike, found.iv, years)
        : null;
    return {
      mid: found.mid,
      greeks: {
        delta: (found.delta ?? bs?.delta ?? 0) * s * MULTIPLIER,
        gamma: (found.gamma ?? bs?.gamma ?? 0) * s * MULTIPLIER,
        vega: (found.vega ?? bs?.vega ?? 0) * s * MULTIPLIER,
        theta: (bs?.theta ?? 0) * s * MULTIPLIER,
      },
      marked: "live",
    };
  }

  // Model fallback: BS off the current underlying + the leg's entry IV.
  if (underlying != null && leg.entryIv != null && leg.entryIv > 0) {
    const years = Math.max(daysToExpiry(leg.expiry, asOf) / 365, 1 / 365);
    const bs = blackScholes(right, underlying, leg.strike, leg.entryIv, years);
    return {
      mid: bs.price,
      greeks: {
        delta: bs.delta * s * MULTIPLIER,
        gamma: bs.gamma * s * MULTIPLIER,
        vega: bs.vega * s * MULTIPLIER,
        theta: bs.theta * s * MULTIPLIER,
      },
      marked: "model",
    };
  }

  // Last resort: hold at entry, greeks from entry snapshot.
  return {
    mid: leg.entryMid,
    greeks: {
      delta: (leg.entryDelta ?? 0) * s * MULTIPLIER,
      gamma: (leg.entryGamma ?? 0) * s * MULTIPLIER,
      vega: (leg.entryVega ?? 0) * s * MULTIPLIER,
      theta: (leg.entryTheta ?? 0) * s * MULTIPLIER,
    },
    marked: "entry",
  };
}

/** The full options book over open + closed structures. Zeroed shape when empty. */
export async function computeOptionsBook(): Promise<OptionsBook> {
  const [structures, portfolio] = await Promise.all([
    db.select().from(tables.optionStructures).orderBy(desc(tables.optionStructures.createdAt)),
    getPortfolio(),
  ]);
  const open = structures.filter((s) => s.status === "open");
  const closed = structures.filter((s) => s.status === "closed");

  const tickers = [...new Set(open.map((s) => s.ticker.toUpperCase()))];
  const chainEntries = await Promise.all(
    tickers.map(async (t) => [t, await fetchChain(t).catch(() => null)] as const),
  );
  const chains = new Map<string, OptionChain | null>(chainEntries);
  const quoteEntries = await Promise.all(
    tickers.map(async (t) => [t, (await getQuote(t).catch(() => null))?.price ?? null] as const),
  );
  const underlyings = new Map<string, number | null>(quoteEntries);
  const betaEntries = await Promise.all(tickers.map(async (t) => [t, await betaFor(t)] as const));
  const betas = new Map<string, number>(betaEntries);

  const legsByStructure = new Map<number, LegRow[]>();
  if (open.length > 0) {
    const allLegs = await db.select().from(tables.optionLegs);
    for (const leg of allLegs) {
      const list = legsByStructure.get(leg.structureId);
      if (list) list.push(leg);
      else legsByStructure.set(leg.structureId, [leg]);
    }
  }

  const nowIso = new Date().toISOString();
  const openViews: OpenStructureView[] = [];
  let netDeltaShares = 0;
  let netDeltaUsd = 0;
  let betaWeightedDeltaUsd = 0;
  let netGammaShares = 0;
  let vegaUsd = 0;
  let thetaUsd = 0;
  let premiumAtRiskUsd = 0;
  let shortGammaNearExpiry = 0;
  const tenorVega = new Map<string, number>();
  const underlyingAgg = new Map<string, { premiumAtRiskUsd: number; vegaUsd: number }>();

  for (const s of open) {
    const t = s.ticker.toUpperCase();
    const chain = chains.get(t) ?? null;
    const asOf = chain?.asOf ?? nowIso;
    const underlying = chain?.spot ?? underlyings.get(t) ?? null;
    const beta = betas.get(t) ?? 1;
    const legs = legsByStructure.get(s.id) ?? [];

    let currentValuePerShare = 0;
    let priceable = legs.length > 0;
    const legViews: LegView[] = [];
    const g: StructureGreeksView = { delta: 0, gamma: 0, vega: 0, theta: 0 };

    for (const leg of legs) {
      const m = markLeg(leg, chain, underlying, asOf);
      if (m.mid == null) priceable = false;
      else currentValuePerShare += sign(leg.action) * m.mid * leg.qty;
      g.delta += m.greeks.delta;
      g.gamma += m.greeks.gamma;
      g.vega += m.greeks.vega;
      g.theta += m.greeks.theta;
      legViews.push({
        right: leg.right as "C" | "P",
        action: leg.action as "long" | "short",
        strike: leg.strike,
        expiry: leg.expiry,
        qty: leg.qty,
        entryMid: leg.entryMid,
        currentMid: m.mid,
        marked: m.marked,
      });
      // Tenor-bucketed vega across the book.
      const tenor = tenorBucket(daysToExpiry(leg.expiry, asOf));
      tenorVega.set(tenor, (tenorVega.get(tenor) ?? 0) + m.greeks.vega * s.qty);
    }

    const entryCostPerShare = s.netDebit != null ? s.netDebit / MULTIPLIER : null;
    const currentValuePerLot = priceable ? currentValuePerShare * MULTIPLIER : null;
    const pnlUsd =
      priceable && entryCostPerShare != null
        ? (currentValuePerShare - entryCostPerShare) * MULTIPLIER * s.qty
        : null;
    const capitalAtRisk = (s.maxLoss ?? 0) * s.qty;
    const pnlPct = pnlUsd != null && capitalAtRisk > 0 ? (pnlUsd / capitalAtRisk) * 100 : null;
    const dte = s.expiry ? Math.round(daysToExpiry(s.expiry, asOf)) : null;

    // Portfolio greek roll-up (scale per-lot greeks by qty).
    netDeltaShares += g.delta * s.qty;
    const dollarDelta = underlying != null ? g.delta * s.qty * underlying : 0;
    netDeltaUsd += dollarDelta;
    betaWeightedDeltaUsd += dollarDelta * beta;
    netGammaShares += g.gamma * s.qty;
    vegaUsd += g.vega * s.qty;
    thetaUsd += g.theta * s.qty;
    premiumAtRiskUsd += capitalAtRisk;

    if (g.gamma < 0 && dte != null && dte <= OPTIONS_MANDATE.gammaNearExpiryDte) shortGammaNearExpiry++;

    const agg = underlyingAgg.get(t) ?? { premiumAtRiskUsd: 0, vegaUsd: 0 };
    agg.premiumAtRiskUsd += capitalAtRisk;
    agg.vegaUsd += g.vega * s.qty;
    underlyingAgg.set(t, agg);

    const breakevens = parseJsonArray(s.breakevens);
    const breakevenDistancePct =
      underlying != null && breakevens.length > 0
        ? (Math.min(...breakevens.map((b) => Math.abs(b - underlying))) / underlying) * 100
        : null;

    openViews.push({
      id: s.id,
      companyId: s.companyId,
      ticker: t,
      strategy: s.strategy,
      direction: s.direction,
      expiry: s.expiry,
      dte,
      qty: s.qty,
      netDebit: s.netDebit,
      maxLoss: s.maxLoss,
      maxGain: s.maxGain,
      breakevens,
      pop: s.pop,
      entryUnderlying: s.entryUnderlying,
      currentUnderlying: underlying,
      currentValuePerLot: currentValuePerLot != null ? Math.round(currentValuePerLot) : null,
      pnlUsd: pnlUsd != null ? Math.round(pnlUsd) : null,
      pnlPct: pnlPct != null ? Math.round(pnlPct * 10) / 10 : null,
      capitalAtRisk: Math.round(capitalAtRisk),
      greeksPerLot: {
        delta: Math.round(g.delta * 100) / 100,
        gamma: Math.round(g.gamma * 1000) / 1000,
        vega: Math.round(g.vega * 100) / 100,
        theta: Math.round(g.theta * 100) / 100,
      },
      legs: legViews,
      breakevenDistancePct: breakevenDistancePct != null ? Math.round(breakevenDistancePct * 10) / 10 : null,
    });
  }

  const vegaByTenor = ["≤30d", "30–90d", ">90d"]
    .map((tenor) => ({ tenor, vegaUsd: Math.round(tenorVega.get(tenor) ?? 0) }))
    .filter((v) => v.vegaUsd !== 0);

  return {
    navUsd: portfolio.nav,
    open: openViews,
    closed: closed.map((s) => ({
      id: s.id,
      ticker: s.ticker.toUpperCase(),
      strategy: s.strategy,
      qty: s.qty,
      netDebit: s.netDebit,
      realizedPnl: s.realizedPnl,
      closedAt: s.closedAt?.toISOString() ?? null,
    })),
    greeks: {
      netDeltaShares: Math.round(netDeltaShares),
      netDeltaUsd: Math.round(netDeltaUsd),
      betaWeightedDeltaUsd: Math.round(betaWeightedDeltaUsd),
      netGammaShares: Math.round(netGammaShares),
      vegaUsd: Math.round(vegaUsd),
      thetaUsd: Math.round(thetaUsd),
    },
    vegaByTenor,
    premiumAtRiskUsd: Math.round(premiumAtRiskUsd),
    premiumAtRiskPct: portfolio.nav > 0 ? Math.round((premiumAtRiskUsd / portfolio.nav) * 1000) / 10 : 0,
    byUnderlying: [...underlyingAgg.entries()]
      .map(([ticker, v]) => ({ ticker, premiumAtRiskUsd: Math.round(v.premiumAtRiskUsd), vegaUsd: Math.round(v.vegaUsd) }))
      .sort((a, b) => b.premiumAtRiskUsd - a.premiumAtRiskUsd),
    shortGammaNearExpiry,
  };
}

export type { StructureRow };
