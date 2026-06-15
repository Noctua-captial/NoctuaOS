// Augury ingestion: turn raw scraped tweets into stored posts, deduped by the
// platform's own id, and fan out the pipeline. Mirrors the upsert-and-dedup
// shape of lib/signals/news.ts (insert only what's new) but for the posts table.
//
// Flow per author:
//   source.latest/backfill → normalizeTweet → upsert posts (dedup by
//   platformPostId) → per NEW post: extract ticker mentions + enqueue("context")
//   → at end of the run: enqueue("profile").
//
// Cross-slice contract: this module ONLY writes its own tables (authors, posts,
// tickerMentions) and talks to other slices through the jobs queue (enqueue).
import { and, desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { enqueue } from "@/lib/augury/jobs";
import type {
  JobHandler,
  MentionType,
  NormalizedPost,
  Platform,
  RawTweet,
} from "@/lib/augury/types";
import { getSource } from "@/lib/augury/source/apify";

// Cashtags like $AAPL → high-confidence ticker references.
const CASHTAG_RE = /\$([A-Za-z]{1,6})\b/g;
const CASHTAG_CONFIDENCE = 0.95;
const NAME_CONFIDENCE = 0.6;
// Bound a multi-row INSERT so we stay well under SQLite's bound-variable cap.
const INSERT_CHUNK = 100;
// Recent-head size for live polling; the actor enforces a 50-item floor.
const LATEST_MAX_ITEMS = 50;
// Default deep-history cap per author for a backfill run.
const BACKFILL_MAX_ITEMS = 3000;
// How long the companies lookup table is cached during a long backfill.
const COMPANY_TTL_MS = 5 * 60 * 1000;

type AuthorRow = typeof tables.authors.$inferSelect;
type CompanyLite = { id: number; ticker: string; name: string };
type MentionRow = {
  postId: number;
  ticker: string;
  mentionType: MentionType;
  confidence: number;
  companyId: number | null;
};

// --- helpers -----------------------------------------------------------------

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- normalization -----------------------------------------------------------

/** Map a source RawTweet onto the `posts` column shape (no DB access). */
export function normalizeTweet(raw: RawTweet, authorId: number): NormalizedPost {
  return {
    authorId,
    platformPostId: raw.id,
    url: raw.url ?? null,
    text: raw.text ?? "",
    postedAt: parseDate(raw.createdAt),
    isReply: Boolean(raw.isReply),
    isRetweet: Boolean(raw.isRetweet),
    isQuote: Boolean(raw.isQuote),
    conversationId: raw.conversationId ?? null,
    replyToId: raw.replyToId ?? null,
    quotedPostId: raw.quotedId ?? null,
    metrics: raw.metrics ?? {},
    media: raw.media ?? [],
    raw: raw.raw ?? null,
  };
}

function toPostRow(n: NormalizedPost) {
  return {
    authorId: n.authorId,
    platformPostId: n.platformPostId,
    url: n.url,
    text: n.text,
    postedAt: n.postedAt,
    isReply: n.isReply,
    isRetweet: n.isRetweet,
    isQuote: n.isQuote,
    conversationId: n.conversationId,
    replyToId: n.replyToId,
    quotedPostId: n.quotedPostId,
    metrics: JSON.stringify(n.metrics ?? {}),
    media: JSON.stringify(n.media ?? []),
    raw: n.raw != null ? JSON.stringify(n.raw) : null,
  };
}

// --- ticker mentions ---------------------------------------------------------

/**
 * Detect ticker references in post text. Cashtags ($TSLA) are emitted directly
 * with high confidence; company-name matching against the DB happens in
 * ingestTweets (it needs DB access + attaches companyId), keeping this pure.
 */
export function extractTickerMentions(
  text: string,
): { ticker: string; mentionType: MentionType; confidence: number }[] {
  const out: { ticker: string; mentionType: MentionType; confidence: number }[] = [];
  if (!text) return out;
  const seen = new Set<string>();
  for (const m of text.matchAll(CASHTAG_RE)) {
    const ticker = m[1].toUpperCase();
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, mentionType: "cashtag", confidence: CASHTAG_CONFIDENCE });
  }
  return out;
}

let companyCache: { at: number; rows: CompanyLite[] } | null = null;

async function loadCompanies(): Promise<CompanyLite[]> {
  if (companyCache && Date.now() - companyCache.at < COMPANY_TTL_MS) return companyCache.rows;
  const rows = await db
    .select({ id: tables.companies.id, ticker: tables.companies.ticker, name: tables.companies.name })
    .from(tables.companies);
  companyCache = { at: Date.now(), rows };
  return rows;
}

/** Build the ticker-mention rows for one post: cashtags (companyId resolved) + name matches. */
async function buildMentionRows(postId: number, text: string): Promise<MentionRow[]> {
  const companies = await loadCompanies();
  const byTicker = new Map(companies.map((c) => [c.ticker.toUpperCase(), c] as const));
  const rows: MentionRow[] = [];
  const seen = new Set<string>();

  for (const c of extractTickerMentions(text)) {
    if (seen.has(c.ticker)) continue;
    seen.add(c.ticker);
    rows.push({
      postId,
      ticker: c.ticker,
      mentionType: c.mentionType,
      confidence: c.confidence,
      companyId: byTicker.get(c.ticker)?.id ?? null,
    });
  }

  // Name matches: company name appears as a whole word and wasn't already a cashtag.
  const lower = text.toLowerCase();
  for (const c of companies) {
    const name = c.name?.trim();
    const ticker = c.ticker.toUpperCase();
    if (!name || name.length < 4 || seen.has(ticker)) continue;
    if (!lower.includes(name.toLowerCase())) continue; // cheap gate before regex
    if (!new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text)) continue;
    seen.add(ticker);
    rows.push({ postId, ticker, mentionType: "name", confidence: NAME_CONFIDENCE, companyId: c.id });
  }

  return rows;
}

