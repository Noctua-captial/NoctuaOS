// Quant bench — pure, keyless math over real price history + fundamentals.
// Per-name metrics persist to `quant_snapshots` (~6h TTL); book-level metrics
// compute live from open positions; sizing math is deterministic and synchronous.
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getQuote, getQuotes, getBenchmark } from "@/lib/market";
import { getFundamentals } from "@/lib/fundamentals";
import { shrinkCovariance, multivariateKelly, cvarConstrainedScale } from "@/lib/mathlab/covariance";

const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const TRADING_DAYS = 252;
const MIN_OVERLAP = 40; // minimum aligned daily returns for beta/correlation
const CLUSTER_CORR = 0.7;
const ADV_EXIT_DAYS = 5; // liquidity cap: exit within 5 ADV-days

// --- Mandate ----------------------------------------------------------------

export type Mandate = {
  maxPositionPct: number;
  maxThemePct: number;
  minCashPct: number;
  maxBookBeta: number;
  volTargetAnnual: number; // decimal, e.g. 0.15
};

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const MANDATE: Mandate = {
  maxPositionPct: envNum("NOCTUA_MANDATE_MAX_POSITION_PCT", 8),
  maxThemePct: envNum("NOCTUA_MANDATE_MAX_THEME_PCT", 25),
  minCashPct: envNum("NOCTUA_MANDATE_MIN_CASH_PCT", 5),
  maxBookBeta: envNum("NOCTUA_MANDATE_MAX_BOOK_BETA", 1.6),
  volTargetAnnual: envNum("NOCTUA_MANDATE_VOL_TARGET_ANNUAL", 0.15),
};

// --- Math primitives --------------------------------------------------------

function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0; // guard: empty input must not yield NaN
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Conservative fill for pairwise correlations that can't be estimated (e.g. a
 *  zero-variance series). Treating unknown ρ as 0 understates book risk by
 *  assuming a diversification benefit we haven't measured; assume positive
 *  co-movement instead. Override via NOCTUA_BOOK_UNKNOWN_CORR. */
export const UNKNOWN_CORR = (() => {
  const v = Number(process.env.NOCTUA_BOOK_UNKNOWN_CORR);
  return Number.isFinite(v) && v >= -1 && v <= 1 ? v : 0.5;
})();

/**
 * Annualized book volatility √(Σᵢⱼ wᵢwⱼσᵢσⱼρᵢⱼ). Diagonal ρ = 1; unestimable
 * off-diagonal ρ falls back to `unknownCorr` (conservative, not 0). Null on
 * shape mismatch.
 */
export function bookVolatility(
  weights: number[],
  vols: number[],
  corr: (number | null)[][],
  unknownCorr: number = UNKNOWN_CORR,
): number | null {
  const n = weights.length;
  if (n === 0 || vols.length !== n || corr.length !== n) return null;
  let varAcc = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const rho = i === j ? 1 : (corr[i][j] ?? unknownCorr);
      varAcc += weights[i] * weights[j] * vols[i] * vols[j] * rho;
    }
  }
  return Math.sqrt(Math.max(varAcc, 0));
}

function sampleVariance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

function sampleCovariance(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / (n - 1);
}

/** Align two return series by their tails (most recent overlapping sessions). */
function alignTails(a: number[], b: number[]): [number[], number[]] {
  const n = Math.min(a.length, b.length);
  return [a.slice(-n), b.slice(-n)];
}

function correlation(a: number[], b: number[]): number | null {
  const [x, y] = alignTails(a, b);
  if (x.length < MIN_OVERLAP) return null;
  const sx = Math.sqrt(sampleVariance(x));
  const sy = Math.sqrt(sampleVariance(y));
  if (sx === 0 || sy === 0) return null;
  const c = sampleCovariance(x, y) / (sx * sy);
  return Math.max(-1, Math.min(1, c));
}

