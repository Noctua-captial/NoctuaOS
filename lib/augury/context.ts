// Point-in-time "what was going on" builder for each post. Two layers:
//   • postContext (unique per post): the SUBJECT stock's adjusted return windows,
//     market-regime label, point-in-time VIX, sector ETF move, and a news
//     snapshot. The subject ticker now comes from the LLM-resolved `post_entities`
//     (set by the `resolve` stage), not cashtag-only ticker_mentions.
//   • macroContext (shared, unique per calendar date): historical S&P 500 level +
//     trailing move, VIX, Treasury rates, regime, and a macro/world digest — built
//     once per date and reused by every post from that day.
//
// The `context` stage builds both, ensures price history for EVERY resolved
// ticker entity (so extract + backtest have bars ready), then enqueues `extract`.
// No-lookahead is preserved: every figure is anchored on/before the post's date.
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import type {
  JobHandler,
  MacroRates,
  MarketRegime,
  NewsSnapshotItem,
  PostContextData,
  ReturnWindows,
} from "@/lib/augury/types";
import { enqueue } from "@/lib/augury/jobs";
import {
  addCalendarDaysISO,
  ensureDailyHistory,
  isoDateUTC,
  priceAsOf,
  returnBetween,
  sp500ReturnBetween,
} from "@/lib/augury/market/bars";
import { getBenchmark, getQuote } from "@/lib/market";
import { regimeRead } from "@/lib/mathlab/regime";
import { fetchNews } from "@/lib/signals/news";

const NEWS_SNAPSHOT_LIMIT = 5;
const REGIME_LOOKBACK_DAYS = 420; // ≳150 trading days so the HMM in mathlab/regime can fit
const REGIME_MIN_OBS = 151; // closes needed for regimeRead (MIN_OBS+1)
const SIMPLE_LABEL_MIN_OBS = 21; // closes needed for the trend/vol fallback
const RECENT_DAYS = 3; // within this of today, a live VIX quote ≈ the post-time level (no real look-ahead)
const FRED_TIMEOUT_MS = 8_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Free-text companies.sector → SPDR sector ETF, for the sector-move feature.
const SECTOR_ETFS: [RegExp, string][] = [
  [/tech|software|semiconduct|hardware|information technology/i, "XLK"],
  [/financ|bank|insurance|capital market/i, "XLF"],
  [/health|pharma|biotech|medical|life science/i, "XLV"],
  [/energy|oil|gas|petroleum/i, "XLE"],
  [/consumer discretion|retail|auto|apparel|leisure|restaurant/i, "XLY"],
  [/consumer staple|food|beverage|household/i, "XLP"],
  [/industrial|aerospace|defense|machinery|transport|airline/i, "XLI"],
  [/material|chemical|mining|metal|steel|paper/i, "XLB"],
  [/utilit|electric|water/i, "XLU"],
  [/real estate|reit/i, "XLRE"],
  [/communicat|media|telecom|entertainment|internet/i, "XLC"],
];

function emptyReturns(): ReturnWindows {
  return { "-5d": null, "-1d": null, "+1d": null, "+5d": null, "+30d": null };
}

function pctMove(a: number | null, b: number | null): number | null {
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / a) * 100;
}

function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev) r.push((closes[i] - prev) / prev);
  }
  return r;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Crude trend/vol regime label when the HMM can't fit (too few observations). */
