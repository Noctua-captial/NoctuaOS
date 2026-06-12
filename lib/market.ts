// Live market quotes — keyless. Yahoo chart endpoint primary, then CBOE's
// delayed-quotes options endpoint (price only, no history series), then Stooq
// (CSV download, then the historical-quotes HTML table behind Stooq's
// SHA-256 proof-of-work challenge, which we solve inline).
// Cached in the `quotes` table with a ~10-minute TTL; stale cache served on fetch failure.
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";

const TTL_MS = 10 * 60 * 1000;
const HISTORY_DAYS = 504; // ~2 years of trading sessions
const AVG_VOLUME_DAYS = 60;
const FETCH_TIMEOUT_MS = 8_000; // Stooq tarpits rate-limited IPs; never hang a page on it

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type Quote = {
  ticker: string;
  price: number;
  prevClose: number | null;
  dayChangePct: number | null;
  currency: string | null;
  marketCap: number | null; // raw $, when the source provides it
  history: number[]; // recent daily closes, oldest → newest (~2y)
  avgVolume: number | null; // avg daily share volume over recent sessions
  fetchedAt: Date;
  stale: boolean; // true when served from an expired cache after a fetch failure
  note?: string; // provenance caveat, e.g. CBOE price merged with cached history
};

function parseHistory(s: string | null): number[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function rowToQuote(row: typeof tables.quotes.$inferSelect, stale: boolean): Quote {
  return {
    ticker: row.ticker,
    price: row.price,
    prevClose: row.prevClose,
    dayChangePct: row.dayChangePct,
    currency: row.currency,
    marketCap: row.marketCap,
    history: parseHistory(row.history),
    avgVolume: row.avgVolume,
    fetchedAt: row.fetchedAt ?? new Date(0),
    stale,
  };
}

type Fetched = Omit<Quote, "fetchedAt" | "stale">;

function avgRecentVolume(volumes: number[]): number | null {
  const recent = volumes.filter((v) => Number.isFinite(v) && v > 0).slice(-AVG_VOLUME_DAYS);
  if (recent.length === 0) return null;
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

async function fetchYahoo(ticker: string): Promise<Fetched> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=2y&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Yahoo chart fetch failed (${res.status}) for ${ticker}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  const rawCloses: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
  const rawVolumes: unknown[] = result?.indicators?.quote?.[0]?.volume ?? [];
  const history = rawCloses
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c))
    .slice(-HISTORY_DAYS);
  const avgVolume = avgRecentVolume(
    rawVolumes.filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
  );

  const price: number | undefined =
    typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : history[history.length - 1];
  if (typeof price !== "number") throw new Error(`Yahoo returned no price for ${ticker}`);

  let prevClose: number | null = null;
  if (typeof meta?.regularMarketPreviousClose === "number") prevClose = meta.regularMarketPreviousClose;
  else if (typeof meta?.previousClose === "number") prevClose = meta.previousClose;
  else if (history.length >= 2) prevClose = history[history.length - 2];

  return {
    ticker: ticker.toUpperCase(),
    price,
    prevClose,
    dayChangePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    currency: typeof meta?.currency === "string" ? meta.currency : null,
    marketCap: typeof meta?.marketCap === "number" ? meta.marketCap : null,
    history,
    avgVolume,
  };
}

// --- CBOE fallback ----------------------------------------------------------
// The delayed-quotes options endpoint carries the underlying's live fields
// keylessly (current_price, prev_day_close, volume). It has no history
// series — getQuote merges the cached history array when one exists.