function betaVs(name: number[], bench: number[]): number | null {
  const [x, b] = alignTails(name, bench);
  if (x.length < MIN_OVERLAP) return null;
  const vb = sampleVariance(b);
  if (vb === 0) return null;
  return sampleCovariance(x, b) / vb;
}

function annualizedVolOf(returns: number[]): number | null {
  if (returns.length < MIN_OVERLAP) return null;
  return Math.sqrt(sampleVariance(returns)) * Math.sqrt(TRADING_DAYS);
}

/** Worst peak-to-trough decline over the series, as a negative decimal. */
function maxDrawdownOf(closes: number[]): number | null {
  if (closes.length < 2) return null;
  let peak = closes[0];
  let worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    else if (peak > 0) worst = Math.min(worst, c / peak - 1);
  }
  return worst;
}

/** Wilder-smoothed RSI(14) on the final close. */
function rsi14Of(closes: number[]): number | null {
  const period = 14;
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Trailing simple return over `sessions` trading days, as a decimal. */
function trailingReturn(closes: number[], sessions: number): number | null {
  if (closes.length < sessions + 1) return null;
  const then = closes[closes.length - 1 - sessions];
  if (then <= 0) return null;
  return closes[closes.length - 1] / then - 1;
}

// --- Per-name quant ---------------------------------------------------------

export type NameQuant = {
  ticker: string;
  spot: number | null;
  annualizedVol: number | null; // decimal, e.g. 0.42
  beta: number | null; // vs SPY, daily-returns regression
  maxDrawdown: number | null; // decimal, negative (worst over ~2y)
  pctFrom52wHigh: number | null; // percent, ≤ 0
  pctFrom52wLow: number | null; // percent, ≥ 0
  momentum3m: number | null; // decimal trailing return
  momentum6m: number | null;
  rsi14: number | null; // 0–100
  avgDollarVolume: number | null; // $/day, ~60d average
  evToRevenue: number | null;
  evToOperatingIncome: number | null;
  peRatio: number | null;
  historyDays: number;
  computedAt: string; // ISO
};

/**
 * Per-name quant profile from real price history + EDGAR fundamentals.
 * Reuses a quant_snapshots row when fresher than ~6h; otherwise computes
 * and persists a new snapshot. Null-safe throughout; throws only when the
 * ticker has no price data at all.
 */
export async function computeNameQuant(ticker: string): Promise<NameQuant> {
  const t = ticker.toUpperCase();

  const cached = await db
    .select()
    .from(tables.quantSnapshots)
    .where(eq(tables.quantSnapshots.ticker, t))
    .orderBy(desc(tables.quantSnapshots.createdAt))
    .limit(1);
  if (cached[0]?.createdAt && Date.now() - cached[0].createdAt.getTime() < SNAPSHOT_TTL_MS) {
    try {
      return JSON.parse(cached[0].data) as NameQuant;
    } catch {
      // fall through and recompute
    }
  }

  const [quote, bench, fundamentals] = await Promise.all([
    getQuote(t),
    getBenchmark().catch(() => null),
    getFundamentals(t).catch(() => null),
  ]);
  if (!quote || quote.history.length < 2) throw new Error(`No price history for ${t}`);

  const closes = quote.history;
  const returns = dailyReturns(closes);
  const spot = quote.price;
  const window52w = closes.slice(-TRADING_DAYS);
  const high52w = Math.max(...window52w);
  const low52w = Math.min(...window52w);

  const marketCap =
    quote.marketCap ??
    (fundamentals?.sharesOutstanding != null ? spot * fundamentals.sharesOutstanding : null);
  const ev =
    marketCap != null
      ? marketCap + (fundamentals?.debt ?? 0) - (fundamentals?.cash ?? 0)
      : null;
  const eps =
    fundamentals?.netIncome != null &&
    fundamentals.sharesOutstanding != null &&
    fundamentals.sharesOutstanding > 0
      ? fundamentals.netIncome / fundamentals.sharesOutstanding
      : null;

  const result: NameQuant = {
    ticker: t,
    spot,
    annualizedVol: annualizedVolOf(returns),
    beta: bench ? betaVs(returns, dailyReturns(bench.history)) : null,
    maxDrawdown: maxDrawdownOf(closes),
    pctFrom52wHigh: high52w > 0 ? (spot / high52w - 1) * 100 : null,
    pctFrom52wLow: low52w > 0 ? (spot / low52w - 1) * 100 : null,
    momentum3m: trailingReturn(closes, 63),
    momentum6m: trailingReturn(closes, 126),
    rsi14: rsi14Of(closes),
    avgDollarVolume: quote.avgVolume != null ? quote.avgVolume * spot : null,
    evToRevenue:
      ev != null && fundamentals?.revenue != null && fundamentals.revenue > 0
        ? ev / fundamentals.revenue
        : null,
    evToOperatingIncome:
      ev != null && fundamentals?.operatingIncome != null && fundamentals.operatingIncome > 0
        ? ev / fundamentals.operatingIncome
        : null,
    peRatio: eps != null && eps > 0 ? spot / eps : null,
    historyDays: closes.length,
    computedAt: new Date().toISOString(),
  };

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.ticker, t) });
  await db.insert(tables.quantSnapshots).values({
    ticker: t,
    companyId: company?.id ?? null,
    data: JSON.stringify(result),
  });

  return result;
}

