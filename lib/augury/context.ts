// Point-in-time "what was going on" builder for each post. Computes adjusted
// return windows around the post, a market-regime label, VIX level, sector ETF
// move, and a news snapshot, then caches them in postContext (unique per post).
// The `context` job stage builds context, then enqueues the `extract` stage —
// the cross-worker contract is the {postId} payload + the postContext row.
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import type {
  JobHandler,
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
} from "@/lib/augury/market/bars";
import { getBenchmark, getQuote } from "@/lib/market";
import { regimeRead } from "@/lib/mathlab/regime";
import { fetchNews } from "@/lib/signals/news";

const NEWS_SNAPSHOT_LIMIT = 5;
const REGIME_LOOKBACK_DAYS = 420; // ≳150 trading days so the HMM in mathlab/regime can fit
const REGIME_MIN_OBS = 151; // closes needed for regimeRead (MIN_OBS+1)
const SIMPLE_LABEL_MIN_OBS = 21; // closes needed for the trend/vol fallback

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

function pickTicker(
  mentions: { ticker: string; mentionType: string; confidence: number | null }[],
): string | null {
  if (mentions.length === 0) return null;
  const rank = (m: { mentionType: string }) =>
    m.mentionType === "cashtag" ? 2 : m.mentionType === "name" ? 1 : 0;
  const best = [...mentions].sort(
    (a, b) => rank(b) - rank(a) || (b.confidence ?? 0) - (a.confidence ?? 0),
  )[0];
  return best.ticker ? best.ticker.toUpperCase() : null;
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
 * Current VIX level (best-effort). lib/market is keyless and live-only, so for
 * non-recent posts this is an approximation of the level at post time, not the
 * historical reading. null when unavailable.
 */
async function computeVix(): Promise<number | null> {
  try {
    const q = await getQuote("^VIX");
    return q?.price ?? null;
  } catch {
    return null;
  }
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

/**
 * Build and cache the postContext row for a post. Resolves the subject ticker
 * (ticker mentions, else any extracted call), computes the return windows /
 * regime / VIX / sector / news, and upserts by postId. Tolerates a missing
 * ticker (stores market-wide fields only). Throws only when the post is absent.
 */
export async function buildPostContext(postId: number): Promise<PostContextData> {
  const postRows = await db
    .select({ postedAt: tables.posts.postedAt, ingestedAt: tables.posts.ingestedAt })
    .from(tables.posts)
    .where(eq(tables.posts.id, postId))
    .limit(1);
  const post = postRows[0];
  if (!post) throw new Error(`buildPostContext: post ${postId} not found`);

  const mentions = await db
    .select({
      ticker: tables.tickerMentions.ticker,
      mentionType: tables.tickerMentions.mentionType,
      confidence: tables.tickerMentions.confidence,
    })
    .from(tables.tickerMentions)
    .where(eq(tables.tickerMentions.postId, postId));
  let ticker = pickTicker(mentions);
  if (!ticker) {
    // Re-run path: a prior extract may have attached a ticker to the call.
    const callRows = await db
      .select({ ticker: tables.calls.ticker })
      .from(tables.calls)
      .where(eq(tables.calls.postId, postId))
      .limit(1);
    ticker = callRows[0]?.ticker ? callRows[0].ticker.toUpperCase() : null;
  }

  const when = post.postedAt ?? post.ingestedAt ?? new Date();
  const dateISO = isoDateUTC(when);
  const todayISO = isoDateUTC(new Date());

  // Market-wide fields don't need the post's ticker.
  const marketRegime = await computeMarketRegime(dateISO);
  const vix = await computeVix();

  let returns = emptyReturns();
  let sectorMovePct: number | null = null;
  let newsSnapshot: NewsSnapshotItem[] = [];

  if (ticker) {
    // One ensure spanning the −5d…+30d windows (with weekend/holiday buffer).
    await ensureDailyHistory(
      ticker,
      addCalendarDaysISO(dateISO, -15),
      addCalendarDaysISO(dateISO, 45),
    );

    const priceAt = async (offset: number): Promise<number | null> => {
      const target = addCalendarDaysISO(dateISO, offset);
      if (target > todayISO) return null; // forward window not yet elapsed — no lookahead
      return priceAsOf(ticker as string, target);
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

/** `context` stage: build the post's context, then hand off to `extract`. */
export const contextHandler: JobHandler = async (payload: { postId: number }) => {
  await buildPostContext(payload.postId);
  await enqueue("extract", { postId: payload.postId });
};
