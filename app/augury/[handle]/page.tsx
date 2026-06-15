import Link from "next/link";
import { desc, eq, inArray, and } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  StanceChip,
  LifecycleChip,
  HorizonChip,
  ConvictionChip,
  OutcomeChip,
  RegimeChip,
  fmtSignedPct,
  alphaClass,
} from "@/components/augury-ui";
import type {
  AuthorPlaybook,
  ConvictionCalibrationBucket,
  ReturnWindows,
  SliceStat,
} from "@/lib/augury/types";

export const dynamic = "force-dynamic";

const HORIZON_ORDER: Record<string, number> = {
  "7d": 1,
  "30d": 2,
  "90d": 3,
  "180d": 4,
  "365d": 5,
  to_date: 6,
};

type CallRow = {
  id: number;
  postId: number;
  ticker: string | null;
  stance: string;
  lifecycleStage: string;
  conviction: number | null;
  horizon: string | null;
  thesisSummary: string | null;
  catalyst: string | null;
  targetPrice: number | null;
  isUpdateOf: number | null;
  rawQuote: string | null;
  postText: string;
  postUrl: string | null;
  postedAt: Date | null;
};
type BacktestRow = typeof tables.backtests.$inferSelect;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

function shortDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(5, 10); // MM-DD
}

/** Walk isUpdateOf to the topmost ancestor present in the call set (cycle-guarded). */
function rootOf(id: number, byId: Map<number, CallRow>): number {
  const seen = new Set<number>();
  let cur = id;
  for (;;) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const parent = byId.get(cur)?.isUpdateOf ?? null;
    if (parent == null || !byId.has(parent)) return cur;
    cur = parent;
  }
}

