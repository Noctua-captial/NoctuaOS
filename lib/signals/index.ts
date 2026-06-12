// Signal layer entry point. refreshSignals runs all four keyless sources for
// one name and returns a combined snapshot with per-source asOf timestamps.
// Never throws: a failed source comes back null with its error recorded, so
// downstream consumers (the oracle) always know exactly what data they have.
import { computeOptionsSignals, type OptionsSignals } from "@/lib/signals/options";
import { computeShortSignal, type ShortSignal } from "@/lib/signals/shortflow";
import { fetchInsiderActivity, type InsiderActivity } from "@/lib/signals/insiders";
import { fetchNews, type NewsSignal } from "@/lib/signals/news";

export type { OptionChain, OptionContract, OptionsSignals } from "@/lib/signals/options";
export { fetchChain, computeOptionsSignals } from "@/lib/signals/options";
export type { ShortSignal, ShortVolumeDay } from "@/lib/signals/shortflow";
export { computeShortSignal, fetchShortVolume } from "@/lib/signals/shortflow";
export type { InsiderActivity, InsiderTransaction } from "@/lib/signals/insiders";
export { fetchInsiderActivity } from "@/lib/signals/insiders";
export type { NewsItem, NewsSignal, NewsTag } from "@/lib/signals/news";
export { fetchNews } from "@/lib/signals/news";

export type SignalSource = "options" | "short" | "insider" | "news";

export type SignalSnapshot = {
  ticker: string;
  refreshedAt: string; // when this snapshot was assembled (sources carry their own asOf)
  options: OptionsSignals | null;
  short: ShortSignal | null;
  insider: InsiderActivity | null;
  news: NewsSignal | null;
  errors: { source: SignalSource; message: string }[];
};

async function guard<T>(
  source: SignalSource,
  errors: SignalSnapshot["errors"],
  run: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    errors.push({ source, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Refresh all four signal sources for a ticker and return the combined
 * snapshot. Each source persists its own signal rows; each carries the
 * data's own asOf; unavailable data is null, never invented.
 */
export async function refreshSignals(ticker: string, companyName?: string): Promise<SignalSnapshot> {
  const t = ticker.toUpperCase();
  const errors: SignalSnapshot["errors"] = [];

  const [options, short, insider, news] = await Promise.all([
    guard("options", errors, () => computeOptionsSignals(t)),
    guard("short", errors, () => computeShortSignal(t)),
    guard("insider", errors, () => fetchInsiderActivity(t)),
    guard("news", errors, () => fetchNews(t, companyName)),
  ]);

  return {
    ticker: t,
    refreshedAt: new Date().toISOString(),
    options,
    short,
    insider,
    news,
    errors,
  };
}