/** Underlying quote from CBOE's delayed options endpoint. history is always []. */
export async function fetchCboe(ticker: string): Promise<Fetched> {
  const t = ticker.toUpperCase();
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(t)}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CBOE quote fetch failed (${res.status}) for ${t}`);
  const data = (await res.json())?.data;

  const candidates = [data?.current_price, data?.close];
  const price = candidates.find((p): p is number => typeof p === "number" && p > 0);
  if (price == null) throw new Error(`CBOE returned no price for ${t}`);
  const prevClose =
    typeof data?.prev_day_close === "number" && data.prev_day_close > 0 ? data.prev_day_close : null;

  return {
    ticker: t,
    price,
    prevClose,
    dayChangePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    currency: "USD",
    marketCap: null,
    history: [],
    avgVolume: null,
  };
}

// --- Stooq fallback ---------------------------------------------------------
// Stooq fronts requests with a SHA-256 proof-of-work challenge ("This site
// requires JavaScript to verify your browser"). We solve it server-side and
// keep the resulting session cookies for subsequent requests.

// After a failed refresh, don't re-attempt the sources for a cooldown window —
// serve the stale cache instantly instead of paying the timeout on every render.
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const lastFailureAt = new Map<string, number>();

const stooqJar = new Map<string, string>();

function stooqCookieHeader(): string {
  return [...stooqJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function stooqSaveCookies(res: Response) {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const pair = sc.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) stooqJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function stooqGet(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Cookie: stooqCookieHeader() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  stooqSaveCookies(res);
  return res;
}

/** Solve Stooq's PoW challenge if `html` contains one. Returns true when solved. */
async function stooqSolveChallenge(html: string): Promise<boolean> {
  const m = html.match(/const c="([^"]+)",d=(\d+)/);
  if (!m) return false;
  const c = m[1];
  const target = "0".repeat(Number(m[2]));
  let n = 0;
  while (!createHash("sha256").update(c + n).digest("hex").startsWith(target)) n++;
  const res = await fetch("https://stooq.com/__verify", {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: stooqCookieHeader(),
    },
    body: `c=${encodeURIComponent(c)}&n=${n}`,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  stooqSaveCookies(res);
  return res.ok;
}

async function stooqFetchHtml(url: string): Promise<string> {
  let res = await stooqGet(url);
  let html = await res.text();
  if (html.includes("__verify") && (await stooqSolveChallenge(html))) {
    res = await stooqGet(url);
    html = await res.text();
  }
  if (!res.ok) throw new Error(`Stooq fetch failed (${res.status}) for ${url}`);
  return html;
}

type StooqSeries = { closes: number[]; volumes: number[] };

function stooqHistoryFromCsv(csv: string): StooqSeries {
  // Date,Open,High,Low,Close,Volume — oldest first
  const closes: number[] = [];
  const volumes: number[] = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const cells = line.split(",");
    const close = Number(cells[4]);
    if (!Number.isFinite(close)) continue;
    closes.push(close);
    volumes.push(Number(cells[5]));
  }
  return { closes: closes.slice(-HISTORY_DAYS), volumes: volumes.slice(-HISTORY_DAYS) };
}

function stooqHistoryFromTable(html: string): StooqSeries {
  // Historical-quotes table (id=fth1): No. | Date | Open | High | Low | Close | Change ×2 | Volume — newest first
  const table = html.match(/<table[^>]*id=fth1[^>]*>([\s\S]*?)<\/table>/)?.[1];
  const body = table?.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1];
  if (!body) return { closes: [], volumes: [] };
  const closes: number[] = [];
  const volumes: number[] = [];
  for (const tr of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1].replace(/<[^>]+>/g, "").trim(),
    );
    if (cells.length < 6) continue;
    const close = Number(cells[5].replace(/,/g, ""));
    if (!Number.isFinite(close)) continue;
    closes.push(close);
    volumes.push(Number((cells[8] ?? "").replace(/,/g, "")));
  }
  closes.reverse(); // oldest → newest
  volumes.reverse();
  return { closes, volumes };
}

async function fetchStooq(ticker: string): Promise<Fetched> {
  const symbol = `${ticker.toLowerCase()}.us`;
  let series: StooqSeries = { closes: [], volumes: [] };

  // Preferred: the plain CSV download endpoint (full daily history, sliced to ~2y).
  try {
    const csv = await stooqFetchHtml(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`);
    if (!csv.includes("<") && !/access denied/i.test(csv)) series = stooqHistoryFromCsv(csv);
  } catch {
    // fall through to the HTML table
  }

  // Fallback: walk the historical-quotes pages (newest first), sequentially so a
  // tarpit or missing page stops the walk instead of burning requests.
  if (series.closes.length === 0) {
    const pages: StooqSeries[] = [];
    for (let l = 1; l <= 4; l++) {
      try {
        const html = await stooqFetchHtml(
          `https://stooq.com/q/d/?s=${encodeURIComponent(symbol)}${l > 1 ? `&l=${l}` : ""}`,
        );
        const page = stooqHistoryFromTable(html);
        if (page.closes.length === 0) break;
        pages.push(page);
      } catch {
        break;
      }
    }
    // pages are newest-first; each page's closes are oldest→newest
    pages.reverse();
    series = {
      closes: pages.flatMap((p) => p.closes).slice(-HISTORY_DAYS),
      volumes: pages.flatMap((p) => p.volumes).slice(-HISTORY_DAYS),
    };
  }

  const history = series.closes;
  if (history.length === 0) throw new Error(`Stooq returned no data for ${ticker}`);
  const price = history[history.length - 1];
  const prevClose = history.length >= 2 ? history[history.length - 2] : null;
  return {
    ticker: ticker.toUpperCase(),
    price,
    prevClose,
    dayChangePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    currency: "USD",
    marketCap: null,
    history,
    avgVolume: avgRecentVolume(series.volumes),
  };
}

