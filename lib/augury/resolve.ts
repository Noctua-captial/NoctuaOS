// (v2) Entity resolution + semantic-memory stage. Runs after `ingest`, before
// `context`. An LLM pass reads the post (plus its assembled conversation thread)
// and extracts EVERY referenced market entity — tickers without cashtags,
// company names, industries/themes, macro topics — into `post_entities`
// (role: subject | comparison | mention; confidence). This replaces the
// cashtag-only `ticker_mentions` building that ingest used to do, and fixes the
// wrong-ticker-context ordering (entities are resolved before context is built).
//
// It also lays down the post's pgvector embedding (`posts.embedding`) using the
// same optional-embeddings pattern as lib/vault.ts (FTS/ILIKE-only fallback
// without an OPENAI_API_KEY), powering retrieval-augmented extraction and the
// "everything they ever said about X / this theme" search in the UI.
//
// Keyless discipline (mirrors lib/signals/news.ts): a cheap cashtag regex always
// seeds ticker entities so the pipeline keeps grounding tickers with no key at
// all; the LLM pass (when a provider key exists) supersedes it with full,
// role-aware resolution. Either way the stage enqueues `context` so the chain
// continues. Cross-slice contract: writes only its own tables
// (post_entities, posts.embedding) and hands off via the jobs queue.
import { and, asc, eq, inArray } from "drizzle-orm";
import { generateObject, embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { db, tables, sql } from "@/db";
import { modelFor } from "@/lib/models";
import { enqueue } from "@/lib/augury/jobs";
import type { EntityRole, EntityType, JobHandler, PostEntity } from "@/lib/augury/types";

// --- tuning ------------------------------------------------------------------

const MAX_POST_CHARS = 1400;
const MAX_THREAD_CHARS = 280;
const MAX_THREAD_POSTS = 6; // sibling posts from the same conversation shown to the model
const MAX_ENTITIES = 24; // hard cap on entities persisted per post
const MAX_EMBED_CHARS = 8000; // text-embedding-3-small handles ~8k tokens; bound the input
const EMBED_DIMS = 1536; // must match posts.embedding vector(1536)

// Cashtags like $AAPL → high-confidence, keyless ticker references.
const CASHTAG_RE = /\$([A-Za-z]{1,6})\b/g;
const CASHTAG_CONFIDENCE = 0.9;

// --- LLM extraction schema ---------------------------------------------------

const entitySetSchema = z.object({
  isMarketRelevant: z
    .boolean()
    .describe("False if the post is purely personal, social, or off-topic with no market/trading content."),
  entities: z
    .array(
      z.object({
        entityType: z
          .enum(["ticker", "theme", "macro"])
          .describe(
            "ticker: a specific tradeable equity/ETF (give its SYMBOL). theme: an industry, sector, or investable theme (e.g. 'AI datacenter power', 'uranium'). macro: a macro/world topic (e.g. 'Fed rate cuts', 'oil prices', 'US-China tariffs').",
          ),
        value: z
          .string()
          .describe(
            "For ticker: the uppercase symbol WITHOUT a leading $ (resolve company names to their ticker, e.g. 'Nvidia' → 'NVDA'). For theme/macro: a short canonical label.",
          ),
        role: z
          .enum(["subject", "comparison", "mention"])
          .describe(
            "subject: the post is primarily making a call/claim about it. comparison: named to compare/contrast against the subject. mention: incidental reference.",
          ),
        confidence: z.number().min(0).max(1).describe("How confident you are this entity is genuinely referenced, 0..1."),
      }),
    )
    .describe("Every distinct market entity the post references. Empty when the post is not market-relevant."),
});

type ExtractedEntity = z.infer<typeof entitySetSchema>["entities"][number];

const RESOLVE_SYSTEM = `You are Augur's entity resolver inside Noctua OS. Read a tracked market commentator's post (and any thread context) and list EVERY distinct market entity it references: specific stocks/ETFs (resolve names and tickers even when there is no $ cashtag), industries/investable themes, and macro/world topics. Classify each as ticker, theme, or macro, label its role (subject / comparison / mention), and rate confidence. Be literal and exhaustive but do not invent entities the text does not support. A post can have zero entities (purely personal/social). Output strictly the requested schema.`;

// --- helpers -----------------------------------------------------------------

function normalizeTicker(raw: string): string | null {
  const clean = raw.trim().replace(/^\$/, "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  return clean.length >= 1 && clean.length <= 8 ? clean : null;
}

function normalizeValue(entityType: EntityType, raw: string): string | null {
  if (entityType === "ticker") return normalizeTicker(raw);
  const v = raw.trim().replace(/\s+/g, " ");
  return v.length ? v.slice(0, 120) : null;
}

/** Keyless seed: cashtags as ticker entities (role subject), so ticker grounding survives with no LLM key. */
function cashtagEntities(text: string): PostEntity[] {
  const out: PostEntity[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CASHTAG_RE)) {
    const ticker = m[1].toUpperCase();
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ entityType: "ticker", value: ticker, role: "subject", confidence: CASHTAG_CONFIDENCE });
  }
  return out;
}

