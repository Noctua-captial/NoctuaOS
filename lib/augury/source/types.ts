// The provider seam for tweet ingestion. Augury talks to scrapers only through
// this interface, so a source (Apify today) can be swapped without touching
// ingest.ts. `backfill` walks deep history (optionally bounded by a date floor),
// `latest` pulls the recent head (optionally since a known post id). Both yield
// the source-agnostic RawTweet shape from the shared contracts.
import type { RawTweet } from "@/lib/augury/types";

export interface TweetSource {
  /**
   * Deep-history pull for an author. `maxItems` caps the number of tweets;
   * `sinceISO` floors the window to posts on/after that ISO timestamp (used for
   * resumable, windowed backfills). Returns newest-first, best effort.
   */
  backfill(handle: string, opts?: { maxItems?: number; sinceISO?: string }): Promise<RawTweet[]>;

  /**
   * Recent-head pull for live polling. `sinceId` lets the source stop once it
   * reaches an already-seen post id; `maxItems` caps the batch. Returns
   * newest-first, best effort.
   */
  latest(handle: string, opts?: { sinceId?: string; maxItems?: number }): Promise<RawTweet[]>;
}
