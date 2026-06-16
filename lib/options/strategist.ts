// The Options Strategist — the engine that turns a thesis (posterior P) and the
// vol surface into the defined-risk structure that best expresses the edge.
// Deterministic and keyless end to end: it enumerates a fixed catalog, builds
// each from REAL chain strikes/expiries/mids, prices the payoff, reads POP and
// EV off the RND (market measure) AND a posterior-drifted jump-diffusion Monte
// Carlo (the fund's measure), aggregates entry greeks, and ranks by edge-per-
// dollar-at-risk tilted by the vol regime. An LLM (when a key exists) may only
// rewrite the rationale prose — never a number. No naked short legs, ever.
import { generateObject } from "ai";
import { z } from "zod";
import type { OptionChain, OptionContract } from "@/lib/signals/options";
import { blackScholes } from "@/lib/options/bs";
import {
  buildVolSurfaceFromChain,
  pickExpiry,
  pickLaterExpiry,
  type ExpirySurface,
  type VolSurface,
} from "@/lib/options/surface";
import {
  entryCostPerShare,
  evFromTerminals,
  payoffProfile,
  popAndEvFromRnd,
  type LegSpec,
} from "@/lib/options/payoff";
import { simulateMerton } from "@/lib/mathlab/montecarlo";
import { modelFor } from "@/lib/models";

const TRADING_DAYS = 252;
const MC_PATHS = 6000;
const MC_SEED = 7;
const RATE = 0.04;
const RICH_VRP = 0.08; // IV ≥ 8% above the model forecast → premium is rich
const CHEAP_VRP = -0.08;

export type StrategyKind =
  | "long_call"
  | "long_put"
  | "call_debit_spread"
  | "put_debit_spread"
  | "put_credit_spread"
  | "call_credit_spread"
  | "call_calendar"
  | "pmcc"
  | "long_straddle"
  | "long_strangle"
  | "iron_condor";

export type StructureGreeks = { delta: number; gamma: number; vega: number; theta: number };

export type StructureCandidate = {
  strategy: StrategyKind;
  label: string;
  direction: "bullish" | "bearish" | "neutral";
  legs: LegSpec[];
  expiry: string; // eval horizon (near leg), ISO
  dte: number;
  netDebit: number; // $/lot, + debit / − credit
  maxLoss: number; // $/lot, positive magnitude
  maxGain: number | null; // $/lot, null = unbounded
  breakevens: number[];
  pop: number | null; // probability of profit at the horizon, RND
  evRealPerLot: number | null; // posterior-drifted MC EV, $/lot
  evRndPerLot: number | null; // risk-neutral EV, $/lot
  evPctOnRisk: number | null; // evReal / maxLoss, percent
  evRndPctOnRisk: number | null; // evRnd / maxLoss, percent
  greeks: StructureGreeks | null; // per lot, vega per vol-point, theta per day
  capitalAtRisk: number; // $/lot = maxLoss (defined risk)
  rationale: string;
  score: number;
};

export type StrategistInput = {
  ticker: string;
  chain: OptionChain;
  surface?: VolSurface | null;
  posterior: number; // 0..1 P(thesis)
  spot: number;
  catalystDate?: string | null;
  memo?: { bear: number | null; base: number | null; bull: number | null } | null;
  history?: number[]; // daily closes, for MC jump calibration
  forecastVol?: number | null; // GARCH 30d annualized, decimal
  vrp?: number | null; // variance risk premium
  regimeStressed?: boolean;
  maxCandidates?: number;
  polish?: boolean; // LLM prose polish of rationales
};

// --- chain helpers -----------------------------------------------------------

function contractsAt(chain: OptionChain, expiry: string): OptionContract[] {
  return chain.contracts.filter((c) => c.expiry === expiry);
}

/** Liquid contract of `type` nearest a target |delta|; requires live iv + mid. */
function nearestByDelta(cs: OptionContract[], type: "C" | "P", targetAbsDelta: number): OptionContract | null {
  const usable = cs.filter(
    (c) => c.type === type && c.delta != null && c.iv != null && c.mid != null && c.mid > 0,
  );
  if (usable.length === 0) return null;
  return usable.reduce((best, c) =>
    Math.abs(Math.abs(c.delta!) - targetAbsDelta) < Math.abs(Math.abs(best.delta!) - targetAbsDelta) ? c : best,
  );
}

function nearestByStrike(cs: OptionContract[], type: "C" | "P", strike: number): OptionContract | null {
  const usable = cs.filter((c) => c.type === type && c.iv != null && c.mid != null && c.mid > 0);
  if (usable.length === 0) return null;
  return usable.reduce((best, c) => (Math.abs(c.strike - strike) < Math.abs(best.strike - strike) ? c : best));
}

