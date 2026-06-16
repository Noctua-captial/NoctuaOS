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
import { SubjectTypeChip, SizeDeltaChip } from "@/components/augury-chips";
import { PositionsTimeline, type PositionCall } from "@/components/augury-positions";
import { AugurySearchBox } from "@/components/augury-search";
import { AugurySearchResults, normalizeSearchHits, type SearchHit } from "@/components/augury-search-results";
import { searchPosts } from "@/lib/augury/resolve";
import type {
  AuthorPlaybook,
  ConvictionCalibrationBucket,
  Position,
  ReturnWindows,
  SizeTrajectoryEvent,
  SliceStat,
  ThesisEvolutionEvent,
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
  subjectType: string | null;
  stance: string;
  lifecycleStage: string;
  sizeDelta: string | null;
  conviction: number | null;
  horizon: string | null;
  thesisSummary: string | null;
  catalyst: string | null;
  targetPrice: number | null;
  positionId: number | null;
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

export default async function AuthorPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { handle: rawHandle } = await params;
  const { q: rawQ } = await searchParams;
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
      subjectType: tables.calls.subjectType,
      stance: tables.calls.stance,
      lifecycleStage: tables.calls.lifecycleStage,
      sizeDelta: tables.calls.sizeDelta,
      conviction: tables.calls.conviction,
      horizon: tables.calls.horizon,
      thesisSummary: tables.calls.thesisSummary,
      catalyst: tables.calls.catalyst,
      targetPrice: tables.calls.targetPrice,
      positionId: tables.calls.positionId,
      rawQuote: tables.calls.rawQuote,
      postText: tables.posts.text,
      postUrl: tables.posts.url,
      postedAt: tables.posts.postedAt,
    })
    .from(tables.calls)
    .innerJoin(tables.posts, eq(tables.calls.postId, tables.posts.id))
    .where(eq(tables.calls.authorId, author.id))
    .orderBy(desc(tables.posts.postedAt));

  const positionRows = await db
    .select()
    .from(tables.auguryPositions)
    .where(eq(tables.auguryPositions.authorId, author.id))
    .orderBy(desc(tables.auguryPositions.updatedAt));

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

  // First-class Positions (v2): parse the materialized campaigns the `link` stage
  // built, and thread each position's linked calls (calls.positionId) into a
  // time-ordered lifecycle for the chip sequence.
  const positions: Position[] = positionRows.map((p) => ({
    id: p.id,
    authorId: p.authorId,
    subjectType: p.subjectType as Position["subjectType"],
    subject: p.subject,
    direction: p.direction,
    status: p.status as Position["status"],
    currentStage: p.currentStage as Position["currentStage"],
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    peakConviction: p.peakConviction,
    firstCallId: p.firstCallId,
    lastCallId: p.lastCallId,
    sizeTrajectory: parseJson<SizeTrajectoryEvent[]>(p.sizeTrajectory, []),
    thesisEvolution: parseJson<ThesisEvolutionEvent[]>(p.thesisEvolution, []),
    realizedOutcome: p.realizedOutcome,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  const tickerPositions = positions.filter((p) => p.subjectType === "ticker");
  const themePositions = positions.filter((p) => p.subjectType === "theme" || p.subjectType === "macro");
  const positionSubjectById = new Map(positions.map((p) => [p.id, p.subject]));

  const callsByPosition = new Map<number, PositionCall[]>();
  for (const c of callRows) {
    if (c.positionId == null) continue;
    const lite: PositionCall = {
      id: c.id,
      postId: c.postId,
      lifecycleStage: c.lifecycleStage,
      sizeDelta: c.sizeDelta,
      conviction: c.conviction,
      postedAt: c.postedAt,
    };
    const list = callsByPosition.get(c.positionId);
    if (list) list.push(lite);
    else callsByPosition.set(c.positionId, [lite]);
  }
  for (const list of callsByPosition.values()) {
    list.sort((a, b) => (a.postedAt?.getTime() ?? 0) - (b.postedAt?.getTime() ?? 0));
  }

  const posOpen = positions.filter((p) => p.status === "open").length;
  const posWatching = positions.filter((p) => p.status === "watching").length;
  const posClosed = positions.filter((p) => p.status === "closed").length;

  // Semantic memory scoped to this author. searchPosts is sibling-WIP; degrade
  // gracefully if it throws (keyless embeddings, empty corpus).
  const q = (rawQ ?? "").trim();
  let searchHits: SearchHit[] = [];
  const searchHandleById = new Map<number, string>([[author.id, author.handle]]);
  if (q) {
    try {
      searchHits = normalizeSearchHits(await searchPosts(q, { authorId: author.id, limit: 24 }));
    } catch {
      searchHits = [];
    }
  }

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

      {/* semantic memory scoped to this author */}
      <div className="px-10 pt-6">
        <div className="label mb-3">Semantic Memory — everything @{author.handle} ever said about…</div>
        <AugurySearchBox initialQuery={q} placeholder={`everything @${author.handle} ever said about…`} />
        {q && (
          <div className="mt-4">
            <AugurySearchResults query={q} hits={searchHits} handleById={searchHandleById} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        {/* Left: positions + timeline */}
        <div className="col-span-8 space-y-8">
          <PositionsTimeline
            title="Positions — tradable campaigns"
            countLabel="tickers"
            positions={tickerPositions}
            callsByPosition={callsByPosition}
            emptyState={
              callRows.length > 0
                ? "No ticker positions linked yet. The link stage threads calls into campaigns (watching → open → closed) — run the pipeline to materialize them."
                : "No positions yet. Ingest posts and run the pipeline to thread calls into campaigns."
            }
          />

          <PositionsTimeline
            title="Themes & Macro — qualitative campaigns"
            countLabel="themes"
            positions={themePositions}
            callsByPosition={callsByPosition}
            emptyState="No theme or macro positions yet. These surface when the author makes sector/industry or macro calls (subjectType theme/macro)."
          />

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
                const subjectLabel =
                  c.ticker ?? (c.positionId != null ? positionSubjectById.get(c.positionId) ?? null : null) ?? "—";
                return (
                  <div key={c.id} className="card px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="fin text-sm text-parchment">{subjectLabel}</span>
                      {c.subjectType && c.subjectType !== "ticker" && <SubjectTypeChip subjectType={c.subjectType} />}
                      <StanceChip stance={c.stance} />
                      <LifecycleChip stage={c.lifecycleStage} />
                      <SizeDeltaChip sizeDelta={c.sizeDelta} />
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

              {/* position-aware rollup — campaign lifecycle, not just per-call hits */}
              <div className="card-rule mt-4 grid grid-cols-4 gap-2 pt-4">
                <div>
                  <div className="fin text-lg leading-none text-parchment">{positions.length}</div>
                  <div className="label !text-[7.5px]">campaigns</div>
                </div>
                <div>
                  <div className={`fin text-lg leading-none ${posOpen > 0 ? "text-bull" : "text-parchment-faint"}`}>
                    {posOpen}
                  </div>
                  <div className="label !text-[7.5px]">open</div>
                </div>
                <div>
                  <div className={`fin text-lg leading-none ${posWatching > 0 ? "text-warn" : "text-parchment-faint"}`}>
                    {posWatching}
                  </div>
                  <div className="label !text-[7.5px]">watching</div>
                </div>
                <div>
                  <div className="fin text-lg leading-none text-parchment-dim">{posClosed}</div>
                  <div className="label !text-[7.5px]">closed</div>
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