/**
 * Assemble thread context for a post: its reply parent, its quoted post, and up
 * to a handful of sibling posts sharing the same conversationId (only those we
 * have stored). Returns a prompt-ready block ("" when nothing is on record).
 */
async function assembleThread(post: typeof tables.posts.$inferSelect): Promise<string> {
  const parts: string[] = [];

  if (post.replyToId) {
    const [parent] = await db
      .select({ text: tables.posts.text })
      .from(tables.posts)
      .where(eq(tables.posts.platformPostId, post.replyToId))
      .limit(1);
    if (parent?.text) parts.push(`In reply to: "${parent.text.slice(0, MAX_THREAD_CHARS)}"`);
  }
  if (post.quotedPostId) {
    const [quoted] = await db
      .select({ text: tables.posts.text })
      .from(tables.posts)
      .where(eq(tables.posts.platformPostId, post.quotedPostId))
      .limit(1);
    if (quoted?.text) parts.push(`Quoting: "${quoted.text.slice(0, MAX_THREAD_CHARS)}"`);
  }
  if (post.conversationId) {
    const siblings = await db
      .select({ text: tables.posts.text, postedAt: tables.posts.postedAt })
      .from(tables.posts)
      .where(
        and(eq(tables.posts.conversationId, post.conversationId), eq(tables.posts.authorId, post.authorId)),
      )
      .orderBy(asc(tables.posts.postedAt))
      .limit(MAX_THREAD_POSTS + 1);
    const others = siblings.filter((s) => s.text && s.text !== post.text).slice(0, MAX_THREAD_POSTS);
    if (others.length) {
      parts.push(
        `Same conversation (chronological):\n${others
          .map((s) => `- "${s.text.slice(0, MAX_THREAD_CHARS)}"`)
          .join("\n")}`,
      );
    }
  }

  return parts.join("\n");
}

// --- embeddings (optional — activates with a valid OPENAI_API_KEY) -----------

function embedder() {
  if (!process.env.OPENAI_API_KEY) return null;
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai.textEmbedding("text-embedding-3-small");
}

/** Embed one text. null without a key, on failure, or for empty input — FTS/ILIKE still works. */
async function tryEmbed(text: string): Promise<number[] | null> {
  const model = embedder();
  if (!model || !text.trim()) return null;
  try {
    const { embedding } = await embed({ model, value: text.slice(0, MAX_EMBED_CHARS) });
    return Array.isArray(embedding) && embedding.length === EMBED_DIMS ? embedding : null;
  } catch {
    return null; // dead key / quota — degrade to keyword search
  }
}

// --- entity resolution -------------------------------------------------------

/** Merge cashtag-seeded entities with LLM entities; LLM (richer roles) wins on conflict. Dedup by type+value. */
function mergeEntities(cashtags: PostEntity[], llm: ExtractedEntity[]): PostEntity[] {
  const byKey = new Map<string, PostEntity>();
  for (const c of cashtags) byKey.set(`${c.entityType}:${c.value}`, c);
  for (const e of llm) {
    const value = normalizeValue(e.entityType, e.value);
    if (!value) continue;
    byKey.set(`${e.entityType}:${value}`, {
      entityType: e.entityType,
      value,
      role: e.role as EntityRole,
      confidence: Math.max(0, Math.min(1, e.confidence ?? 0.5)),
    });
  }
  return [...byKey.values()].slice(0, MAX_ENTITIES);
}

