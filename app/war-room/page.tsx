import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { computeRegime, checkMandate, latestBrief } from "@/lib/warroom";
import { computeBookQuant, getPortfolio, MANDATE } from "@/lib/quant";
import { getQuotes } from "@/lib/market";
import { parseDirectiveRow, type Directive } from "@/lib/oracle";
import { ThesisStatus, TickerLink } from "@/components/ui";
import { ConveneButton, ProposalCard, NavEditor, RefreshDirectivesButton, DirectiveActionRow } from "./war-room-client";

export const dynamic = "force-dynamic";

function pct(v: number | null | undefined, digits = 1): string {
  return v != null ? `${v.toFixed(digits)}%` : "—";
}

export default async function WarRoom() {
  const [regime, book, portfolio, brief, openRows] = await Promise.all([
    computeRegime().catch(() => null),
    computeBookQuant().catch(() => null),
    getPortfolio(),
    latestBrief(),
    db
      .select({ position: tables.positions, company: tables.companies })
      .from(tables.positions)
      .innerJoin(tables.companies, eq(tables.positions.companyId, tables.companies.id))
      .where(eq(tables.positions.status, "open")),
  ]);

  const violations = book ? checkMandate(book) : [];
  const quoteMap = await getQuotes(openRows.map((r) => r.position.ticker)).catch(() => new Map());

  const positionByTicker = new Map(
    openRows.map((r) => [r.position.ticker.toUpperCase(), { id: r.position.id, sizePct: r.position.sizePct }]),
  );

  // Action Plan: latest directive per open position, ranked by expected
  // dollar impact |EV90d × sizePct| — the biggest swing to the book first.
  const openTickers = [...positionByTicker.keys()];
  const directiveRows =
    openTickers.length > 0
      ? await db
          .select()
          .from(tables.directives)
          .where(inArray(tables.directives.ticker, openTickers))
          .orderBy(desc(tables.directives.createdAt), desc(tables.directives.id))
      : [];
  const latestByTicker = new Map<string, Directive>();
  for (const row of directiveRows) {
    if (latestByTicker.has(row.ticker)) continue;
    const parsed = parseDirectiveRow(row);
    if (parsed) latestByTicker.set(row.ticker, parsed);
  }
  const actionPlan = openTickers
    .map((t) => {
      const d = latestByTicker.get(t) ?? null;
      const pos = positionByTicker.get(t)!;
      const impact = d?.ev90dPct != null ? Math.abs((d.ev90dPct * pos.sizePct) / 100) : null;
      return { ticker: t, directive: d, position: pos, impact };
    })
    .sort((a, b) => (b.impact ?? -1) - (a.impact ?? -1));

  const regimeTone =
    regime?.read === "risk_on" ? "text-bull" : regime?.read === "risk_off" ? "text-bear" : "text-warn";

  return (
    <div>
      <div className="border-b border-line px-10 py-8">
        <div className="flex items-end justify-between">
          <div>
            <div className="label mb-2">The War Room — Navigating the Market</div>
            <h1 className="serif text-4xl font-medium text-parchment">
              The book, the mandate, the conditions.
            </h1>
          </div>
          <ConveneButton />
        </div>

        {/* Regime strip */}
        <div className="mt-7 grid grid-cols-6 divide-x divide-line border border-line bg-ink-card">
          <div className="px-5 py-4">
            <div className={`fin text-xl leading-none ${regimeTone}`}>
              {regime?.read ? regime.read.replace("_", " ").toUpperCase() : "—"}
            </div>
            <div className="label mt-1.5 !text-[8.5px]">Regime read</div>
          </div>
          <div className="px-5 py-4">
            <div className="fin text-xl leading-none text-parchment">
              {regime?.trend ? regime.trend.toUpperCase() : "—"}
            </div>
            <div className="label mt-1.5 !text-[8.5px]">
              {regime?.benchmark ?? "Benchmark"} {regime?.above50d != null ? `· ${regime.above50d ? "above" : "below"} 50d` : ""}{" "}
              {regime?.above200d != null ? `· ${regime.above200d ? "above" : "below"} 200d` : ""}
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="fin text-xl leading-none text-parchment">
              {regime?.volRegime ? regime.volRegime.toUpperCase() : "—"}
            </div>
            <div className="label mt-1.5 !text-[8.5px]">
              Vol 20d {regime?.vol20d != null ? (regime.vol20d * 100).toFixed(0) + "%" : "—"} vs 1y{" "}
              {regime?.vol1y != null ? (regime.vol1y * 100).toFixed(0) + "%" : "—"}
              {regime?.pStressed != null ? ` · P(stressed) ${(regime.pStressed * 100).toFixed(0)}%` : ""}
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="fin text-xl leading-none text-parchment">
              {regime?.breadth ? `${regime.breadth.above50d}/${regime.breadth.total}` : "—"}
            </div>
            <div className="label mt-1.5 !text-[8.5px]">Book above own 50d</div>
          </div>
          <div className="px-5 py-4">
            <div className="fin text-xl leading-none text-parchment">{pct(book?.grossExposurePct)}</div>
            <div className="label mt-1.5 !text-[8.5px]">Gross exposure</div>
          </div>
          <div className="px-5 py-4">
            <div className={`fin text-xl leading-none ${book?.cashPct != null && book.cashPct < MANDATE.minCashPct ? "text-bear" : "text-parchment"}`}>
              {pct(book?.cashPct)}
            </div>
            <div className="label mt-1.5 !text-[8.5px]">Cash · floor {MANDATE.minCashPct}%</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        {/* Left: brief + proposals */}
        <section className="col-span-7 space-y-8">
          {/* Action Plan — the Oracle's standing orders on the open book */}
          <div>
            <div className="mb-3 flex items-end justify-between">
              <span className="label">Action Plan — directives ranked by expected book impact</span>
              <RefreshDirectivesButton />
            </div>
            <div className="space-y-3">
              {actionPlan.map(({ ticker, directive, position, impact }) =>
                directive ? (
                  <DirectiveActionRow
                    key={ticker}
                    ticker={ticker}
                    action={directive.action}
                    conviction={directive.conviction}
                    reason={directive.reasons[0] ?? ""}
                    impactPct={impact}
                    sizeTargetPct={directive.sizeTargetPct}
                    position={position}
                    livePrice={quoteMap.get(ticker)?.price ?? null}
                  />
                ) : (
                  <div key={ticker} className="card flex items-center justify-between px-5 py-3.5">
                    <span className="fin text-sm text-parchment">{ticker}</span>
                    <span className="text-[11px] text-parchment-faint">
                      No directive on record — refresh directives to consult the Oracle.
                    </span>
                  </div>
                ),
              )}
              {actionPlan.length === 0 && (
                <div className="card px-5 py-6 text-center text-xs text-parchment-faint">
                  No open positions — the Oracle has no book to rule on.
                </div>
              )}
            </div>
          </div>

          {brief ? (
            <div>
              <div className="mb-3 flex items-baseline justify-between">
                <span className="label">
                  Council Brief — {brief.createdAt?.toISOString().slice(0, 16).replace("T", " ") ?? ""} UTC
                  {brief.regime ? ` · regime ${brief.regime.replace("_", " ")}` : ""}
                </span>
              </div>
              <div className="card px-6 py-5">
                <p className="serif text-lg leading-relaxed text-parchment">{brief.content.regimeStance}</p>
                <div className="card-rule mt-4 grid grid-cols-2 gap-x-8 gap-y-3 pt-4">
                  <div>
                    <div className="label mb-1.5">Cash Stance</div>
                    <p className="text-[12.5px] leading-relaxed text-parchment-dim">{brief.content.cashStance}</p>
                  </div>
                  <div>
                    <div className="label mb-1.5">What Would Change Our Mind</div>
                    <p className="text-[12.5px] leading-relaxed text-parchment-dim">
                      {brief.content.whatWouldChangeOurMind}
                    </p>
                  </div>
                </div>
              </div>

              <div className="label mb-3 mt-6">Action Proposals — human approval required</div>
              <div className="space-y-3">
                {brief.content.perPosition.map((p, i) => (
                  <ProposalCard
                    key={i}
                    proposal={p}
                    position={positionByTicker.get(p.ticker.toUpperCase()) ?? null}
                    livePrice={quoteMap.get(p.ticker.toUpperCase())?.price ?? null}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="card px-6 py-10 text-center">
              <p className="text-sm text-parchment-faint">
                No council brief on record. Convene the council — PM proposes, Risk constrains, Strix attacks —
                and the merged navigation brief lands here with approvable proposals.
              </p>
              <p className="mt-2 text-[11px] text-parchment-faint">
                Requires a model key and at least one open position. The regime and mandate dashboards above work regardless.
              </p>
            </div>
          )}

          {/* Mandate compliance */}
          <div>
            <div className="label mb-3">The Mandate — compliance</div>
            <div className="space-y-2.5">
              {violations.map((v, i) => (
                <div
                  key={i}
                  className={`card border-l-2 px-5 py-3 ${v.severity === "violation" ? "border-l-bear" : "border-l-warn"}`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`fin border px-1.5 py-px text-[9px] tracking-[0.15em] ${
                        v.severity === "violation" ? "border-bear/60 text-bear" : "border-warn/60 text-warn"
                      }`}
                    >
                      {v.severity.toUpperCase()}
                    </span>
                    <span className="label !text-[9px]">{v.rule}</span>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-parchment">{v.detail}</p>
                </div>
              ))}
              {violations.length === 0 && (
                <div className="card px-5 py-6 text-center text-xs text-parchment-faint">
                  Book is compliant: max position {MANDATE.maxPositionPct}%, max theme {MANDATE.maxThemePct}%,
                  cash floor {MANDATE.minCashPct}%, beta ceiling {MANDATE.maxBookBeta}.
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Right rail: book detail */}
        <section className="col-span-5 space-y-8">
          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="label">The Book</span>
              <span className="flex items-center gap-3">
                <span className="fin text-[10px] text-parchment-faint">
                  NAV ${(portfolio.nav / 1_000_000).toFixed(1)}M
                </span>
                <NavEditor nav={portfolio.nav} cash={portfolio.cash} />
              </span>
            </div>
            <div className="card divide-y divide-line">
              {openRows.map(({ position, company }) => {
                const q = quoteMap.get(position.ticker.toUpperCase());
                const pnl = q?.price != null ? ((q.price - position.entryPrice) / position.entryPrice) * 100 : null;
                return (
                  <div key={position.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className="flex items-baseline gap-2">
                        <TickerLink ticker={position.ticker} />
                        <span className="fin text-[10px] text-parchment-faint">{position.sizePct.toFixed(1)}%</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3">
                        <ThesisStatus status={company.thesisStatus} />
                        {company.theme && <span className="label !text-[8px]">{company.theme}</span>}
                      </div>
                    </div>
                    <span className={`fin text-sm ${pnl == null ? "text-parchment-faint" : pnl >= 0 ? "text-bull" : "text-bear"}`}>
                      {pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                );
              })}
              {openRows.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-parchment-faint">
                  No open positions. Approved memos open positions in the IC Chamber.
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="label mb-3">Theme Concentration vs Mandate ({MANDATE.maxThemePct}% cap)</div>
            <div className="card px-5 py-4">
              {(book?.themeConcentration ?? []).map((t) => (
                <div key={t.theme} className="py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] text-parchment-dim">{t.theme}</span>
                    <span className={`fin text-[11px] ${t.sizePct > MANDATE.maxThemePct ? "text-bear" : "text-parchment"}`}>
                      {t.sizePct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-[3px] w-full bg-line">
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.min((t.sizePct / MANDATE.maxThemePct) * 100, 100)}%`,
                        background: t.sizePct > MANDATE.maxThemePct ? "var(--bear)" : "var(--platinum)",
                        opacity: 0.7,
                      }}
                    />
                  </div>
                </div>
              ))}
              {(!book || book.themeConcentration.length === 0) && (
                <p className="py-2 text-xs text-parchment-faint">No themed exposure.</p>
              )}
            </div>
          </div>

          {book && book.correlationClusters.length > 0 && (
            <div>
              <div className="label mb-3">Correlation Clusters — one bet, many tickers</div>
              <div className="card divide-y divide-line">
                {book.correlationClusters.map((c, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-3">
                    <span className="fin text-sm text-parchment">
                      {c.a} ↔ {c.b}
                    </span>
                    <span className="fin text-[11px] text-warn">ρ {c.corr.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card px-5 py-4">
            <div className="label mb-2">Doctrine</div>
            <p className="text-[11.5px] leading-relaxed text-parchment-faint">
              The council proposes; the human disposes. Every executed proposal becomes a trace.
              A stock can be up while the thesis is broken — the War Room navigates the thesis,
              not the tape. <Link href="/talons" className="text-parchment-dim underline-offset-4 hover:underline">Positions live in Talons →</Link>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