// --- Portfolio --------------------------------------------------------------

export type Portfolio = { id: number; nav: number; cash: number | null; updatedAt: Date | null };

/** Single portfolio row; seeds nav $10M if the table is empty. */
export async function getPortfolio(): Promise<Portfolio> {
  const rows = await db.select().from(tables.portfolio).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db
    .insert(tables.portfolio)
    .values({ nav: 10_000_000, cash: null })
    .returning();
  return inserted[0];
}

// --- Book-level quant -------------------------------------------------------

export type BookQuant = {
  navUsd: number;
  grossExposurePct: number;
  weightedBeta: number | null; // Σ wᵢβᵢ across priced positions (weights = sizePct/100)
  bookAnnualizedVol: number | null; // decimal; √(Σᵢⱼ wᵢwⱼσᵢσⱼρᵢⱼ) over priced positions
  pairwiseCorrelations: { tickers: string[]; matrix: (number | null)[][] };
  correlationClusters: { a: string; b: string; corr: number }[]; // pairs with ρ > 0.7
  themeConcentration: { theme: string; sizePct: number }[];
  cashPct: number | null;
  worstDrawdownFromEntry: { ticker: string; pnlPct: number } | null;
  positions: { ticker: string; sizePct: number; theme: string | null; priced: boolean }[];
};

/**
 * Book-level quant over open positions: exposure, weighted beta, realized
 * book vol with pairwise correlations, cluster flags, theme concentration,
 * cash. Returns a zeroed shape when the book is empty.
 */
