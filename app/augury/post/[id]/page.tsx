import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  StanceChip,
  LifecycleChip,
  HorizonChip,
  ConvictionChip,
  OutcomeChip,
  RegimeChip,
  fmtSignedPct,
  fmtPct,
  alphaClass,
} from "@/components/augury-ui";
import { SubjectTypeChip, SizeDeltaChip, EntityChip } from "@/components/augury-chips";
import { AuguryPriceChart, type PriceBar } from "@/components/augury-price-chart";
import { addCalendarDaysISO, isoDateUTC } from "@/lib/augury/market/bars";
import type { MacroRates, NewsSnapshotItem, PostEntity, ReturnWindows, TweetMetrics } from "@/lib/augury/types";

export const dynamic = "force-dynamic";

const HORIZON_ORDER: Record<string, number> = {
  "7d": 1,
  "30d": 2,
  "90d": 3,
  "180d": 4,
  "365d": 5,
  to_date: 6,
};

const RETURN_KEYS: (keyof ReturnWindows)[] = ["-5d", "-1d", "+1d", "+5d", "+30d"];

type BacktestRow = typeof tables.backtests.$inferSelect;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fmtNum(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtPrice(n: number | null): string {
  return n == null ? "—" : n.toFixed(2);
}

export default async function PostDeepDive({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [post] = await db.select().from(tables.posts).where(eq(tables.posts.id, id)).limit(1);
  if (!post) notFound();

  const when = post.postedAt ?? post.ingestedAt ?? new Date();
  const dateISO = isoDateUTC(when);

  const [[author], calls, [ctx], mentions, entityRows, [macro]] = await Promise.all([
    db.select().from(tables.authors).where(eq(tables.authors.id, post.authorId)).limit(1),
    db.select().from(tables.calls).where(eq(tables.calls.postId, id)).orderBy(asc(tables.calls.id)),
    db.select().from(tables.postContext).where(eq(tables.postContext.postId, id)).limit(1),
    db.select().from(tables.tickerMentions).where(eq(tables.tickerMentions.postId, id)),
    db.select().from(tables.postEntities).where(eq(tables.postEntities.postId, id)),
    db.select().from(tables.macroContext).where(eq(tables.macroContext.date, dateISO)).limit(1),
  ]);

  // All calls' backtests (multi-entity): grouped per call for inline outcomes,
  // and a flat, (call, horizon)-ordered list for the detailed table.
  const callIds = calls.map((c) => c.id);
  const backtestRows = callIds.length
    ? await db.select().from(tables.backtests).where(inArray(tables.backtests.callId, callIds))
    : [];
  const btByCall = new Map<number, BacktestRow[]>();
  for (const b of backtestRows as BacktestRow[]) {
    const list = btByCall.get(b.callId);
    if (list) list.push(b);
    else btByCall.set(b.callId, [b]);
  }
  for (const list of btByCall.values()) {
    list.sort((a, b) => (HORIZON_ORDER[a.horizon] ?? 99) - (HORIZON_ORDER[b.horizon] ?? 99));
  }
  const backtests = [...backtestRows].sort(
    (a, b) => a.callId - b.callId || (HORIZON_ORDER[a.horizon] ?? 99) - (HORIZON_ORDER[b.horizon] ?? 99),
  );

  // Linked-position subjects, so theme/macro calls (which carry no ticker) label.
  const callPositionIds = [...new Set(calls.map((c) => c.positionId).filter((x): x is number => x != null))];
  const posSubjectById = new Map<number, string>();
  if (callPositionIds.length) {
    const prs = await db
      .select({ id: tables.auguryPositions.id, subject: tables.auguryPositions.subject })
      .from(tables.auguryPositions)
      .where(inArray(tables.auguryPositions.id, callPositionIds));
    for (const pr of prs) posSubjectById.set(pr.id, pr.subject);
  }

  const entities: PostEntity[] = entityRows.map((e) => ({
    entityType: e.entityType as PostEntity["entityType"],
    value: e.value,
    role: e.role as PostEntity["role"],
    confidence: e.confidence,
    companyId: e.companyId,
  }));

  const metrics = parseJson<TweetMetrics>(post.metrics, {});
  const returns = ctx ? parseJson<ReturnWindows | null>(ctx.returns, null) : null;
  const news = ctx ? parseJson<NewsSnapshotItem[]>(ctx.newsSnapshot, []) : [];
  const rates = macro ? parseJson<MacroRates | null>(macro.rates, null) : null;

  // Subject ticker for the price chart: a call's ticker, else the resolved
  // subject ticker entity, else the context's, else the top cashtag mention.
  const topMention = [...mentions].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  const tickerEntities = entities.filter((e) => e.entityType === "ticker");
  const subjectEntity =
    tickerEntities.find((e) => e.role === "subject") ??
    [...tickerEntities].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  const subjectTicker =
    (
      calls.find((c) => c.ticker)?.ticker ||
      subjectEntity?.value ||
      ctx?.ticker ||
      topMention?.ticker ||
      null
    )?.toUpperCase() ?? null;

  // Price-around-date bars: read ONLY stored dailyBars (the pipeline populates
  // them); never fetch here. Window: ±60 calendar days around the post.
  const barRows = subjectTicker
    ? await db
        .select({ date: tables.dailyBars.date, adjClose: tables.dailyBars.adjClose, close: tables.dailyBars.close })
        .from(tables.dailyBars)
        .where(
          and(
            eq(tables.dailyBars.ticker, subjectTicker),
            gte(tables.dailyBars.date, addCalendarDaysISO(dateISO, -60)),
            lte(tables.dailyBars.date, addCalendarDaysISO(dateISO, 60)),
          ),
        )
        .orderBy(asc(tables.dailyBars.date))
    : [];
  const bars: PriceBar[] = barRows
    .map((r) => ({ date: r.date, close: r.adjClose ?? r.close ?? NaN }))
    .filter((b) => Number.isFinite(b.close));

  const handle = author?.handle ?? `author#${post.authorId}`;

  return (
    <div>
      <div className="border-b border-line px-10 py-8">
        <div className="mb-2 flex items-center justify-between">
          <Link href={`/augury/${encodeURIComponent(handle)}`} className="label hover:text-parchment-dim">
            ← @{handle}
          </Link>
          {post.url && (
            <a href={post.url} target="_blank" rel="noreferrer" className="label hover:text-parchment-dim">
              VIEW ON X ↗
            </a>
          )}
        </div>
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="label mb-2">
              Post deep-dive — {when.toISOString().slice(0, 16).replace("T", " ")}
              {post.isReply ? " · reply" : ""}
              {post.isQuote ? " · quote" : ""}
              {post.isRetweet ? " · retweet" : ""}
            </div>
            <h1 className="serif text-3xl font-medium text-parchment">
              {subjectTicker ? `@${handle} on ${subjectTicker}` : `@${handle}`}
            </h1>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        {/* Left: tweet, interpretation, backtests */}
        <div className="col-span-7 space-y-8">
          {/* The tweet */}
          <section className="card px-6 py-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="label">The Post</span>
              {mentions.map((m) => (
                <span
                  key={m.id}
                  className="fin border border-line px-1.5 py-px text-[9px] uppercase tracking-[0.1em] text-parchment-dim"
                  title={`${m.mentionType} · confidence ${(m.confidence ?? 0).toFixed(2)}`}
                >
                  ${m.ticker}
                </span>
              ))}
            </div>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-parchment">{post.text}</p>

            {entities.length > 0 ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="label mr-1 !text-[8.5px]">Entities</span>
                {entities.map((e, i) => (
                  <EntityChip key={i} entity={e} />
                ))}
              </div>
            ) : (
              <p className="mt-4 text-[11px] leading-relaxed text-parchment-faint">
                No entities resolved yet — the resolve stage extracts tickers (even without cashtags), company names,
                themes, and macro topics.
              </p>
            )}

            <div className="card-rule mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 pt-3">
              {(
                [
                  ["likes", metrics.likes],
                  ["RTs", metrics.retweets],
                  ["replies", metrics.replies],
                  ["quotes", metrics.quotes],
                  ["views", metrics.views],
                ] as [string, number | undefined][]
              ).map(([label, v]) => (
                <span key={label} className="fin text-[10px] text-parchment-faint">
                  {label} <span className="text-parchment-dim">{fmtNum(v)}</span>
                </span>
              ))}
            </div>
          </section>

          {/* LLM interpretation — one card per extracted call (multi-entity) */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <span className="label">
                Interpretation — {calls.length} call{calls.length === 1 ? "" : "s"}
              </span>
              {calls.length > 1 && <span className="label !text-[8px]">multi-entity</span>}
            </div>
            {calls.length > 0 ? (
              <div className="space-y-3">
                {calls.map((call) => {
                  const subjectLabel =
                    call.ticker ??
                    (call.positionId != null ? posSubjectById.get(call.positionId) ?? null : null) ??
                    "—";
                  const outcomes = btByCall.get(call.id) ?? [];
                  return (
                    <div key={call.id} className="card px-6 py-5">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="fin text-sm text-parchment">{subjectLabel}</span>
                        {call.subjectType && call.subjectType !== "ticker" && (
                          <SubjectTypeChip subjectType={call.subjectType} />
                        )}
                        <StanceChip stance={call.stance} />
                        <LifecycleChip stage={call.lifecycleStage} />
                        <SizeDeltaChip sizeDelta={call.sizeDelta} />
                        <HorizonChip horizon={call.horizon} />
                        <ConvictionChip conviction={call.conviction} />
                      </div>
                      {call.thesisSummary && (
                        <p className="text-[14px] leading-relaxed text-parchment">{call.thesisSummary}</p>
                      )}
                      <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 text-[12px]">
                        {call.catalyst && (
                          <p className="text-parchment-dim">
                            <span className="label mr-2 !text-[8.5px]">Catalyst</span>
                            {call.catalyst}
                          </p>
                        )}
                        {call.targetPrice != null && (
                          <p className="text-parchment-dim">
                            <span className="label mr-2 !text-[8.5px]">Target</span>
                            <span className="fin">{call.targetPrice.toFixed(2)}</span>
                          </p>
                        )}
                      </div>
                      {call.rawQuote && (
                        <p className="card-rule mt-4 pt-3 text-[12.5px] italic leading-relaxed text-parchment-dim">
                          “{call.rawQuote}”
                        </p>
                      )}
                      {outcomes.length > 0 && (
                        <div className="card-rule mt-3 flex flex-wrap items-center gap-2 pt-3">
                          {outcomes.map((b) => (
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
                      {call.extractorModel && (
                        <p className="mt-2 fin text-[9px] text-parchment-faint">decoded by {call.extractorModel}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="card px-6 py-5">
                <p className="py-2 text-xs leading-relaxed text-parchment-faint">
                  Not yet interpreted. The extraction pass either hasn&apos;t run, found no market-relevant content, or
                  no LLM key is configured (the interpretation step no-ops keylessly).
                </p>
              </div>
            )}
          </section>

          {/* Backtests */}
          <section>
            <div className="label mb-3">Backtest — no-lookahead, benchmark-relative</div>
            <div className="card px-2 py-2">
              {backtests.length > 0 ? (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="label !text-[8px]">
                      <th className="px-2 py-2 text-left font-normal">Subject</th>
                      <th className="px-2 py-2 text-left font-normal">Horizon</th>
                      <th className="px-2 py-2 text-right font-normal">Entry</th>
                      <th className="px-2 py-2 text-right font-normal">Eval</th>
                      <th className="px-2 py-2 text-right font-normal">Raw</th>
                      <th className="px-2 py-2 text-right font-normal">Bench</th>
                      <th className="px-2 py-2 text-right font-normal">Alpha</th>
                      <th className="px-2 py-2 text-right font-normal">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backtests.map((b) => (
                      <tr key={b.id} className="border-t border-line">
                        <td className="px-2 py-2">
                          <span className="fin text-[12px] text-parchment">{b.ticker}</span>
                        </td>
                        <td className="px-2 py-2">
                          <span className="fin text-[12px] text-parchment-dim">{b.horizon}</span>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span className="fin text-[11px] text-parchment-dim">{fmtPrice(b.entryPrice)}</span>
                          <span className="fin block text-[8.5px] text-parchment-faint">{b.entryDate}</span>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span className="fin text-[11px] text-parchment-dim">{fmtPrice(b.evalPrice)}</span>
                          <span className="fin block text-[8.5px] text-parchment-faint">{b.evalDate}</span>
                        </td>
                        <td className={`fin px-2 py-2 text-right text-[11px] ${alphaClass(b.rawReturnPct)}`}>
                          {fmtSignedPct(b.rawReturnPct)}
                        </td>
                        <td className="fin px-2 py-2 text-right text-[11px] text-parchment-dim">
                          {fmtPct(b.benchmarkReturnPct)}
                        </td>
                        <td className={`fin px-2 py-2 text-right text-[11px] ${alphaClass(b.alphaPct)}`}>
                          {fmtSignedPct(b.alphaPct)}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <OutcomeChip outcome={b.outcome} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="px-3 py-4 text-xs leading-relaxed text-parchment-faint">
                  {calls.length > 0
                    ? "Not yet backtested. Needs a ticker plus stored price history; RUN PIPELINE to score these across horizons."
                    : "No calls to backtest yet."}
                </p>
              )}
              {backtests.some((b) => b.judgeNotes) && (
                <div className="card-rule mt-1 space-y-1 px-3 py-3">
                  {backtests
                    .filter((b) => b.judgeNotes)
                    .map((b) => (
                      <p key={b.id} className="text-[11px] leading-relaxed text-parchment-faint">
                        <span className="fin text-parchment-dim">{b.horizon}</span> — {b.judgeNotes}
                      </p>
                    ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right: market context + price chart */}
        <div className="col-span-5 space-y-8">
          <section>
            <div className="label mb-3">Market Context — as of the post</div>
            <div className="card px-5 py-4">
              {ctx ? (
                <>
                  <div className="flex items-center justify-between">
                    <RegimeChip regime={ctx.marketRegime} />
                    <span className="fin text-[11px] text-parchment-faint">
                      {ctx.vix != null ? `VIX ${ctx.vix.toFixed(1)}` : "VIX —"}
                    </span>
                  </div>

                  <div className="card-rule mt-3 pt-3">
                    <div className="label mb-2 !text-[8.5px]">
                      Return windows{ctx.ticker ? ` · ${ctx.ticker}` : ""}
                    </div>
                    <div className="grid grid-cols-5 gap-1">
                      {RETURN_KEYS.map((k) => {
                        const v = returns?.[k] ?? null;
                        return (
                          <div key={k} className="text-center">
                            <div className={`fin text-[11px] ${alphaClass(v)}`}>{fmtSignedPct(v)}</div>
                            <div className="label !text-[7px]">{k}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {ctx.sectorMovePct != null && (
                    <div className="card-rule mt-3 flex items-baseline justify-between pt-3">
                      <span className="label !text-[8.5px]">Sector ETF move</span>
                      <span className={`fin text-[12px] ${alphaClass(ctx.sectorMovePct)}`}>
                        {fmtSignedPct(ctx.sectorMovePct)}
                      </span>
                    </div>
                  )}

                  {news.length > 0 && (
                    <div className="card-rule mt-3 pt-3">
                      <div className="label mb-2 !text-[8.5px]">News snapshot</div>
                      <ul className="space-y-1.5">
                        {news.map((n, i) => (
                          <li key={i} className="text-[11px] leading-relaxed">
                            {n.url ? (
                              <a
                                href={n.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-parchment-dim hover:text-parchment"
                              >
                                {n.title}
                              </a>
                            ) : (
                              <span className="text-parchment-dim">{n.title}</span>
                            )}
                            {n.source && <span className="fin ml-1 text-[9px] text-parchment-faint">· {n.source}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="py-2 text-xs leading-relaxed text-parchment-faint">
                  Not yet computed. The context stage builds return windows, regime, VIX and a news snapshot when the
                  pipeline runs.
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="label mb-3">Macro · World — as of {dateISO}</div>
            <div className="card px-5 py-4">
              {macro ? (
                <>
                  <div className="flex items-center justify-between">
                    <RegimeChip regime={macro.regime} />
                    <span className="fin text-[11px] text-parchment-faint">
                      {macro.vix != null ? `VIX ${macro.vix.toFixed(1)}` : "VIX —"}
                    </span>
                  </div>

                  <div className="card-rule mt-3 grid grid-cols-2 gap-x-6 gap-y-2 pt-3">
                    <div className="flex items-baseline justify-between">
                      <span className="label !text-[8px]">SPX</span>
                      <span className="fin text-[12px] text-parchment-dim">
                        {macro.sp500 != null ? macro.sp500.toFixed(0) : "—"}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="label !text-[8px]">SPX 5d</span>
                      <span className={`fin text-[12px] ${alphaClass(macro.sp500Return5dPct)}`}>
                        {fmtSignedPct(macro.sp500Return5dPct)}
                      </span>
                    </div>
                    {rates?.us2y != null && (
                      <div className="flex items-baseline justify-between">
                        <span className="label !text-[8px]">US 2Y</span>
                        <span className="fin text-[12px] text-parchment-dim">{rates.us2y.toFixed(2)}%</span>
                      </div>
                    )}
                    {rates?.us10y != null && (
                      <div className="flex items-baseline justify-between">
                        <span className="label !text-[8px]">US 10Y</span>
                        <span className="fin text-[12px] text-parchment-dim">{rates.us10y.toFixed(2)}%</span>
                      </div>
                    )}
                    {rates?.us30y != null && (
                      <div className="flex items-baseline justify-between">
                        <span className="label !text-[8px]">US 30Y</span>
                        <span className="fin text-[12px] text-parchment-dim">{rates.us30y.toFixed(2)}%</span>
                      </div>
                    )}
                    {rates?.fedFunds != null && (
                      <div className="flex items-baseline justify-between">
                        <span className="label !text-[8px]">Fed funds</span>
                        <span className="fin text-[12px] text-parchment-dim">{rates.fedFunds.toFixed(2)}%</span>
                      </div>
                    )}
                  </div>

                  {macro.worldDigest && (
                    <div className="card-rule mt-3 pt-3">
                      <div className="label mb-2 !text-[8.5px]">World digest</div>
                      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-parchment-dim">
                        {macro.worldDigest}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <p className="py-2 text-xs leading-relaxed text-parchment-faint">
                  Not yet computed. The context stage caches one point-in-time macro/world snapshot per calendar date
                  (S&amp;P 500 level, VIX, rates, regime, and a no-look-ahead world-events digest).
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="label mb-3">
              Price Around the Post{subjectTicker ? ` · ${subjectTicker}` : ""}
            </div>
            <div className="card px-5 py-4">
              {bars.length >= 2 ? (
                <AuguryPriceChart bars={bars} markerDate={dateISO} />
              ) : (
                <p className="py-2 text-xs leading-relaxed text-parchment-faint">
                  {subjectTicker
                    ? "No stored price history around this date yet. RUN PIPELINE (or set POLYGON_API_KEY for deep history) to populate daily bars."
                    : "No ticker resolved for this post, so there is nothing to chart."}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