/**
 * Resolve a post's entities + embedding, then enqueue `context`. Idempotent and
 * re-runnable: replaces the post's `post_entities` rows and overwrites its
 * embedding, so improvements reprocess history. Always enqueues `context` so the
 * chain continues even fully keyless (no LLM, no embeddings).
 */
export async function resolvePost(postId: number): Promise<void> {
  if (!Number.isFinite(postId)) return;

  const [post] = await db.select().from(tables.posts).where(eq(tables.posts.id, postId)).limit(1);
  if (!post) return;

  const text = post.text ?? "";
  const thread = await assembleThread(post);

  // 1) Entity resolution — cashtag seed (keyless) + optional LLM superset.
  let llmEntities: ExtractedEntity[] = [];
  try {
    const m = modelFor("augur_extract"); // throws without any provider key — keyless skip
    const [author] = await db
      .select({ handle: tables.authors.handle })
      .from(tables.authors)
      .where(eq(tables.authors.id, post.authorId))
      .limit(1);
    const handle = author?.handle ?? `author#${post.authorId}`;
    const prompt = `POST by @${handle} (posted ${post.postedAt ? post.postedAt.toISOString() : "unknown"})
"""
${text.slice(0, MAX_POST_CHARS)}
"""
${thread ? `\nTHREAD CONTEXT\n${thread}\n` : ""}
TASK
List every distinct market entity this post references (tickers without needing a $, company names resolved to symbols, industries/themes, macro topics), each with role and confidence. Return no entities if the post is not market-relevant.`;
    const { object } = await generateObject({
      model: m.model,
      system: RESOLVE_SYSTEM,
      schema: entitySetSchema,
      prompt,
    });
    if (object.isMarketRelevant) llmEntities = object.entities;
  } catch {
    // no key or model failure — fall back to cashtags only
  }

  const entities = mergeEntities(cashtagEntities(text), llmEntities);

  // Resolve companyId for ticker entities against the seeded companies table.
  const tickerValues = [...new Set(entities.filter((e) => e.entityType === "ticker").map((e) => e.value))];
  const companyByTicker = new Map<string, number>();
  if (tickerValues.length) {
    const companies = await db
      .select({ id: tables.companies.id, ticker: tables.companies.ticker })
      .from(tables.companies)
      .where(inArray(tables.companies.ticker, tickerValues));
    for (const c of companies) companyByTicker.set(c.ticker.toUpperCase(), c.id);
  }

  // Replace this post's entities so re-runs reprocess cleanly.
  await db.delete(tables.postEntities).where(eq(tables.postEntities.postId, postId));
  if (entities.length) {
    await db
      .insert(tables.postEntities)
      .values(
        entities.map((e) => ({
          postId,
          entityType: e.entityType,
          value: e.value,
          role: e.role,
          confidence: e.confidence,
          companyId: e.entityType === "ticker" ? companyByTicker.get(e.value) ?? null : null,
        })),
      )
      .onConflictDoNothing({
        target: [tables.postEntities.postId, tables.postEntities.entityType, tables.postEntities.value],
      });
  }

  // 2) Semantic memory: embed the post text (optional). Independent of the LLM key.
  const vec = await tryEmbed(text);
  if (vec) {
    await db.update(tables.posts).set({ embedding: vec }).where(eq(tables.posts.id, postId));
  }

  // 3) Hand off to context.
  await enqueue("context", { postId });
}

/** Job handler for `resolve` jobs. Payload: { postId }. */
export const resolveHandler: JobHandler = async (payload: { postId: number }) => {
  await resolvePost(Number(payload?.postId));
};

// --- semantic post search (consumed by extract retrieval + the UI) -----------

/** One post returned by `searchPosts`. `score` is cosine similarity (embedding) or a recency rank (ILIKE). */
export interface PostSearchHit {
  postId: number;
  authorId: number;
  text: string;
  url: string | null;
  postedAt: Date | null;
  score: number;
}

