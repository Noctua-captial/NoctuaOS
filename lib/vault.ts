import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { embedMany, embed } from "ai";
import { embeddingModelFor } from "@/lib/models";

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

// ---------- embeddings (optional — resolved through the model router) ----------
// The embedding model is configured in lib/models.ts (ROUTING.embeddings) and
// overridable via NOCTUA_MODEL_EMBEDDINGS, rather than being hardcoded here.
function embedder() {
  return embeddingModelFor()?.model ?? null;
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
        embedding: embeddings[i] ? JSON.stringify(embeddings[i]) : null,
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

function tsQuery(query: string): string {
  // Sanitize to alphanumeric terms, OR-joined for recall. Safe for to_tsquery
  // because every term is plain alphanumeric (no tsquery operators leak in).
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 12);
  return terms.join(" | ");
}

export async function searchVault(
  query: string,
  opts: { ticker?: string; limit?: number } = {},
): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 8;
  const results = new Map<number, { score: number }>();

  // 1) Postgres full-text search over the generated chunks.tsv column.
  const tq = tsQuery(query);
  if (tq) {
    const rows = (await db.execute(sql`
      SELECT id, ts_rank(tsv, to_tsquery('english', ${tq})) AS rank
      FROM chunks
      WHERE tsv @@ to_tsquery('english', ${tq})
      ORDER BY rank DESC
      LIMIT ${limit * 3}
    `)) as unknown as { id: number; rank: number }[];
    rows.forEach((r, i) => {
      results.set(Number(r.id), { score: 1 - i / (rows.length || 1) });
    });
  }

  // 2) Embedding search when available
  const model = embedder();
  if (model) {
    try {
      const { embedding: qVec } = await embed({ model, value: query });
      const embedded = await db
        .select({ id: tables.chunks.id, embedding: tables.chunks.embedding })
        .from(tables.chunks)
        .where(isNotNull(tables.chunks.embedding));
      const scored = embedded
        .map((row) => {
          const v = JSON.parse(row.embedding as string) as number[];
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