export async function computeBookQuant(): Promise<BookQuant> {
  const [rows, portfolio] = await Promise.all([
    db
      .select({ position: tables.positions, company: tables.companies })
      .from(tables.positions)
      .innerJoin(tables.companies, eq(tables.positions.companyId, tables.companies.id))
      .where(eq(tables.positions.status, "open")),
    getPortfolio(),
  ]);

  const grossExposurePct = rows.reduce((s, r) => s + r.position.sizePct, 0);
  const cashPct =
    portfolio.cash != null && portfolio.nav > 0
      ? (portfolio.cash / portfolio.nav) * 100
      : 100 - grossExposurePct;

  const themeMap = new Map<string, number>();
  for (const r of rows) {
    const theme = r.company.theme ?? "Unthemed";
    themeMap.set(theme, (themeMap.get(theme) ?? 0) + r.position.sizePct);
  }
  const themeConcentration = [...themeMap.entries()]
    .map(([theme, sizePct]) => ({ theme, sizePct }))
    .sort((a, b) => b.sizePct - a.sizePct);

  const tickers = [...new Set(rows.map((r) => r.position.ticker.toUpperCase()))];
  const [quoteMap, bench] = await Promise.all([
    getQuotes(tickers).catch(() => new Map<string, never>()),
    getBenchmark().catch(() => null),
  ]);
  const benchReturns = bench ? dailyReturns(bench.history) : [];

  const priced = tickers.filter((t) => {
    const q = quoteMap.get(t);
    return q != null && q.history.length >= MIN_OVERLAP + 1;
  });
  const returnsByTicker = new Map(priced.map((t) => [t, dailyReturns(quoteMap.get(t)!.history)]));
  const sizeByTicker = new Map<string, number>();
  for (const r of rows) {
    const t = r.position.ticker.toUpperCase();
    sizeByTicker.set(t, (sizeByTicker.get(t) ?? 0) + r.position.sizePct);
  }

  // Pairwise correlation matrix over priced names.
  const matrix: (number | null)[][] = priced.map((a) =>
    priced.map((b) =>
      a === b ? 1 : correlation(returnsByTicker.get(a)!, returnsByTicker.get(b)!),
    ),
  );
  const correlationClusters: { a: string; b: string; corr: number }[] = [];
  for (let i = 0; i < priced.length; i++) {
    for (let j = i + 1; j < priced.length; j++) {
      const corr = matrix[i][j];
      if (corr != null && corr > CLUSTER_CORR) {
        correlationClusters.push({ a: priced[i], b: priced[j], corr });
      }
    }
  }

  // Weighted beta: Σ wᵢβᵢ, weights as fraction of NAV (cash dilutes beta).
  let weightedBeta: number | null = null;
  if (benchReturns.length >= MIN_OVERLAP && priced.length > 0) {
    let acc = 0;
    let any = false;
    for (const t of priced) {
      const beta = betaVs(returnsByTicker.get(t)!, benchReturns);
      if (beta != null) {
        acc += ((sizeByTicker.get(t) ?? 0) / 100) * beta;
        any = true;
      }
    }
    weightedBeta = any ? acc : null;
  }

  // Book vol: √(Σᵢⱼ wᵢwⱼσᵢσⱼρᵢⱼ); unestimable off-diagonal ρ uses the
  // conservative UNKNOWN_CORR fill rather than 0 (see bookVolatility).
  let bookAnnualizedVol: number | null = null;
  if (priced.length > 0) {
    const vols = priced.map((t) => annualizedVolOf(returnsByTicker.get(t)!) ?? 0);
    const weights = priced.map((t) => (sizeByTicker.get(t) ?? 0) / 100);
    bookAnnualizedVol = bookVolatility(weights, vols, matrix);
  }

  // Worst live P&L vs entry across priced positions.
  let worstDrawdownFromEntry: { ticker: string; pnlPct: number } | null = null;
  for (const r of rows) {
    const q = quoteMap.get(r.position.ticker.toUpperCase());
    if (!q || r.position.entryPrice <= 0) continue;
    const pnlPct = (q.price / r.position.entryPrice - 1) * 100;
    if (!worstDrawdownFromEntry || pnlPct < worstDrawdownFromEntry.pnlPct) {
      worstDrawdownFromEntry = { ticker: r.position.ticker.toUpperCase(), pnlPct };
    }
  }

  return {
    navUsd: portfolio.nav,
    grossExposurePct,
    weightedBeta,
    bookAnnualizedVol,
    pairwiseCorrelations: { tickers: priced, matrix },
    correlationClusters,
    themeConcentration,
    cashPct,
    worstDrawdownFromEntry,
    positions: rows.map((r) => ({
      ticker: r.position.ticker.toUpperCase(),
      sizePct: r.position.sizePct,
      theme: r.company.theme,
      priced: priced.includes(r.position.ticker.toUpperCase()),
    })),
  };
}

