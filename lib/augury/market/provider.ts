// Market-history provider seam for Augury. A `MarketProvider` yields adjusted
// daily and (sparse) intraday bars; bars.ts caches them in dailyBars/intradayBars
// for point-in-time, no-lookahead lookups. Two implementations:
//   • PolygonProvider — paid, deep adjusted history (POLYGON_API_KEY).
//   • KeylessProvider — graceful fallback over the existing keyless lib/market
//     (getQuote/getBenchmark). ~2y of daily closes only, no real OHLC/volume,
//     no intraday, and holiday-naive dating. Never crashes on import or on a
//     missing key — returns [] quietly (same discipline as lib/signals/news).
import type { IntradayBar, MarketBar } from "@/lib/augury/types";
import { getBenchmark, getQuote } from "@/lib/market";

const FETCH_TIMEOUT_MS = 15_000;
const POLYGON_BASE = "https://api.polygon.io";

/** Yields raw bars for a ticker over [fromISO, toISO]; storage/caching is bars.ts's job. */
export interface MarketProvider {
  readonly name: string;
  /** Adjusted daily bars over an inclusive date range (ISO date or timestamp accepted). */
  dailyBars(ticker: string, fromISO: string, toISO: string): Promise<MarketBar[]>;
  /** 5-minute intraday bars over an inclusive timestamp range. May be [] (e.g. keyless). */
  intradayBars(ticker: string, fromISO: string, toISO: string): Promise<IntradayBar[]>;
}

// --- pure date helpers (shared with bars.ts) --------------------------------

/** UTC calendar date (YYYY-MM-DD) of a Date. */
export function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const isWeekend = (day: number): boolean => day === 0 || day === 6;

/**
 * Date a closes series (oldest→newest) by walking business days backward from
 * `anchor`. Holiday-naive (skips weekends only), so dates drift around market
 * holidays — acceptable for the keyless fallback, where lib/market returns an
 * undated ~2y closes array. Returns {date, close} oldest→newest.
 */
export function assignBusinessDates(
  closes: number[],
  anchor: Date,
): { date: string; close: number }[] {
  const out: { date: string; close: number }[] = [];
  const cursor = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()),
  );
  while (isWeekend(cursor.getUTCDay())) cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = closes.length - 1; i >= 0; i--) {
    out.push({ date: isoDateUTC(cursor), close: closes[i] });
    do {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } while (isWeekend(cursor.getUTCDay()));
  }
  out.reverse();
  return out;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function epochMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// --- Polygon adapter --------------------------------------------------------

interface PolygonAgg {
  t: number; // window start, epoch ms
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}
interface PolygonAggResponse {
  results?: PolygonAgg[];
  status?: string;
  resultsCount?: number;
}

class PolygonProvider implements MarketProvider {
  readonly name = "polygon";
  constructor(private readonly apiKey: string) {}

  private async aggs(path: string): Promise<PolygonAgg[]> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${POLYGON_BASE}${path}${sep}apiKey=${encodeURIComponent(this.apiKey)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return []; // rate limit / bad symbol / outage — degrade quietly
      const data = (await res.json()) as PolygonAggResponse;
      return data.results ?? [];
    } catch {
      return [];
    }
  }

  async dailyBars(ticker: string, fromISO: string, toISO: string): Promise<MarketBar[]> {
    const t = ticker.toUpperCase();
    const from = fromISO.slice(0, 10);
    const to = toISO.slice(0, 10);
    const aggs = await this.aggs(
      `/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000`,
    );
    return aggs.map((a) => {
      // adjusted=true → o/h/l/c are split/dividend-adjusted; c is the adjusted
      // close. As-of/return helpers read adjClose only; we mirror the adjusted
      // print into `close` rather than spend a second (adjusted=false) call just
      // to carry the raw print, since Polygon free tiers are rate-limited.
      const close = num(a.c);
      const bar: MarketBar = {
        ticker: t,
        date: isoDateUTC(new Date(a.t)),
        open: num(a.o),
        high: num(a.h),
        low: num(a.l),
        close,
        adjClose: close,
        volume: num(a.v),
      };
      return bar;
    });
  }

  async intradayBars(ticker: string, fromISO: string, toISO: string): Promise<IntradayBar[]> {
    const t = ticker.toUpperCase();
    // Intraday range params take epoch-ms for precise windows around a timestamp.
    const from = epochMs(fromISO);
    const to = epochMs(toISO);
    if (from == null || to == null) return [];
    const aggs = await this.aggs(
      `/v2/aggs/ticker/${encodeURIComponent(t)}/range/5/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`,
    );
    return aggs.map((a) => {
      const bar: IntradayBar = {
        ticker: t,
        ts: new Date(a.t).toISOString(),
        open: num(a.o),
        high: num(a.h),
        low: num(a.l),
        close: num(a.c),
        volume: num(a.v),
      };
      return bar;
    });
  }
}

// --- Keyless fallback over lib/market ---------------------------------------

const BENCH_TICKERS = new Set(["SPY", "SP500", "^GSPC", "^SPX"]);

class KeylessProvider implements MarketProvider {
  readonly name = "keyless";

  async dailyBars(ticker: string, fromISO: string, toISO: string): Promise<MarketBar[]> {
    const t = ticker.toUpperCase();
    const quote = BENCH_TICKERS.has(t) ? await getBenchmark() : await getQuote(t);
    if (!quote || quote.history.length === 0) return [];
    const from = fromISO.slice(0, 10);
    const to = toISO.slice(0, 10);
    const dated = assignBusinessDates(quote.history, quote.fetchedAt ?? new Date());
    // lib/market carries only ~2y of closes and no OHLC/volume: fill o/h/l from
    // the close, treat close as adjClose, leave volume null. Dating is naive.
    return dated
      .filter((d) => d.date >= from && d.date <= to)
      .map((d) => ({
        ticker: t,
        date: d.date,
        open: d.close,
        high: d.close,
        low: d.close,
        close: d.close,
        adjClose: d.close,
        volume: null,
      }));
  }

  async intradayBars(): Promise<IntradayBar[]> {
    // No keyless intraday source; callers degrade to daily granularity.
    return [];
  }
}

// --- selection --------------------------------------------------------------

/** The active provider: Polygon when POLYGON_API_KEY is set, else the keyless fallback. */
export function getProvider(): MarketProvider {
  const key = process.env.POLYGON_API_KEY;
  return key ? new PolygonProvider(key) : new KeylessProvider();
}

export interface ProviderStatus {
  provider: "polygon" | "keyless";
  keyed: boolean;
  source: string;
  note?: string;
}

/** Describe the active provider for status panels / smoke checks. Never throws. */
export function providerStatus(): ProviderStatus {
  const keyed = Boolean(process.env.POLYGON_API_KEY);
  return keyed
    ? {
        provider: "polygon",
        keyed: true,
        source: "Polygon.io aggregates (adjusted 1-day + 5-minute)",
      }
    : {
        provider: "keyless",
        keyed: false,
        source: "lib/market getQuote/getBenchmark",
        note: "≈2y daily closes only; OHLC mirrors close; no intraday; holiday-naive dating",
      };
}