function SliceTable({ title, slices }: { title: string; slices: Record<string, SliceStat> }) {
  const entries = Object.entries(slices).sort((a, b) => b[1].n - a[1].n);
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="label mb-2 !text-[8.5px]">{title}</div>
      <div className="space-y-1">
        {entries.map(([k, s]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="text-parchment-dim">{k.replace(/_/g, " ")}</span>
            <span className="fin flex items-baseline gap-2">
              <span className={alphaClass(s.avgAlphaPct)}>{fmtSignedPct(s.avgAlphaPct)}</span>
              <span className="text-parchment">
                {s.hitRate != null ? `${(s.hitRate * 100).toFixed(0)}%` : "—"}
              </span>
              <span className="text-parchment-faint">n{s.n}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function AuthorPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle: rawHandle } = await params;
  const handle = decodeURIComponent(rawHandle).replace(/^@/, "");

  const [author] = await db
    .select()
    .from(tables.authors)
    .where(and(eq(tables.authors.platform, "x"), eq(tables.authors.handle, handle)))
    .limit(1);

  if (!author) {
    return (
      <div>
        <div className="border-b border-line px-10 py-8">
          <Link href="/augury" className="label hover:text-parchment-dim">
            ← Augury
          </Link>
          <h1 className="serif mt-2 text-4xl font-medium text-parchment">@{handle}</h1>
        </div>
        <div className="px-10 py-8">
          <div className="card px-6 py-10 text-sm leading-relaxed text-parchment-dim">
            <p className="serif text-xl text-parchment">No data for @{handle} yet.</p>
            <p className="mt-3">
              Add the handle to <span className="fin text-parchment">lib/augury/authors.config.ts</span> (if
              missing), set <span className="fin text-parchment">APIFY_TOKEN</span>, then run{" "}
              <span className="fin text-parchment">npx tsx scripts/augury-backfill.ts</span> and{" "}
              <span className="fin text-parchment">RUN PIPELINE</span> from the overview.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const [scorecard] = await db
    .select()
    .from(tables.authorScorecards)
    .where(eq(tables.authorScorecards.authorId, author.id))
    .limit(1);

  const callRows: CallRow[] = await db
    .select({
      id: tables.calls.id,
      postId: tables.calls.postId,
      ticker: tables.calls.ticker,
      stance: tables.calls.stance,
      lifecycleStage: tables.calls.lifecycleStage,
      conviction: tables.calls.conviction,
      horizon: tables.calls.horizon,
      thesisSummary: tables.calls.thesisSummary,
      catalyst: tables.calls.catalyst,
      targetPrice: tables.calls.targetPrice,
      isUpdateOf: tables.calls.isUpdateOf,
      rawQuote: tables.calls.rawQuote,
      postText: tables.posts.text,
      postUrl: tables.posts.url,
      postedAt: tables.posts.postedAt,
    })
    .from(tables.calls)
    .innerJoin(tables.posts, eq(tables.calls.postId, tables.posts.id))
    .where(eq(tables.calls.authorId, author.id))
    .orderBy(desc(tables.posts.postedAt));

  const postIds = callRows.map((c) => c.postId);
  const callIds = callRows.map((c) => c.id);

  const [ctxRows, btRows] = await Promise.all([
    postIds.length
      ? db.select().from(tables.postContext).where(inArray(tables.postContext.postId, postIds))
      : Promise.resolve([]),
    callIds.length
      ? db.select().from(tables.backtests).where(inArray(tables.backtests.callId, callIds))
      : Promise.resolve([]),
  ]);

  const ctxByPost = new Map(ctxRows.map((c) => [c.postId, c]));
  const btByCall = new Map<number, BacktestRow[]>();
  for (const b of btRows as BacktestRow[]) {
    const list = btByCall.get(b.callId);
    if (list) list.push(b);
    else btByCall.set(b.callId, [b]);
  }
  for (const list of btByCall.values()) {
    list.sort((a, b) => (HORIZON_ORDER[a.horizon] ?? 99) - (HORIZON_ORDER[b.horizon] ?? 99));
  }

  // Reconstruct positions: group calls into lifecycle threads via isUpdateOf.
  const byId = new Map(callRows.map((c) => [c.id, c]));
  const groups = new Map<number, CallRow[]>();
  for (const c of callRows) {
    const root = rootOf(c.id, byId);
    const list = groups.get(root);
    if (list) list.push(c);
    else groups.set(root, [c]);
  }
  const positions = [...groups.values()]
    .map((calls) => [...calls].sort((a, b) => (a.postedAt?.getTime() ?? 0) - (b.postedAt?.getTime() ?? 0)))
    .filter((calls) => calls.length >= 2) // singletons live in the timeline below
    .sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return (b[b.length - 1].postedAt?.getTime() ?? 0) - (a[a.length - 1].postedAt?.getTime() ?? 0);
    });
  const singletonCount = callRows.length - positions.reduce((s, g) => s + g.length, 0);

  const playbook = parseJson<AuthorPlaybook | null>(scorecard?.playbook ?? null, null);
  const byHorizon = parseJson<Record<string, SliceStat>>(scorecard?.byHorizon ?? null, {});
  const byStance = parseJson<Record<string, SliceStat>>(scorecard?.byStance ?? null, {});
  const bySector = parseJson<Record<string, SliceStat>>(scorecard?.bySector ?? null, {});
  const calibration = parseJson<ConvictionCalibrationBucket[]>(scorecard?.convictionCalibration ?? null, []);

  const hitRate = scorecard?.hitRate ?? null;

  return (
    <div>
      <div className="border-b border-line px-10 py-8">
        <div className="mb-2 flex items-center justify-between">
          <Link href="/augury" className="label hover:text-parchment-dim">
            ← Augury
          </Link>
          {!author.active && <span className="label !text-warn">PAUSED</span>}
        </div>
        <div className="flex items-end justify-between gap-8">
          <div>
            <h1 className="serif text-4xl font-medium text-parchment">@{author.handle}</h1>
            {author.displayName && <div className="mt-1 text-sm text-parchment-dim">{author.displayName}</div>}
            {author.bio && <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-parchment-dim">{author.bio}</p>}
          </div>
          <div className="text-right">
            <div
              className={`fin text-4xl leading-none ${
                hitRate == null
                  ? "text-parchment-faint"
                  : hitRate >= 0.55
                    ? "text-bull"
                    : hitRate >= 0.45
                      ? "text-warn"
                      : "text-bear"
              }`}
            >
              {hitRate == null ? "—" : `${(hitRate * 100).toFixed(0)}%`}
            </div>
            <div className="label !text-[8px]">hit-rate · {scorecard?.sampleSize ?? 0} scored</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        {/* Left: positions + timeline */}
        <div className="col-span-8 space-y-8">
          {positions.length > 0 && (
            <section>
              <div className="mb-3 flex items-baseline justify-between">
                <span className="label">Reconstructed Positions — threaded lifecycles</span>
                <span className="label !text-[8px]">{positions.length} threaded</span>
              </div>
              <div className="space-y-3">
                {positions.map((calls) => {
                  const head = calls[calls.length - 1];
                  return (
                    <div key={calls[0].id} className="card px-5 py-4">
                      <div className="flex items-center gap-3">
                        <span className="fin text-sm text-parchment">{head.ticker ?? "—"}</span>
                        <StanceChip stance={head.stance} />
                        <span className="label ml-auto !text-[8px]">{calls.length} updates</span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {calls.map((c, i) => (
                          <span key={c.id} className="flex items-center gap-2">
                            {i > 0 && <span className="text-parchment-faint">→</span>}
                            <Link
                              href={`/augury/post/${c.postId}`}
                              className="flex items-center gap-1.5 border border-line px-2 py-1 transition-colors hover:border-line-strong"
                            >
                              <span className="fin text-[10px] text-platinum">{c.lifecycleStage}</span>
                              <span className="fin text-[9px] text-parchment-faint">{shortDate(c.postedAt)}</span>
                            </Link>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {singletonCount > 0 && (
                <p className="mt-2 text-[10.5px] text-parchment-faint">
                  + {singletonCount} single-post call{singletonCount === 1 ? "" : "s"} in the timeline below.
                </p>
              )}
            </section>
          )}

          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="label">Call Timeline — newest first</span>
              <span className="label !text-[8px]">{callRows.length} calls</span>
            </div>
            <div className="space-y-3">
              {callRows.map((c) => {
                const ctx = ctxByPost.get(c.postId);
                const returns = ctx ? parseJson<ReturnWindows | null>(ctx.returns, null) : null;
                const bts = btByCall.get(c.id) ?? [];
                return (
                  <div key={c.id} className="card px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="fin text-sm text-parchment">{c.ticker ?? "—"}</span>
                      <StanceChip stance={c.stance} />
                      <LifecycleChip stage={c.lifecycleStage} />
                      <HorizonChip horizon={c.horizon} />
                      <ConvictionChip conviction={c.conviction} />
                      <span className="fin ml-auto text-[10px] text-parchment-faint">{fmtDate(c.postedAt)}</span>
                    </div>

                    <Link href={`/augury/post/${c.postId}`} className="mt-2.5 block">
                      <p className="text-[13px] leading-relaxed text-parchment hover:text-parchment-dim">
                        {c.postText.length > 240 ? `${c.postText.slice(0, 240)}…` : c.postText}
                      </p>
                    </Link>

                    {c.thesisSummary && (
                      <p className="mt-2 border-l border-line-strong pl-3 text-[12px] leading-relaxed text-parchment-dim">
                        {c.thesisSummary}
                      </p>
                    )}

                    {/* context chips */}
                    {ctx && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                        <RegimeChip regime={ctx.marketRegime} />
                        {ctx.vix != null && (
                          <span className="fin text-[10px] text-parchment-faint">VIX {ctx.vix.toFixed(1)}</span>
                        )}
                        {returns?.["-5d"] != null && (
                          <span className="fin text-[10px] text-parchment-faint">
                            −5d <span className={alphaClass(returns["-5d"])}>{fmtSignedPct(returns["-5d"])}</span>
                          </span>
                        )}
                        {returns?.["+5d"] != null && (
                          <span className="fin text-[10px] text-parchment-faint">
                            +5d <span className={alphaClass(returns["+5d"])}>{fmtSignedPct(returns["+5d"])}</span>
                          </span>
                        )}
                        {returns?.["+30d"] != null && (
                          <span className="fin text-[10px] text-parchment-faint">
                            +30d <span className={alphaClass(returns["+30d"])}>{fmtSignedPct(returns["+30d"])}</span>
                          </span>
                        )}
                        {ctx.sectorMovePct != null && (
                          <span className="fin text-[10px] text-parchment-faint">
                            sector <span className={alphaClass(ctx.sectorMovePct)}>{fmtSignedPct(ctx.sectorMovePct)}</span>
                          </span>
                        )}
                      </div>
                    )}

                    {/* backtest outcomes */}
                    {bts.length > 0 && (
                      <div className="card-rule mt-3 flex flex-wrap items-center gap-2 pt-3">
                        {bts.map((b) => (
                          <span key={b.id} className="flex items-center gap-1.5">
                            <span className="fin text-[9px] text-parchment-faint">{b.horizon}</span>
                            <span className={`fin text-[10px] ${alphaClass(b.alphaPct)}`}>
                              {fmtSignedPct(b.alphaPct)}
                            </span>
                            <OutcomeChip outcome={b.outcome} />
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {callRows.length === 0 && (
                <div className="card px-5 py-10 text-center text-sm text-parchment-faint">
                  No calls extracted yet. Ingest posts, then RUN PIPELINE with an LLM key configured to decode them
                  into structured calls.
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right: playbook + scorecard */}
        <div className="col-span-4 space-y-8">
          <section>
            <div className="label mb-3">Playbook</div>
            <div className="card px-5 py-4">
              {playbook ? (
                <>
                  <p className="text-[13px] leading-relaxed text-parchment-dim">{playbook.summary}</p>
                  {playbook.edges.length > 0 && (
                    <div className="card-rule mt-4 pt-3">
                      <div className="label mb-1.5 !text-[8.5px] !text-bull">Edges</div>
                      <ul className="space-y-1">
                        {playbook.edges.map((e, i) => (
                          <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-parchment-dim">
                            <span className="text-bull">▲</span>
                            {e}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {playbook.weaknesses.length > 0 && (
                    <div className="card-rule mt-3 pt-3">
                      <div className="label mb-1.5 !text-[8.5px] !text-bear">Weaknesses</div>
                      <ul className="space-y-1">
                        {playbook.weaknesses.map((w, i) => (
                          <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-parchment-dim">
                            <span className="text-bear">▼</span>
                            {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="py-2 text-xs text-parchment-faint">
                  No playbook yet. It is synthesized once calls have been backtested (RUN PIPELINE).
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="label mb-3">Scorecard</div>
            <div className="card px-5 py-4">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div
                    className={`fin text-lg leading-none ${
                      hitRate == null ? "text-parchment-faint" : hitRate >= 0.5 ? "text-bull" : "text-bear"
                    }`}
                  >
                    {hitRate == null ? "—" : `${(hitRate * 100).toFixed(0)}%`}
                  </div>
                  <div className="label !text-[7.5px]">hit-rate</div>
                </div>
                <div>
                  <div className={`fin text-lg leading-none ${alphaClass(scorecard?.avgAlphaPct ?? null)}`}>
                    {fmtSignedPct(scorecard?.avgAlphaPct ?? null)}
                  </div>
                  <div className="label !text-[7.5px]">avg alpha</div>
                </div>
                <div>
                  <div className="fin text-lg leading-none text-parchment">{scorecard?.sampleSize ?? 0}</div>
                  <div className="label !text-[7.5px]">scored</div>
                </div>
              </div>

              {(Object.keys(byStance).length > 0 ||
                Object.keys(byHorizon).length > 0 ||
                Object.keys(bySector).length > 0) && (
                <div className="card-rule mt-4 space-y-4 pt-4">
                  <SliceTable title="By stance" slices={byStance} />
                  <SliceTable title="By horizon" slices={byHorizon} />
                  <SliceTable title="By sector" slices={bySector} />
                </div>
              )}

              {calibration.length > 0 && (
                <div className="card-rule mt-4 pt-4">
                  <div className="label mb-2 !text-[8.5px]">Conviction calibration</div>
                  <div className="space-y-1">
                    {calibration.map((c) => (
                      <div key={c.bucket} className="flex items-baseline justify-between gap-2 text-[11px]">
                        <span className="fin text-parchment-faint">{c.bucket}</span>
                        <span className="fin flex items-baseline gap-2">
                          <span className="text-parchment-dim">pred {(c.predicted * 100).toFixed(0)}%</span>
                          <span className="text-parchment">
                            real {c.realizedHitRate != null ? `${(c.realizedHitRate * 100).toFixed(0)}%` : "—"}
                          </span>
                          <span className="text-parchment-faint">n{c.n}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!scorecard && (
                <p className="card-rule mt-4 pt-4 text-xs text-parchment-faint">
                  No scorecard yet — it materializes after the pipeline backtests this author&apos;s calls.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
