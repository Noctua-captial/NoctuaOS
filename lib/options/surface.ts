// The vol surface — a first-class object built from the CBOE delayed chain.
// Promotes the point metrics in lib/signals/options.ts into a per-expiry term
// structure (ATM IV, 25-delta skew, ATM straddle implied move) plus a
// multi-expiry RND ladder (Breeden-Litzenberger per expiry, not just the
// catalyst-nearest one). Keyless, null-safe, asOf-stamped — the same honesty
// discipline as the chain code it sits on. Pure given a chain.
import { fetchChain, type OptionChain, type OptionContract } from "@/lib/signals/options";
import {
  riskNeutralDensity,
  impliedMovePct,
  tailAsymmetry,
  type RiskNeutralDensity,
} from "@/lib/mathlab/rnd";

const SKEW_DELTA_TARGET = 0.25;
const SKEW_DELTA_BAND = 0.1; // accept |delta| within target ± band
const TERM_FAR_DTE = 90;
const RND_MIN_DTE = 3;
const MAX_RND_EXPIRIES = 8; // cap the ladder — RND is the expensive part

export type ExpirySurface = {
  expiry: string; // ISO
  dte: number; // calendar days to expiry from the chain's asOf
  atmIv: number | null; // decimal
  skew25: number | null; // put 25Δ IV − call 25Δ IV (positive = downside fear bid)
  straddleMovePct: number | null; // ATM straddle mid / spot, percent
  callCount: number;
  putCount: number;
  rnd: RiskNeutralDensity | null; // risk-neutral density at this expiry, when the chain supports it
  rndImpliedMovePct: number | null; // stdev/mean of the RND, percent
  rndTailAsymmetry: number | null; // P(+20%)/P(−20%) under the RND
  usableStrikes: number; // OTM strikes with live iv+mid feeding the density
};

export type VolSurface = {
  ticker: string;
  spot: number | null;
  asOf: string; // the chain's own data timestamp
  iv30: number | null; // decimal (CBOE iv30, normalized)
  termSlope: number | null; // far ATM IV − near ATM IV (positive = upward-sloping)
  expiries: ExpirySurface[]; // ascending DTE
};

function daysToExpiry(expiry: string, asOf: string): number {
  const exp = Date.parse(`${expiry}T21:00:00Z`); // ~4pm ET close on expiry day
  const ref = Date.parse(asOf) || Date.now();
  return (exp - ref) / 86_400_000;
}

/** Mean IV of up to 3 contracts nearest the delta target within the band; null when none qualify. */
function ivNearDelta(contracts: OptionContract[], targetAbsDelta: number): number | null {
  const candidates = contracts
    .filter(
      (c) =>
        c.iv != null &&
        c.delta != null &&
        Math.abs(Math.abs(c.delta) - targetAbsDelta) <= SKEW_DELTA_BAND,
    )
    .sort(
      (a, b) =>
        Math.abs(Math.abs(a.delta!) - targetAbsDelta) - Math.abs(Math.abs(b.delta!) - targetAbsDelta),
    )
    .slice(0, 3);
  if (candidates.length === 0) return null;
  return candidates.reduce((s, c) => s + c.iv!, 0) / candidates.length;
}

/** ATM IV at one expiry: mean of the call and put IV at the strike nearest spot. */
function atmIv(contracts: OptionContract[], spot: number): number | null {
  const withIv = contracts.filter((c) => c.iv != null);
  if (withIv.length === 0) return null;
  const nearestStrike = withIv.reduce((best, c) =>
    Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best,
  ).strike;
  const atStrike = withIv.filter((c) => c.strike === nearestStrike);
  return atStrike.reduce((s, c) => s + c.iv!, 0) / atStrike.length;
}

/** ATM straddle mid / spot at one expiry, percent; null when no matched-strike pair quotes. */
function straddleMovePct(contracts: OptionContract[], spot: number): number | null {
  if (!(spot > 0)) return null;
  const pickAtm = (type: "C" | "P") => {
    const side = contracts.filter((c) => c.type === type && c.mid != null);
    if (side.length === 0) return null;
    return side.reduce((best, c) =>
      Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best,
    );
  };
  const call = pickAtm("C");
  const put = pickAtm("P");
  if (call?.mid != null && put?.mid != null && call.strike === put.strike) {
    return ((call.mid + put.mid) / spot) * 100;
  }
  return null;
}

