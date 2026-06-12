// Google News RSS per ticker — keyless headline stream into `news_items`,
// deduped by URL. Tagging is two-tier: a keyword map always runs (bullish /
// bearish / neutral); an optional LLM pass classifies untagged items into the
// existing signal taxonomy when a provider key exists, and silently skips
// when none does. News burst: ≥4 items inside 48h raises a "news_burst" row.
import { desc, eq, isNull, and, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, tables } from "@/db";
import { modelFor } from "@/lib/models";
import { traceSchema } from "@/lib/athena";
import { FETCH_TIMEOUT_MS, upsertSignal } from "@/lib/signals/common";

const FEED_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS_PER_FETCH = 30;
const RETURN_LIMIT = 25;
const BURST_WINDOW_MS = 48 * 60 * 60 * 1000;
const BURST_MIN_ITEMS = 4;
const LLM_BATCH = 8;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type NewsTag = "bullish" | "bearish" | "neutral";

export type NewsItem = {
  title: string;
  url: string;
  source: string | null;
  publishedAt: string | null; // ISO
  tag: NewsTag;
  classified: string | null; // signal-taxonomy label once the LLM pass has run
};

export type NewsSignal = {
  ticker: string;
  asOf: string | null; // newest item's own publish time; null when the feed is empty
  items: NewsItem[]; // newest first, capped at 25
  newCount: number; // items first seen this fetch
  burstCount: number; // items published in the trailing 48h
  burst: boolean; // burstCount ≥ 4
  classifiedCount: number; // items LLM-classified this pass (0 without keys)
};

// --- keyword tagging ----------------------------------------------------------

const BULLISH_RE =
  /\b(beats?|raises?|raised|upgrades?|upgraded|outperform|contract|buyback|partnership|approves?|approval|expands?|expansion|record|wins?|awarded|acquires?|breakthrough)\b/i;
const BEARISH_RE =
  /\b(miss|misses|missed|cuts?|lowers?|lowered|downgrades?|downgraded|dilution|offering|investigation|investigates?|lawsuit|probe|recall|delays?|delayed|layoffs?|bankruptcy|fraud|short.seller|plunges?|warns?|warning)\b/i;

function keywordTag(title: string): NewsTag {
  const bull = BULLISH_RE.test(title);
  const bear = BEARISH_RE.test(title);
  if (bull && !bear) return "bullish";
  if (bear && !bull) return "bearish";
  return "neutral";
}

// --- RSS parsing (hand-rolled; no dependency) -----------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
}

type FeedItem = { title: string; url: string; source: string | null; publishedAt: string | null };

function parseRss(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= MAX_ITEMS_PER_FETCH) break;
    const block = m[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    if (!title || !link) continue;
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1];
    let publishedAt: string | null = null;
    if (pubDate) {
      const t = Date.parse(decodeEntities(pubDate));
      if (Number.isFinite(t)) publishedAt = new Date(t).toISOString();
    }
    out.push({
      title: decodeEntities(title),
      url: decodeEntities(link),
      source: source ? decodeEntities(source) : null,
      publishedAt,
    });
  }
  return out;
}

const feedCache = new Map<string, { fetchedAt: number; items: FeedItem[] }>();

async function loadFeed(ticker: string, companyName?: string): Promise<FeedItem[]> {
  const key = `${ticker}|${companyName ?? ""}`;
  const cached = feedCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < FEED_TTL_MS) return cached.items;

  const query = [ticker, companyName, "stock"].filter(Boolean).join(" ");
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`News RSS fetch failed (${res.status}) for ${ticker}`);
  const items = parseRss(await res.text());
  feedCache.set(key, { fetchedAt: Date.now(), items });
  return items;
}

// --- optional LLM classification -------------------------------------------------

// Reuses the canonical signal taxonomy from lib/athena's trace schema.
const classificationSchema = z.object({
  classifications: z.array(
    z.object({
      index: z.number().int().describe("Index of the headline in the provided list"),
      category: traceSchema.shape.signalCategory,
    }),
  ),
});