/** Live quote with ~2y of daily closes. Cached ~10 min; stale cache on failure; null when nothing available. */
export async function getQuote(ticker: string): Promise<Quote | null> {
  const t = ticker.toUpperCase();
  const cached = await db.query.quotes.findFirst({ where: eq(tables.quotes.ticker, t) });

  if (cached?.fetchedAt && Date.now() - cached.fetchedAt.getTime() < TTL_MS) {
    return rowToQuote(cached, false);
  }

  const attempt = async (): Promise<Fetched | null> => {
    try {
      return await fetchYahoo(t);
    } catch {
      try {
        return await fetchCboe(t);
      } catch {
        try {
          return await fetchStooq(t);
        } catch {
          return null;
        }
      }
    }
  };

  // Inside the failure cooldown, don't even attempt — serve stale immediately.
  const lastFail = lastFailureAt.get(t);
  if (cached && lastFail && Date.now() - lastFail < FAILURE_COOLDOWN_MS) {
    return rowToQuote(cached, true);
  }

  // With a stale cache available, cap the refresh attempt so page renders
  // never wait out a tarpitted source; the stale row is served instead.
  let fetched: Fetched | null;
  if (cached) {
    fetched = await Promise.race([
      attempt(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 9_000)),
    ]);
  } else {
    fetched = await attempt();
  }

  if (!fetched) lastFailureAt.set(t, Date.now());
  else lastFailureAt.delete(t);

  if (!fetched) {
    return cached ? rowToQuote(cached, true) : null;
  }

  // CBOE carries no history series. When the cache has one, keep it alongside
  // the fresh price/prevClose/dayChangePct (and the avgVolume derived from that
  // same cached series), with a provenance note. With no cached history the
  // quote goes out with history = [] and callers handle the short series.
  if (fetched.history.length === 0 && cached) {
    const cachedHistory = parseHistory(cached.history);
    if (cachedHistory.length > 0) {
      fetched = {
        ...fetched,
        history: cachedHistory,
        avgVolume: fetched.avgVolume ?? cached.avgVolume,
        note: "price refreshed via CBOE; history carried from the cached series",
      };
    }
  }

  const now = new Date();
  const values = {
    ticker: t,
    price: fetched.price,
    prevClose: fetched.prevClose,
    dayChangePct: fetched.dayChangePct,
    currency: fetched.currency,
    marketCap: fetched.marketCap,
    history: JSON.stringify(fetched.history),
    avgVolume: fetched.avgVolume,
    fetchedAt: now,
  };
  await db
    .insert(tables.quotes)
    .values(values)
    .onConflictDoUpdate({ target: tables.quotes.ticker, set: values });

  return { ...fetched, fetchedAt: now, stale: false };
}

// --- Benchmark ---------------------------------------------------------------
// Primary: SPY like any ticker. Fallback: FRED's SP500 daily index series —
// keyless, stable, ~10y of history — cached under ticker "SP500" with a long TTL.

const FRED_TTL_MS = 12 * 60 * 60 * 1000;

async function fetchFredSp500(): Promise<Fetched> {
  const res = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500", {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FRED SP500 fetch failed (${res.status})`);
  const csv = await res.text();
  const closes: number[] = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const cell = line.split(",")[1]?.trim();
    if (!cell || cell === ".") continue; // holidays/missing — skipped ("" would parse as 0)
    const v = Number(cell);
    if (Number.isFinite(v) && v > 0) closes.push(v);
  }
  if (closes.length < 2) throw new Error("FRED SP500 returned no usable data");
  const history = closes.slice(-HISTORY_DAYS);
  const price = history[history.length - 1];
  const prevClose = history[history.length - 2];
  return {
    ticker: "SP500",
    price,
    prevClose,
    dayChangePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    currency: "USD",
    marketCap: null,
    history,
    avgVolume: null,
  };
}

/** Benchmark series (~2y daily closes): FRED's SP500 index (reliable, keyless), else SPY. */
export async function getBenchmark(): Promise<Quote | null> {
  // FRED first — SPY via Yahoo/Stooq is blocked/tarpitted on this machine and
  // attempting it can stall page renders for minutes.
  const cached = await db.query.quotes.findFirst({ where: eq(tables.quotes.ticker, "SP500") });
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt.getTime() < FRED_TTL_MS) {
    return rowToQuote(cached, false);
  }
  try {
    const fetched = await fetchFredSp500();
    const now = new Date();
    const values = {
      ticker: "SP500",
      price: fetched.price,
      prevClose: fetched.prevClose,
      dayChangePct: fetched.dayChangePct,
      currency: fetched.currency,
      marketCap: fetched.marketCap,
      history: JSON.stringify(fetched.history),
      avgVolume: fetched.avgVolume,
      fetchedAt: now,
    };
    await db
      .insert(tables.quotes)
      .values(values)
      .onConflictDoUpdate({ target: tables.quotes.ticker, set: values });
    return { ...fetched, fetchedAt: now, stale: false };
  } catch {
    if (cached) return rowToQuote(cached, true);
    return getQuote("SPY").catch(() => null);
  }
}

/** Batched quotes; failed tickers are simply absent from the result map. */
export async function getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()))];
  const results = await Promise.all(
    unique.map(async (t) => [t, await getQuote(t).catch(() => null)] as const),
  );
  const map = new Map<string, Quote>();
  for (const [t, q] of results) if (q) map.set(t, q);
  return map;
}
