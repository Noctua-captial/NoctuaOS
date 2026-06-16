// Apify "Tweet Scraper V2" (apidojo/tweet-scraper) adapter for the TweetSource
// seam. Talks to the Apify REST API with raw fetch (no SDK) via the
// run-sync-get-dataset-items endpoint, which runs the actor and returns the
// dataset (a JSON array of tweet items) in one synchronous call.
//
// Graceful degradation: with no APIFY_TOKEN the source returns [] quietly and
// never throws on import (mirrors the optional-LLM skip in lib/signals/news.ts).
// HTTP/network failures DO throw so the jobs queue can retry with backoff.
//
// Field mapping is defensive: the actor occasionally renames fields between
// builds, so each value is read from several candidate keys. The verbatim item
// is preserved on RawTweet.raw for re-parsing later.
import type { RawTweet, TweetMedia, TweetMetrics } from "@/lib/augury/types";
import type { TweetSource } from "@/lib/augury/source/types";

const ACTOR_SLUG = "apidojo~tweet-scraper";
const RUN_SYNC_ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR_SLUG}/run-sync-get-dataset-items`;

// The synchronous run endpoint is capped at ~300s server-side; keep just under
// it. Overridable for long deep-history windows run from the backfill script.
const RUN_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS ?? 280_000);

// The actor enforces a 50-tweet minimum per query; ask for at least that.
const MIN_ITEMS = 50;

// --- deep-history paging (backfill) -----------------------------------------
// The run-sync endpoint caps a single run at ~300s, and `twitterHandles` pulls
// are not date-bounded — so "every post they've ever done" is captured by
// walking dated `from:<handle> since:.. until:..` windows backward in time until
// the account's start (a run of empty windows) or an absolute floor. All
// tunable via env for very prolific accounts (smaller windows finish faster).
const BACKFILL_WINDOW_DAYS = Math.max(1, Number(process.env.AUGURY_BACKFILL_WINDOW_DAYS ?? 90));
const BACKFILL_MAX_WINDOWS = Math.max(1, Number(process.env.AUGURY_BACKFILL_MAX_WINDOWS ?? 240));
const BACKFILL_MAX_EMPTY_STREAK = Math.max(1, Number(process.env.AUGURY_BACKFILL_EMPTY_STREAK ?? 3));
const BACKFILL_WINDOW_MAX_ITEMS = Math.max(MIN_ITEMS, Number(process.env.AUGURY_BACKFILL_WINDOW_MAX_ITEMS ?? 100_000));
// Pre-Twitter; the absolute oldest date a window walk will reach.
const BACKFILL_HARD_FLOOR_MS = Date.parse("2006-03-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

// --- small defensive readers -------------------------------------------------

type Json = Record<string, unknown>;

function asObj(v: unknown): Json {
  return v != null && typeof v === "object" ? (v as Json) : {};
}

function pick(obj: Json, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

/** Parse a tweet timestamp (Twitter's "Fri Nov 24 17:49:36 +0000 2023" or ISO) to ISO 8601. */
function toISO(v: unknown): string {
  const raw = typeof v === "string" || typeof v === "number" ? v : null;
  if (raw == null) return "";
  const t = Date.parse(String(raw));
  if (Number.isFinite(t)) return new Date(t).toISOString();
  return typeof raw === "string" ? raw : "";
}

/** Snowflake-id comparison for the `latest({ sinceId })` cursor; lenient on parse failure. */
function isNewerId(id: string, sinceId: string): boolean {
  try {
    return BigInt(id) > BigInt(sinceId);
  } catch {
    return true;
  }
}

// --- output mapping ----------------------------------------------------------

function mapMetrics(item: Json): TweetMetrics {
  const m: TweetMetrics = {};
  const likes = asNum(pick(item, ["likeCount", "favoriteCount", "favorite_count", "likes"]));
  if (likes != null) m.likes = likes;
  const retweets = asNum(pick(item, ["retweetCount", "retweet_count", "retweets"]));
  if (retweets != null) m.retweets = retweets;
  const replies = asNum(pick(item, ["replyCount", "reply_count", "replies"]));
  if (replies != null) m.replies = replies;
  const quotes = asNum(pick(item, ["quoteCount", "quote_count", "quotes"]));
  if (quotes != null) m.quotes = quotes;
  const views = asNum(pick(item, ["viewCount", "view_count", "views"]));
  if (views != null) m.views = views;
  const bookmarks = asNum(pick(item, ["bookmarkCount", "bookmark_count", "bookmarks"]));
  if (bookmarks != null) m.bookmarks = bookmarks;
  return m;
}

function mapMedia(item: Json): TweetMedia[] {
  const buckets: unknown[] = [];
  for (const arr of [item.media, asObj(item.extendedEntities).media, asObj(item.entities).media]) {
    if (Array.isArray(arr)) buckets.push(...arr);
  }
  const out: TweetMedia[] = [];
  const seen = new Set<string>();
  for (const raw of buckets) {
    const m = asObj(raw);
    const url = asStr(
      pick(m, ["media_url_https", "media_url", "url", "expanded_url", "thumbnailUrl", "thumbnail"]),
    );
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const thumb = asStr(pick(m, ["thumbnailUrl", "thumbnail", "media_url_https"]));
    out.push({
      type: asStr(pick(m, ["type"])) ?? "photo",
      url,
      thumbnailUrl: thumb ?? undefined,
      altText: asStr(pick(m, ["ext_alt_text", "altText", "alt_text"])),
    });
  }
  return out;
}

/** Map one Apify dataset item → RawTweet. Returns null for non-tweet/sentinel rows. */
function mapItem(item: Json, fallbackHandle: string): RawTweet | null {
  const type = asStr(item.type);
  if (type != null && type !== "tweet") return null; // skip user/list/error sentinels
  const id = asStr(pick(item, ["id", "id_str", "tweetId", "rest_id"]));
  if (!id) return null; // no dedupe key → unusable

  const author = asObj(item.author);
  const handle =
    asStr(pick(author, ["userName", "screen_name", "username", "handle"])) ??
    asStr(pick(item, ["authorHandle", "userName", "screen_name", "username"])) ??
    fallbackHandle;

  const replyToId = asStr(
    pick(item, ["inReplyToId", "in_reply_to_status_id_str", "inReplyToStatusId", "replyToId"]),
  );
  const quotedId = asStr(
    pick(item, ["quoteId", "quotedStatusId", "quoted_status_id_str", "quotedStatusIdStr", "quotedId"]),
  );

  return {
    id,
    url: asStr(pick(item, ["url", "twitterUrl", "tweetUrl"])) ?? `https://x.com/${handle}/status/${id}`,
    text: asStr(pick(item, ["text", "fullText", "full_text"])) ?? "",
    createdAt: toISO(pick(item, ["createdAt", "created_at", "date", "timestamp"])),
    authorHandle: handle.replace(/^@/, ""),
    isReply: asBool(pick(item, ["isReply", "is_reply"])) || replyToId != null,
    isRetweet: asBool(pick(item, ["isRetweet", "is_retweet"])),
    isQuote: asBool(pick(item, ["isQuote", "is_quote"])) || quotedId != null,
    conversationId: asStr(
      pick(item, ["conversationId", "conversation_id_str", "conversationIdStr", "conversation_id"]),
    ),
    replyToId,
    quotedId,
    metrics: mapMetrics(item),
    media: mapMedia(item),
    raw: item,
  };
}