/**
 * Correlation of one name's daily returns against each open position
 * (itself excluded). Null when the name has no usable history; positions
 * without history are simply absent.
 */
export async function correlationsVsBook(
  ticker: string,
): Promise<{ ticker: string; corr: number }[] | null> {
  const t = ticker.toUpperCase();
  const open = await db
    .select({ ticker: tables.positions.ticker })
    .from(tables.positions)
    .where(eq(tables.positions.status, "open"));
  const others = [...new Set(open.map((p) => p.ticker.toUpperCase()))].filter((x) => x !== t);
  if (others.length === 0) return [];

  const quoteMap = await getQuotes([t, ...others]).catch(() => new Map<string, never>());
  const self = quoteMap.get(t);
  if (!self || self.history.length < MIN_OVERLAP + 1) return null;
  const selfReturns = dailyReturns(self.history);

  const out: { ticker: string; corr: number }[] = [];
  for (const other of others) {
    const q = quoteMap.get(other);
    if (!q) continue;
    const corr = correlation(selfReturns, dailyReturns(q.history));
    if (corr != null) out.push({ ticker: other, corr });
  }
  return out.sort((a, b) => b.corr - a.corr);
}

// --- Sizing math ------------------------------------------------------------

export type SizingInput = {
  bearPrice: number;
  basePrice: number;
  bullPrice: number;
  probabilities?: [number, number, number]; // bear/base/bull, default 0.25/0.5/0.25
  spot: number;
  annualizedVol: number | null; // decimal
  advDollars?: number | null; // avg daily $ volume
  navUsd: number;
  mandate?: Mandate;
};

export type SizingOutput = {
  kellyPct: number; // full Kelly, % of NAV
  kellyHalfPct: number;
  volTargetPct: number | null; // size whose vol contribution hits the annual vol target
  liquidityCapPct: number | null; // exit within 5 ADV-days
  mandateCapPct: number;
  recommendedPct: number; // min of half-Kelly / vol target / liquidity / mandate
  bindingConstraint: "kelly" | "vol_target" | "liquidity" | "mandate";
};

/**
 * Deterministic position sizing from scenario prices. Kelly uses the
 * discrete approximation f* = E[r] / E[r²] over bear/base/bull outcomes;
 * recommended size is the minimum of half-Kelly and the hard caps, with
 * the binding constraint named. Never negative.
 */
export function sizingMath(input: SizingInput): SizingOutput {
  const mandate = input.mandate ?? MANDATE;
  const probs = input.probabilities ?? [0.25, 0.5, 0.25];
  const pSum = probs[0] + probs[1] + probs[2];
  const p = pSum > 0 ? probs.map((x) => x / pSum) : [0.25, 0.5, 0.25];

  const scenarios = [input.bearPrice, input.basePrice, input.bullPrice];
  const rets = scenarios.map((s) => (input.spot > 0 ? s / input.spot - 1 : 0));
  const expected = rets.reduce((s, r, i) => s + p[i] * r, 0);
  const secondMoment = rets.reduce((s, r, i) => s + p[i] * r * r, 0);

  const kellyFraction =
    expected > 0 && secondMoment > 0 ? Math.min(expected / secondMoment, 1) : 0;
  const kellyPct = kellyFraction * 100;
  const kellyHalfPct = kellyPct / 2;

  const volTargetPct =
    input.annualizedVol != null && input.annualizedVol > 0
      ? Math.min((mandate.volTargetAnnual / input.annualizedVol) * 100, 100)
      : null;

  const liquidityCapPct =
    input.advDollars != null && input.advDollars > 0 && input.navUsd > 0
      ? (ADV_EXIT_DAYS * input.advDollars * 100) / input.navUsd
      : null;

  const mandateCapPct = mandate.maxPositionPct;

  const candidates: [SizingOutput["bindingConstraint"], number | null][] = [
    ["kelly", kellyHalfPct],
    ["vol_target", volTargetPct],
    ["liquidity", liquidityCapPct],
    ["mandate", mandateCapPct],
  ];
  let bindingConstraint: SizingOutput["bindingConstraint"] = "kelly";
  let recommendedPct = kellyHalfPct;
  for (const [name, value] of candidates) {
    if (value != null && value < recommendedPct) {
      bindingConstraint = name;
      recommendedPct = value;
    }
  }
  recommendedPct = Math.max(recommendedPct, 0);

  return {
    kellyPct,
    kellyHalfPct,
    volTargetPct,
    liquidityCapPct,
    mandateCapPct,
    recommendedPct,
    bindingConstraint,
  };
}