function daysToExpiry(expiry: string, asOf: string): number {
  const exp = Date.parse(`${expiry}T21:00:00Z`);
  const ref = Date.parse(asOf) || Date.now();
  return (exp - ref) / 86_400_000;
}

function mkLeg(c: OptionContract, action: "long" | "short", qty = 1): LegSpec {
  return { right: c.type, action, strike: c.strike, expiry: c.expiry, qty, mid: c.mid, iv: c.iv };
}

function legGreeks(c: OptionContract, action: "long" | "short", qty: number, spot: number, asOf: string): StructureGreeks {
  const s = action === "long" ? 1 : -1;
  const years = Math.max(daysToExpiry(c.expiry, asOf) / 365, 1 / 365);
  const bs = c.iv != null && c.iv > 0 ? blackScholes(c.type, spot, c.strike, c.iv, years, RATE) : null;
  const m = s * qty * 100;
  return {
    delta: (c.delta ?? bs?.delta ?? 0) * m,
    gamma: (c.gamma ?? bs?.gamma ?? 0) * m,
    vega: (c.vega ?? bs?.vega ?? 0) * m,
    theta: (bs?.theta ?? 0) * m,
  };
}

function sumGreeks(parts: StructureGreeks[]): StructureGreeks {
  return parts.reduce(
    (acc, g) => ({ delta: acc.delta + g.delta, gamma: acc.gamma + g.gamma, vega: acc.vega + g.vega, theta: acc.theta + g.theta }),
    { delta: 0, gamma: 0, vega: 0, theta: 0 },
  );
}

function monthDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// --- real-world terminal distribution (the fund's measure) -------------------

/**
 * Jump-diffusion terminals at the horizon with drift implied by the thesis.
 * Mirrors positionRisk's calibration (jumps = daily log moves beyond 3σ) but
 * returns the raw terminal sample so any payoff can be mapped through it.
 */
function realWorldTerminals(
  spot: number,
  horizonTradingDays: number,
  volHint: number | null,
  history: number[],
  driftAnnual: number,
): number[] | null {
  const logRets: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (a > 0 && b > 0) logRets.push(Math.log(b / a));
  }

  let vol = volHint;
  if (vol == null || !(vol > 0)) {
    if (logRets.length < 40) return null;
    const m = logRets.reduce((s, x) => s + x, 0) / logRets.length;
    const variance = logRets.reduce((s, x) => s + (x - m) ** 2, 0) / (logRets.length - 1);
    vol = Math.sqrt(variance * TRADING_DAYS);
    if (!(vol > 0)) return null;
  }

  let jumpIntensity = 0;
  let jumpMean = 0;
  let jumpVol = 0;
  if (logRets.length >= 60) {
    const m = logRets.reduce((s, x) => s + x, 0) / logRets.length;
    const sd = Math.sqrt(logRets.reduce((s, x) => s + (x - m) ** 2, 0) / (logRets.length - 1));
    if (sd > 0) {
      const jumps = logRets.filter((x) => Math.abs(x - m) > 3 * sd);
      if (jumps.length > 0) {
        const years = logRets.length / TRADING_DAYS;
        jumpIntensity = jumps.length / years;
        jumpMean = jumps.reduce((s, x) => s + x, 0) / jumps.length;
        jumpVol = jumps.length > 1 ? Math.sqrt(jumps.reduce((s, x) => s + (x - jumpMean) ** 2, 0) / (jumps.length - 1)) : 0;
      }
    }
  }
  const jumpVar = jumpIntensity * (jumpMean * jumpMean + jumpVol * jumpVol);
  const diffusionVol = Math.sqrt(Math.max(vol * vol - jumpVar, 0.25 * vol * vol));

  const sim = simulateMerton({
    spot,
    mu: driftAnnual,
    vol: diffusionVol,
    jumpIntensity,
    jumpMean,
    jumpVol,
    days: horizonTradingDays,
    paths: MC_PATHS,
    seed: MC_SEED,
  });
  return sim ? sim.terminalPrices : null;
}

// --- candidate assembly ------------------------------------------------------

type RawCandidate = {
  strategy: StrategyKind;
  label: string;
  direction: "bullish" | "bearish" | "neutral";
  legs: LegSpec[];
  greeks: StructureGreeks | null;
};