function trendVolLabel(closes: number[]): MarketRegime {
  const window = closes.slice(-21);
  const first = window[0];
  const last = window[window.length - 1];
  const trend = first ? (last - first) / first : 0;
  const annualVol = stdev(dailyReturns(window)) * Math.sqrt(252);
  if (annualVol > 0.25 || trend < -0.03) return "risk_off";
  if (trend > 0.02 && annualVol < 0.18) return "risk_on";
  return "neutral";
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** SPY adjusted closes (oldest→newest) in [fromISO, toISO] from stored bars. */
async function spySeries(fromISO: string, toISO: string): Promise<number[]> {
  const rows = await db
    .select({ adjClose: tables.dailyBars.adjClose, close: tables.dailyBars.close })
    .from(tables.dailyBars)
    .where(
      and(
        eq(tables.dailyBars.ticker, "SPY"),
        gte(tables.dailyBars.date, fromISO),
        lte(tables.dailyBars.date, toISO),
      ),
    )
    .orderBy(asc(tables.dailyBars.date));
  const out: number[] = [];
  for (const r of rows) {
    const v = r.adjClose ?? r.close;
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Market regime as of `dateISO`, point-in-time. Primary: fit the 2-state HMM on
 * trailing SPY returns (no lookahead). Fallbacks: a trend/vol label on SPY, then
 * on getBenchmark's (now-anchored) history. null when nothing is available.
 */
async function computeMarketRegime(dateISO: string): Promise<MarketRegime | null> {
  try {
    await ensureDailyHistory("SPY", addCalendarDaysISO(dateISO, -REGIME_LOOKBACK_DAYS), dateISO);
    const closes = await spySeries(addCalendarDaysISO(dateISO, -REGIME_LOOKBACK_DAYS), dateISO);
    if (closes.length >= REGIME_MIN_OBS) {
      const rr = regimeRead(dailyReturns(closes));
      if (rr) return rr.label === "calm" ? "risk_on" : rr.label === "stressed" ? "risk_off" : "transition";
    }
    if (closes.length >= SIMPLE_LABEL_MIN_OBS) return trendVolLabel(closes);
    const bench = await getBenchmark();
    if (bench && bench.history.length >= SIMPLE_LABEL_MIN_OBS) return trendVolLabel(bench.history);
    return null;
  } catch {
    return null;
  }
}

/**
 * Point-in-time VIX as of `dateISO`. Primary: the historical ^VIX close on/before
 * the date from stored bars (real point-in-time keyless via lib/market's ~2y of
 * closes; deeper with Polygon). Fallback: a live quote, but only for RECENT posts
 * (within RECENT_DAYS), where "now" ≈ post time — older posts return null rather
 * than a look-ahead value.
 */
async function vixAsOf(dateISO: string, todayISO: string): Promise<number | null> {
  try {
    await ensureDailyHistory("^VIX", addCalendarDaysISO(dateISO, -10), dateISO);
    const v = await priceAsOf("^VIX", dateISO);
    if (v != null) return v;
  } catch {
    // fall through to the recent-only live fallback
  }
  if (dateISO >= addCalendarDaysISO(todayISO, -RECENT_DAYS)) {
    try {
      const q = await getQuote("^VIX");
      return q?.price ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Sector ETF move (date-1 → date) for the post's ticker, via its companies.sector. */
async function computeSectorMove(ticker: string, dateISO: string): Promise<number | null> {
  try {
    const rows = await db
      .select({ sector: tables.companies.sector })
      .from(tables.companies)
      .where(eq(tables.companies.ticker, ticker.toUpperCase()))
      .limit(1);
    const sector = rows[0]?.sector;
    if (!sector) return null;
    const etf = SECTOR_ETFS.find(([re]) => re.test(sector))?.[1];
    if (!etf) return null;
    return await returnBetween(etf, addCalendarDaysISO(dateISO, -1), dateISO);
  } catch {
    return null;
  }
}

async function computeNewsSnapshot(ticker: string): Promise<NewsSnapshotItem[]> {
  try {
    // Keyless news is a live feed, so these are the headlines current at
    // context-build time — a point-in-time snapshot isn't available keylessly.
    const news = await fetchNews(ticker);
    return news.items.slice(0, NEWS_SNAPSHOT_LIMIT).map((i) => ({
      title: i.title,
      url: i.url,
      source: i.source,
      publishedAt: i.publishedAt,
    }));
  } catch {
    return [];
  }
}

// --- macro / world context (shared per calendar date) -----------------------

type RatesRow = { date: string; us2y: number | null; us10y: number | null; us30y: number | null; fedFunds: number | null };

// FRED Treasury/policy-rate series, fetched once per process (keyless, like
// lib/market's SP500 path) and reused for every date's point-in-time lookup.
let fredRatesPromise: Promise<RatesRow[]> | null = null;

async function fetchFredRates(): Promise<RatesRow[]> {
  const url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2,DGS10,DGS30,FEDFUNDS";
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FRED_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`FRED rates fetch failed (${res.status})`);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const i2 = col("DGS2");
  const i10 = col("DGS10");
  const i30 = col("DGS30");
  const iff = col("FEDFUNDS");
  const rows: RatesRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const date = (cells[0] ?? "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const num = (i: number): number | null => {
      if (i < 0) return null;
      const c = (cells[i] ?? "").trim();
      if (!c || c === ".") return null;
      const v = Number(c);
      return Number.isFinite(v) ? v : null;
    };
    rows.push({ date, us2y: num(i2), us10y: num(i10), us30y: num(i30), fedFunds: num(iff) });
  }
  return rows; // FRED CSV is chronological (oldest → newest)
}

function ratesSeries(): Promise<RatesRow[]> {
  if (!fredRatesPromise) fredRatesPromise = fetchFredRates().catch(() => []);
  return fredRatesPromise;
}

/** Treasury/policy rates as of `dateISO` (most recent on/before the date). null when unavailable. */
async function ratesAsOf(dateISO: string): Promise<MacroRates | null> {
  const series = await ratesSeries();
  let best: RatesRow | null = null;
  for (const r of series) {
    if (r.date <= dateISO) best = r;
    else break;
  }
  if (!best) return null;
  const out: MacroRates = {};
  if (best.us2y != null) out.us2y = best.us2y;
  if (best.us10y != null) out.us10y = best.us10y;
  if (best.us30y != null) out.us30y = best.us30y;
  if (best.fedFunds != null) out.fedFunds = best.fedFunds;
  return Object.keys(out).length ? out : null;
}

function vixLabel(vix: number): string {
  if (vix < 15) return "calm";
  if (vix < 20) return "normal";
  if (vix < 30) return "elevated";
  return "stressed";
}

function fmtPct(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}

/** Deterministic, no-lookahead macro/world digest synthesized from point-in-time figures. */
function buildWorldDigest(m: {
  sp500: number | null;
  sp500Return5dPct: number | null;
  vix: number | null;
  rates: MacroRates | null;
  regime: MarketRegime | null;
}): string | null {
  const parts: string[] = [];
  if (m.sp500 != null) {
    parts.push(`S&P 500 ${m.sp500.toFixed(0)}${m.sp500Return5dPct != null ? ` (5d ${fmtPct(m.sp500Return5dPct)})` : ""}`);
  }
  if (m.vix != null) parts.push(`VIX ${m.vix.toFixed(1)} (${vixLabel(m.vix)})`);
  if (m.regime) parts.push(`regime ${m.regime}`);
  if (m.rates) {
    const rateBits: string[] = [];
    if (m.rates.us2y != null) rateBits.push(`2y ${m.rates.us2y.toFixed(2)}%`);
    if (m.rates.us10y != null) rateBits.push(`10y ${m.rates.us10y.toFixed(2)}%`);
    if (m.rates.fedFunds != null) rateBits.push(`Fed funds ${m.rates.fedFunds.toFixed(2)}%`);
    if (rateBits.length) parts.push(`UST ${rateBits.join(" / ")}`);
  }
  return parts.length ? parts.join("; ") : null;
}

/**
 * Build the shared macroContext row for a calendar date (idempotent, built once
 * per date and reused). Historical S&P 500 level + trailing 5d move, point-in-time
 * VIX and Treasury rates, regime, and a world digest — all anchored on/before the
 * date (no look-ahead). Degrades to nulls when sources are blocked/keyless.
 */
export async function buildMacroContext(dateISO: string): Promise<void> {
  const existing = await db
    .select({ id: tables.macroContext.id })
    .from(tables.macroContext)
    .where(eq(tables.macroContext.date, dateISO))
    .limit(1);
  if (existing[0]) return; // one row per date; immutable history

  const regime = await computeMarketRegime(dateISO);
  const todayISO = isoDateUTC(new Date());
  const vix = await vixAsOf(dateISO, todayISO);

  let sp500: number | null = null;
  let sp500Return5dPct: number | null = null;
  try {
    await ensureDailyHistory("SPY", addCalendarDaysISO(dateISO, -15), dateISO);
    sp500 = await priceAsOf("SPY", dateISO);
  } catch {
    sp500 = null;
  }
  try {
    sp500Return5dPct = await sp500ReturnBetween(addCalendarDaysISO(dateISO, -7), dateISO);
  } catch {
    sp500Return5dPct = null;
  }

  const rates = await ratesAsOf(dateISO);
  const worldDigest = buildWorldDigest({ sp500, sp500Return5dPct, vix, rates, regime });

  await db
    .insert(tables.macroContext)
    .values({
      date: dateISO,
      sp500,
      sp500Return5dPct,
      vix,
      rates: rates ? JSON.stringify(rates) : null,
      regime,
      worldDigest,
    })
    .onConflictDoNothing({ target: tables.macroContext.date });
}

// --- subject-ticker resolution ----------------------------------------------

/**
 * The post's subject ticker for the return windows. Primary: the highest-
 * confidence ticker entity in post_entities (preferring role "subject"), set by
 * the resolve stage. Fallbacks (so re-runs / legacy posts still work): a ticker
 * already attached to one of the post's calls, then legacy ticker_mentions.
 */
async function resolveSubjectTicker(postId: number): Promise<string | null> {
  const ents = await db
    .select({ value: tables.postEntities.value, role: tables.postEntities.role, confidence: tables.postEntities.confidence })
    .from(tables.postEntities)
    .where(and(eq(tables.postEntities.postId, postId), eq(tables.postEntities.entityType, "ticker")));
  if (ents.length) {
    const best = [...ents].sort(
      (a, b) =>
        (b.role === "subject" ? 1 : 0) - (a.role === "subject" ? 1 : 0) ||
        (b.confidence ?? 0) - (a.confidence ?? 0),
    )[0];
    if (best?.value) return best.value.toUpperCase();
  }

  const callRows = await db
    .select({ ticker: tables.calls.ticker })
    .from(tables.calls)
    .where(eq(tables.calls.postId, postId))
    .limit(1);
  if (callRows[0]?.ticker) return callRows[0].ticker.toUpperCase();

  const mentions = await db
    .select({ ticker: tables.tickerMentions.ticker, mentionType: tables.tickerMentions.mentionType, confidence: tables.tickerMentions.confidence })
    .from(tables.tickerMentions)
    .where(eq(tables.tickerMentions.postId, postId));
  if (mentions.length) {
    const rank = (m: { mentionType: string }) => (m.mentionType === "cashtag" ? 2 : m.mentionType === "name" ? 1 : 0);
    const best = [...mentions].sort((a, b) => rank(b) - rank(a) || (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    if (best?.ticker) return best.ticker.toUpperCase();
  }
  return null;
}

/** All distinct resolved ticker entity symbols on the post (for bar pre-fetching). */
async function tickerEntities(postId: number): Promise<string[]> {
  const rows = await db
    .select({ value: tables.postEntities.value })
    .from(tables.postEntities)
    .where(and(eq(tables.postEntities.postId, postId), eq(tables.postEntities.entityType, "ticker")));
  return [...new Set(rows.map((r) => r.value.toUpperCase()))];
}

// --- core --------------------------------------------------------------------

/**
 * Build and cache the postContext row for a post and the shared macroContext for
 * its date, and ensure price history for every resolved ticker entity. Upserts
 * postContext by postId; tolerates a missing subject ticker (stores market-wide
 * fields only). Throws only when the post itself is absent.
 */
export async function buildPostContext(postId: number): Promise<PostContextData> {
  const postRows = await db
    .select({ postedAt: tables.posts.postedAt, ingestedAt: tables.posts.ingestedAt })
    .from(tables.posts)
    .where(eq(tables.posts.id, postId))
    .limit(1);
  const post = postRows[0];
  if (!post) throw new Error(`buildPostContext: post ${postId} not found`);

  const when = post.postedAt ?? post.ingestedAt ?? new Date();
  const dateISO = isoDateUTC(when);
  const todayISO = isoDateUTC(new Date());

  // Shared, point-in-time market + world context for the date (built once).
  await buildMacroContext(dateISO);

  const ticker = await resolveSubjectTicker(postId);

  // Pre-fetch daily history for EVERY resolved ticker entity so extract's
  // per-entity context reads and the backtest stage have bars ready.
  for (const t of await tickerEntities(postId)) {
    try {
      await ensureDailyHistory(t, addCalendarDaysISO(dateISO, -15), addCalendarDaysISO(dateISO, 45));
    } catch {
      // best-effort; a single bad symbol must not abort context
    }
  }

  // Market-wide fields don't need the post's ticker.
  const marketRegime = await computeMarketRegime(dateISO);
  const vix = await vixAsOf(dateISO, todayISO);

  let returns = emptyReturns();
  let sectorMovePct: number | null = null;
  let newsSnapshot: NewsSnapshotItem[] = [];

  if (ticker) {
    // The subject's history was ensured above; compute the −5d…+30d windows.
    const priceAt = async (offset: number): Promise<number | null> => {
      const target = addCalendarDaysISO(dateISO, offset);
      if (target > todayISO) return null; // forward window not yet elapsed — no lookahead
      return priceAsOf(ticker, target);
    };

    const p0 = await priceAt(0);
    const [pm5, pm1, pp1, pp5, pp30] = await Promise.all([
      priceAt(-5),
      priceAt(-1),
      priceAt(1),
      priceAt(5),
      priceAt(30),
    ]);
    returns = {
      "-5d": pctMove(pm5, p0),
      "-1d": pctMove(pm1, p0),
      "+1d": pctMove(p0, pp1),
      "+5d": pctMove(p0, pp5),
      "+30d": pctMove(p0, pp30),
    };

    sectorMovePct = await computeSectorMove(ticker, dateISO);
    newsSnapshot = await computeNewsSnapshot(ticker);
  }

  const data: PostContextData = { ticker, returns, marketRegime, vix, sectorMovePct, newsSnapshot };

  const values = {
    postId,
    ticker,
    returns: JSON.stringify(returns),
    marketRegime,
    vix,
    sectorMovePct,
    newsSnapshot: JSON.stringify(newsSnapshot),
  };
  await db
    .insert(tables.postContext)
    .values(values)
    .onConflictDoUpdate({
      target: tables.postContext.postId,
      set: {
        ticker: values.ticker,
        returns: values.returns,
        marketRegime: values.marketRegime,
        vix: values.vix,
        sectorMovePct: values.sectorMovePct,
        newsSnapshot: values.newsSnapshot,
      },
    });

  return data;
}

/** Read the cached postContext for a post, parsed back into PostContextData. null when absent. */
export async function getStoredContext(postId: number): Promise<PostContextData | null> {
  const rows = await db
    .select()
    .from(tables.postContext)
    .where(eq(tables.postContext.postId, postId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ticker: row.ticker ?? null,
    returns: parseJson<ReturnWindows>(row.returns, emptyReturns()),
    marketRegime: (row.marketRegime as MarketRegime | null) ?? null,
    vix: row.vix ?? null,
    sectorMovePct: row.sectorMovePct ?? null,
    newsSnapshot: parseJson<NewsSnapshotItem[]>(row.newsSnapshot, []),
  };
}

/** `context` stage: build the post's context (+ shared macro), then hand off to `extract`. */
export const contextHandler: JobHandler = async (payload: { postId: number }) => {
  await buildPostContext(payload.postId);
  await enqueue("extract", { postId: payload.postId });
};
