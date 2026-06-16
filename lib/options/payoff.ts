// Structure payoff engine — the shared, pure core used by the strategist (rank
// candidates), the book (mark to model), and the backtester (realized P&L).
// Everything is per ONE structure-lot: one contract per leg unit = 100 shares.
// Multi-expiry structures (calendars/diagonals) are valued at the EARLIEST leg
// expiry (the "eval horizon"); legs still alive at that point are repriced with
// Black-Scholes at their entry IV — a documented constant-vol approximation,
// not a surface-dynamics model.
import { blackScholes, intrinsic, type Right } from "@/lib/options/bs";
import type { RiskNeutralDensity } from "@/lib/mathlab/rnd";

const MULTIPLIER = 100; // shares per contract
const GRID_POINTS = 480;

export type LegSpec = {
  right: Right;
  action: "long" | "short";
  strike: number;
  expiry: string; // ISO date
  qty: number; // contracts per structure-lot
  mid: number | null; // per-share entry premium
  iv: number | null; // for repricing if it outlives the eval horizon
};

const sign = (leg: LegSpec): number => (leg.action === "long" ? 1 : -1);

function yearsBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T21:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T21:00:00Z`);
  return Math.max((b - a) / (365 * 86_400_000), 0);
}

/** The earliest leg expiry — the horizon at which the structure is evaluated. */
export function evalHorizon(legs: LegSpec[]): string {
  return legs.reduce((min, l) => (l.expiry < min ? l.expiry : min), legs[0].expiry);
}

/** Net entry cost per share: + = debit paid, − = credit received. Null if any leg is unpriced. */
export function entryCostPerShare(legs: LegSpec[]): number | null {
  let acc = 0;
  for (const leg of legs) {
    if (leg.mid == null || !Number.isFinite(leg.mid)) return null;
    acc += sign(leg) * leg.mid * leg.qty;
  }
  return acc;
}

/** What the structure is worth per share if the underlying is `s` at the eval horizon. */
export function valuePerShareAt(legs: LegSpec[], s: number, horizon: string, rate = 0.04): number {
  let v = 0;
  for (const leg of legs) {
    let price: number;
    if (leg.expiry <= horizon) {
      price = intrinsic(leg.right, s, leg.strike);
    } else {
      const years = yearsBetween(horizon, leg.expiry);
      const iv = leg.iv != null && leg.iv > 0 ? leg.iv : 0.5;
      price = blackScholes(leg.right, s, leg.strike, iv, years, rate).price;
    }
    v += sign(leg) * price * leg.qty;
  }
  return v;
}

/** P&L in dollars per lot at underlying `s`. */
export function pnlPerLotAt(legs: LegSpec[], s: number, entryCost: number, horizon: string, rate = 0.04): number {
  return MULTIPLIER * (valuePerShareAt(legs, s, horizon, rate) - entryCost);
}

/** Net signed call contracts — > 0 means upside is unbounded (no capping short call). */
function netCallQty(legs: LegSpec[]): number {
  return legs.filter((l) => l.right === "C").reduce((s, l) => s + sign(l) * l.qty, 0);
}

export type PayoffProfile = {
  maxLoss: number; // positive magnitude of the worst case ($/lot)
  maxGain: number | null; // null = unbounded
  breakevens: number[]; // underlying prices where P&L crosses zero
};

/** Worst/best case and breakevens by scanning a strike-aware grid of terminal prices. */
export function payoffProfile(legs: LegSpec[], entryCost: number, spot: number, rate = 0.04): PayoffProfile {
  const horizon = evalHorizon(legs);
  const hi = Math.max(spot * 4, Math.max(...legs.map((l) => l.strike)) * 1.5);
  const grid = new Set<number>();
  for (let i = 0; i <= GRID_POINTS; i++) grid.add((hi * i) / GRID_POINTS);
  for (const l of legs) {
    grid.add(l.strike);
    grid.add(l.strike * 0.999);
    grid.add(l.strike * 1.001);
  }
  const xs = [...grid].filter((x) => x >= 0).sort((a, b) => a - b);

  let minPnl = Infinity;
  let maxPnl = -Infinity;
  const pnls = xs.map((x) => {
    const p = pnlPerLotAt(legs, x, entryCost, horizon, rate);
    if (p < minPnl) minPnl = p;
    if (p > maxPnl) maxPnl = p;
    return p;
  });

  const breakevens: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = pnls[i - 1];
    const b = pnls[i];
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
      const t = a / (a - b); // linear interp to the zero crossing
      breakevens.push(xs[i - 1] + t * (xs[i] - xs[i - 1]));
    }
  }

  const unboundedUp = netCallQty(legs) > 1e-9;
  return {
    maxLoss: Math.max(0, -minPnl),
    maxGain: unboundedUp ? null : Math.max(0, maxPnl),
    breakevens: breakevens.map((b) => Math.round(b * 100) / 100),
  };
}

export type RndEval = { pop: number; evPerLot: number };

/**
 * Probability of profit and risk-neutral expected P&L, integrating the RND at
 * the eval horizon. POP = ∫ q(K) over the region where P&L(K) > 0; EV =
 * ∫ q(K)·P&L(K). Returns null when there is no usable density.
 */
export function popAndEvFromRnd(
  rnd: RiskNeutralDensity | null,
  legs: LegSpec[],
  entryCost: number,
  rate = 0.04,
): RndEval | null {
  if (!rnd || rnd.strikes.length < 2) return null;
  const horizon = evalHorizon(legs);
  const { strikes, density } = rnd;
  let popMass = 0;
  let ev = 0;
  for (let i = 1; i < strikes.length; i++) {
    const dx = strikes[i] - strikes[i - 1];
    const midK = (strikes[i - 1] + strikes[i]) / 2;
    const dMid = (density[i - 1] + density[i]) / 2;
    const pnl = pnlPerLotAt(legs, midK, entryCost, horizon, rate);
    ev += dMid * pnl * dx;
    if (pnl > 0) popMass += dMid * dx;
  }
  return { pop: Math.min(Math.max(popMass, 0), 1), evPerLot: ev };
}

/** Mean P&L per lot over a Monte Carlo terminal-price sample (real-world measure). */
export function evFromTerminals(terminals: number[], legs: LegSpec[], entryCost: number, rate = 0.04): number | null {
  if (terminals.length === 0) return null;
  const horizon = evalHorizon(legs);
  let acc = 0;
  for (const s of terminals) acc += pnlPerLotAt(legs, s, entryCost, horizon, rate);
  return acc / terminals.length;
}

export { MULTIPLIER };
