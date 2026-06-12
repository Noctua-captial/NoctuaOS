import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, asc, and } from "drizzle-orm";
import { db, tables } from "@/db";
import { StatusBadge, ThesisStatus, ScoreRing, scoreBand } from "@/components/ui";
import { ScoreWheel, ScoreWheelLegend } from "@/components/score-wheel";
import { ValuationModel } from "@/components/valuation-model";
import { StatusControls } from "@/components/status-controls";
import { EvidenceTable } from "@/components/evidence-table";
import { Sparkline } from "@/components/sparkline";
import { PostmortemForm } from "@/components/postmortem-form";
import { AthenaChat } from "@/components/athena-chat";
import { DirectiveCard } from "@/components/directive-card";
import { getQuote } from "@/lib/market";
import { getFundamentals } from "@/lib/fundamentals";
import { computeNameQuant, correlationsVsBook } from "@/lib/quant";
import { getProviderStatus } from "@/lib/models";
import { latestDirective } from "@/lib/oracle";
import { fitGarch } from "@/lib/mathlab/garch";
import type { OptionsSignals } from "@/lib/signals";

export const dynamic = "force-dynamic";

function fmtCap(raw: number): string {
  if (raw >= 1e12) return `$${(raw / 1e12).toFixed(2)}T`;
  if (raw >= 1e9) return `$${(raw / 1e9).toFixed(1)}B`;
  return `$${(raw / 1e6).toFixed(0)}M`;
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Quant card formatters — "—" whenever a metric is unavailable.
function fmtSignedPct(v: number | null, digits = 1): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function fmtDecimalAsPct(v: number | null, signed = false): string {
  if (v == null) return "—";
  const pct = v * 100;
  return signed ? fmtSignedPct(pct) : `${pct.toFixed(0)}%`;
}

function fmtRatio(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(1)}×`;
}

function fmtAdv(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

export default async function Dossier({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  const company = await db.query.companies.findFirst({
    where: eq(tables.companies.ticker, ticker.toUpperCase()),
  });
  if (!company) notFound();

  const [thesisRows, claimRows, catalystRows, scoreRows, memoRows, docRows, positionRows, postmortemRows, quote, fundamentals] = await Promise.all([
    db
      .select()
      .from(tables.theses)
      .where(eq(tables.theses.companyId, company.id))
      .orderBy(desc(tables.theses.version)),
    db
      .select()
      .from(tables.claims)
      .where(eq(tables.claims.companyId, company.id))
      .orderBy(desc(tables.claims.confidence)),
    db
      .select()
      .from(tables.catalysts)
      .where(eq(tables.catalysts.companyId, company.id))
      .orderBy(asc(tables.catalysts.expectedDate)),
    db
      .select()
      .from(tables.scores)
      .where(eq(tables.scores.companyId, company.id))
      .orderBy(desc(tables.scores.createdAt))
      .limit(1),
    db
      .select()
      .from(tables.memos)
      .where(eq(tables.memos.companyId, company.id))
      .orderBy(desc(tables.memos.version)),
    db
      .select()
      .from(tables.documents)
      .where(eq(tables.documents.ticker, ticker.toUpperCase()))
      .orderBy(desc(tables.documents.createdAt))
      .limit(10),
    db
      .select()
      .from(tables.positions)
      .where(eq(tables.positions.companyId, company.id))
      .orderBy(desc(tables.positions.createdAt)),
    db
      .select()
      .from(tables.postmortems)
      .where(eq(tables.postmortems.companyId, company.id))
      .orderBy(desc(tables.postmortems.createdAt)),
    // Market data must never break the page — null on any failure.
    getQuote(ticker).catch(() => null),
    getFundamentals(ticker).catch(() => null),
  ]);

  const [questionRows, debateRows] = await Promise.all([
    db
      .select()
      .from(tables.researchQuestions)
      .where(eq(tables.researchQuestions.ticker, ticker.toUpperCase()))
      .orderBy(asc(tables.researchQuestions.id)),
    db
      .select()
      .from(tables.debates)
      .where(eq(tables.debates.ticker, ticker.toUpperCase()))
      .orderBy(desc(tables.debates.createdAt))
      .limit(3),
  ]);

  const [quant, bookCorrelations, directive, optionsFlowRows] = await Promise.all([
    computeNameQuant(ticker).catch(() => null),
    correlationsVsBook(ticker).catch(() => null),
    latestDirective(ticker).catch(() => null),
    // Latest stored options-flow snapshot — read from the signal store rather
    // than hitting CBOE on every render; RECOMPUTE on the directive refreshes it.
    db
      .select()
      .from(tables.signals)
      .where(and(eq(tables.signals.ticker, ticker.toUpperCase()), eq(tables.signals.kind, "options_flow")))
      .orderBy(desc(tables.signals.asOf))
      .limit(1),
  ]);

  let optionsFlow: OptionsSignals | null = null;
  try {
    optionsFlow = optionsFlowRows[0]?.payload ? (JSON.parse(optionsFlowRows[0].payload) as OptionsSignals) : null;
  } catch {
    optionsFlow = null;
  }
  const garchForecastVol =
    quote && quote.history.length >= 251
      ? (() => {
          const rets: number[] = [];
          for (let i = 1; i < quote.history.length; i++) {
            if (quote.history[i - 1] > 0) rets.push(quote.history[i] / quote.history[i - 1] - 1);
          }
          return fitGarch(rets)?.forecastVol30dAnnualized ?? null;
        })()
      : null;

  const thesis = thesisRows[0];
  const score = scoreRows[0];
  const components = score ? (JSON.parse(score.components) as Record<string, number>) : null;

  // After-Action: closed positions + filed postmortems.
  const closedPositions = positionRows.filter((p) => p.status === "closed");
  const pmByPosition = new Map(postmortemRows.filter((p) => p.positionId != null).map((p) => [p.positionId, p]));
  const showAfterAction = closedPositions.length > 0 || postmortemRows.length > 0;
  const aiAvailable = getProviderStatus().some((p) => p.configured);

  const computedCap =
    quote && fundamentals?.sharesOutstanding ? quote.price * fundamentals.sharesOutstanding : null;

  // Seed the valuation model with real numbers (slider units: $M and $).
  const opMargin =
    fundamentals?.revenue && fundamentals.operatingIncome != null
      ? Math.round((fundamentals.operatingIncome / fundamentals.revenue) * 100)
      : undefined;
  const valuationSeed = {
    baseRevenue: fundamentals?.revenue != null ? Math.round(fundamentals.revenue / 1e6) : undefined,
    margin: opMargin,
    netCash:
      fundamentals?.cash != null
        ? Math.round((fundamentals.cash - (fundamentals.debt ?? 0)) / 1e6)
        : undefined,
    shares:
      fundamentals?.sharesOutstanding != null
        ? Math.round(fundamentals.sharesOutstanding / 1e6)
        : undefined,
    spot: quote ? Math.round(quote.price * 100) / 100 : undefined,
  };

  return (
    <div>
      {/* Snapshot header */}
      <div className="border-b border-line px-10 py-8">
        <div className="mb-2 flex items-center justify-between">
          <Link href="/dossiers" className="label hover:text-parchment-dim">
            ← Dossiers
          </Link>
          <div className="flex items-center gap-2.5">
            <Link href={`/new?ticker=${company.ticker}`} className="btn !px-3 !py-1.5 !text-[9px]">
              ⟳ RE-RUN ATHENA
            </Link>
            <Link href={`/dossiers/${company.ticker}/graph`} className="btn btn-primary !px-3 !py-1.5 !text-[9px]">
              ◉ RESEARCH GRAPH
            </Link>
          </div>
        </div>
        <div className="flex items-start justify-between gap-8">
          <div>
            <div className="flex items-baseline gap-4">
              <h1 className="serif text-5xl font-medium text-parchment">{company.ticker}</h1>
              <span className="text-lg text-parchment-dim">{company.name}</span>
            </div>
            {quote && (
              <div className="mt-3 flex items-center gap-4">
                <span className="fin text-2xl text-parchment">
                  {quote.currency && quote.currency !== "USD" ? `${quote.currency} ` : "$"}
                  {quote.price.toFixed(2)}
                </span>
                {quote.dayChangePct != null && (
                  <span
                    className={`fin text-sm ${quote.dayChangePct >= 0 ? "text-bull" : "text-bear"}`}
                  >
                    {quote.dayChangePct >= 0 ? "▲ +" : "▼ "}
                    {quote.dayChangePct.toFixed(2)}%
                  </span>
                )}
                <Sparkline data={quote.history.slice(-60)} />
                {quote.stale && <span className="label !text-[8px]">STALE</span>}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              <StatusBadge status={company.status} />
              <ThesisStatus status={company.thesisStatus} />
              <span className="fin text-xs text-parchment-faint">{company.sector}</span>
              <span className="fin text-xs text-parchment-faint">
                {computedCap != null ? `${fmtCap(computedCap)} mkt cap` : company.marketCap}
              </span>
              <span className="fin text-xs text-parchment-faint">{company.liquidity}</span>
              {company.theme && (
                <span className="fin border border-line px-2 py-0.5 text-[10px] text-parchment-dim">
                  {company.theme}
                </span>
              )}
              <span className="label !text-[9px]">Analyst: {company.ownerAnalyst ?? "Unassigned"}</span>
            </div>
            <div className="mt-4">
              <StatusControls
                companyId={company.id}
                status={company.status}
                thesisStatus={company.thesisStatus}
              />
            </div>
            {company.businessSummary && (
              <p className="mt-4 max-w-3xl text-sm leading-relaxed text-parchment-dim">
                {company.businessSummary}
              </p>
            )}
            {company.rejectionReason && (
              <p className="mt-3 max-w-3xl border-l-2 border-bear/60 pl-3 text-xs leading-relaxed text-bear">
                {company.rejectionReason}
              </p>
            )}
          </div>
          <div className="text-right">
            <ScoreRing score={company.convictionScore} size={84} />
            {company.convictionScore != null && (
              <div className="label mt-2 max-w-[110px] !text-[9px] leading-snug">
                {scoreBand(company.convictionScore)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* sticky section nav */}
      <div className="sticky top-0 z-30 flex items-center gap-1 border-b border-line bg-ink/90 px-10 py-2.5 backdrop-blur">
        {[
          ["#directive", "Directive"],
          ["#thesis", "Thesis"],
          ...(questionRows.length > 0 || debateRows.length > 0 ? [["#symposium", "Symposium"]] : []),
          ["#evidence", "Evidence"],
          ["#model", "Model"],
          ["#quant", "Quant"],
          ...(showAfterAction ? [["#after-action", "After-Action"]] : []),
          ["#catalysts", "Catalysts"],
          ["#documents", "Documents"],
          ["#memos", "Memos"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="fin px-3 py-1.5 text-[10px] tracking-[0.15em] text-parchment-faint transition-colors hover:bg-ink-card hover:text-parchment"
          >
            {label.toUpperCase()}
          </a>
        ))}
        <span className="fin ml-auto text-[10px] text-parchment-faint">
          Last update: {company.updatedAt?.toISOString().slice(0, 10) ?? "—"}
        </span>
      </div>

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        {/* Left: thesis + evidence */}
        <div className="col-span-8 space-y-8">
          {/* The Directive — the answer before the research */}
          <DirectiveCard ticker={company.ticker} directive={directive} />

          {thesis ? (
            <section id="thesis" className="card scroll-mt-16 px-6 py-5">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="serif text-2xl text-parchment">Thesis</h2>
                <span className="fin text-[10px] text-parchment-faint">
                  v{thesis.version} · {thesisRows.length} version{thesisRows.length > 1 ? "s" : ""} on record
                </span>
              </div>
              <p className="serif text-xl leading-relaxed text-parchment">
                “{thesis.oneLiner}”
              </p>
              <div className="card-rule mt-5 grid grid-cols-2 gap-x-8 gap-y-5 pt-5">
                {thesis.variantPerception && (
                  <div>
                    <div className="label mb-1.5">Variant Perception</div>
                    <p className="text-[13px] leading-relaxed text-parchment-dim">{thesis.variantPerception}</p>
                  </div>
                )}
                {thesis.whyMarketWrong && (
                  <div>
                    <div className="label mb-1.5">Why the Market Is Wrong</div>
                    <p className="text-[13px] leading-relaxed text-parchment-dim">{thesis.whyMarketWrong}</p>
                  </div>
                )}
                {thesis.whyNow && (
                  <div>
                    <div className="label mb-1.5">Why Now</div>
                    <p className="text-[13px] leading-relaxed text-parchment-dim">{thesis.whyNow}</p>
                  </div>
                )}
                <div>
                  <div className="label mb-1.5">What Must Happen</div>
                  <ul className="space-y-1 text-[13px] leading-relaxed text-parchment-dim">
                    {parseJsonArray(thesis.whatMustHappen).map((x, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-parchment-faint">·</span>
                        {x}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {parseJsonArray(thesis.killCriteria).length > 0 && (
                <div className="card-rule mt-5 pt-5">
                  <div className="label mb-2 !text-bear">Kill Criteria — what makes us exit</div>
                  <ul className="space-y-1.5">
                    {parseJsonArray(thesis.killCriteria).map((x, i) => (
                      <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-parchment-dim">
                        <span className="text-bear">✕</span>
                        {x}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          ) : (
            <section className="card px-6 py-8 text-center text-sm text-parchment-faint">
              No thesis on record. Run Athena to generate one.
            </section>
          )}

          {/* The Symposium — recursive question tree + debates */}
          {(questionRows.length > 0 || debateRows.length > 0) && (
            <section id="symposium" className="scroll-mt-16">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="serif text-2xl text-parchment">The Symposium</h2>
                <span className="label">
                  {questionRows.length} questions · {debateRows.length} debate{debateRows.length === 1 ? "" : "s"}
                </span>
              </div>

              {debateRows.length > 0 && (
                <div className="card mb-3 divide-y divide-line">
                  {debateRows.map((d) => (
                    <Link
                      key={d.id}
                      href={`/debates/${d.id}`}
                      className="flex items-center justify-between px-5 py-3.5 transition-colors hover:bg-ink-raised"
                    >
                      <div className="min-w-0">
                        <span className="fin text-[11px] tracking-[0.15em] text-parchment">
                          DEBATE — ADVOCATE v STRIX v QUANT
                        </span>
                        {d.crux && (
                          <p className="mt-1 truncate text-[11.5px] text-parchment-faint">Crux: {d.crux}</p>
                        )}
                      </div>
                      <span
                        className={`fin ml-4 shrink-0 text-[10px] tracking-[0.15em] ${
                          d.verdict === "pursue"
                            ? "text-bull"
                            : d.verdict === "reject"
                              ? "text-bear"
                              : d.verdict
                                ? "text-warn"
                                : "text-parchment-faint"
                        }`}
                      >
                        {d.verdict ? `${d.verdict.toUpperCase()} ${d.conviction != null ? `· ${(d.conviction * 100).toFixed(0)}%` : ""}` : "RUNNING"}
                      </span>
                    </Link>
                  ))}
                </div>
              )}

              {questionRows.length > 0 && (
                <div className="card divide-y divide-line">
                  {questionRows.map((q) => (
                    <div
                      key={q.id}
                      className="px-5 py-3"
                      style={{ paddingLeft: `${1.25 + (q.depth - 1) * 1.5}rem` }}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={`fin mt-0.5 shrink-0 text-[9px] tracking-[0.1em] ${
                            q.status === "pending" ? "text-warn" : "text-parchment-faint"
                          }`}
                        >
                          {q.depth > 1 ? "└ " : ""}D{q.depth} · {(q.agent ?? "general").toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] leading-relaxed text-parchment">{q.question}</p>
                          {q.answer && (
                            <p className="mt-1 text-[12px] leading-relaxed text-parchment-dim">{q.answer}</p>
                          )}
                        </div>
                        <div className="fin shrink-0 text-right text-[10px] text-parchment-dim">
                          {q.confidence != null ? (
                            <>
                              <div className="label !text-[7px]">CONF</div>
                              {(q.confidence * 100).toFixed(0)}%
                            </>
                          ) : (
                            <span className="text-warn">OPEN</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Evidence — The Vault */}
          <div className="scroll-mt-16">
            <EvidenceTable
              companyId={company.id}
              claims={claimRows.map((cl) => ({
                id: cl.id,
                text: cl.text,
                kind: cl.kind,
                supports: cl.supports,
                confidence: cl.confidence,
                source: cl.source,
                sourceType: cl.sourceType,
              }))}
            />
          </div>

          <div id="model" className="scroll-mt-16">
            <ValuationModel ticker={company.ticker} {...valuationSeed} />
          </div>

          {showAfterAction && (
            <section id="after-action" className="card scroll-mt-16 px-6 py-5">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="serif text-2xl text-parchment">After-Action</h2>
                <span className="fin text-[10px] text-parchment-faint">
                  {postmortemRows.length} postmortem{postmortemRows.length === 1 ? "" : "s"} ·{" "}
                  {closedPositions.length} closed position{closedPositions.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="space-y-4">
                {postmortemRows.map((pm) => {
                  const lessons = parseJsonArray(pm.lessons);
                  const outcomeCls =
                    pm.outcome === "win"
                      ? "border-bull/50 text-bull"
                      : pm.outcome === "loss"
                        ? "border-bear/50 text-bear"
                        : "border-line text-parchment-faint";
                  return (
                    <div key={pm.id} className="border border-line bg-ink px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <span className={`fin border px-1.5 py-px text-[9px] uppercase tracking-[0.12em] ${outcomeCls}`}>
                          {pm.outcome}
                        </span>
                        <span className="fin text-[10px] text-parchment-faint">
                          Thesis {pm.thesisRight.replace(/_/g, " ")} · timing {pm.timingRight ? "right" : "wrong"} ·
                          sizing {pm.sizingRight ? "right" : "wrong"}
                        </span>
                        <span className="fin ml-auto text-[10px] text-parchment-faint">
                          {pm.createdBy} · {pm.createdAt?.toISOString().slice(0, 10)}
                        </span>
                      </div>
                      <p className="mt-2.5 text-[13px] leading-relaxed text-parchment-dim">{pm.narrative}</p>
                      {lessons.length > 0 && (
                        <div className="card-rule mt-3 pt-3">
                          <div className="label mb-1.5 !text-[8.5px]">Lessons</div>
                          <ul className="space-y-1">
                            {lessons.map((l, i) => (
                              <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-parchment-dim">
                                <span className="text-platinum">·</span>
                                {l}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}

                {closedPositions
                  .filter((p) => !pmByPosition.has(p.id))
                  .map((p) => {
                    const realized =
                      p.exitPrice != null ? ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100 : null;
                    return (
                      <div key={p.id} className="border border-warn/40 bg-ink px-4 py-3.5">
                        <div className="flex items-center gap-3">
                          <span className="label !text-warn">Postmortem due</span>
                          <span className="fin text-[11px] text-parchment-dim">
                            ${p.entryPrice.toFixed(2)} → {p.exitPrice != null ? `$${p.exitPrice.toFixed(2)}` : "—"} ·{" "}
                            {p.entryDate} → {p.exitDate ?? "—"}
                          </span>
                          {realized != null && (
                            <span
                              className={`fin text-[12px] ${realized > 0 ? "text-bull" : realized < 0 ? "text-bear" : "text-parchment-faint"}`}
                            >
                              {realized > 0 ? "+" : ""}
                              {realized.toFixed(1)}%
                            </span>
                          )}
                        </div>
                        <div className="mt-2">
                          <PostmortemForm
                            positionId={p.id}
                            companyId={company.id}
                            ticker={company.ticker}
                            aiAvailable={aiAvailable}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </section>
          )}
        </div>

        {/* Right rail */}
        <div className="col-span-4 space-y-8">
          {score && components && (
            <section className="card px-5 py-5">
              <div className="label mb-3">Noctua Score — explainable</div>
              <div className="flex justify-center">
                <ScoreWheel total={score.total} components={components} size={264} />
              </div>
              <div className="card-rule mt-4 pt-4">
                <ScoreWheelLegend components={components} />
              </div>
              <p className="card-rule mt-4 pt-4 text-xs leading-relaxed text-parchment-dim">
                {score.rationale}
              </p>
            </section>
          )}

          <section id="quant" className="scroll-mt-16">
            <div className="label mb-3">Quant Profile — keyless, real data</div>
            <div className="card px-5 py-4">
              {quant ? (
                <>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    {(
                      [
                        ["Ann. vol", fmtDecimalAsPct(quant.annualizedVol)],
                        ["Beta vs SPY", quant.beta != null ? quant.beta.toFixed(2) : "—"],
                        ["Max drawdown", fmtDecimalAsPct(quant.maxDrawdown, true)],
                        ["RSI(14)", quant.rsi14 != null ? quant.rsi14.toFixed(0) : "—"],
                        ["vs 52w high", fmtSignedPct(quant.pctFrom52wHigh)],
                        ["vs 52w low", fmtSignedPct(quant.pctFrom52wLow)],
                        ["3m momentum", fmtDecimalAsPct(quant.momentum3m, true)],
                        ["6m momentum", fmtDecimalAsPct(quant.momentum6m, true)],
                        ["ADV ($)", fmtAdv(quant.avgDollarVolume)],
                        ["EV / Revenue", fmtRatio(quant.evToRevenue)],
                        ["EV / Op. income", fmtRatio(quant.evToOperatingIncome)],
                        ["P / E", fmtRatio(quant.peRatio)],
                      ] as [string, string][]
                    ).map(([label, value]) => (
                      <div key={label} className="flex items-baseline justify-between gap-2">
                        <span className="label !text-[8.5px]">{label}</span>
                        <span className="fin text-[12px] text-parchment">{value}</span>
                      </div>
                    ))}
                  </div>
                  <div className="card-rule mt-4 pt-3">
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="label !text-[8.5px]">Options flow</span>
                      <span className="fin text-[9px] text-parchment-faint">
                        {optionsFlow ? `as of ${optionsFlow.asOf.slice(0, 10)}` : "no chain pulled"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                      {(
                        [
                          ["P/C volume", optionsFlow?.putCallVolumeRatio != null ? optionsFlow.putCallVolumeRatio.toFixed(2) : "—"],
                          ["P/C open int.", optionsFlow?.putCallOiRatio != null ? optionsFlow.putCallOiRatio.toFixed(2) : "—"],
                          ["25Δ skew", optionsFlow?.skew25Delta != null ? `${(optionsFlow.skew25Delta * 100).toFixed(1)} pts` : "—"],
                          ["Term slope", optionsFlow?.termSlope != null ? `${optionsFlow.termSlope >= 0 ? "+" : ""}${(optionsFlow.termSlope * 100).toFixed(1)} pts` : "—"],
                          ["Implied move", optionsFlow?.impliedEarningsMovePct != null ? `±${optionsFlow.impliedEarningsMovePct.toFixed(1)}%` : "—"],
                          ["GEX", optionsFlow?.gex != null ? `${optionsFlow.gex < 0 ? "−" : ""}$${(Math.abs(optionsFlow.gex) / 1e6).toFixed(1)}M` : "—"],
                          ["IV30", optionsFlow?.iv30 != null ? `${(optionsFlow.iv30 * 100).toFixed(0)}%` : "—"],
                          ["GARCH 30d fcst", garchForecastVol != null ? `${(garchForecastVol * 100).toFixed(0)}%` : "—"],
                        ] as [string, string][]
                      ).map(([label, value]) => (
                        <div key={label} className="flex items-baseline justify-between gap-2">
                          <span className="label !text-[8.5px]">{label}</span>
                          <span className="fin text-[12px] text-parchment">{value}</span>
                        </div>
                      ))}
                    </div>
                    {optionsFlow?.iv30 != null && garchForecastVol != null && garchForecastVol > 0 && (
                      <p className="mt-2 text-[10px] leading-relaxed text-parchment-faint">
                        Implied vol trades {(((optionsFlow.iv30 - garchForecastVol) / garchForecastVol) * 100).toFixed(0)}%{" "}
                        {optionsFlow.iv30 >= garchForecastVol ? "above" : "below"} the GARCH forecast — fear is{" "}
                        {optionsFlow.iv30 >= garchForecastVol ? "rich" : "cheap"}.
                      </p>
                    )}
                  </div>

                  {bookCorrelations && bookCorrelations.length > 0 && (
                    <div className="card-rule mt-4 pt-3">
                      <div className="label mb-2 !text-[8.5px]">Correlation vs book</div>
                      <div className="space-y-1">
                        {bookCorrelations.map(({ ticker: bt, corr }) => (
                          <div key={bt} className="flex items-baseline justify-between gap-2">
                            <span className="fin text-[11px] text-parchment-dim">{bt}</span>
                            <span
                              className={`fin text-[11px] ${corr > 0.7 ? "text-bear" : "text-parchment"}`}
                            >
                              {corr.toFixed(2)}
                              {corr > 0.7 ? " · same bet" : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="card-rule mt-4 pt-3 text-[10px] leading-relaxed text-parchment-faint">
                    {quant.historyDays} sessions of history · computed{" "}
                    {quant.computedAt.slice(0, 10)}
                  </p>
                </>
              ) : (
                <p className="py-2 text-xs text-parchment-faint">
                  No price history available. Quant profile returns when the market data does.
                </p>
              )}
            </div>
          </section>

          <section id="catalysts" className="scroll-mt-16">
            <div className="label mb-3">Flight Path — Catalysts</div>
            <div className="card divide-y divide-line">
              {catalystRows.map((ct) => (
                <div key={ct.id} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="label !text-[9px]">{ct.kind}</span>
                    <span className="fin text-[11px] text-warn">{ct.expectedDate}</span>
                  </div>
                  <p className="mt-1 text-[13px] text-parchment">{ct.title}</p>
                  {ct.impact && (
                    <p className="mt-1 text-[11px] leading-relaxed text-parchment-faint">{ct.impact}</p>
                  )}
                </div>
              ))}
              {catalystRows.length === 0 && (
                <div className="px-4 py-5 text-xs text-parchment-faint">
                  No catalyst, no urgency. A cheap stock can stay cheap forever.
                </div>
              )}
            </div>
          </section>

          <section id="documents" className="scroll-mt-16">
            <div className="label mb-3">Vault Documents</div>
            <div className="card divide-y divide-line">
              {docRows.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] text-parchment">{d.title}</p>
                    <span className="fin text-[10px] text-parchment-faint">
                      {d.formType ?? d.docType}
                      {d.filedAt ? ` · ${d.filedAt}` : ""}
                    </span>
                  </div>
                  {d.source?.startsWith("http") && (
                    <a href={d.source} target="_blank" rel="noreferrer" className="label shrink-0 !text-[9px] hover:text-parchment-dim">
                      ↗
                    </a>
                  )}
                </div>
              ))}
              {docRows.length === 0 && (
                <Link href="/vault" className="block px-4 py-5 text-xs text-parchment-faint hover:text-parchment-dim">
                  No primary sources on file. Ingest filings in The Vault →
                </Link>
              )}
            </div>
          </section>

          <section id="memos" className="scroll-mt-16">
            <div className="label mb-3">IC Chamber — Memos</div>
            <div className="card divide-y divide-line">
              {memoRows.map((m) => (
                <Link
                  key={m.id}
                  href={`/ic/${m.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-ink-raised"
                >
                  <div>
                    <span className="fin text-sm text-parchment">Memo v{m.version}</span>
                    <span className="ml-2 text-[11px] text-parchment-faint">{m.analyst}</span>
                  </div>
                  <span
                    className={`fin text-[10px] tracking-[0.15em] ${
                      m.recommendation === "approve"
                        ? "text-bull"
                        : m.recommendation === "reject"
                          ? "text-bear"
                          : "text-warn"
                    }`}
                  >
                    {m.recommendation === "more_work" ? "MORE WORK" : m.recommendation?.toUpperCase()}
                  </span>
                </Link>
              ))}
              {memoRows.length === 0 && (
                <div className="px-4 py-5 text-xs text-parchment-faint">
                  No memo. No trade without a memo.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <AthenaChat ticker={company.ticker} />
    </div>
  );
}
