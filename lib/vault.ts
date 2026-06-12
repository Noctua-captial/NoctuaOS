import { eq, inArray } from "drizzle-orm";
import { db, tables, sqliteRaw } from "@/db";
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
  const [doc] = db
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
    .returning()
    .all();

  const pieces = chunkText(opts.content);
  const embeddings = await tryEmbedMany(pieces);

  if (pieces.length > 0) {
    db.insert(tables.chunks)
      .values(
        pieces.map((text, i) => ({
          documentId: doc.id,
          idx: i,
          text,
          embedding: embeddings[i] ? JSON.stringify(embeddings[i]) : null,
        })),
      )
      .run();
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

function ftsQuery(query: string): string {
  // sanitize into OR-joined terms so raw user text can't break FTS syntax
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 12);
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export async function searchVault(
  query: string,
  opts: { ticker?: string; limit?: number } = {},
): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 8;
  const results = new Map<number, { score: number }>();

  // 1) FTS keyword search (always available)
  const q = ftsQuery(query);
  if (q) {
    const rows = sqliteRaw
      .prepare(
        `SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(q, limit * 3) as { rowid: number; rank: number }[];
    rows.forEach((r, i) => {
      results.set(r.rowid, { score: 1 - i / (rows.length || 1) });
    });
  }

  // 2) Embedding search when available
  const model = embedder();
  if (model) {
    try {
      const { embedding: qVec } = await embed({ model, value: query });
      const embedded = sqliteRaw
        .prepare(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL`)
        .all() as { id: number; embedding: string }[];
      const scored = embedded
        .map((row) => {
          const v = JSON.parse(row.embedding) as number[];
          let dot = 0;
          for (let i = 0; i < v.length; i++) dot += v[i] * qVec[i];
          return { id: row.id, sim: dot }; // text-embedding-3 vectors are unit-normalized
        })
        .sort((a, b) => b.sim - a.sim)
        .slice(0, limit * 2);
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
