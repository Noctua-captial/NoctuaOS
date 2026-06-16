// Server-side rendering for semantic post-search results, plus a defensive
// normalizer for whatever shape `searchPosts` returns. The normalizer accepts
// `unknown` on purpose: the resolve worker is being built in parallel, so we
// stay decoupled from its exact return type (a post row, or a { post, score }
// wrapper, snake_case or camelCase) and read fields opportunistically.
import Link from "next/link";

export type SearchHit = {
  id: number;
  text: string;
  url: string | null;
  postedAt: Date | null;
  authorId: number | null;
  score: number | null;
};

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Coerce `searchPosts(...)`'s result into SearchHit[]. Tolerates: an array of
 * post rows, an array of { post, score } wrappers, snake_case columns, and a
 * variety of score field names. Anything without a numeric id is dropped.
 */
export function normalizeSearchHits(raw: unknown): SearchHit[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const nested = r.post && typeof r.post === "object" ? (r.post as Record<string, unknown>) : null;
    const post = nested ?? r;
    // searchPosts returns PostSearchHit { postId, ... }; tolerate id/post_id too.
    const id = asNum(post.postId ?? post.id ?? post.post_id);
    if (id == null) continue;
    out.push({
      id,
      text: typeof post.text === "string" ? post.text : "",
      url: typeof post.url === "string" ? post.url : null,
      postedAt: asDate(post.postedAt ?? post.posted_at),
      authorId: asNum(post.authorId ?? post.author_id),
      score: asNum(r.score ?? r.rank ?? r.similarity ?? r.distance ?? post.score),
    });
  }
  return out;
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

function excerpt(text: string, max = 220): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function AugurySearchResults({
  query,
  hits,
  handleById,
}: {
  query: string;
  hits: SearchHit[];
  handleById: Map<number, string>;
}) {
  return (
    <div className="space-y-3">
      <div className="label !text-[8.5px]">
        {hits.length} match{hits.length === 1 ? "" : "es"} for “{query}”
      </div>
      {hits.length === 0 ? (
        <div className="card px-5 py-8 text-center text-sm leading-relaxed text-parchment-faint">
          Nothing matched “{query}” yet. Semantic memory is built in the resolve stage (post embeddings); without an
          embeddings key it falls back to keyword search, and it only covers posts already ingested.
        </div>
      ) : (
        hits.map((h) => {
          const handle = h.authorId != null ? handleById.get(h.authorId) : undefined;
          return (
            <Link
              key={h.id}
              href={`/augury/post/${h.id}`}
              className="card block px-5 py-4 transition-colors hover:bg-ink-raised"
            >
              <div className="flex flex-wrap items-center gap-2">
                {handle && <span className="fin text-[11px] text-parchment-dim">@{handle}</span>}
                <span className="fin text-[10px] text-parchment-faint">{fmtDate(h.postedAt)}</span>
                {h.score != null && (
                  <span className="fin ml-auto text-[9px] text-parchment-faint">score {h.score.toFixed(3)}</span>
                )}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-parchment">{excerpt(h.text)}</p>
            </Link>
          );
        })
      )}
    </div>
  );
}