// --- Correlation-aware sizing (Math Lab) ------------------------------------

export type SizingMultiInput = {
  candidateReturns: number[]; // candidate's daily returns
  bookReturnsMatrix: number[][]; // one row of daily returns per open position
  expectedReturns: number[]; // [candidate, ...book] — same horizon as the daily covariance
  mandate?: Mandate;
};

export type SizingMultiOutput = {
  weightsPct: number[]; // [candidate, ...book] as % of NAV, after caps + CVaR scaling
  candidatePct: number; // weightsPct[0]
  shrinkage: number; // Ledoit-Wolf intensity actually used
  cvarScale: number; // 1 = the CVaR governor was slack
  bindingConstraint: "kelly" | "mandate_cap" | "gross_cap" | "cvar";
};

/**
 * Correlation-aware sizing: Ledoit-Wolf shrinkage covariance over
 * [candidate, ...book] daily returns, multivariate half-Kelly (w = Σ⁻¹μ is
 * linear in μ, so halving expected returns IS half-Kelly — same fractional
 * discipline as sizingMath), capped per-name at the mandate position limit
 * and in aggregate at 100 − minCash, then scaled so the historical daily
 * CVaR-95 stays within what the mandate's vol target implies (a normal book
 * at target vol has CVaR-95 ≈ 2.06σ, since E[Z | Z > z₉₅] = φ(1.645)/0.05).
 * The binding constraint is named from the post-projection geometry. Null on
 * degenerate inputs (mismatched lengths, < 40 overlapping sessions, singular
 * covariance). Complements sizingMath — does not replace it.
 */
export function sizingMathMulti(input: SizingMultiInput): SizingMultiOutput | null {
  const mandate = input.mandate ?? MANDATE;
  const matrix = [input.candidateReturns, ...input.bookReturnsMatrix];
  if (input.expectedReturns.length !== matrix.length) return null;

  const shrunk = shrinkCovariance(matrix);
  if (!shrunk) return null;

  const capPerName = mandate.maxPositionPct / 100;
  const grossCap = Math.max((100 - mandate.minCashPct) / 100, capPerName);
  const halfMu = input.expectedReturns.map((m) => m / 2);
  const weights = multivariateKelly({
    expectedReturns: halfMu,
    cov: shrunk.cov,
    capPerName,
    grossCap,
  });
  if (!weights) return null;

  const dailyVolTarget = mandate.volTargetAnnual / Math.sqrt(TRADING_DAYS);
  const cvarLimitPct = 2.06 * dailyVolTarget * 100;
  const cvarScale = cvarConstrainedScale(weights, matrix, cvarLimitPct) ?? 1;
  const scaled = weights.map((w) => w * cvarScale);

  const eps = 1e-9;
  const gross = weights.reduce((s, w) => s + w, 0);
  const bindingConstraint: SizingMultiOutput["bindingConstraint"] =
    cvarScale < 1 - eps ? "cvar"
    : weights[0] >= capPerName - eps ? "mandate_cap"
    : gross >= grossCap - eps ? "gross_cap"
    : "kelly";

  return {
    weightsPct: scaled.map((w) => w * 100),
    candidatePct: scaled[0] * 100,
    shrinkage: shrunk.shrinkage,
    cvarScale,
    bindingConstraint,
  };
}
