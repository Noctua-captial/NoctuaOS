// The Oracle — the Greek letters live in the engine, never in the answer.
// computeDirective fuses everything the desk knows about one name (thesis,
// memo valuation, debate verdict, position, price history, options chain,
// short flow, insiders, news) through the Math Lab (RND, GARCH, jump-diffusion
// Monte Carlo, HMM regime, Bayesian log-odds fusion) into ONE decision:
// ACTION / conviction / EV / three plain-English reasons / the biggest risk /
// the explicit flip condition. Deterministic and keyless end to end; an LLM
// (when a key exists) may only polish the prose of the three reasons.
//
// Honesty guarantees: every number carries its data's own asOf; missing
// sources are named in dataCoverage and reduce conviction; conviction caps at
// 60 when the options market is dark; nothing is fabricated to fill a gap.
import { and, asc, desc, eq } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, tables } from "@/db";
import { getQuote, getQuotes, type Quote } from "@/lib/market";
import { refreshSignals, fetchChain, type OptionChain, type SignalSnapshot } from "@/lib/signals";
import {
  riskNeutralDensity,
  probAbove,
  probBelow,
  impliedMovePct,
  tailAsymmetry,
} from "@/lib/mathlab/rnd";
import { fitGarch, varianceRiskPremium } from "@/lib/mathlab/garch";
import { positionRisk } from "@/lib/mathlab/montecarlo";
import { updatePosterior, lrFrom, type Contribution, type Evidence } from "@/lib/mathlab/bayes";
import { computeRegime } from "@/lib/warroom";
import {
  computeNameQuant,
  getPortfolio,
  sizingMath,
  sizingMathMulti,
  MANDATE,
  type NameQuant,
} from "@/lib/quant";
import { modelFor } from "@/lib/models";

// --- Decision thresholds (documented, deterministic) --------------------------
// No position:   BUY    posterior ≥ 0.62 AND risk-adj EV90d > 8% AND mandate headroom
//                AVOID  posterior ≤ 0.40, or data broken (no price), or the memo's
//                       own cases offer no payable upside (EV ≤ 0 with targets on file
//                       — stale memo or realized thesis; the logic is broken as written)
//                HOLD   otherwise (watch)
// With position: EXIT   posterior < 0.35 OR thesis marked broken
//                TRIM   posterior < 0.50 OR P(hit kill) > 0.40 OR mandate breach
//                ADD    posterior ≥ 0.65 AND headroom AND P(hit kill) < 0.25
//                HEDGE  posterior ≥ 0.55 AND regime stressed AND options liquid
//                HOLD   otherwise
// Precedence with a position: EXIT > TRIM > ADD > HEDGE > HOLD — the harshest
// applicable verdict wins; de-risking outranks adding.
const BUY_POSTERIOR = 0.62;
const BUY_MIN_EV_PCT = 8;
const AVOID_POSTERIOR = 0.4;
const EXIT_POSTERIOR = 0.35;
const TRIM_POSTERIOR = 0.5;
const TRIM_KILL_PROB = 0.4;
const ADD_POSTERIOR = 0.65;
const ADD_MAX_KILL_PROB = 0.25;
const HEDGE_POSTERIOR = 0.55;
const HEDGE_STRESS_P = 0.6;
const HEDGE_MIN_OI = 1_000; // total open interest before a collar is realistic
const MIN_HEADROOM_PCT = 1; // % of NAV that must be free before BUY/ADD
const HORIZON_TRADING_DAYS = 63; // ≈ 90 calendar days
const EV_CVAR_PENALTY = 0.25; // risk-adj EV = raw EV + 0.25 × CVaR-95 (CVaR is negative)
const MC_SEED = 7; // fixed seed — directives change when data changes, not when dice do
const OPTIONS_STALE_DAYS = 4;
const RND_MIN_DTE = 3;

export type DirectiveAction = "BUY" | "ADD" | "HOLD" | "TRIM" | "EXIT" | "AVOID" | "HEDGE";

export type CoverageStatus = "live" | "stale" | "missing";

export type CoverageEntry = {
  source: string;
  status: CoverageStatus;
  asOf: string | null;
  note: string | null;
};

export type DirectiveInputs = {
  computedAt: string;
  spot: number | null;
  prior: { value: number; source: string };
  posterior: number;
  contributions: Contribution[];
  rnd: {
    expiry: string;
    dte: number;
    pAboveBull: number | null;
    pBelowBear: number | null;
    pAboveBase: number | null;
    impliedMovePct: number | null;
    tailAsymmetry: number | null;
    usableStrikes: number;
  } | null;
  valuation: { bear: number | null; base: number | null; bull: number | null; memoVersion: number } | null;
  garch: {
    forecastVol30d: number;
    longRunVol: number;
    alpha: number;
    beta: number;
    iv30: number | null;
    vrp: number | null;
  } | null;
  monteCarlo: {
    killPrice: number | null;
    killSource: string;
    targetPrice: number | null;
    days: number;
    pHitKill: number | null;
    pAboveTarget: number | null;
    cvar95Pct: number;
    pDrawdown20: number;
    calibration: { diffusionVol: number; jumpIntensity: number; jumpMean: number; jumpVol: number };
  } | null;
  optionsFlow: {
    asOf: string;
    iv30: number | null;
    putCallVolumeRatio: number | null;
    putCallOiRatio: number | null;
    skew25Delta: number | null;
    termSlope: number | null;
    impliedEarningsMovePct: number | null;
    unusualVolumeZ: number | null;
    gex: number | null;
    totalVolume: number;
    totalOpenInterest: number;
    contractCount: number;
  } | null;
  short: { asOf: string; ratio: number; trend: number | null; z: number | null; daysOfHistory: number } | null;
  insider: {
    asOf: string | null;
    buyValue: number;
    sellValue: number;
    netValue: number;
    clusterBuy: boolean;
    distinctBuyers: number;
    transactions: number;
  } | null;
  news: {
    asOf: string | null;
    count: number;
    bullish: number;
    bearish: number;
    neutral: number;
    burst: boolean;
    burstCount: number;
    sentiment: number | null;
  } | null;
  regime: { pStressed: number | null; volRegime: string; read: string } | null;
  thesis: { version: number; oneLiner: string; killCriteria: string[] } | null;
  ev: { rawPct: number; cvarPenaltyPct: number; riskAdjustedPct: number; baseReturnPct: number; bearReturnPct: number } | null;
  sizing: { method: "multi" | "single"; recommendedPct: number; bindingConstraint: string } | null;
  hedge: { expiry: string; putStrike: number; callStrike: number; netCostPerShare: number | null } | null;
  catalyst: { title: string; date: string; daysOut: number } | null;
  position: { sizePct: number; entryPrice: number; pnlPct: number | null } | null;
  mandate: { maxPositionPct: number; headroomPct: number; grossExposurePct: number | null };
  decisionPath: string;
};