/** Classify up to 8 untagged stored items into the signal taxonomy. Returns rows updated; 0 without keys. */
async function classifyUntagged(ticker: string): Promise<number> {
  try {
    const nv = modelFor("nightvision"); // throws when no provider key — silent skip
    const pending = await db
      .select({ id: tables.newsItems.id, title: tables.newsItems.title })
      .from(tables.newsItems)
      .where(and(eq(tables.newsItems.ticker, ticker), isNull(tables.newsItems.classified)))
      .orderBy(desc(tables.newsItems.publishedAt))
      .limit(LLM_BATCH);
    if (pending.length === 0) return 0;

    const { object } = await generateObject({
      model: nv.model,
      schema: classificationSchema,
      prompt: `Classify each headline about ${ticker} into exactly one signal category from the schema. Use "noise" for routine coverage, listicles, and price-action commentary with no new information.

${pending.map((p, i) => `${i}. ${p.title}`).join("\n")}`,
    });

    let updated = 0;
    for (const c of object.classifications) {
      const row = pending[c.index];
      if (!row) continue;
      await db
        .update(tables.newsItems)
        .set({ classified: c.category })
        .where(eq(tables.newsItems.id, row.id));
      updated++;
    }
    return updated;
  } catch {
    return 0; // no keys or model failure — keyword tags stand
  }
}

/**
 * Pull the ticker's news feed, upsert into `news_items` (dedup by URL,
 * keyword-tagged), detect a news burst (≥4 items in 48h → "news_burst"
 * signals row), and run the optional LLM taxonomy pass. Returns the stored
 * recent items, newest first.
 */
export async function fetchNews(ticker: string, companyName?: string): Promise<NewsSignal> {
  const t = ticker.toUpperCase();
  const feed = await loadFeed(t, companyName);

  // Dedup by URL against stored rows; insert only what's new.
  let newCount = 0;
  if (feed.length > 0) {
    const existing = await db
      .select({ url: tables.newsItems.url })
      .from(tables.newsItems)
      .where(inArray(tables.newsItems.url, feed.map((f) => f.url)));
    const known = new Set(existing.map((e) => e.url));
    const fresh = feed.filter((f) => !known.has(f.url));
    if (fresh.length > 0) {
      await db
        .insert(tables.newsItems)
        .values(
          fresh.map((f) => ({
            ticker: t,
            title: f.title,
            url: f.url,
            source: f.source,
            publishedAt: f.publishedAt,
            tag: keywordTag(f.title),
          })),
        )
        .onConflictDoNothing({ target: tables.newsItems.url });
      newCount = fresh.length;
    }
  }

  // Burst detection on the feed's own publish times.
  const now = Date.now();
  const recent = feed.filter(
    (f) => f.publishedAt != null && now - Date.parse(f.publishedAt) <= BURST_WINDOW_MS,
  );
  const burst = recent.length >= BURST_MIN_ITEMS;
  if (burst) {
    const latest = recent
      .map((f) => f.publishedAt!)
      .sort()
      .at(-1)!;
    await upsertSignal({
      ticker: t,
      kind: "news_burst",
      value: recent.length,
      z: null,
      asOf: latest,
      payload: {
        windowHours: 48,
        count: recent.length,
        items: recent.map((f) => ({ title: f.title, url: f.url, source: f.source, publishedAt: f.publishedAt })),
      },
    });
  }

  const classifiedCount = await classifyUntagged(t);

  const rows = await db
    .select()
    .from(tables.newsItems)
    .where(eq(tables.newsItems.ticker, t))
    .orderBy(desc(tables.newsItems.publishedAt))
    .limit(RETURN_LIMIT);

  const items: NewsItem[] = rows.map((r) => ({
    title: r.title,
    url: r.url,
    source: r.source,
    publishedAt: r.publishedAt,
    tag: (r.tag as NewsTag | null) ?? "neutral",
    classified: r.classified,
  }));

  return {
    ticker: t,
    asOf: items[0]?.publishedAt ?? null,
    items,
    newCount,
    burstCount: recent.length,
    burst,
    classifiedCount,
  };
}
