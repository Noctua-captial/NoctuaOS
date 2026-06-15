// Shared plumbing for fetching untrusted external data (SEC EDGAR, Yahoo, CBOE,
// FINRA, Stooq, FRED, Google News). Every source here is unauthenticated and
// rate-sensitive, so each request gets: a hard timeout (never hang a page on a
// tarpitting host), retry-with-backoff on transient failures, and optional
// per-host spacing so we stay inside fair-use limits — even when callers fan
// out many requests at once (e.g. getQuotes over a whole book).

export type FetchExternalOptions = {
  headers?: Record<string, string>;
  method?: string;
  body?: BodyInit | null;
  timeoutMs?: number;
  retries?: number;
  /** Requests sharing this key are spaced by `minIntervalMs`. Defaults to the URL host. */
  rateKey?: string;
  minIntervalMs?: number;
};

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;
const MAX_BACKOFF_MS = 15_000;

// SEC asks for ≤10 requests/sec across its hosts; one shared bucket keeps EDGAR
// filings, XBRL fundamentals, and Form 4 fetches collectively polite.
export const SEC_RATE_KEY = "sec.gov";
export const SEC_MIN_INTERVAL_MS = Number(process.env.NOCTUA_SEC_MIN_INTERVAL_MS ?? 150);

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Per-key next-available timestamp. Reserving the slot synchronously spaces out
// even concurrent callers, not just sequential ones.
const nextAvailableAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateGate(key: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const earliest = Math.max(now, nextAvailableAt.get(key) ?? 0);
  nextAvailableAt.set(key, earliest + minIntervalMs);
  const wait = earliest - now;
  if (wait > 0) await sleep(wait);
}

function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec != null && Number.isFinite(retryAfterSec)) {
    return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250), MAX_BACKOFF_MS);
}

/**
 * `fetch` with a timeout, retry-with-backoff (network errors + 408/429/5xx,
 * honoring Retry-After), and optional per-host rate spacing. Returns the
 * Response (callers still check `res.ok`); throws only when every attempt fails
 * to produce a response (network error / timeout).
 */
export async function fetchExternal(url: string, opts: FetchExternalOptions = {}): Promise<Response> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  let rateKey = opts.rateKey;
  if (!rateKey) {
    try {
      rateKey = new URL(url).host;
    } catch {
      rateKey = "default";
    }
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    await rateGate(rateKey, minIntervalMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method,
        body: opts.body,
        headers: opts.headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (attempt <= retries && RETRYABLE_STATUS.has(res.status)) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(backoffMs(attempt, Number.isFinite(retryAfter) ? retryAfter : undefined));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt <= retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** SEC-polite fetch: shared rate bucket + a generous timeout + retries. */
export function fetchSec(url: string, headers: Record<string, string>): Promise<Response> {
  return fetchExternal(url, {
    headers,
    rateKey: SEC_RATE_KEY,
    minIntervalMs: SEC_MIN_INTERVAL_MS,
    timeoutMs: 15_000,
    retries: 2,
  });
}