const DEFAULT_SEARCH_LIMIT = 10;

/** Embedding (pgvector) hits, optionally scoped to an author. [] when embeddings are unavailable. */
async function embeddingHits(
  query: string,
  authorId: number | undefined,
  limit: number,
): Promise<{ id: number; score: number }[]> {
  const model = embedder();
  if (!model) return [];
  try {
    const { embedding } = await embed({ model, value: query.slice(0, MAX_EMBED_CHARS) });
    if (!Array.isArray(embedding) || embedding.length !== EMBED_DIMS) return [];
    const vec = `[${embedding.join(",")}]`;
    const rows =
      authorId != null
        ? await sql<{ id: number; sim: number }[]>`
            SELECT id, 1 - (embedding <=> ${vec}::vector) AS sim
            FROM posts
            WHERE embedding IS NOT NULL AND author_id = ${authorId}
            ORDER BY embedding <=> ${vec}::vector
            LIMIT ${limit}
          `
        : await sql<{ id: number; sim: number }[]>`
            SELECT id, 1 - (embedding <=> ${vec}::vector) AS sim
            FROM posts
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> ${vec}::vector
            LIMIT ${limit}
          `;
    return rows.map((r) => ({ id: r.id, score: r.sim }));
  } catch {
    return []; // dead key / quota / pgvector hiccup — caller falls back to ILIKE
  }
}

/** Keyword (ILIKE on posts.text) hits, optionally scoped to an author. Always available. */
async function ilikeHits(
  query: string,
  authorId: number | undefined,
  limit: number,
): Promise<{ id: number; score: number }[]> {
  const like = `%${query.trim()}%`;
  const rows =
    authorId != null
      ? await sql<{ id: number }[]>`
          SELECT id FROM posts
          WHERE text ILIKE ${like} AND author_id = ${authorId}
          ORDER BY posted_at DESC NULLS LAST
          LIMIT ${limit}
        `
      : await sql<{ id: number }[]>`
          SELECT id FROM posts
          WHERE text ILIKE ${like}
          ORDER BY posted_at DESC NULLS LAST
          LIMIT ${limit}
        `;
  // Decreasing recency-rank score in (0,1], so embedding sims (also ≤1) compare sensibly.
  return rows.map((r, i) => ({ id: r.id, score: 1 - i / (rows.length + 1) }));
}

/**
 * Semantic memory over a tracked trader's posts. Uses pgvector cosine search
 * (`embedding <=> $vec`) when embeddings exist, topped up with an ILIKE keyword
 * scan; degrades to ILIKE-only with no OpenAI key. Optionally scoped to one
 * author. Returns hits ordered best-first. Empty query → []. Never throws on a
 * missing key (only a missing DATABASE_URL would surface).
 */
export async function searchPosts(
  query: string,
  opts: { authorId?: number; limit?: number } = {},
): Promise<PostSearchHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? DEFAULT_SEARCH_LIMIT));
  const authorId = opts.authorId;

  // Embedding-first, then top up with keyword hits to fill the limit (dedup).
  const ranked: { id: number; score: number }[] = [];
  const seen = new Set<number>();
  for (const h of await embeddingHits(q, authorId, limit)) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    ranked.push(h);
  }
  if (ranked.length < limit) {
    for (const h of await ilikeHits(q, authorId, limit * 3)) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      ranked.push(h);
      if (ranked.length >= limit) break;
    }
  }
  if (ranked.length === 0) return [];

  const ids = ranked.slice(0, limit).map((r) => r.id);
  const scoreById = new Map(ranked.map((r) => [r.id, r.score] as const));
  const rows = await db
    .select({
      id: tables.posts.id,
      authorId: tables.posts.authorId,
      text: tables.posts.text,
      url: tables.posts.url,
      postedAt: tables.posts.postedAt,
    })
    .from(tables.posts)
    .where(inArray(tables.posts.id, ids));

  return rows
    .map((r) => ({
      postId: r.id,
      authorId: r.authorId,
      text: r.text,
      url: r.url,
      postedAt: r.postedAt,
      score: scoreById.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}
