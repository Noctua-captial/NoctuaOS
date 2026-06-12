// CBOE delayed options chain — keyless. Full per-contract IV/greeks/OI/volume
// plus the underlying's live fields. Cached in memory and as a `signals` row
// (kind "options_chain") with a ~15-minute TTL; derived flow metrics persist
// as one "options_flow" row per ticker-day so daily volume totals accumulate
// into a real z-score history.
import { FETCH_TIMEOUT_MS, meanStd, num, signalHistory, upsertSignal } from "@/lib/signals/common";

const CHAIN_TTL_MS = 15 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MIN_Z_OBSERVATIONS = 5; // prior daily volume totals required before unusualVolumeZ
const SKEW_DELTA_TARGET = 0.25;
const SKEW_DELTA_BAND = 0.1; // accept |delta| within target ± band
const SKEW_DTE_MIN = 30;
const SKEW_DTE_MAX = 60;
const TERM_FAR_DTE = 90;

export type OptionContract = {
  type: "C" | "P";
  strike: number;
  expiry: string; // ISO date, parsed from the option symbol (yymmdd)
  bid: number | null;
  ask: number | null;
  mid: number | null; // (bid+ask)/2 when the ask is live; null otherwise
  iv: number | null; // decimal (e.g. 0.96 = 96%); null when CBOE reports 0
  oi: number | null;
  volume: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
};

export type OptionChain = {
  ticker: string;
  spot: number | null; // CBOE current_price
  prevDayClose: number | null;
  underlyingVolume: number | null; // today's share volume of the underlying
  iv30: number | null; // decimal (CBOE reports percent; normalized here)
  iv30Change: number | null; // decimal points of IV30 change on the day
  asOf: string; // CBOE's own data timestamp (ISO)
  contracts: OptionContract[];
};

export type OptionsSignals = {
  ticker: string;
  asOf: string; // chain timestamp — the data's time, not ours
  spot: number | null;
  iv30: number | null; // decimal
  putCallVolumeRatio: number | null; // total put volume / total call volume
  putCallOiRatio: number | null; // total put OI / total call OI
  skew25Delta: number | null; // avg put IV at ~-0.25Δ minus call IV at ~0.25Δ, nearest 30-60d expiry
  termSlope: number | null; // ATM IV at ~90d minus ATM IV at the nearest expiry (positive = upward-sloping)
  impliedEarningsMovePct: number | null; // nearest-expiry ATM straddle mid / spot, percent
  unusualVolumeZ: number | null; // today's total option volume vs stored daily totals; null until ≥5 prior days
  gex: number | null; // Σ gamma·OI·100·spot, calls positive puts negative (dealer gamma estimate, $)
  totalVolume: number; // today's total option volume across the chain
  totalOpenInterest: number;
  contractCount: number;
};

// --- chain fetch + cache ------------------------------------------------------

type ChainCacheEntry = { fetchedAt: number; chain: OptionChain };
const chainCache = new Map<string, ChainCacheEntry>();

/** "TSEM260724P00175000" → { expiry: "2026-07-24", type: "P", strike: 175 }; null when malformed. */
function parseOptionSymbol(
  symbol: string,
): { expiry: string; type: "C" | "P"; strike: number } | null {
  if (symbol.length < 16) return null;
  const strikeRaw = symbol.slice(-8);
  const cp = symbol.slice(-9, -8);
  const ymd = symbol.slice(-15, -9);
  if (!/^\d{8}$/.test(strikeRaw) || !/^\d{6}$/.test(ymd) || (cp !== "C" && cp !== "P")) return null;
  const strike = Number(strikeRaw) / 1000;
  const expiry = `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`;
  return { expiry, type: cp, strike };
}

type CboeOption = Record<string, unknown> & { option?: string };

function parseChain(ticker: string, raw: unknown): OptionChain {
  const root = raw as { timestamp?: string; data?: Record<string, unknown> };
  const data = root.data ?? {};
  const rawOptions = Array.isArray(data.options) ? (data.options as CboeOption[]) : [];

  const contracts: OptionContract[] = [];
  for (const o of rawOptions) {
    if (typeof o.option !== "string") continue;
    const parsed = parseOptionSymbol(o.option);
    if (!parsed) continue;
    const bid = num(o.bid);
    const ask = num(o.ask);
    const iv = num(o.iv);
    contracts.push({
      type: parsed.type,
      strike: parsed.strike,
      expiry: parsed.expiry,
      bid,
      ask,
      mid: bid != null && ask != null && ask > 0 ? (bid + ask) / 2 : null,
      iv: iv != null && iv > 0 ? iv : null,
      oi: num(o.open_interest),
      volume: num(o.volume),
      delta: num(o.delta),
      gamma: num(o.gamma),
      vega: num(o.vega),
    });
  }

  const iv30Pct = num(data.iv30);
  const iv30ChangePct = num(data.iv30_change);
  const asOf =
    typeof root.timestamp === "string" && root.timestamp.length >= 10
      ? root.timestamp.replace(" ", "T")
      : new Date().toISOString();

  return {
    ticker: ticker.toUpperCase(),
    spot: num(data.current_price) || num(data.close),
    prevDayClose: num(data.prev_day_close),
    underlyingVolume: num(data.volume),
    iv30: iv30Pct != null && iv30Pct > 0 ? iv30Pct / 100 : null,
    iv30Change: iv30ChangePct != null ? iv30ChangePct / 100 : null,
    asOf,
    contracts,
  };
}