/** Build the full vol surface + RND ladder from an already-fetched chain. Null when there is no spot. */
export function buildVolSurfaceFromChain(chain: OptionChain): VolSurface | null {
  const spot = chain.spot;
  if (spot == null || !(spot > 0)) {
    return chain.iv30 != null
      ? { ticker: chain.ticker, spot: null, asOf: chain.asOf, iv30: chain.iv30, termSlope: null, expiries: [] }
      : null;
  }

  // Group contracts by expiry, future only.
  const byExpiry = new Map<string, OptionContract[]>();
  for (const c of chain.contracts) {
    const list = byExpiry.get(c.expiry);
    if (list) list.push(c);
    else byExpiry.set(c.expiry, [c]);
  }
  const ordered = [...byExpiry.entries()]
    .map(([expiry, contracts]) => ({ expiry, dte: daysToExpiry(expiry, chain.asOf), contracts }))
    .filter((e) => e.dte >= RND_MIN_DTE)
    .sort((a, b) => a.dte - b.dte);

  // The RND is expensive; compute it only on a capped set of liquid expiries
  // (the nearest several), but report ATM/skew structure for all of them.
  const rndExpiries = new Set(ordered.slice(0, MAX_RND_EXPIRIES).map((e) => e.expiry));

  const expiries: ExpirySurface[] = ordered.map((e) => {
    const calls = e.contracts.filter((c) => c.type === "C");
    const puts = e.contracts.filter((c) => c.type === "P");
    const putIv = ivNearDelta(puts, SKEW_DELTA_TARGET);
    const callIv = ivNearDelta(calls, SKEW_DELTA_TARGET);

    let rnd: RiskNeutralDensity | null = null;
    let usableStrikes = 0;
    if (rndExpiries.has(e.expiry)) {
      const slice = e.contracts.map((c) => ({ type: c.type, strike: c.strike, mid: c.mid, iv: c.iv }));
      usableStrikes = slice.filter((c) => c.iv != null && c.mid != null && c.mid > 0).length;
      rnd = riskNeutralDensity({ spot, expiryYears: e.dte / 365, contracts: slice });
    }

    const move = rnd ? impliedMovePct(rnd) : null;
    return {
      expiry: e.expiry,
      dte: e.dte,
      atmIv: atmIv(e.contracts, spot),
      skew25: putIv != null && callIv != null ? putIv - callIv : null,
      straddleMovePct: straddleMovePct(e.contracts, spot),
      callCount: calls.length,
      putCount: puts.length,
      rnd,
      rndImpliedMovePct: move != null ? move * 100 : null,
      rndTailAsymmetry: rnd ? tailAsymmetry(rnd, spot) : null,
      usableStrikes,
    };
  });

  // Term slope: ATM IV at ~90d minus ATM IV at the nearest expiry.
  let termSlope: number | null = null;
  if (expiries.length >= 2) {
    const near = expiries[0];
    const far = expiries.reduce((best, e) =>
      Math.abs(e.dte - TERM_FAR_DTE) < Math.abs(best.dte - TERM_FAR_DTE) ? e : best,
    );
    if (far.expiry !== near.expiry && near.atmIv != null && far.atmIv != null) {
      termSlope = far.atmIv - near.atmIv;
    }
  }

  return {
    ticker: chain.ticker,
    spot,
    asOf: chain.asOf,
    iv30: chain.iv30,
    termSlope,
    expiries,
  };
}

/** Fetch the chain and build the surface. Returns null when the chain is dark. */
export async function buildVolSurface(ticker: string): Promise<VolSurface | null> {
  try {
    const chain = await fetchChain(ticker);
    return buildVolSurfaceFromChain(chain);
  } catch {
    return null;
  }
}

export type ExpiryPickOpts = { catalystDate?: string | null; targetDte?: number };

/**
 * Choose the expiry that best brackets a catalyst (nearest expiry on or after
 * the event), else the one nearest `targetDte` (default 45d — far enough to
 * carry a thesis, near enough that theta is not the whole trade).
 */
export function pickExpiry(surface: VolSurface, opts: ExpiryPickOpts = {}): ExpirySurface | null {
  const list = surface.expiries;
  if (list.length === 0) return null;

  if (opts.catalystDate && /^\d{4}-\d{2}-\d{2}/.test(opts.catalystDate)) {
    const catDte = daysToExpiry(opts.catalystDate, surface.asOf);
    const onOrAfter = list.filter((e) => e.dte >= catDte);
    if (onOrAfter.length > 0) return onOrAfter[0];
    return list.reduce((best, e) => (Math.abs(e.dte - catDte) < Math.abs(best.dte - catDte) ? e : best));
  }

  const target = opts.targetDte ?? 45;
  return list.reduce((best, e) => (Math.abs(e.dte - target) < Math.abs(best.dte - target) ? e : best));
}

/** The first expiry strictly later than `afterDte` (for the long leg of calendars/diagonals). */
export function pickLaterExpiry(surface: VolSurface, afterDte: number, minGapDays = 21): ExpirySurface | null {
  const later = surface.expiries.filter((e) => e.dte >= afterDte + minGapDays);
  return later[0] ?? null;
}
