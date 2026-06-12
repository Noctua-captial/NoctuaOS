// FINRA Reg SHO daily short volume — keyless. One pipe-delimited file per
// trading day (Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market);
// weekends/holidays are missing, so we walk back to the last published day.
// The parsed file is cached in memory per day (one fetch serves every ticker
// in a scan); per-ticker daily ratios persist as "short_pressure" signal rows
// so trend and z-score build from real stored history.
import { FETCH_TIMEOUT_MS, meanStd, signalHistory, upsertSignal } from "@/lib/signals/common";

const WALK_BACK_DAYS = 5; // attempts beyond today: covers a long weekend + holiday
const MISS_RETRY_MS = 30 * 60 * 1000; // re-check a missing day's file after 30 minutes
const Z_MIN_DAYS = 10; // stored prior days required before a z-score
const TREND_WINDOW = 20; // trailing stored days for the trend baseline
const HISTORY_LIMIT = 90;

export type ShortVolumeDay = {
  ticker: string;
  date: string; // YYYY-MM-DD — the file's trading day
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  ratio: number; // shortVolume / totalVolume
  market: string;
};

export type ShortSignal = {
  ticker: string;
  asOf: string; // the FINRA file's trading day
  ratio: number; // latest short volume / total volume, 0..1
  trend: number | null; // latest ratio minus the trailing stored mean; null with no prior days
  z: number | null; // vs stored history; null until ≥10 prior days exist
  daysOfHistory: number; // prior stored days backing trend/z
};

// --- per-day file cache -------------------------------------------------------

type FileRow = { shortVolume: number; shortExemptVolume: number; totalVolume: number; market: string };

const fileCache = new Map<string, Map<string, FileRow>>(); // YYYYMMDD → symbol → row
const missAt = new Map<string, number>(); // YYYYMMDD → last miss timestamp

function parseFile(text: string): Map<string, FileRow> {
  const map = new Map<string, FileRow>();
  for (const line of text.split("\n")) {
    const cells = line.split("|");
    if (cells.length < 5 || cells[0] === "Date") continue;
    const shortVolume = Number(cells[2]);
    const totalVolume = Number(cells[4]);
    if (!Number.isFinite(shortVolume) || !Number.isFinite(totalVolume)) continue;
    map.set(cells[1].toUpperCase(), {
      shortVolume,
      shortExemptVolume: Number(cells[3]) || 0,
      totalVolume,
      market: (cells[5] ?? "").trim(),
    });
  }
  return map;
}

/** The day's parsed file, or null when FINRA hasn't published it (any non-200). */
async function loadDay(yyyymmdd: string): Promise<Map<string, FileRow> | null> {
  const cached = fileCache.get(yyyymmdd);
  if (cached) return cached;
  const miss = missAt.get(yyyymmdd);
  if (miss && Date.now() - miss < MISS_RETRY_MS) return null;

  let res: Response;
  try {
    res = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    missAt.set(yyyymmdd, Date.now());
    return null;
  }
  if (!res.ok) {
    missAt.set(yyyymmdd, Date.now());
    return null;
  }
  const parsed = parseFile(await res.text());
  if (parsed.size === 0) {
    missAt.set(yyyymmdd, Date.now());
    return null;
  }
  fileCache.set(yyyymmdd, parsed);
  missAt.delete(yyyymmdd);
  return parsed;
}

function dayKeys(): { yyyymmdd: string; iso: string }[] {
  const out: { yyyymmdd: string; iso: string }[] = [];
  for (let back = 0; back <= WALK_BACK_DAYS; back++) {
    const d = new Date(Date.now() - back * 86_400_000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    out.push({ yyyymmdd: iso.replaceAll("-", ""), iso });
  }
  return out;
}

/**
 * The ticker's row from the most recent published FINRA file (walking back
 * ≤5 days). Persists one "short_pressure" signals row per (ticker, date) with
 * value = short ratio. Null when no file is reachable or the ticker has no
 * row in the latest file.
 */
export async function fetchShortVolume(ticker: string): Promise<ShortVolumeDay | null> {
  const t = ticker.toUpperCase();
  for (const { yyyymmdd, iso } of dayKeys()) {
    const file = await loadDay(yyyymmdd);
    if (!file) continue;
    const row = file.get(t);
    if (!row || row.totalVolume <= 0) return null; // latest published day simply lacks the name
    const day: ShortVolumeDay = {
      ticker: t,
      date: iso,
      shortVolume: row.shortVolume,
      shortExemptVolume: row.shortExemptVolume,
      totalVolume: row.totalVolume,
      ratio: row.shortVolume / row.totalVolume,
      market: row.market,
    };
    await upsertSignal({
      ticker: t,
      kind: "short_pressure",
      value: day.ratio,
      z: null, // filled by computeShortSignal once history supports it
      asOf: day.date,
      payload: day,
    });
    return day;
  }
  return null;
}

/**
 * Latest short-pressure reading with trend and z-score vs the stored daily
 * history. trend = ratio − trailing mean (≤20 prior days); z requires ≥10
 * prior stored days and is null before — never fabricated. Null when FINRA
 * has no data for the ticker.
 */
export async function computeShortSignal(ticker: string): Promise<ShortSignal | null> {
  const latest = await fetchShortVolume(ticker);
  if (!latest) return null;

  const rows = await signalHistory(ticker, "short_pressure", HISTORY_LIMIT);
  const prior = rows
    .filter((r) => r.asOf.slice(0, 10) < latest.date && r.value != null)
    .map((r) => r.value!);

  let trend: number | null = null;
  const { mean: trendMean } = meanStd(prior.slice(0, TREND_WINDOW));
  if (trendMean != null) trend = latest.ratio - trendMean;

  let z: number | null = null;
  if (prior.length >= Z_MIN_DAYS) {
    const { mean, std } = meanStd(prior);
    if (mean != null && std != null && std > 0) z = (latest.ratio - mean) / std;
  }

  if (z != null) {
    await upsertSignal({
      ticker: latest.ticker,
      kind: "short_pressure",
      value: latest.ratio,
      z,
      asOf: latest.date,
      payload: latest,
    });
  }

  return {
    ticker: latest.ticker,
    asOf: latest.date,
    ratio: latest.ratio,
    trend,
    z,
    daysOfHistory: prior.length,
  };
}