/**
 * Fetch the CBOE delayed chain with a ~15-minute cache: in-memory first, then
 * the latest `signals` row (kind "options_chain", shared across processes),
 * then the network. On fetch failure a stale cached chain is served when one
 * exists — its asOf still tells the truth about data age.
 */
export async function fetchChain(ticker: string): Promise<OptionChain> {
  const t = ticker.toUpperCase();
  const now = Date.now();

  const mem = chainCache.get(t);
  if (mem && now - mem.fetchedAt < CHAIN_TTL_MS) return mem.chain;

  const dbRows = await signalHistory(t, "options_chain", 1);
  if (dbRows[0]?.payload) {
    try {
      const stored = JSON.parse(dbRows[0].payload) as { fetchedAt?: string; chain?: OptionChain };
      const fetchedAt = stored.fetchedAt ? new Date(stored.fetchedAt).getTime() : 0;
      if (stored.chain && now - fetchedAt < CHAIN_TTL_MS) {
        chainCache.set(t, { fetchedAt, chain: stored.chain });
        return stored.chain;
      }
    } catch {
      // unreadable cache row — refetch
    }
  }

  let chain: OptionChain;
  try {
    const res = await fetch(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(t)}.json`,
      {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`CBOE chain fetch failed (${res.status}) for ${t}`);
    chain = parseChain(t, await res.json());
    if (chain.contracts.length === 0 && chain.spot == null) {
      throw new Error(`CBOE returned an empty chain for ${t}`);
    }
  } catch (err) {
    const stale = mem?.chain ?? parseStoredChain(dbRows[0]?.payload);
    if (stale) return stale;
    throw err;
  }

  chainCache.set(t, { fetchedAt: now, chain });
  await upsertSignal({
    ticker: t,
    kind: "options_chain",
    value: chain.spot,
    z: null,
    asOf: chain.asOf,
    payload: { fetchedAt: new Date(now).toISOString(), chain },
  });
  return chain;
}

function parseStoredChain(payload: string | null | undefined): OptionChain | null {
  if (!payload) return null;
  try {
    const stored = JSON.parse(payload) as { chain?: OptionChain };
    return stored.chain ?? null;
  } catch {
    return null;
  }
}

// --- derived metrics ----------------------------------------------------------

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

/** Pick the expiry whose DTE is closest to the [min,max] window (distance 0 inside it; ties → nearest mid). */
function expiryNearWindow(expiries: { expiry: string; dte: number }[], min: number, max: number): string | null {
  if (expiries.length === 0) return null;
  const mid = (min + max) / 2;
  const scored = expiries.map((e) => ({
    expiry: e.expiry,
    dist: e.dte < min ? min - e.dte : e.dte > max ? e.dte - max : 0,
    midDist: Math.abs(e.dte - mid),
  }));
  scored.sort((a, b) => a.dist - b.dist || a.midDist - b.midDist);
  return scored[0].expiry;
}

/**
 * Derived options-flow metrics from the cached chain. Null-safe throughout:
 * any metric whose inputs are missing comes back null, never fabricated.
 * Persists one "options_flow" signals row per ticker-day (value = put/call
 * volume ratio, z = unusual-volume z) so daily totals build a real history.
 */
export async function computeOptionsSignals(ticker: string): Promise<OptionsSignals> {
  const chain = await fetchChain(ticker);
  const { contracts, spot } = chain;

  let putVol = 0;
  let callVol = 0;
  let putOi = 0;
  let callOi = 0;
  let gexAcc = 0;
  let gexUsable = false;
  for (const c of contracts) {
    const vol = c.volume ?? 0;
    const oi = c.oi ?? 0;
    if (c.type === "P") {
      putVol += vol;
      putOi += oi;
    } else {
      callVol += vol;
      callOi += oi;
    }
    if (spot != null && c.gamma != null && c.oi != null) {
      gexAcc += (c.type === "C" ? 1 : -1) * c.gamma * c.oi * 100 * spot;
      gexUsable = true;
    }
  }
  const totalVolume = putVol + callVol;
  const totalOpenInterest = putOi + callOi;

  // Expiries by DTE (only future ones matter for the IV-structure metrics).
  const expiryMap = new Map<string, OptionContract[]>();
  for (const c of contracts) {
    const list = expiryMap.get(c.expiry);
    if (list) list.push(c);
    else expiryMap.set(c.expiry, [c]);
  }
  const expiries = [...expiryMap.keys()]
    .map((expiry) => ({ expiry, dte: daysToExpiry(expiry, chain.asOf) }))
    .filter((e) => e.dte > 0)
    .sort((a, b) => a.dte - b.dte);

  // 25-delta skew at the expiry nearest the 30-60d window.
  let skew25Delta: number | null = null;
  const skewExpiry = expiryNearWindow(expiries, SKEW_DTE_MIN, SKEW_DTE_MAX);
  if (skewExpiry) {
    const atExpiry = expiryMap.get(skewExpiry)!;
    const putIv = ivNearDelta(atExpiry.filter((c) => c.type === "P"), SKEW_DELTA_TARGET);
    const callIv = ivNearDelta(atExpiry.filter((c) => c.type === "C"), SKEW_DELTA_TARGET);
    if (putIv != null && callIv != null) skew25Delta = putIv - callIv;
  }

  // Term slope: ATM IV at ~90d minus ATM IV at the nearest expiry.
  let termSlope: number | null = null;
  if (spot != null && expiries.length >= 2) {
    const near = expiries[0];
    const far = expiries.reduce((best, e) =>
      Math.abs(e.dte - TERM_FAR_DTE) < Math.abs(best.dte - TERM_FAR_DTE) ? e : best,
    );
    if (far.expiry !== near.expiry) {
      const ivNear = atmIv(expiryMap.get(near.expiry)!, spot);
      const ivFar = atmIv(expiryMap.get(far.expiry)!, spot);
      if (ivNear != null && ivFar != null) termSlope = ivFar - ivNear;
    }
  }

  // Implied move: nearest-expiry ATM straddle mid / spot.
  let impliedEarningsMovePct: number | null = null;
  if (spot != null && spot > 0 && expiries.length > 0) {
    const atNearest = expiryMap.get(expiries[0].expiry)!;
    const pickAtm = (type: "C" | "P") => {
      const side = atNearest.filter((c) => c.type === type && c.mid != null);
      if (side.length === 0) return null;
      return side.reduce((best, c) =>
        Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best,
      );
    };
    const call = pickAtm("C");
    const put = pickAtm("P");
    if (call?.mid != null && put?.mid != null && call.strike === put.strike) {
      impliedEarningsMovePct = ((call.mid + put.mid) / spot) * 100;
    }
  }

  // Unusual volume z vs stored daily totals (prior days only; needs ≥5).
  const today = chain.asOf.slice(0, 10);
  const history = await signalHistory(ticker, "options_flow", 70);
  const priorTotals: number[] = [];
  for (const row of history) {
    if (row.asOf.slice(0, 10) >= today) continue;
    try {
      const p = JSON.parse(row.payload ?? "{}") as { totalVolume?: number };
      if (typeof p.totalVolume === "number" && Number.isFinite(p.totalVolume)) {
        priorTotals.push(p.totalVolume);
      }
    } catch {
      // skip unreadable rows
    }
  }
  let unusualVolumeZ: number | null = null;
  if (priorTotals.length >= MIN_Z_OBSERVATIONS) {
    const { mean, std } = meanStd(priorTotals);
    if (mean != null && std != null && std > 0) unusualVolumeZ = (totalVolume - mean) / std;
  }

  const result: OptionsSignals = {
    ticker: chain.ticker,
    asOf: chain.asOf,
    spot,
    iv30: chain.iv30,
    putCallVolumeRatio: callVol > 0 ? putVol / callVol : null,
    putCallOiRatio: callOi > 0 ? putOi / callOi : null,
    skew25Delta,
    termSlope,
    impliedEarningsMovePct,
    unusualVolumeZ,
    gex: gexUsable ? gexAcc : null,
    totalVolume,
    totalOpenInterest,
    contractCount: contracts.length,
  };

  await upsertSignal({
    ticker: chain.ticker,
    kind: "options_flow",
    value: result.putCallVolumeRatio,
    z: unusualVolumeZ,
    asOf: chain.asOf,
    payload: result,
  });

  return result;
}