// --- input building ----------------------------------------------------------

/** ISO timestamp → YYYY-MM-DD for Twitter advanced-search since:/until: tokens. */
function dateOnly(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

interface BuildOpts {
  handle: string;
  maxItems?: number;
  sinceISO?: string;
  untilISO?: string;
  sort?: "Latest" | "Top" | "Latest + Top";
}

/**
 * Build the actor input. Date filters (start/end) are only honored by the actor
 * for `searchTerms`, NOT `twitterHandles` — so a date-bounded pull is expressed
 * as a `from:<handle> since:.. until:..` advanced-search query; an unbounded
 * pull uses the simpler `twitterHandles` path.
 */
function buildInput(opts: BuildOpts): Json {
  const handle = opts.handle.replace(/^@/, "");
  const input: Json = {
    sort: opts.sort ?? "Latest",
    onlyVerifiedUsers: false,
  };
  if (opts.maxItems != null && Number.isFinite(opts.maxItems)) {
    input.maxItems = Math.max(MIN_ITEMS, Math.floor(opts.maxItems));
  }

  const since = opts.sinceISO ? dateOnly(opts.sinceISO) : null;
  const until = opts.untilISO ? dateOnly(opts.untilISO) : null;
  if (since || until) {
    const parts = [`from:${handle}`];
    if (since) parts.push(`since:${since}`);
    if (until) parts.push(`until:${until}`);
    input.searchTerms = [parts.join(" ")];
    if (opts.sinceISO) input.start = opts.sinceISO;
    if (opts.untilISO) input.end = opts.untilISO;
  } else {
    input.twitterHandles = [handle];
  }
  return input;
}

// --- runner ------------------------------------------------------------------

async function runActor(input: Json, fallbackHandle = ""): Promise<RawTweet[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return []; // graceful no-op — no key configured

  const res = await fetch(`${RUN_SYNC_ENDPOINT}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Apify tweet-scraper failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];

  // Date-windowed pulls use `searchTerms` (no twitterHandles), so thread the
  // requested handle through as the author fallback for items missing one.
  const handle =
    fallbackHandle || (Array.isArray(input.twitterHandles) ? String(input.twitterHandles[0] ?? "") : "");
  const out: RawTweet[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    const mapped = mapItem(asObj(row), handle);
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    out.push(mapped);
  }
  return out;
}

/**
 * Walk an author's full history by stepping dated windows backward from now.
 * Resumable upstream (ingest dedups by id); here we dedup across overlapping
 * windows and stop at: an explicit `maxItems`, `sinceISO`/the hard floor, a run
 * of empty windows (account start), or BACKFILL_MAX_WINDOWS. `maxItems` omitted
 * = unbounded (full history).
 */
async function backfillPaged(
  handle: string,
  opts: { maxItems?: number; sinceISO?: string },
): Promise<RawTweet[]> {
  const sinceFloor = opts.sinceISO && Number.isFinite(Date.parse(opts.sinceISO)) ? Date.parse(opts.sinceISO) : 0;
  const floorMs = Math.max(BACKFILL_HARD_FLOOR_MS, sinceFloor);
  const cap = opts.maxItems != null && Number.isFinite(opts.maxItems) ? Math.max(1, Math.floor(opts.maxItems)) : Infinity;

  const byId = new Map<string, RawTweet>();
  let untilMs = Date.now();
  let emptyStreak = 0;

  for (let w = 0; w < BACKFILL_MAX_WINDOWS; w++) {
    const sinceMs = Math.max(floorMs, untilMs - BACKFILL_WINDOW_DAYS * DAY_MS);
    if (sinceMs >= untilMs) break; // window collapsed onto the floor

    const remaining = cap === Infinity ? BACKFILL_WINDOW_MAX_ITEMS : Math.max(MIN_ITEMS, cap - byId.size);
    const items = await runActor(
      buildInput({
        handle,
        sinceISO: new Date(sinceMs).toISOString(),
        untilISO: new Date(untilMs).toISOString(),
        maxItems: Math.min(BACKFILL_WINDOW_MAX_ITEMS, remaining),
        sort: "Latest",
      }),
      handle,
    );

    let added = 0;
    for (const it of items) {
      if (byId.has(it.id)) continue;
      byId.set(it.id, it);
      added++;
    }
    emptyStreak = added === 0 ? emptyStreak + 1 : 0;

    if (byId.size >= cap) break;
    if (sinceMs <= floorMs) break; // reached the floor
    if (emptyStreak >= BACKFILL_MAX_EMPTY_STREAK) break; // account start (gap of empty windows)
    untilMs = sinceMs; // step the window back in time
  }

  const out = [...byId.values()];
  return cap === Infinity ? out : out.slice(0, cap);
}

// --- TweetSource implementation ----------------------------------------------

export const apifySource: TweetSource = {
  async backfill(handle, opts = {}) {
    // Page the full history via dated windows (maxItems omitted = unbounded).
    return backfillPaged(handle, { maxItems: opts.maxItems, sinceISO: opts.sinceISO });
  },

  async latest(handle, opts = {}) {
    const items = await runActor(buildInput({ handle, maxItems: opts.maxItems, sort: "Latest" }), handle);
    if (!opts.sinceId) return items;
    return items.filter((t) => isNewerId(t.id, opts.sinceId!));
  },
};

/**
 * Source selector. Only Apify is wired today; this is the single seam to extend
 * when another scraper is added (e.g. choose by env). Returns a TweetSource.
 */
export function getSource(): TweetSource {
  return apifySource;
}
