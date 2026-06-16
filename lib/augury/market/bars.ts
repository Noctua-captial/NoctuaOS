// Bar storage + no-lookahead price helpers for Augury. Fetches via the active
// MarketProvider and upserts into dailyBars/intradayBars (idempotent on the
// composite unique keys), then answers point-in-time questions strictly from
// stored bars: priceAsOf reads the most recent bar on/before a date, never after.
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import type { IntradayBar, MarketBar } from "@/lib/augury/types";
import { getBenchmark } from "@/lib/market";
import { assignBusinessDates, getProvider, isoDateUTC } from "@/lib/augury/market/provider";

export { isoDateUTC };

const UPSERT_CHUNK = 200; // rows per insert; keeps bound-parameter counts comfortable
const COVERAGE_FRESH_DAYS = 7; // newest cached bar must be within this of the range end

/** Add (or subtract) calendar days to an ISO date, returning a YYYY-MM-DD string. */
export function addCalendarDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDateUTC(d);
}

function calendarDaysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00.000Z`);
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// In-process memo of ranges already ensured this run, so repeated reads inside
// one drain don't re-hit the provider. The DB coverage check handles restarts.
const ensuredDailyRanges = new Set<string>();

// --- daily history ----------------------------------------------------------

async function dailyCovered(t: string, fromISO: string, toISO: string): Promise<boolean> {
  const todayISO = isoDateUTC(new Date());
  const effectiveTo = toISO > todayISO ? todayISO : toISO; // no bars exist in the future
  if (effectiveTo < fromISO) return true; // whole window is future — nothing to fetch

  const rows = await db
    .select({ date: tables.dailyBars.date })
    .from(tables.dailyBars)
    .where(
      and(
        eq(tables.dailyBars.ticker, t),
        gte(tables.dailyBars.date, fromISO),
        lte(tables.dailyBars.date, effectiveTo),
      ),
    );
  if (rows.length === 0) return false;

  // ~5/7 of calendar days are trading days; require at least half of those to be
  // present (tolerates holidays + the keyless ~2y truncation) AND the newest
  // cached bar to be close to the range end (so the recent tail isn't missing).
  const expected = Math.max(2, Math.floor(((calendarDaysBetween(fromISO, effectiveTo) * 5) / 7) * 0.5));
  if (rows.length < expected) return false;
  let newest = rows[0].date;
  for (const r of rows) if (r.date > newest) newest = r.date;
  return calendarDaysBetween(newest, effectiveTo) <= COVERAGE_FRESH_DAYS;
}

async function upsertDailyBars(bars: MarketBar[]): Promise<void> {
  if (bars.length === 0) return;
  for (const part of chunk(bars, UPSERT_CHUNK)) {
    await db
      .insert(tables.dailyBars)
      .values(
        part.map((b) => ({
          ticker: b.ticker.toUpperCase(),
          date: b.date.slice(0, 10),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          adjClose: b.adjClose,
          volume: b.volume,
        })),
      )
      .onConflictDoNothing({ target: [tables.dailyBars.ticker, tables.dailyBars.date] });
  }
}

/**
 * Make sure dailyBars holds [fromISO, toISO] for `ticker`, fetching+caching via
 * the active provider when the range isn't already covered. Idempotent and safe
 * to call before any read. Degrades quietly when the provider returns nothing.
 */
export async function ensureDailyHistory(
  ticker: string,
  fromISO: string,
  toISO: string,
): Promise<void> {
  const t = ticker.toUpperCase();
  const from = fromISO.slice(0, 10);
  const to = toISO.slice(0, 10);
  if (from > to) return;

  const key = `${t}|${from}|${to}`;
  if (ensuredDailyRanges.has(key)) return;
  if (await dailyCovered(t, from, to)) {
    ensuredDailyRanges.add(key);
    return;
  }

  const bars = await getProvider().dailyBars(t, from, to);
  await upsertDailyBars(bars);
  ensuredDailyRanges.add(key);
}

// --- intraday (sparse, around timestamps) -----------------------------------

async function upsertIntradayBars(bars: IntradayBar[]): Promise<void> {
  if (bars.length === 0) return;
  for (const part of chunk(bars, UPSERT_CHUNK)) {
    await db
      .insert(tables.intradayBars)
      .values(
        part.map((b) => ({
          ticker: b.ticker.toUpperCase(),
          ts: b.ts,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        })),
      )
      .onConflictDoNothing({ target: [tables.intradayBars.ticker, tables.intradayBars.ts] });
  }
}

/**
 * Cache 5-minute bars in a ±`windowMin` window around `tsISO` (the post time).
 * No-op when bars already exist in the window or when the provider has no
 * intraday source (keyless). Best-effort; never throws.
 */
export async function ensureIntradayAround(
  ticker: string,
  tsISO: string,
  windowMin = 120,
): Promise<void> {
  const t = ticker.toUpperCase();
  const center = Date.parse(tsISO);
  if (!Number.isFinite(center)) return;
  const fromISO = new Date(center - windowMin * 60_000).toISOString();
  const toISO = new Date(center + windowMin * 60_000).toISOString();

  const existing = await db
    .select({ ts: tables.intradayBars.ts })
    .from(tables.intradayBars)
    .where(
      and(
        eq(tables.intradayBars.ticker, t),
        gte(tables.intradayBars.ts, fromISO),
        lte(tables.intradayBars.ts, toISO),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  const bars = await getProvider().intradayBars(t, fromISO, toISO);
  await upsertIntradayBars(bars);
}

// --- no-lookahead reads -----------------------------------------------------

/**
 * Adjusted close of the most recent daily bar on/before `dateISO` (no lookahead).
 * Reads stored bars only — callers must ensureDailyHistory first. null when no
 * bar exists on/before the date.
 */
export async function priceAsOf(ticker: string, dateISO: string): Promise<number | null> {
  const t = ticker.toUpperCase();
  const d = dateISO.slice(0, 10);
  const rows = await db
    .select({ adjClose: tables.dailyBars.adjClose, close: tables.dailyBars.close })
    .from(tables.dailyBars)
    .where(and(eq(tables.dailyBars.ticker, t), lte(tables.dailyBars.date, d)))
    .orderBy(desc(tables.dailyBars.date))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return r.adjClose ?? r.close ?? null;
}

async function readReturn(t: string, fromISO: string, toISO: string): Promise<number | null> {
  const a = await priceAsOf(t, fromISO);
  const b = await priceAsOf(t, toISO);
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / a) * 100;
}

/**
 * Adjusted % return between two dates (ensures history first). Uses as-of prices,
 * so a non-trading endpoint falls back to the most recent prior bar. null when a
 * price is missing.
 */
export async function returnBetween(
  ticker: string,
  fromISO: string,
  toISO: string,
): Promise<number | null> {
  const t = ticker.toUpperCase();
  await ensureDailyHistory(t, addCalendarDaysISO(fromISO, -7), toISO); // -7d so the `from` as-of has a bar
  return readReturn(t, fromISO, toISO);
}

function closeAsOf(dated: { date: string; close: number }[], dateISO: string): number | null {
  const d = dateISO.slice(0, 10);
  let best: number | null = null;
  for (const row of dated) {
    if (row.date <= d) best = row.close; // dated is oldest→newest; keep the last ≤ d
    else break;
  }
  return best;
}

/**
 * Benchmark (S&P 500) % return between two dates. Primary path: SPY bars via the
 * provider (real history with Polygon; getBenchmark-backed when keyless). Fallback:
 * FRED's SP500 closes from lib/market, dated holiday-naively. null when neither works.
 */
export async function sp500ReturnBetween(fromISO: string, toISO: string): Promise<number | null> {
  await ensureDailyHistory("SPY", addCalendarDaysISO(fromISO, -7), toISO);
  const viaBars = await readReturn("SPY", fromISO, toISO);
  if (viaBars != null) return viaBars;

  try {
    const bench = await getBenchmark();
    if (!bench || bench.history.length < 2) return null;
    const dated = assignBusinessDates(bench.history, bench.fetchedAt ?? new Date());
    const a = closeAsOf(dated, fromISO);
    const b = closeAsOf(dated, toISO);
    if (a == null || b == null || a === 0) return null;
    return ((b - a) / a) * 100;
  } catch {
    return null;
  }
}