export type Directive = {
  id: number;
  ticker: string;
  companyId: number | null;
  action: DirectiveAction;
  conviction: number;
  pThesis: number;
  expectedMovePct: number | null;
  ev90dPct: number | null;
  sizeTargetPct: number | null;
  reasons: [string, string, string];
  biggestRisk: string;
  flipCondition: string;
  dataCoverage: CoverageEntry[];
  inputs: DirectiveInputs;
  createdAt: string;
};

// --- small helpers -------------------------------------------------------------

/** First $-figure in a valuation case string like "$38 — SiPho stalls, 12x trough EPS". */
function parsePrice(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/\$\s*(\d+(?:[,.]\d+)?)/);
  if (!m) return null;
  const v = Number(m[1].replace(",", ""));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function money(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function monthDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

function daysBetween(fromMs: number, toIso: string): number {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T16:00:00Z`) - fromMs) / 86_400_000);
}

/** Posterior implied by shifting current log-odds by `deltaLogOdds`. */
function posteriorShift(posterior: number, deltaLogOdds: number): number {
  const p = Math.min(Math.max(posterior, 0.001), 0.999);
  const lo = Math.log(p / (1 - p)) + deltaLogOdds;
  return 1 / (1 + Math.exp(-lo));
}

// --- RND expiry selection --------------------------------------------------------

type ExpiryPick = { expiry: string; dte: number };

/**
 * Choose the expiry whose date best brackets the next catalyst: the nearest
 * expiry ON OR AFTER the catalyst date (the event must be inside the window),
 * falling back to the closest expiry overall. With no catalyst, the expiry
 * nearest the 60-90d window — far enough out to say something about a 90d EV.
 */
function pickRndExpiry(chain: OptionChain, catalystDate: string | null): ExpiryPick | null {
  const nowMs = Date.parse(chain.asOf) || Date.now();
  const expiries = [...new Set(chain.contracts.map((c) => c.expiry))]
    .map((expiry) => ({ expiry, dte: daysBetween(nowMs, expiry) }))
    .filter((e) => e.dte >= RND_MIN_DTE)
    .sort((a, b) => a.dte - b.dte);
  if (expiries.length === 0) return null;

  if (catalystDate) {
    const catDte = daysBetween(nowMs, catalystDate);
    const onOrAfter = expiries.filter((e) => e.dte >= catDte);
    if (onOrAfter.length > 0) return onOrAfter[0];
    return expiries.reduce((best, e) => (Math.abs(e.dte - catDte) < Math.abs(best.dte - catDte) ? e : best));
  }

  const score = (e: ExpiryPick) => (e.dte < 60 ? 60 - e.dte : e.dte > 90 ? e.dte - 90 : 0);
  return expiries.reduce((best, e) =>
    score(e) < score(best) || (score(e) === score(best) && Math.abs(e.dte - 75) < Math.abs(best.dte - 75)) ? e : best,
  );
}

// --- plain-English rendering -----------------------------------------------------

const DRIVER_NAMES: Record<string, string> = {
  insider_cluster_buy: "insider buying",
  insider_cluster_sell: "insider selling",
  short_pressure_z: "short-sale pressure",
  rnd_tail_asymmetry: "option-implied skew",
  variance_risk_premium: "the variance premium",
  regime_stressed: "the market regime",
  unusual_options_volume_z: "unusual options volume",
  news_sentiment: "headline flow",
};

export function humanizeDriver(name: string): string {
  return DRIVER_NAMES[name] ?? name.replace(/_/g, " ");
}

type ReasonCandidate = { score: number; text: string };

// --- the engine --------------------------------------------------------------------

/**
 * Compute, persist, and return the directive for one covered name.
 * Throws only when the ticker is not in coverage; every data failure inside
 * degrades to nulls that the decision logic and dataCoverage handle honestly.
 */
export async function computeDirective(ticker: string): Promise<Directive> {
  const t = ticker.toUpperCase();
  const computedAtMs = Date.now();

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.ticker, t) });
  if (!company) throw new Error(`${t} is not in coverage — open a dossier before asking the Oracle.`);

  // ---- 1) Gather --------------------------------------------------------------
  const [thesis, memo, catalystRows, debate, openPositions, portfolio] = await Promise.all([
    db.query.theses.findFirst({
      where: eq(tables.theses.companyId, company.id),
      orderBy: desc(tables.theses.version),
    }),
    db.query.memos.findFirst({
      where: eq(tables.memos.companyId, company.id),
      orderBy: desc(tables.memos.version),
    }),
    db.select().from(tables.catalysts).where(eq(tables.catalysts.companyId, company.id)).orderBy(asc(tables.catalysts.expectedDate)),
    db.query.debates.findFirst({
      where: eq(tables.debates.ticker, t),
      orderBy: desc(tables.debates.createdAt),
    }),
    db
      .select()
      .from(tables.positions)
      .where(and(eq(tables.positions.companyId, company.id), eq(tables.positions.status, "open"))),
    getPortfolio(),
  ]);

  const [quant, quote, signals, chain, regime] = await Promise.all([
    computeNameQuant(t).catch(() => null as NameQuant | null),
    getQuote(t).catch(() => null as Quote | null),
    refreshSignals(t, company.name),
    fetchChain(t).catch(() => null as OptionChain | null),
    computeRegime().catch(() => null),
  ]);

  const spot = quote?.price ?? chain?.spot ?? quant?.spot ?? null;
  const history = quote?.history ?? [];
  const returns = dailyReturns(history);

  // Memo valuation cases (parsed the same way the sizing council does).
  let bearPrice: number | null = null;
  let basePrice: number | null = null;
  let bullPrice: number | null = null;
  if (memo) {
    try {
      const content = JSON.parse(memo.content) as { valuation?: { bear?: string; base?: string; bull?: string } };
      bearPrice = parsePrice(content.valuation?.bear);
      basePrice = parsePrice(content.valuation?.base);
      bullPrice = parsePrice(content.valuation?.bull);
    } catch {
      // unreadable memo content — valuation stays null
    }
  }

  // Next firm-dated catalyst (fuzzy windows like "Q3 2026" are not dates).
  const nextCatalyst =
    catalystRows
      .filter((c) => c.expectedDate != null && /^\d{4}-\d{2}-\d{2}/.test(c.expectedDate.trim()))
      .map((c) => ({ title: c.title, date: c.expectedDate!.trim().slice(0, 10) }))
      .filter((c) => daysBetween(computedAtMs, c.date) >= 0)
      .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;

  // ---- 2) Math ----------------------------------------------------------------

  // (a) Risk-neutral density at the catalyst-nearest expiry.
  let rndBlock: DirectiveInputs["rnd"] = null;
  let rndTail: number | null = null;
  if (chain && spot != null && spot > 0) {
    const pick = pickRndExpiry(chain, nextCatalyst?.date ?? null);
    if (pick) {
      const slice = chain.contracts
        .filter((c) => c.expiry === pick.expiry)
        .map((c) => ({ type: c.type, strike: c.strike, mid: c.mid, iv: c.iv }));
      const rnd = riskNeutralDensity({ spot, expiryYears: pick.dte / 365, contracts: slice });
      if (rnd) {
        rndTail = tailAsymmetry(rnd, spot);
        const move = impliedMovePct(rnd);
        rndBlock = {
          expiry: pick.expiry,
          dte: pick.dte,
          pAboveBull: bullPrice != null ? probAbove(rnd, bullPrice) : null,
          pBelowBear: bearPrice != null ? probBelow(rnd, bearPrice) : null,
          pAboveBase: basePrice != null ? probAbove(rnd, basePrice) : null,
          impliedMovePct: move != null ? move * 100 : null,
          tailAsymmetry: rndTail,
          usableStrikes: slice.filter((c) => c.iv != null && c.mid != null && c.mid > 0).length,
        };
      }
    }
  }

  // (b) GARCH forecast vs implied vol → variance risk premium.
  const iv30 = chain?.iv30 ?? signals.options?.iv30 ?? null;
  const garchFit = returns.length >= 250 ? fitGarch(returns) : null;
  const vrp =
    garchFit && iv30 != null ? varianceRiskPremium(garchFit.forecastVol30dAnnualized, iv30) : null;
  const garchBlock: DirectiveInputs["garch"] = garchFit
    ? {
        forecastVol30d: garchFit.forecastVol30dAnnualized,
        longRunVol: garchFit.longRunVolAnnualized,
        alpha: garchFit.alpha,
        beta: garchFit.beta,
        iv30,
        vrp,
      }
    : null;

  // (c) Jump-diffusion Monte Carlo: kill = memo bear case, else 0.75×spot.
  const killSource = bearPrice != null ? `memo bear case ($${bearPrice})` : "0.75 × spot fallback";
  const killPrice = bearPrice ?? (spot != null ? spot * 0.75 : null);
  const mc =
    spot != null && spot > 0
      ? positionRisk({
          spot,
          killPrice,
          targetPrice: basePrice,
          days: HORIZON_TRADING_DAYS,
          vol: garchFit?.forecastVol30dAnnualized ?? quant?.annualizedVol ?? null,
          history,
          seed: MC_SEED,
        })
      : null;
  const mcBlock: DirectiveInputs["monteCarlo"] = mc
    ? {
        killPrice,
        killSource,
        targetPrice: basePrice,
        days: HORIZON_TRADING_DAYS,
        pHitKill: mc.pHitKillBeforeHorizon,
        pAboveTarget: mc.pAboveTarget,
        cvar95Pct: mc.cvar95Pct,
        pDrawdown20: mc.pDrawdown20,
        calibration: mc.calibration,
      }
    : null;

  // (d) Bayesian fusion. Prior from the latest debate verdict, conviction-weighted.
  let prior = 0.5;
  let priorSource = "no debate on record — market-data prior only";
  if (debate?.verdict) {
    const c = debate.conviction ?? 0.5;
    prior =
      debate.verdict === "pursue" ? 0.5 + 0.3 * c : debate.verdict === "reject" ? 0.5 - 0.3 * c : 0.5;
    priorSource = `debate #${debate.id} verdict "${debate.verdict}" at conviction ${(c * 100).toFixed(0)}%`;
  }

  const evidences: Evidence[] = [];
  const pushEvidence = (kind: string, value: number) =>
    evidences.push({ name: kind, likelihoodRatio: lrFrom({ kind, value }) });

  const insider = signals.insider;
  const insiderLive = insider != null && insider.asOf != null;
  let distinctSellers14d = 0;
  if (insiderLive && insider.transactions.length > 0) {
    const latest = insider.transactions[0].date;
    const cutoff = new Date(Date.parse(`${latest}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
    distinctSellers14d = new Set(
      insider.transactions.filter((x) => x.code === "S" && x.date >= cutoff).map((x) => x.insider),
    ).size;
  }
  if (insiderLive) {
    pushEvidence("insider_cluster_buy", insider.distinctBuyers);
    if (distinctSellers14d >= 2) pushEvidence("insider_cluster_sell", distinctSellers14d);
  }
  if (signals.short?.z != null) pushEvidence("short_pressure_z", signals.short.z);
  if (rndTail != null) pushEvidence("rnd_tail_asymmetry", rndTail);
  if (vrp != null) pushEvidence("variance_risk_premium", vrp);
  if (regime?.pStressed != null) pushEvidence("regime_stressed", regime.pStressed);
  if (signals.options?.unusualVolumeZ != null)
    pushEvidence("unusual_options_volume_z", signals.options.unusualVolumeZ);

  const news = signals.news;
  let newsSentiment: number | null = null;
  let newsBull = 0;
  let newsBear = 0;
  if (news && news.items.length > 0) {
    newsBull = news.items.filter((i) => i.tag === "bullish").length;
    newsBear = news.items.filter((i) => i.tag === "bearish").length;
    newsSentiment = (newsBull - newsBear) / news.items.length;
    pushEvidence("news_sentiment", newsSentiment);
  }

  const fused = updatePosterior(prior, evidences);
  const posterior = fused?.posterior ?? prior;
  const contributions = fused?.contributions ?? [];

  // (e) Expected value over ~90 days: posterior-weighted memo scenarios,
  // penalized by the Monte Carlo tail (risk-adj EV = raw + 0.25 × CVaR-95).
  let evBlock: DirectiveInputs["ev"] = null;
  if (spot != null && spot > 0 && basePrice != null && bearPrice != null) {
    const baseReturnPct = (basePrice / spot - 1) * 100;
    const bearReturnPct = (bearPrice / spot - 1) * 100;
    const rawPct = posterior * baseReturnPct + (1 - posterior) * bearReturnPct;
    const cvarPenaltyPct = mc ? EV_CVAR_PENALTY * mc.cvar95Pct : 0;
    evBlock = {
      rawPct,
      cvarPenaltyPct,
      riskAdjustedPct: rawPct + cvarPenaltyPct,
      baseReturnPct,
      bearReturnPct,
    };
  }
  const ev90dPct = evBlock?.riskAdjustedPct ?? null;

  // ---- 3) Position, mandate headroom, sizing ----------------------------------
  const positionSizePct = openPositions.reduce((s, p) => s + p.sizePct, 0);
  const hasPosition = openPositions.length > 0;
  const entryPrice = openPositions[0]?.entryPrice ?? null;
  const positionBlock: DirectiveInputs["position"] = hasPosition
    ? {
        sizePct: positionSizePct,
        entryPrice: entryPrice!,
        pnlPct: spot != null && entryPrice != null && entryPrice > 0 ? (spot / entryPrice - 1) * 100 : null,
      }
    : null;

  const allOpen = await db
    .select({ position: tables.positions, company: tables.companies })
    .from(tables.positions)
    .innerJoin(tables.companies, eq(tables.positions.companyId, tables.companies.id))
    .where(eq(tables.positions.status, "open"));
  const grossExposurePct = allOpen.reduce((s, r) => s + r.position.sizePct, 0);
  const themeUsedPct = company.theme
    ? allOpen
        .filter((r) => r.company.theme === company.theme && r.position.ticker.toUpperCase() !== t)
        .reduce((s, r) => s + r.position.sizePct, 0) + (hasPosition ? positionSizePct : 0)
    : 0;
  const headroomPct = Math.max(
    Math.min(
      MANDATE.maxPositionPct - positionSizePct,
      100 - MANDATE.minCashPct - grossExposurePct,
      company.theme ? MANDATE.maxThemePct - themeUsedPct : Number.POSITIVE_INFINITY,
    ),
    0,
  );
  const hasHeadroom = headroomPct >= MIN_HEADROOM_PCT;
  const mandateBreach =
    positionSizePct > MANDATE.maxPositionPct ||
    (company.theme != null && themeUsedPct > MANDATE.maxThemePct);

  // Sizing: correlation-aware multivariate Kelly when the rest of the book has
  // ≥2 priced positions; the pairwise sizingMath otherwise. The posterior sets
  // the scenario weights — bear carries (1 − posterior); the thesis-side mass
  // splits 60/40 between base and bull (catalyst-path uncertainty).
  let sizingBlock: DirectiveInputs["sizing"] = null;
  if (spot != null && spot > 0 && bearPrice != null && basePrice != null && bullPrice != null) {
    const others = [...new Set(allOpen.map((r) => r.position.ticker.toUpperCase()))].filter((x) => x !== t);
    let multiDone = false;
    if (others.length >= 2 && evBlock != null && returns.length >= 41) {
      const quoteMap = await getQuotes(others).catch(() => new Map<string, Quote>());
      const bookReturns = others
        .map((o) => dailyReturns(quoteMap.get(o)?.history ?? []))
        .filter((r) => r.length >= 41);
      if (bookReturns.length >= 2) {
        const candDailyEdge = evBlock.rawPct / 100 / HORIZON_TRADING_DAYS;
        const multi = sizingMathMulti({
          candidateReturns: returns,
          bookReturnsMatrix: bookReturns,
          // Zero expected edge for the incumbents: the question here is the
          // candidate's size GIVEN its correlation to what the book already holds.
          expectedReturns: [candDailyEdge, ...bookReturns.map(() => 0)],
        });
        if (multi) {
          sizingBlock = {
            method: "multi",
            recommendedPct: multi.candidatePct,
            bindingConstraint: multi.bindingConstraint,
          };
          multiDone = true;
        }
      }
    }
    if (!multiDone) {
      const single = sizingMath({
        bearPrice,
        basePrice,
        bullPrice,
        probabilities: [1 - posterior, posterior * 0.6, posterior * 0.4],
        spot,
        annualizedVol: quant?.annualizedVol ?? null,
        advDollars: quant?.avgDollarVolume ?? null,
        navUsd: portfolio.nav,
      });
      sizingBlock = {
        method: "single",
        recommendedPct: single.recommendedPct,
        bindingConstraint: single.bindingConstraint,
      };
    }
  }

  // ---- 4) Decision ------------------------------------------------------------
  const pHitKill = mc?.pHitKillBeforeHorizon ?? null;
  const thesisBroken = company.thesisStatus === "broken";
  const regimeStressed =
    (regime?.pStressed != null && regime.pStressed >= HEDGE_STRESS_P) || regime?.volRegime === "stressed";
  const optionsLiquid =
    signals.options != null &&
    signals.options.totalOpenInterest >= HEDGE_MIN_OI &&
    signals.options.contractCount >= 100;
  const dataBroken = spot == null || fused == null;
  const valuationOnFile = basePrice != null && bearPrice != null;

  let action: DirectiveAction;
  let decisionPath: string;
  if (!hasPosition) {
    if (dataBroken) {
      action = "AVOID";
      decisionPath = "no position · price/posterior data broken → AVOID";
    } else if (posterior <= AVOID_POSTERIOR) {
      action = "AVOID";
      decisionPath = `no position · posterior ${posterior.toFixed(2)} ≤ ${AVOID_POSTERIOR} → AVOID`;
    } else if (ev90dPct != null && ev90dPct <= 0 && valuationOnFile) {
      action = "AVOID";
      decisionPath = `no position · risk-adj EV90d ${ev90dPct.toFixed(1)}% ≤ 0 with targets on file → AVOID (memo math offers no payable upside)`;
    } else if (posterior >= BUY_POSTERIOR && ev90dPct != null && ev90dPct > BUY_MIN_EV_PCT && hasHeadroom) {
      action = "BUY";
      decisionPath = `no position · posterior ${posterior.toFixed(2)} ≥ ${BUY_POSTERIOR}, EV90d ${ev90dPct.toFixed(1)}% > ${BUY_MIN_EV_PCT}%, headroom ${headroomPct.toFixed(1)}% → BUY`;
    } else {
      action = "HOLD";
      decisionPath = `no position · posterior ${posterior.toFixed(2)} between gates${ev90dPct != null ? `, EV90d ${ev90dPct.toFixed(1)}%` : ", EV unavailable"} → HOLD (watch)`;
    }
  } else {
    if (thesisBroken || posterior < EXIT_POSTERIOR) {
      action = "EXIT";
      decisionPath = thesisBroken
        ? "open position · thesis marked BROKEN → EXIT"
        : `open position · posterior ${posterior.toFixed(2)} < ${EXIT_POSTERIOR} → EXIT`;
    } else if (posterior < TRIM_POSTERIOR || (pHitKill != null && pHitKill > TRIM_KILL_PROB) || mandateBreach) {
      action = "TRIM";
      decisionPath =
        posterior < TRIM_POSTERIOR
          ? `open position · posterior ${posterior.toFixed(2)} < ${TRIM_POSTERIOR} → TRIM`
          : pHitKill != null && pHitKill > TRIM_KILL_PROB
            ? `open position · P(hit kill) ${pct(pHitKill)} > ${pct(TRIM_KILL_PROB)} → TRIM`
            : "open position · mandate breach → TRIM";
    } else if (posterior >= ADD_POSTERIOR && hasHeadroom && (pHitKill == null || pHitKill < ADD_MAX_KILL_PROB)) {
      action = "ADD";
      decisionPath = `open position · posterior ${posterior.toFixed(2)} ≥ ${ADD_POSTERIOR}, headroom ${headroomPct.toFixed(1)}%, P(hit kill) ${pHitKill != null ? pct(pHitKill) : "n/a"} → ADD`;
    } else if (posterior >= HEDGE_POSTERIOR && regimeStressed && optionsLiquid) {
      action = "HEDGE";
      decisionPath = `open position · posterior ${posterior.toFixed(2)} ≥ ${HEDGE_POSTERIOR} but regime stressed and options liquid → HEDGE`;
    } else {
      action = "HOLD";
      decisionPath = `open position · posterior ${posterior.toFixed(2)} inside the hold band → HOLD`;
    }
  }

  // Collar suggestion when hedging: ~25Δ put funded by a ~25Δ call at the RND expiry.
  let hedgeBlock: DirectiveInputs["hedge"] = null;
  if (action === "HEDGE" && chain && rndBlock) {
    const atExpiry = chain.contracts.filter((c) => c.expiry === rndBlock!.expiry && c.delta != null);
    const nearDelta = (type: "C" | "P") =>
      atExpiry
        .filter((c) => c.type === type)
        .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.25) - Math.abs(Math.abs(b.delta!) - 0.25))[0] ?? null;
    const put = nearDelta("P");
    const call = nearDelta("C");
    if (put && call) {
      hedgeBlock = {
        expiry: rndBlock.expiry,
        putStrike: put.strike,
        callStrike: call.strike,
        netCostPerShare: put.mid != null && call.mid != null ? put.mid - call.mid : null,
      };
    }
  }

  // ---- 5) Data coverage + conviction -------------------------------------------
  const coverage: CoverageEntry[] = [];
  const optionsAgeDays = signals.options ? daysBetween(Date.parse(signals.options.asOf), new Date(computedAtMs).toISOString()) : null;
  coverage.push(
    signals.options
      ? {
          source: "options",
          status: optionsAgeDays != null && optionsAgeDays > OPTIONS_STALE_DAYS ? "stale" : "live",
          asOf: signals.options.asOf,
          note: `${signals.options.contractCount} contracts${rndBlock ? "" : " — chain too thin for a density"}`,
        }
      : { source: "options", status: "missing", asOf: null, note: "no chain — odds derived from price history only" },
  );
  coverage.push(
    signals.short
      ? {
          source: "short_flow",
          status: "live",
          asOf: signals.short.asOf,
          note:
            signals.short.z == null
              ? `${signals.short.daysOfHistory} day${signals.short.daysOfHistory === 1 ? "" : "s"} of history — z-score gated until 10`
              : null,
        }
      : { source: "short_flow", status: "missing", asOf: null, note: "FINRA file unavailable" },
  );
  coverage.push(
    insiderLive
      ? { source: "insider", status: "live", asOf: insider.asOf, note: `${insider.transactions.length} Form 4 transaction${insider.transactions.length === 1 ? "" : "s"} in ${insider.windowDays}d` }
      : {
          source: "insider",
          status: "missing",
          asOf: null,
          note: "no Form 4 tape — foreign private issuers do not file Section 16",
        },
  );
  coverage.push(
    news && news.items.length > 0
      ? { source: "news", status: "live", asOf: news.asOf, note: `${news.items.length} headlines` }
      : { source: "news", status: "missing", asOf: null, note: "feed empty" },
  );
  coverage.push(
    debate?.verdict
      ? { source: "debate", status: "live", asOf: debate.createdAt?.toISOString() ?? null, note: priorSource }
      : { source: "debate", status: "missing", asOf: null, note: "no debate on record — market-data prior only" },
  );
  coverage.push(
    valuationOnFile
      ? {
          source: "valuation",
          status: spot != null && basePrice != null && basePrice < spot ? "stale" : "live",
          asOf: memo?.createdAt?.toISOString() ?? null,
          note:
            spot != null && basePrice != null && basePrice < spot
              ? `memo v${memo?.version} base case $${basePrice} sits below spot $${spot.toFixed(0)} — re-underwrite suspected`
              : `memo v${memo?.version} scenario prices`,
        }
      : { source: "valuation", status: "missing", asOf: null, note: "no memo scenario prices — EV and sizing gated" },
  );
  coverage.push(
    quote
      ? { source: "price_history", status: quote.stale ? "stale" : "live", asOf: quote.fetchedAt.toISOString(), note: `${history.length} sessions` }
      : { source: "price_history", status: "missing", asOf: null, note: "no quote" },
  );
  coverage.push(
    nextCatalyst
      ? { source: "catalyst", status: "live", asOf: nextCatalyst.date, note: nextCatalyst.title }
      : { source: "catalyst", status: "missing", asOf: null, note: "no firm-dated catalyst" },
  );
  coverage.push(
    regime?.pStressed != null
      ? { source: "regime", status: "live", asOf: new Date(computedAtMs).toISOString(), note: `P(stressed) ${pct(regime.pStressed)}` }
      : { source: "regime", status: "missing", asOf: null, note: "HMM could not fit the benchmark" },
  );

  // Conviction: distance from the coin flip, scaled by coverage; a dark
  // options market caps it at 60 — we will not bank conviction we cannot see.
  const coverageScore = coverage.reduce(
    (s, c) => s + (c.status === "live" ? 1 : c.status === "stale" ? 0.5 : 0),
    0,
  );
  const coverageScale = 0.5 + 0.5 * (coverageScore / coverage.length);
  let conviction = Math.round(Math.abs(posterior - 0.5) * 200 * coverageScale);
  if (!signals.options) conviction = Math.min(conviction, 60);
  conviction = Math.max(0, Math.min(100, conviction));

  // ---- 6) Size target ----------------------------------------------------------
  // TRIM halves the book's exposure (a de-risking step, not a re-underwrite);
  // EXIT/AVOID zero it; ADD/BUY take the math's recommendation inside headroom.
  let sizeTargetPct: number | null = null;
  if (action === "EXIT" || action === "AVOID") sizeTargetPct = 0;
  else if (action === "TRIM") sizeTargetPct = Math.round(Math.max(positionSizePct / 2, 0.5) * 10) / 10;
  else if (action === "BUY")
    sizeTargetPct = sizingBlock ? Math.round(Math.min(sizingBlock.recommendedPct, headroomPct) * 10) / 10 : null;
  else if (action === "ADD")
    sizeTargetPct = sizingBlock
      ? Math.round(Math.min(Math.max(sizingBlock.recommendedPct, positionSizePct), positionSizePct + headroomPct) * 10) / 10
      : null;
  else if (hasPosition) sizeTargetPct = positionSizePct;

  // ---- 7) Reasons, biggest risk, flip condition ---------------------------------
  const catalystLabel = nextCatalyst ? `the ${monthDay(nextCatalyst.date)} catalyst` : null;
  const expiryLabel = rndBlock ? monthDay(rndBlock.expiry) : null;

  const candidates: ReasonCandidate[] = [];

  // The market's own odds on our base case — the centerpiece when available.
  if (rndBlock?.pAboveBase != null && basePrice != null && spot != null) {
    const p = rndBlock.pAboveBase;
    if (basePrice < spot) {
      candidates.push({
        score: 2.6,
        text: `The memo's $${basePrice} base case sits ${pct(1 - basePrice / spot)} below the current $${spot.toFixed(0)} tape — the options market calls it ${pct(p)} likely because it is already behind us; the thesis as written has nothing left to pay.`,
      });
    } else {
      candidates.push({
        score: 2.2 + Math.abs(p - 0.5),
        text: `The options market prices a ${pct(p)} chance of reaching our $${basePrice} base case by ${catalystLabel ?? `the ${expiryLabel} expiry`} — ${
          p < 0.45
            ? "our thesis needs better than a coin flip and the market is not paying for it"
            : p > 0.55
              ? "the market is already leaning our way; the edge is in being earlier, not righter"
              : "the market sits exactly on the fence our thesis claims to resolve"
        }.`,
      });
    }
  }

  // Contribution-driven sentences, scored by how hard each moved the odds.
  for (const c of contributions) {
    const mag = Math.abs(c.deltaLogOdds);
    if (mag < 1e-9) continue;
    let text: string | null = null;
    switch (c.name) {
      case "insider_cluster_buy":
        text =
          insider && insider.distinctBuyers >= 2
            ? `${insider.distinctBuyers} distinct insiders bought ${money(insider.buyValue)} of stock inside a two-week window — clustered buying is the one insider pattern with real predictive weight.`
            : `An insider bought in the open market recently — mildly supportive, but one buyer is not a cluster.`;
        break;
      case "insider_cluster_sell":
        text = `${distinctSellers14d} insiders sold inside two weeks (net ${money(insider?.netValue ?? 0)}) — often liquidity, but the tape leans against the thesis.`;
        break;
      case "short_pressure_z":
        text =
          (signals.short?.z ?? 0) > 0
            ? `Short-sale pressure is running ${signals.short!.z!.toFixed(1)} standard deviations above its trailing norm — someone is leaning on the name.`
            : `Short-sale pressure has faded ${Math.abs(signals.short!.z!).toFixed(1)} standard deviations below its norm — the pressure trade is unwinding.`;
        break;
      case "rnd_tail_asymmetry":
        text =
          (rndTail ?? 1) > 1
            ? `Options price the +20% tail ${rndTail!.toFixed(1)}x richer than the -20% tail by ${expiryLabel} — the market's own skew leans toward the upside.`
            : `Options price the -20% tail ${(1 / rndTail!).toFixed(1)}x richer than the upside tail — crash protection is bid; upside is not.`;
        break;
      case "variance_risk_premium":
        text =
          (vrp ?? 0) > 0
            ? `Implied volatility trades ${pct(vrp!)} above the volatility model's 30-day forecast — fear is richly priced and hedging demand is real.`
            : `Implied volatility sits ${pct(Math.abs(vrp!))} below the model's forecast — protection is cheap and complacency is the consensus.`;
        break;
      case "regime_stressed":
        text =
          (regime?.pStressed ?? 0) >= HEDGE_STRESS_P
            ? `The benchmark regime model reads ${pct(regime!.pStressed!)} stressed — long theses underperform until that clears.`
            : `The market regime reads calm (${pct(regime!.pStressed!)} stressed) — a tailwind for carrying thesis risk.`;
        break;
      case "unusual_options_volume_z":
        text = `Options volume is running ${signals.options!.unusualVolumeZ!.toFixed(1)} standard deviations above its history — positioning is arriving ahead of us.`;
        break;
      case "news_sentiment":
        text = `Headline flow runs ${newsBull} bullish to ${newsBear} bearish over the recent tape${news?.burst ? ` with ${news.burstCount} stories inside 48 hours` : ""} — the narrative is ${newsSentiment! > 0 ? "moving toward" : "moving against"} the thesis.`;
        break;
    }
    if (text) candidates.push({ score: mag, text });
  }

  // Monte Carlo kill odds.
  if (pHitKill != null && killPrice != null) {
    candidates.push({
      score: pHitKill > 0.25 ? 1.2 + pHitKill : 0.25 + pHitKill,
      text: `Simulated paths touch the $${killPrice.toFixed(0)} kill level (${killSource}) ${pct(pHitKill)} of the time inside 90 days — ${
        pHitKill > TRIM_KILL_PROB ? "that is not a tail, that is a coin flip on the exit rule" : pHitKill > 0.15 ? "survivable, but the exit rule is live" : "the kill line is comfortably remote"
      }.`,
    });
  }

  // EV statement.
  if (evBlock) {
    candidates.push({
      score: 0.8 + Math.min(Math.abs(evBlock.riskAdjustedPct) / 20, 1),
      text: `Posterior-weighted 90-day expected value is ${evBlock.riskAdjustedPct >= 0 ? "+" : ""}${evBlock.riskAdjustedPct.toFixed(1)}% after the tail penalty — ${
        evBlock.riskAdjustedPct > BUY_MIN_EV_PCT
          ? "the math clears the bar for committing capital"
          : evBlock.riskAdjustedPct > 0
            ? "positive, but not by enough to pay for the risk"
            : "the scenario math pays nothing for the risk taken"
      }.`,
    });
  }

  // Honest fallbacks so three reasons always exist.
  if (!debate?.verdict) {
    candidates.push({
      score: 0.3,
      text: `No debate on record — the prior is a coin flip and this directive leans entirely on market-priced evidence.`,
    });
  }
  if (!valuationOnFile) {
    candidates.push({
      score: 0.32,
      text: `No memo scenario prices on file — expected value and Kelly sizing stay gated until the valuation work exists.`,
    });
  }
  if (signals.short && signals.short.z == null) {
    candidates.push({
      score: 0.28,
      text: `Short-sale pressure reads ${pct(signals.short.ratio)} of volume but has only ${signals.short.daysOfHistory} day${signals.short.daysOfHistory === 1 ? "" : "s"} of stored history — the z-score gate stays closed until ten.`,
    });
  }
  if (!insiderLive) {
    candidates.push({
      score: 0.27,
      text: `The insider tape is dark — no Form 4 filings exist for this issuer, so that channel neither helps nor warns.`,
    });
  }
  candidates.push({
    score: 0.1,
    text: `Data coverage stands at ${coverage.filter((c) => c.status === "live").length} of ${coverage.length} sources live — conviction is scaled down accordingly.`,
  });

  candidates.sort((a, b) => b.score - a.score);
  const reasons = candidates.slice(0, 3).map((c) => c.text) as [string, string, string];

  // Biggest risk: the strongest force pushing against the current stance.
  let biggestRisk: string;
  const mostNegative = [...contributions].sort((a, b) => a.deltaLogOdds - b.deltaLogOdds)[0];
  if (pHitKill != null && pHitKill > 0.25 && killPrice != null) {
    biggestRisk = `${pct(pHitKill)} of simulated paths touch the $${killPrice.toFixed(0)} kill level within 90 days — the exit rule is the live risk.`;
  } else if (mostNegative && mostNegative.deltaLogOdds < -1e-9) {
    biggestRisk = `${humanizeDriver(mostNegative.name)[0].toUpperCase()}${humanizeDriver(mostNegative.name).slice(1)} is the heaviest weight against the thesis (it moved the odds ${Math.exp(mostNegative.deltaLogOdds).toFixed(2)}:1).`;
  } else if (mc) {
    biggestRisk = `The worst 5% of simulated 90-day outcomes average ${mc.cvar95Pct.toFixed(1)}% — that is the tail being carried.`;
  } else {
    biggestRisk = `The dominant risk is blindness: too little live data to even rank the risks.`;
  }

  // Flip condition: the boundary nearest to changing the action, plus the
  // single evidence lever (one capped 3:1 signal) that would cross it.
  const oneSignalUp = posteriorShift(posterior, Math.log(3));
  const oneSignalDown = posteriorShift(posterior, -Math.log(3));
  let flipCondition: string;
  if (!hasPosition) {
    if (action === "AVOID" && ev90dPct != null && ev90dPct <= 0 && valuationOnFile) {
      flipCondition = `A re-underwritten memo with a base case above the $${spot?.toFixed(0)} tape — today's targets top out below the price, so no posterior can rescue the math.`;
    } else if (action === "AVOID") {
      flipCondition = `Posterior back above ${AVOID_POSTERIOR.toFixed(2)} reopens the watch (now ${posterior.toFixed(2)}); one full-strength bullish signal — an insider cluster buy, say — lifts it to ${oneSignalUp.toFixed(2)}.`;
    } else if (action === "BUY") {
      flipCondition = `Posterior below ${BUY_POSTERIOR.toFixed(2)} or risk-adjusted EV under ${BUY_MIN_EV_PCT}% pulls the BUY — one full-strength bearish signal would drop the posterior to ${oneSignalDown.toFixed(2)}.`;
    } else {
      const dBuy = BUY_POSTERIOR - posterior;
      const dAvoid = posterior - AVOID_POSTERIOR;
      flipCondition =
        dBuy <= dAvoid
          ? `Posterior above ${BUY_POSTERIOR.toFixed(2)} (now ${posterior.toFixed(2)}) with EV90d over ${BUY_MIN_EV_PCT}% flips this to BUY — one strong confirming signal reaches ${oneSignalUp.toFixed(2)}${ev90dPct == null || ev90dPct <= BUY_MIN_EV_PCT ? ", but the EV gate also needs the valuation math to clear" : ""}.`
          : `Posterior below ${AVOID_POSTERIOR.toFixed(2)} (now ${posterior.toFixed(2)}) flips this to AVOID — one full-strength bearish signal drops it to ${oneSignalDown.toFixed(2)}.`;
    }
  } else {
    if (action === "EXIT") {
      flipCondition = `This is the exit; posterior back above ${TRIM_POSTERIOR.toFixed(2)} with the thesis re-marked intact would be required to re-enter.`;
    } else if (action === "TRIM") {
      flipCondition = `Posterior back above ${TRIM_POSTERIOR.toFixed(2)} (now ${posterior.toFixed(2)})${pHitKill != null && pHitKill > TRIM_KILL_PROB ? ` and P(hit kill) back under ${pct(TRIM_KILL_PROB)} (now ${pct(pHitKill)})` : ""} restores HOLD — one strong confirming signal lifts the posterior to ${oneSignalUp.toFixed(2)}.`;
    } else if (action === "ADD") {
      flipCondition = `Posterior below ${ADD_POSTERIOR.toFixed(2)} (now ${posterior.toFixed(2)}) drops this back to HOLD; below ${TRIM_POSTERIOR.toFixed(2)} it becomes a TRIM.`;
    } else if (action === "HEDGE") {
      flipCondition = `Regime P(stressed) back under ${HEDGE_STRESS_P.toFixed(2)} lifts the hedge; posterior under ${TRIM_POSTERIOR.toFixed(2)} converts it to a TRIM instead.`;
    } else {
      const dTrim = posterior - TRIM_POSTERIOR;
      const dAdd = ADD_POSTERIOR - posterior;
      const killGap = pHitKill != null ? TRIM_KILL_PROB - pHitKill : Number.POSITIVE_INFINITY;
      flipCondition =
        killGap < Math.min(dTrim, dAdd)
          ? `P(hit kill) above ${pct(TRIM_KILL_PROB)} flips this to TRIM — it stands at ${pct(pHitKill!)} now; a volatility spike does it without any price move.`
          : dTrim <= dAdd
            ? `Posterior below ${TRIM_POSTERIOR.toFixed(2)} flips this to TRIM (now ${posterior.toFixed(2)}) — one full-strength bearish signal drops it to ${oneSignalDown.toFixed(2)}.`
            : `Posterior above ${ADD_POSTERIOR.toFixed(2)} flips this to ADD (now ${posterior.toFixed(2)}) — one full-strength bullish signal lifts it to ${oneSignalUp.toFixed(2)}.`;
    }
  }

  // ---- 8) Optional LLM polish of the three reasons (templates are the floor) ----
  let polishedReasons = reasons;
  try {
    const m = modelFor("synthesis");
    const { object } = await generateObject({
      model: m.model,
      schema: z.object({
        reasons: z.array(z.string()).length(3).describe("The same three reasons, each rewritten in one cold institutional sentence. Preserve every number exactly. No Greek letters, no jargon."),
      }),
      prompt: `Rewrite these three reasons for a ${action} directive on ${t} for an investment committee. Keep each under 40 words, keep all figures verbatim, do not add claims:\n${reasons.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    });
    const rs = object.reasons.map((r) => r.trim()).filter((r) => r.length > 0);
    if (rs.length === 3) polishedReasons = rs as [string, string, string];
  } catch {
    // no key or model failure — deterministic templates stand
  }

  // ---- 9) Assemble + persist -----------------------------------------------------
  const snapshot = signalsView(signals);
  const inputs: DirectiveInputs = {
    computedAt: new Date(computedAtMs).toISOString(),
    spot,
    prior: { value: prior, source: priorSource },
    posterior,
    contributions,
    rnd: rndBlock,
    valuation: memo ? { bear: bearPrice, base: basePrice, bull: bullPrice, memoVersion: memo.version } : null,
    garch: garchBlock,
    monteCarlo: mcBlock,
    optionsFlow: snapshot.options,
    short: snapshot.short,
    insider: snapshot.insider,
    news: snapshot.news
      ? { ...snapshot.news, bullish: newsBull, bearish: newsBear, neutral: (news?.items.length ?? 0) - newsBull - newsBear, sentiment: newsSentiment }
      : null,
    regime: regime ? { pStressed: regime.pStressed, volRegime: regime.volRegime, read: regime.read } : null,
    thesis: thesis
      ? {
          version: thesis.version,
          oneLiner: thesis.oneLiner,
          killCriteria: (() => {
            try {
              const v = JSON.parse(thesis.killCriteria ?? "[]");
              return Array.isArray(v) ? (v as string[]) : [];
            } catch {
              return [];
            }
          })(),
        }
      : null,
    ev: evBlock,
    sizing: sizingBlock,
    hedge: hedgeBlock,
    catalyst: nextCatalyst
      ? { title: nextCatalyst.title, date: nextCatalyst.date, daysOut: daysBetween(computedAtMs, nextCatalyst.date) }
      : null,
    position: positionBlock,
    mandate: { maxPositionPct: MANDATE.maxPositionPct, headroomPct, grossExposurePct },
    decisionPath,
  };

  const expectedMovePct = rndBlock?.impliedMovePct ?? null;

  const inserted = await db
    .insert(tables.directives)
    .values({
      ticker: t,
      companyId: company.id,
      action,
      conviction,
      pThesis: posterior,
      expectedMovePct,
      ev90dPct,
      sizeTargetPct,
      reasons: JSON.stringify(polishedReasons),
      biggestRisk,
      flipCondition,
      dataCoverage: JSON.stringify(coverage),
      inputs: JSON.stringify(inputs),
    })
    .returning();
  const row = inserted[0];

  await db.insert(tables.traces).values({
    researcher: "Oracle",
    ticker: t,
    companyId: company.id,
    currentQuestion: `What does the full quantitative picture say to do about ${t} today?`,
    actionTaken: `Issued directive: ${action} at conviction ${conviction}/100 (posterior P(thesis) ${posterior.toFixed(2)})`,
    sourceType: "directive",
    informationSeen: coverage.map((c) => `${c.source}:${c.status}`).join(", "),
    interpretation: polishedReasons.join(" "),
    signalCategory:
      action === "BUY" || action === "ADD" ? "thesis_support" : action === "EXIT" || action === "AVOID" || action === "TRIM" ? "thesis_contradiction" : "noise",
    confidenceChange: Math.round((posterior - 0.5) * 100) / 100,
    nextAction: flipCondition,
    reasoningPattern: decisionPath,
  });

  return {
    id: row.id,
    ticker: t,
    companyId: company.id,
    action,
    conviction,
    pThesis: posterior,
    expectedMovePct,
    ev90dPct,
    sizeTargetPct,
    reasons: polishedReasons,
    biggestRisk,
    flipCondition,
    dataCoverage: coverage,
    inputs,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
  };
}

/** Flatten the signal snapshot into the serializable show-the-work blocks. */
function signalsView(s: SignalSnapshot): {
  options: DirectiveInputs["optionsFlow"];
  short: DirectiveInputs["short"];
  insider: DirectiveInputs["insider"];
  news: Omit<NonNullable<DirectiveInputs["news"]>, "bullish" | "bearish" | "neutral" | "sentiment"> | null;
} {
  return {
    options: s.options
      ? {
          asOf: s.options.asOf,
          iv30: s.options.iv30,
          putCallVolumeRatio: s.options.putCallVolumeRatio,
          putCallOiRatio: s.options.putCallOiRatio,
          skew25Delta: s.options.skew25Delta,
          termSlope: s.options.termSlope,
          impliedEarningsMovePct: s.options.impliedEarningsMovePct,
          unusualVolumeZ: s.options.unusualVolumeZ,
          gex: s.options.gex,
          totalVolume: s.options.totalVolume,
          totalOpenInterest: s.options.totalOpenInterest,
          contractCount: s.options.contractCount,
        }
      : null,
    short: s.short
      ? { asOf: s.short.asOf, ratio: s.short.ratio, trend: s.short.trend, z: s.short.z, daysOfHistory: s.short.daysOfHistory }
      : null,
    insider:
      s.insider != null
        ? {
            asOf: s.insider.asOf,
            buyValue: s.insider.buyValue,
            sellValue: s.insider.sellValue,
            netValue: s.insider.netValue,
            clusterBuy: s.insider.clusterBuy,
            distinctBuyers: s.insider.distinctBuyers,
            transactions: s.insider.transactions.length,
          }
        : null,
    news: s.news
      ? { asOf: s.news.asOf, count: s.news.items.length, burst: s.news.burst, burstCount: s.news.burstCount }
      : null,
  };
}

/** Latest persisted directive for a ticker, parsed; null when none exists. */
export async function latestDirective(ticker: string): Promise<Directive | null> {
  const rows = await db
    .select()
    .from(tables.directives)
    .where(eq(tables.directives.ticker, ticker.toUpperCase()))
    .orderBy(desc(tables.directives.createdAt), desc(tables.directives.id))
    .limit(1);
  return rows[0] ? parseDirectiveRow(rows[0]) : null;
}

export function parseDirectiveRow(row: typeof tables.directives.$inferSelect): Directive | null {
  try {
    return {
      id: row.id,
      ticker: row.ticker,
      companyId: row.companyId,
      action: row.action as DirectiveAction,
      conviction: row.conviction,
      pThesis: row.pThesis,
      expectedMovePct: row.expectedMovePct,
      ev90dPct: row.ev90dPct,
      sizeTargetPct: row.sizeTargetPct,
      reasons: JSON.parse(row.reasons) as [string, string, string],
      biggestRisk: row.biggestRisk,
      flipCondition: row.flipCondition,
      dataCoverage: JSON.parse(row.dataCoverage) as CoverageEntry[],
      inputs: JSON.parse(row.inputs) as DirectiveInputs,
      createdAt: row.createdAt?.toISOString() ?? "",
    };
  } catch {
    return null;
  }
}