function buildRawCandidates(input: StrategistInput, surface: VolSurface, near: ExpirySurface): RawCandidate[] {
  const { chain, spot, posterior } = input;
  const asOf = chain.asOf;
  const nearCs = contractsAt(chain, near.expiry);
  const out: RawCandidate[] = [];

  const add = (strategy: StrategyKind, label: string, direction: RawCandidate["direction"], picks: { c: OptionContract; action: "long" | "short"; qty?: number }[]) => {
    if (picks.some((p) => !p.c)) return;
    const legs = picks.map((p) => mkLeg(p.c, p.action, p.qty ?? 1));
    const greeks = sumGreeks(picks.map((p) => legGreeks(p.c, p.action, p.qty ?? 1, spot, asOf)));
    out.push({ strategy, label, direction, legs, greeks });
  };

  const bullish = posterior >= 0.55;
  const bearish = posterior <= 0.45;
  const neutral = !bullish && !bearish;
  const vrp = input.vrp ?? null;
  const cheapVol = vrp != null && vrp <= CHEAP_VRP;

  // --- directional: bullish ---
  if (bullish) {
    const atmC = nearestByDelta(nearCs, "C", 0.5);
    const otmC25 = nearestByDelta(nearCs, "C", 0.25);
    if (atmC) add("long_call", "Long call", "bullish", [{ c: atmC, action: "long" }]);
    if (atmC && otmC25 && otmC25.strike > atmC.strike)
      add("call_debit_spread", "Call debit spread", "bullish", [
        { c: atmC, action: "long" },
        { c: otmC25, action: "short" },
      ]);
    const shortP30 = nearestByDelta(nearCs, "P", 0.3);
    const longP15 = nearestByDelta(nearCs, "P", 0.15);
    if (shortP30 && longP15 && longP15.strike < shortP30.strike)
      add("put_credit_spread", "Put credit spread", "bullish", [
        { c: shortP30, action: "short" },
        { c: longP15, action: "long" },
      ]);
    // PMCC: long deep-ITM far call, short OTM near call (diagonal).
    const far = pickLaterExpiry(surface, near.dte, 45);
    if (far) {
      const farCs = contractsAt(chain, far.expiry);
      const deepC = nearestByDelta(farCs, "C", 0.8);
      const shortC30 = nearestByDelta(nearCs, "C", 0.3);
      if (deepC && shortC30 && shortC30.strike > deepC.strike)
        add("pmcc", "Poor-man's covered call (diagonal)", "bullish", [
          { c: deepC, action: "long" },
          { c: shortC30, action: "short" },
        ]);
    }
  }

  // --- directional: bearish ---
  if (bearish) {
    const atmP = nearestByDelta(nearCs, "P", 0.5);
    const otmP25 = nearestByDelta(nearCs, "P", 0.25);
    if (atmP) add("long_put", "Long put", "bearish", [{ c: atmP, action: "long" }]);
    if (atmP && otmP25 && otmP25.strike < atmP.strike)
      add("put_debit_spread", "Put debit spread", "bearish", [
        { c: atmP, action: "long" },
        { c: otmP25, action: "short" },
      ]);
    const shortC30 = nearestByDelta(nearCs, "C", 0.3);
    const longC15 = nearestByDelta(nearCs, "C", 0.15);
    if (shortC30 && longC15 && longC15.strike > shortC30.strike)
      add("call_credit_spread", "Call credit spread", "bearish", [
        { c: shortC30, action: "short" },
        { c: longC15, action: "long" },
      ]);
  }

  // --- neutral / vol expressions ---
  if (neutral || cheapVol) {
    const atmC = nearestByDelta(nearCs, "C", 0.5);
    const atmP = nearestByStrike(nearCs, "P", atmC?.strike ?? spot);
    if (atmC && atmP)
      add("long_straddle", "Long straddle", "neutral", [
        { c: atmC, action: "long" },
        { c: atmP, action: "long" },
      ]);
    const c30 = nearestByDelta(nearCs, "C", 0.3);
    const p30 = nearestByDelta(nearCs, "P", 0.3);
    if (c30 && p30)
      add("long_strangle", "Long strangle", "neutral", [
        { c: c30, action: "long" },
        { c: p30, action: "long" },
      ]);
    // Calendar: short near ATM call, long far ATM call (long vega / term play).
    const far = pickLaterExpiry(surface, near.dte, 30);
    if (far && atmC) {
      const farCs = contractsAt(chain, far.expiry);
      const farC = nearestByStrike(farCs, "C", atmC.strike);
      if (farC) add("call_calendar", "Call calendar", "neutral", [
        { c: atmC, action: "short" },
        { c: farC, action: "long" },
      ]);
    }
  }
  if (neutral) {
    // Iron condor — defined-risk premium sell.
    const sp = nearestByDelta(nearCs, "P", 0.25);
    const lp = nearestByDelta(nearCs, "P", 0.12);
    const sc = nearestByDelta(nearCs, "C", 0.25);
    const lc = nearestByDelta(nearCs, "C", 0.12);
    if (sp && lp && sc && lc && lp.strike < sp.strike && lc.strike > sc.strike)
      add("iron_condor", "Iron condor", "neutral", [
        { c: lp, action: "long" },
        { c: sp, action: "short" },
        { c: sc, action: "short" },
        { c: lc, action: "long" },
      ]);
  }

  return out;
}

