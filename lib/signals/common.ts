// Shared plumbing for the signal layer: one-row-per-(ticker, kind, day) upsert
// into `signals`, stored-history reads, and small stats helpers. Every signal
// row stores the DATA's own asOf — never our fetch time.
import { and, desc, eq, like } from "drizzle-orm";
import { db, tables } from "@/db";

export const FETCH_TIMEOUT_MS = 10_000;

export type SignalRowInput = {
  ticker: string;
  kind: string;
  value: number | null;
  z: number | null;
  asOf: string; // ISO timestamp or date; the first 10 chars are the dedupe day key
  payload: unknown;
};

/**
 * Insert or update the signal row for (ticker, kind, day-of-asOf). One row per
 * ticker-day per kind keeps daily histories clean for z-scores while letting
 * intraday refreshes update in place.
 */
export async function upsertSignal(input: SignalRowInput): Promise<void> {
  const ticker = input.ticker.toUpperCase();
  const day = input.asOf.slice(0, 10);
  const payload = JSON.stringify(input.payload);

  const existing = await db
    .select({ id: tables.signals.id })
    .from(tables.signals)
    .where(
      and(
        eq(tables.signals.ticker, ticker),
        eq(tables.signals.kind, input.kind),
        like(tables.signals.asOf, `${day}%`),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(tables.signals)
      .set({ value: input.value, z: input.z, asOf: input.asOf, payload })
      .where(eq(tables.signals.id, existing[0].id));
  } else {
    await db.insert(tables.signals).values({
      ticker,
      kind: input.kind,
      value: input.value,
      z: input.z,
      asOf: input.asOf,
      payload,
    });
  }
}

export type SignalRow = typeof tables.signals.$inferSelect;

/** Stored rows for (ticker, kind), newest asOf first. */
export async function signalHistory(
  ticker: string,
  kind: string,
  limit = 90,
): Promise<SignalRow[]> {
  return db
    .select()
    .from(tables.signals)
    .where(and(eq(tables.signals.ticker, ticker.toUpperCase()), eq(tables.signals.kind, kind)))
    .orderBy(desc(tables.signals.asOf))
    .limit(limit);
}

/** Sample mean and standard deviation; std is null below 2 observations. */
export function meanStd(xs: number[]): { mean: number | null; std: number | null } {
  if (xs.length === 0) return { mean: null, std: null };
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  if (xs.length < 2) return { mean, std: null };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
