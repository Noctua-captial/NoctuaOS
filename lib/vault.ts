import { eq, inArray } from "drizzle-orm";
import { db, tables, sql } from "@/db";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany, embed } from "ai";

// ---------- chunking ----------
export function chunkText(text: string, target = 1800, overlap = 200): string[] {
  const paras = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  for (const p of paras) {
    if (current.length + p.length > target && current.length > 0) {
      chunks.push(current.trim());
      current = current.slice(-overlap) + "\n\n" + p;
    } else {
      current += (current ? "\n\n" : "") + p;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 80);
}

// ---------- embeddings (optional — activates when OPENAI_API_KEY is valid) ----------
function embedder() {
  if (!process.env.OPENAI_API_KEY) return null;
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai.textEmbedding("text-embedding-3-small");
}

async function tryEmbedMany(texts: string[]): Promise<(number[] | null)[]> {
  const model = embedder();
  if (!model) return texts.map(() => null);
  try {
    const { embeddings } = await embedMany({ model, values: texts });
    return embeddings;
  } catch {
    return texts.map(() => null); // dead key or quota — FTS still works
  }
}

// ---------- ingestion ----------
export async function storeDocument(opts: {
  companyId?: number | null;
  ticker?: string | null;
  title: string;
  docType: string;
  formType?: string | null;
  source?: string | null;
  filedAt?: string | null;
  content: string;
}): Promise<{ documentId: number; chunkCount: number; embedded: boolean }> {
  const [doc] = await db
    .insert(tables.documents)
    .values({
      companyId: opts.companyId ?? null,
      ticker: opts.ticker?.toUpperCase() ?? null,
      title: opts.title,
      docType: opts.docType,
      formType: opts.formType ?? null,
      source: opts.source ?? null,
      filedAt: opts.filedAt ?? null,
      content: opts.content,
    })
    .returning();

  const pieces = chunkText(opts.content);
  const embeddings = await tryEmbedMany(pieces);

  if (pieces.length > 0) {
    await db.insert(tables.chunks).values(
      pieces.map((text, i) => ({
        documentId: doc.id,
        idx: i,
        text,
        embedding: embeddings[i] ?? null, // pgvector column maps number[] directly
      })),
    );
  }

  return { documentId: doc.id, chunkCount: pieces.length, embedded: embeddings[0] != null };
}

// ---------- retrieval ----------
export type RetrievedChunk = {
  chunkId: number;
  documentId: number;
  text: string;
  score: number;
  title: string;
  formType: string | null;
  filedAt: string | null;
  source: string | null;
};

export async function searchVault(
  query: string,
  opts: { ticker?: string; limit?: number } = {},
): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 8;
  const results = new Map<number, { score: number }>();

  // 1) Postgres full-text search (always available — uses the generated `tsv`
  // tsvector column + GIN index). websearch_to_tsquery safely parses raw user
  // text, so no hand-rolled sanitization is needed.
  if (query.trim()) {
    const rows = await sql<{ id: number; rank: number }[]>`
      SELECT id, ts_rank(tsv, websearch_to_tsquery('english', ${query})) AS rank
      FROM chunks
      WHERE tsv @@ websearch_to_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit * 3}
    `;
    rows.forEach((r, i) => {
      results.set(r.id, { score: 1 - i / (rows.length || 1) });
    });
  }

  // 2) Embedding search when available — pgvector cosine distance (`<=>`) with
  // the HNSW index does the nearest-neighbor scan in Postgres (no loading every
  // embedding into memory). 1 - distance = cosine similarity.
  const model = embedder();
  if (model) {
    try {
      const { embedding: qVec } = await embed({ model, value: query });
      const vec = `[${qVec.join(",")}]`;
      const scored = await sql<{ id: number; sim: number }[]>`
        SELECT id, 1 - (embedding <=> ${vec}::vector) AS sim
        FROM chunks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vec}::vector
        LIMIT ${limit * 2}
      `;
      for (const s of scored) {
        const prev = results.get(s.id)?.score ?? 0;
        results.set(s.id, { score: prev + s.sim });
      }
    } catch {
      // fall through to FTS-only
    }
  }

  if (results.size === 0) return [];

  const ids = [...results.keys()];
  const rows = await db
    .select({
      chunkId: tables.chunks.id,
      documentId: tables.chunks.documentId,
      text: tables.chunks.text,
      title: tables.documents.title,
      formType: tables.documents.formType,
      filedAt: tables.documents.filedAt,
      source: tables.documents.source,
      docTicker: tables.documents.ticker,
    })
    .from(tables.chunks)
    .innerJoin(tables.documents, eq(tables.chunks.documentId, tables.documents.id))
    .where(inArray(tables.chunks.id, ids));

  return rows
    .filter((r) => !opts.ticker || r.docTicker === opts.ticker.toUpperCase())
    .map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      text: r.text,
      title: r.title,
      formType: r.formType,
      filedAt: r.filedAt,
      source: r.source,
      score: results.get(r.chunkId)?.score ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Build the evidence context block injected into agent prompts. */
export async function vaultContext(ticker: string, queries: string[], perQuery = 3): Promise<string> {
  const seen = new Set<number>();
  const blocks: string[] = [];
  for (const q of queries) {
    const hits = await searchVault(q, { ticker, limit: perQuery });
    for (const h of hits) {
      if (seen.has(h.chunkId)) continue;
      seen.add(h.chunkId);
      blocks.push(
        `[SOURCE: ${h.title}${h.formType ? ` (${h.formType})` : ""}${h.filedAt ? `, filed ${h.filedAt}` : ""}]\n${h.text.slice(0, 1600)}`,
      );
    }
  }
  if (blocks.length === 0) return "";
  return `PRIMARY-SOURCE EVIDENCE FROM THE VAULT (real documents — claims supported by these excerpts may be classified as "fact" and must cite the source title):\n\n${blocks.slice(0, 10).join("\n\n---\n\n")}`;
}