// --- scoring + rationale -----------------------------------------------------

const CREDIT_STRATEGIES: Set<StrategyKind> = new Set(["put_credit_spread", "call_credit_spread", "iron_condor"]);
const LONG_PREMIUM: Set<StrategyKind> = new Set(["long_call", "long_put", "long_straddle", "long_strangle", "call_calendar", "pmcc"]);

function volNote(vrp: number | null, termSlope: number | null): string {
  if (vrp != null && vrp >= RICH_VRP) return "implied vol sits rich to the volatility model — the desk is paid to sell premium";
  if (vrp != null && vrp <= CHEAP_VRP) return "implied vol is cheap to the model — owning premium is favored";
  if (termSlope != null && termSlope < -0.01) return "the term structure is backwardated — calendars harvest the front-month decay";
  return "the vol surface is roughly fair, so structure choice rests on the payoff geometry";
}

// --- the engine --------------------------------------------------------------

/** Rank defined-risk structures expressing `posterior` for `ticker`. Empty when the chain is too dark to price anything. */
export async function structureThesis(input: StrategistInput): Promise<StructureCandidate[]> {
  const surface = input.surface ?? buildVolSurfaceFromChain(input.chain);
  if (!surface || surface.spot == null || !(input.spot > 0)) return [];

  const near = pickExpiry(surface, { catalystDate: input.catalystDate, targetDte: 45 });
  if (!near) return [];
  const dte = near.dte;

  // One real-world terminal sample, reused across every candidate.
  let horizonReturn: number;
  const m = input.memo;
  if (m?.base != null && m?.bear != null && input.spot > 0) {
    const baseR = m.base / input.spot - 1;
    const bearR = m.bear / input.spot - 1;
    const bullR = m.bull != null ? m.bull / input.spot - 1 : baseR;
    horizonReturn = (1 - input.posterior) * bearR + input.posterior * 0.6 * baseR + input.posterior * 0.4 * bullR;
  } else {
    horizonReturn = (input.posterior - 0.5) * 0.4; // ±20% at the extremes
  }
  const driftAnnual = Math.log(1 + Math.max(horizonReturn, -0.95)) * (365 / Math.max(dte, 1));
  const horizonTradingDays = Math.max(1, Math.round((dte * TRADING_DAYS) / 365));
  const volHint = input.forecastVol ?? near.atmIv ?? null;
  const terminals = input.history && input.history.length >= 2
    ? realWorldTerminals(input.spot, horizonTradingDays, volHint, input.history, driftAnnual)
    : volHint != null
      ? realWorldTerminals(input.spot, horizonTradingDays, volHint, [], driftAnnual)
      : null;

  const raws = buildRawCandidates(input, surface, near);
  const candidates: StructureCandidate[] = [];

  for (const raw of raws) {
    const cost = entryCostPerShare(raw.legs);
    if (cost == null) continue;
    const profile = payoffProfile(raw.legs, cost, input.spot, RATE);
    if (!(profile.maxLoss > 0)) continue; // not a defined, payable structure
    const rnd = popAndEvFromRnd(near.rnd, raw.legs, cost, RATE);
    const evReal = terminals ? evFromTerminals(terminals, raw.legs, cost, RATE) : null;

    const evPctOnRisk = evReal != null ? (evReal / profile.maxLoss) * 100 : null;
    const evRndPctOnRisk = rnd ? (rnd.evPerLot / profile.maxLoss) * 100 : null;

    // Score: edge per dollar at risk (real-world EV), tilted by the vol regime.
    const base = evPctOnRisk ?? evRndPctOnRisk ?? (rnd ? (rnd.pop - 0.5) * 40 : 0);
    const vrp = input.vrp ?? null;
    let mult = 1;
    if (CREDIT_STRATEGIES.has(raw.strategy)) {
      if (vrp != null && vrp >= RICH_VRP) mult *= 1.25;
      if (vrp != null && vrp <= CHEAP_VRP) mult *= 0.8;
      if (rnd && rnd.pop >= 0.6) mult *= 1.1; // credit thrives on high POP
    }
    if (LONG_PREMIUM.has(raw.strategy)) {
      if (vrp != null && vrp <= CHEAP_VRP) mult *= 1.25;
      if (vrp != null && vrp >= RICH_VRP) mult *= 0.8;
    }
    if (raw.strategy === "call_calendar" && surface.termSlope != null && surface.termSlope < 0) mult *= 1.2;
    const score = base * mult;

    const greeks = raw.greeks;
    const bePart = profile.breakevens.length > 0 ? `breakeven ${profile.breakevens.map((b) => `$${round(b, 2)}`).join(" / ")}` : "no finite breakeven";
    const evPart = evPctOnRisk != null ? `real-world EV ${evPctOnRisk >= 0 ? "+" : ""}${round(evPctOnRisk, 0)}% on risk` : rnd ? "EV from the RND only" : "EV unavailable (chain too thin for a density)";
    const popPart = rnd ? `${round(rnd.pop * 100, 0)}% POP` : "POP n/a";
    const rationale = `${raw.label} at the ${monthDay(near.expiry)} expiry (${Math.round(dte)}d): ${raw.direction} expression, defined risk $${round(profile.maxLoss, 0)}/lot, ${popPart}, ${evPart}; ${bePart}. Chosen because ${volNote(vrp, surface.termSlope)}.`;

    candidates.push({
      strategy: raw.strategy,
      label: raw.label,
      direction: raw.direction,
      legs: raw.legs,
      expiry: near.expiry,
      dte,
      netDebit: round(cost * 100, 2),
      maxLoss: round(profile.maxLoss, 2),
      maxGain: profile.maxGain != null ? round(profile.maxGain, 2) : null,
      breakevens: profile.breakevens,
      pop: rnd ? round(rnd.pop, 4) : null,
      evRealPerLot: evReal != null ? round(evReal, 2) : null,
      evRndPerLot: rnd ? round(rnd.evPerLot, 2) : null,
      evPctOnRisk: evPctOnRisk != null ? round(evPctOnRisk, 2) : null,
      evRndPctOnRisk: evRndPctOnRisk != null ? round(evRndPctOnRisk, 2) : null,
      greeks: greeks
        ? { delta: round(greeks.delta, 2), gamma: round(greeks.gamma, 4), vega: round(greeks.vega, 2), theta: round(greeks.theta, 2) }
        : null,
      capitalAtRisk: round(profile.maxLoss, 2),
      rationale,
      score: Number.isFinite(score) ? round(score, 3) : 0,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, input.maxCandidates ?? 3);

  if (input.polish && top.length > 0) {
    try {
      const md = modelFor("options_strategist");
      const { object } = await generateObject({
        model: md.model,
        schema: z.object({
          rationales: z.array(z.string()).length(top.length).describe("Each rationale rewritten in one cold institutional sentence. Preserve every number, strike, and date exactly. No Greek letters, no hype."),
        }),
        prompt: `Rewrite each options-structure rationale for ${input.ticker}'s investment committee. Keep each under 45 words, keep all figures verbatim, add no claims:\n${top.map((c, i) => `${i + 1}. ${c.rationale}`).join("\n")}`,
      });
      const rs = object.rationales.map((r) => r.trim()).filter((r) => r.length > 0);
      if (rs.length === top.length) top.forEach((c, i) => (c.rationale = rs[i]));
    } catch {
      // no key / model failure — deterministic rationales stand
    }
  }

  return top;
}

// --- protective collar (the Oracle's HEDGE path) -----------------------------

export type Collar = { expiry: string; putStrike: number; callStrike: number; netCostPerShare: number | null };

/**
 * The ~25Δ put financed by a ~25Δ call at `expiry` — the defined-risk hedge for
 * an EXISTING long equity position. Folded out of the Oracle so HEDGE and the
 * standalone catalog share one source of truth. The short call is covered by
 * the underlying shares, so this carries no naked risk.
 */
export function protectiveCollar(chain: OptionChain, expiry: string): Collar | null {
  const atExpiry = chain.contracts.filter((c) => c.expiry === expiry && c.delta != null);
  const nearDelta = (type: "C" | "P") =>
    atExpiry
      .filter((c) => c.type === type)
      .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.25) - Math.abs(Math.abs(b.delta!) - 0.25))[0] ?? null;
  const put = nearDelta("P");
  const call = nearDelta("C");
  if (!put || !call) return null;
  return {
    expiry,
    putStrike: put.strike,
    callStrike: call.strike,
    netCostPerShare: put.mid != null && call.mid != null ? put.mid - call.mid : null,
  };
}