// --- authors -----------------------------------------------------------------

/** Ensure an author row exists for (platform, handle); returns the row. */
export async function upsertAuthor(handle: string, platform: Platform = "x"): Promise<AuthorRow> {
  const h = handle.replace(/^@/, "").trim();
  if (!h) throw new Error("upsertAuthor: empty handle");
  await db.insert(tables.authors).values({ handle: h, platform, active: true }).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(tables.authors)
    .where(and(eq(tables.authors.platform, platform), eq(tables.authors.handle, h)))
    .limit(1);
  if (!row) throw new Error(`upsertAuthor: failed to load author ${platform}:${h}`);
  return row;
}

/** Newest stored post id for an author (by post time) — the live-poll cursor. */
async function latestPlatformPostId(authorId: number): Promise<string | null> {
  const [row] = await db
    .select({ pid: tables.posts.platformPostId })
    .from(tables.posts)
    .where(eq(tables.posts.authorId, authorId))
    .orderBy(desc(tables.posts.postedAt))
    .limit(1);
  return row?.pid ?? null;
}

/** Move authors.firstPostAt back if this batch contains an earlier post. */
async function updateFirstPostAt(authorId: number, normalized: NormalizedPost[]): Promise<void> {
  let earliest: number | null = null;
  for (const n of normalized) {
    if (!n.postedAt) continue;
    const t = n.postedAt.getTime();
    if (earliest == null || t < earliest) earliest = t;
  }
  if (earliest == null) return;
  const [a] = await db
    .select({ firstPostAt: tables.authors.firstPostAt })
    .from(tables.authors)
    .where(eq(tables.authors.id, authorId))
    .limit(1);
  const current = a?.firstPostAt ? a.firstPostAt.getTime() : null;
  if (current == null || earliest < current) {
    await db
      .update(tables.authors)
      .set({ firstPostAt: new Date(earliest), updatedAt: new Date() })
      .where(eq(tables.authors.id, authorId));
  }
}

// --- core ingest -------------------------------------------------------------

/**
 * Normalize + upsert raws into `posts`, deduping by platformPostId. For each
 * genuinely new post, store its ticker mentions and enqueue a "context" job.
 * Returns the ids of the posts inserted this call (empty when all were dupes).
 */
export async function ingestTweets(
  authorId: number,
  raws: RawTweet[],
): Promise<{ newPostIds: number[] }> {
  if (!raws || raws.length === 0) return { newPostIds: [] };

  // Normalize + dedup within the batch (sources can repeat a post across pages).
  const byPid = new Map<string, NormalizedPost>();
  for (const raw of raws) {
    if (!raw?.id) continue;
    const n = normalizeTweet(raw, authorId);
    if (!byPid.has(n.platformPostId)) byPid.set(n.platformPostId, n);
  }
  const normalized = [...byPid.values()];
  if (normalized.length === 0) return { newPostIds: [] };

  const newPostIds: number[] = [];
  for (const batch of chunk(normalized, INSERT_CHUNK)) {
    // onConflictDoNothing → RETURNING yields only the rows actually inserted,
    // i.e. the genuinely new posts. Dupes are silently skipped.
    const inserted = await db
      .insert(tables.posts)
      .values(batch.map(toPostRow))
      .onConflictDoNothing({ target: tables.posts.platformPostId })
      .returning({ id: tables.posts.id, platformPostId: tables.posts.platformPostId });

    for (const row of inserted) {
      newPostIds.push(row.id);
      const text = byPid.get(row.platformPostId)?.text ?? "";
      const mentions = await buildMentionRows(row.id, text);
      if (mentions.length > 0) await db.insert(tables.tickerMentions).values(mentions);
      await enqueue("context", { postId: row.id });
    }
  }

  await updateFirstPostAt(authorId, normalized);
  return { newPostIds };
}

// --- orchestration entry points ---------------------------------------------

/**
 * Job handler for kind "ingest". Resolves the author, pulls the recent head
 * from the source since the last stored post, ingests it, then enqueues a
 * profile refresh. Registered by the integration worker as `ingest`.
 */
export const ingestHandler: JobHandler = async (payload: { authorHandle?: string }) => {
  const handle = payload?.authorHandle;
  if (!handle) throw new Error("ingest job payload missing authorHandle");
  const author = await upsertAuthor(handle, "x");
  const sinceId = await latestPlatformPostId(author.id);
  const raws = await getSource().latest(handle, {
    sinceId: sinceId ?? undefined,
    maxItems: LATEST_MAX_ITEMS,
  });
  await ingestTweets(author.id, raws);
  await enqueue("profile", { authorId: author.id });
};

/**
 * Deep-history pull for a single author, used by scripts/augury-backfill.ts.
 * Resumable: dedup by platformPostId means re-running only inserts what's new.
 * Does not enqueue profile — the caller does that once the run completes.
 */
export async function backfillAuthor(
  handle: string,
  opts: { maxItems?: number; sinceISO?: string } = {},
): Promise<{ authorId: number; fetched: number; newPostIds: number[] }> {
  const author = await upsertAuthor(handle, "x");
  const raws = await getSource().backfill(handle, {
    maxItems: opts.maxItems ?? BACKFILL_MAX_ITEMS,
    sinceISO: opts.sinceISO,
  });
  const { newPostIds } = await ingestTweets(author.id, raws);
  return { authorId: author.id, fetched: raws.length, newPostIds };
}
