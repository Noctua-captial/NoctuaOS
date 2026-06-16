import { and, desc, eq, ne } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader, TickerLink } from "@/components/ui";
import { OpenStructure, CloseOptionStructure, OptionPostmortemForm } from "@/components/desk-ui";
import { computeOptionsBook } from "@/lib/options/book";
import { optionSizing, checkOptionsMandate } from "@/lib/options/sizing";

export const dynamic = "force-dynamic";

type StoredStructure = {
  strategy: string;
  label?: string;
  direction: string | null;
  expiry: string | null;
  dte?: number;
  legs: { right: string; action: string; strike: number; expiry: string; qty: number; mid: number | null }[];
  netDebit: number | null;
  maxLoss: number | null;
  maxGain: number | null;
  breakevens: number[];
  pop: number | null;
  evPctOnRisk: number | null;
  greeks: { delta: number; gamma: number; vega: number; theta: number } | null;
  rationale: string;
};

function money(v: number | null): string {
  if (v == null) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function strategyLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function legLabel(l: { right: string; action: string; strike: number; qty: number }): string {
  return `${l.action === "long" ? "+" : "−"}${l.qty}${l.right}${l.strike}`;
}

function Pnl({ value, pct }: { value: number | null; pct: number | null }) {
  if (value == null) return <span className="fin text-[11px] text-parchment-faint">—</span>;
  const cls = value > 0 ? "text-bull" : value < 0 ? "text-bear" : "text-parchment-faint";
  return (
    <span className={`fin text-[12px] ${cls}`}>
      {value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString()}
      {pct != null && <span className="ml-1 text-[10px]">({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)</span>}
    </span>
  );
}

export default async function Desk() {
  const book = await computeOptionsBook();

  // Recommended expressions: the latest directive per name that carries an
  // options structure (the Oracle's dual output). Dedup to the freshest.
  const directiveRows = await db
    .select()
    .from(tables.directives)
    .orderBy(desc(tables.directives.createdAt), desc(tables.directives.id))
    .limit(80);
  const onBook = new Set(book.open.map((s) => s.ticker.toUpperCase()));
  const seen = new Set<string>();
  type Rec = {
    ticker: string;
    companyId: number | null;
    directiveId: number;
    os: StoredStructure;
    spot: number | null;
    suggestedQty: number;
    binding: string;
  };
  const recs: Rec[] = [];
  for (const row of directiveRows) {
    const t = row.ticker.toUpperCase();
    if (seen.has(t)) continue;
    seen.add(t);
    let inputs: { spot?: number | null; optionsStructure?: StoredStructure | null };
    try {
      inputs = JSON.parse(row.inputs) as typeof inputs;
    } catch {
      continue;
    }
    const os = inputs.optionsStructure;
    if (!os || os.maxLoss == null || os.maxLoss <= 0) continue;
    const evRealPerLot = os.evPctOnRisk != null ? (os.evPctOnRisk / 100) * os.maxLoss : null;
    const sizing = optionSizing({
      maxLoss: os.maxLoss,
      maxGain: os.maxGain,
      pop: os.pop,
      evRealPerLot,
      vegaPerLot: os.greeks?.vega ?? null,
      navUsd: book.navUsd,
      bookPremiumAtRiskUsd: book.premiumAtRiskUsd,
      bookVegaUsd: book.greeks.vegaUsd,
    });
    recs.push({
      ticker: t,
      companyId: row.companyId,
      directiveId: row.id,
      os,
      spot: inputs.spot ?? null,
      suggestedQty: sizing.qty,
      binding: sizing.bindingConstraint,
    });
  }

  const pmRows = await db.select({ structureId: tables.optionPostmortems.structureId }).from(tables.optionPostmortems);
  const pmSet = new Set(pmRows.map((p) => p.structureId).filter((x): x is number => x != null));

  // Per-strategy scorecard (across regimes): the moat — which structures pay.
  const scorecards = await db
    .select()
    .from(tables.optionScorecards)
    .where(and(eq(tables.optionScorecards.volRegime, "*"), ne(tables.optionScorecards.strategy, "*")))
    .orderBy(desc(tables.optionScorecards.sampleSize));

  const flags = checkOptionsMandate({
    navUsd: book.navUsd,
    premiumAtRiskPct: book.premiumAtRiskPct,
    bookVegaUsd: book.greeks.vegaUsd,
    netDeltaUsd: book.greeks.betaWeightedDeltaUsd,
    shortGammaNearExpiry: book.shortGammaNearExpiry,
  });

  // Expiry ladder over open structures.
  const ladder = new Map<string, { count: number; premium: number; dte: number | null }>();
  for (const s of book.open) {
    const key = s.expiry ?? "—";
    const cur = ladder.get(key) ?? { count: 0, premium: 0, dte: s.dte };
    cur.count += 1;
    cur.premium += s.capitalAtRisk;
    cur.dte = s.dte;
    ladder.set(key, cur);
  }
  const ladderRows = [...ladder.entries()].sort((a, b) => (a[1].dte ?? 1e9) - (b[1].dte ?? 1e9));

  const stats = [
    { label: "Premium at risk", value: `${book.premiumAtRiskPct.toFixed(1)}%`, sub: money(book.premiumAtRiskUsd) },
    { label: "β-wtd net Δ", value: money(book.greeks.betaWeightedDeltaUsd), sub: `${book.greeks.netDeltaShares.toLocaleString()} sh` },
    { label: "Net vega / pt", value: money(book.greeks.vegaUsd), tone: book.greeks.vegaUsd >= 0 ? "text-parchment" : "text-warn" },
    { label: "Net theta / day", value: money(book.greeks.thetaUsd), tone: book.greeks.thetaUsd >= 0 ? "text-bull" : "text-bear" },
  ];

  return (
    <div>
      <PageHeader
        kicker="Derivatives Desk — Options overlay"
        title="Defined risk, expressed"
        right={
          <span className="fin text-[11px] text-parchment-faint">
            {book.open.length} open · {book.closed.length} closed
          </span>
        }
      />

      <div className="px-10 py-8">
        {/* greeks strip */}
        <div className="grid grid-cols-4 divide-x divide-line border border-line bg-ink-card">
          {stats.map((s) => (
            <div key={s.label} className="px-5 py-4">
              <div className={`fin text-2xl leading-none ${s.tone ?? "text-parchment"}`}>{s.value}</div>
              <div className="label mt-1.5 !text-[8.5px]">{s.label}</div>
              {s.sub && <div className="fin mt-0.5 text-[10px] text-parchment-faint">{s.sub}</div>}
            </div>
          ))}
        </div>

        {flags.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {flags.map((f, i) => (
              <div
                key={i}
                className={`flex items-baseline gap-3 border-l-2 px-3 py-1.5 ${f.severity === "violation" ? "border-bear bg-bear/5" : "border-warn bg-warn/5"}`}
              >
                <span className={`label !text-[8px] ${f.severity === "violation" ? "!text-bear" : "!text-warn"}`}>
                  {f.severity === "violation" ? "BREACH" : "WARN"}
                </span>
                <span className="text-[11.5px] text-parchment-dim">
                  <span className="text-parchment">{f.rule}.</span> {f.detail}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 grid grid-cols-12 gap-6">
          <section className="col-span-8">
            {/* recommended expressions */}
            <div className="label mb-3">Recommended Expressions — from the Oracle&apos;s latest read</div>
            <div className="card">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line text-left">
                    {["Ticker", "Structure", "Expiry", "Max loss", "POP", "EV/risk", "Size", ""].map((h, i) => (
                      <th key={i} className={`label px-4 py-2.5 !text-[8.5px] font-normal ${i >= 3 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recs.map((r) => (
                    <tr key={r.directiveId} className="align-top transition-colors hover:bg-ink-raised">
                      <td className="px-4 py-3">
                        <TickerLink ticker={r.ticker} />
                        {onBook.has(r.ticker) && <span className="label mt-0.5 block !text-[7.5px] !text-parchment-faint">ON BOOK</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[12px] text-parchment">{strategyLabel(r.os.strategy)}</div>
                        <div className="fin mt-0.5 text-[10px] text-parchment-faint">
                          {r.os.legs.map(legLabel).join("  ")}
                        </div>
                      </td>
                      <td className="fin px-4 py-3 text-right text-[11px] text-parchment-dim">
                        {r.os.expiry ? r.os.expiry.slice(5) : "—"}
                        {r.os.dte != null && <span className="ml-1 text-parchment-faint">{Math.round(r.os.dte)}d</span>}
                      </td>
                      <td className="fin px-4 py-3 text-right text-[11px] text-parchment">{money(r.os.maxLoss)}</td>
                      <td className="fin px-4 py-3 text-right text-[11px] text-parchment-dim">
                        {r.os.pop != null ? `${Math.round(r.os.pop * 100)}%` : "—"}
                      </td>
                      <td className="fin px-4 py-3 text-right text-[11px]">
                        <span className={r.os.evPctOnRisk == null ? "text-parchment-faint" : r.os.evPctOnRisk >= 0 ? "text-bull" : "text-bear"}>
                          {r.os.evPctOnRisk != null ? `${r.os.evPctOnRisk >= 0 ? "+" : ""}${r.os.evPctOnRisk.toFixed(0)}%` : "—"}
                        </span>
                      </td>
                      <td className="fin px-4 py-3 text-right text-[11px] text-parchment-dim" title={`Binding: ${r.binding}`}>
                        {r.suggestedQty}×
                      </td>
                      <td className="px-4 py-3 text-right">
                        <OpenStructure
                          structure={{
                            ticker: r.ticker,
                            companyId: r.companyId,
                            directiveId: r.directiveId,
                            strategy: r.os.strategy,
                            direction: r.os.direction,
                            expiry: r.os.expiry,
                            legs: r.os.legs,
                            netDebit: r.os.netDebit,
                            maxLoss: r.os.maxLoss,
                            maxGain: r.os.maxGain,
                            breakevens: r.os.breakevens,
                            pop: r.os.pop,
                            evPct: r.os.evPctOnRisk,
                            greeks: r.os.greeks,
                            entryUnderlying: r.spot,
                            rationale: r.os.rationale,
                            bindingConstraint: r.binding,
                          }}
                          suggestedQty={r.suggestedQty}
                          bindingNote={`Binding constraint: ${r.binding}`}
                        />
                      </td>
                    </tr>
                  ))}
                  {recs.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-parchment-faint">
                        No options expressions yet. Run the Oracle on a covered name — every directive now proposes the
                        defined-risk structure that best fits the edge.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* open book */}
            <div className="mt-8 label mb-3">Open Structures — marked to model</div>
            <div className="card">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line text-left">
                    {["Ticker", "Structure", "DTE", "Entry→Mark", "P&L", "Δ / V / Θ", "BE dist", ""].map((h, i) => (
                      <th key={i} className={`label px-4 py-2.5 !text-[8.5px] font-normal ${i >= 3 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {book.open.map((s) => (
                    <tr key={s.id} className="align-top transition-colors hover:bg-ink-raised">
                      <td className="px-4 py-3">
                        <TickerLink ticker={s.ticker} />
                        <div className="label mt-0.5 !text-[7.5px] !text-parchment-faint">{s.qty}× · {s.direction ?? "—"}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[12px] text-parchment">{strategyLabel(s.strategy)}</div>
                        <div className="fin mt-0.5 text-[10px] text-parchment-faint">
                          {s.legs.map((l) => `${legLabel(l)}${l.marked !== "live" ? "*" : ""}`).join("  ")}
                        </div>
                      </td>
                      <td className="fin px-4 py-3 text-right text-[11px] text-parchment-dim">{s.dte != null ? `${s.dte}d` : "—"}</td>
                      <td className="fin px-4 py-3 text-right text-[11px] text-parchment-dim">
                        {money(s.netDebit)} → {money(s.currentValuePerLot)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Pnl value={s.pnlUsd} pct={s.pnlPct} />
                      </td>
                      <td className="fin px-4 py-3 text-right text-[10px] text-parchment-dim">
                        {s.greeksPerLot ? `${s.greeksPerLot.delta} / ${s.greeksPerLot.vega} / ${s.greeksPerLot.theta}` : "—"}
                      </td>
                      <td className="fin px-4 py-3 text-right text-[11px] text-parchment-dim">
                        {s.breakevenDistancePct != null ? `${s.breakevenDistancePct.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <CloseOptionStructure structureId={s.id} suggestedExitPerLot={s.currentValuePerLot} currentUnderlying={s.currentUnderlying} />
                      </td>
                    </tr>
                  ))}
                  {book.open.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-parchment-faint">
                        No open structures. Open one from a recommended expression above — the desk marks it to model and
                        Night Vision manages it to plan. (* = leg marked by model, not a live quote.)
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* closed + postmortems */}
            <div className="mt-8 label mb-3">Closed Structures — realized, on the record</div>
            <div className="card divide-y divide-line">
              {book.closed.map((s) => (
                <div key={s.id} className="px-4 py-3">
                  <div className="flex items-center gap-4">
                    <TickerLink ticker={s.ticker} />
                    <span className="fin text-[11px] text-parchment-dim">{s.qty}× {strategyLabel(s.strategy)}</span>
                    <span className="fin text-[10px] text-parchment-faint">{s.closedAt?.slice(0, 10) ?? "—"}</span>
                    <span className="ml-auto flex items-center gap-3">
                      <Pnl value={s.realizedPnl} pct={null} />
                      {pmSet.has(s.id) ? (
                        <span className="label !text-[8px] !text-parchment-faint">PM FILED</span>
                      ) : (
                        <span className="label !text-[8px] !text-warn">PM DUE</span>
                      )}
                    </span>
                  </div>
                  {!pmSet.has(s.id) && (
                    <div className="mt-2 text-right">
                      <OptionPostmortemForm structureId={s.id} ticker={s.ticker} />
                    </div>
                  )}
                </div>
              ))}
              {book.closed.length === 0 && (
                <div className="px-4 py-6 text-xs text-parchment-faint">
                  Nothing closed yet. Every exit ends in an options After-Action: vol view, direction, theta, structure choice.
                </div>
              )}
            </div>
          </section>

          {/* right rail: vega-by-tenor, expiry ladder, underlying exposure */}
          <section className="col-span-4 space-y-8">
            <div>
              <div className="label mb-3">Vega by Tenor — $/vol point</div>
              <div className="card px-5 py-4">
                {book.vegaByTenor.map((v) => (
                  <div key={v.tenor} className="flex items-baseline justify-between py-1.5">
                    <span className="text-[12px] text-parchment-dim">{v.tenor}</span>
                    <span className={`fin text-[11px] ${v.vegaUsd >= 0 ? "text-parchment" : "text-warn"}`}>{money(v.vegaUsd)}</span>
                  </div>
                ))}
                {book.vegaByTenor.length === 0 && <p className="py-2 text-xs text-parchment-faint">No vega on the book.</p>}
                <p className="card-rule mt-3 pt-3 text-[10.5px] leading-relaxed text-parchment-faint">
                  Long vega up front decays into earnings; short vega up front is what gets run over. Watch the front bucket.
                </p>
              </div>
            </div>

            <div>
              <div className="label mb-3">Expiry Ladder</div>
              <div className="card px-5 py-4">
                {ladderRows.map(([expiry, v]) => (
                  <div key={expiry} className="flex items-baseline justify-between py-1.5">
                    <span className="fin text-[12px] text-parchment-dim">
                      {expiry.slice(0, 10)} {v.dte != null && <span className="text-parchment-faint">{v.dte}d</span>}
                    </span>
                    <span className="fin text-[11px] text-parchment">
                      {v.count} · {money(v.premium)}
                    </span>
                  </div>
                ))}
                {ladderRows.length === 0 && <p className="py-2 text-xs text-parchment-faint">No expiries on the book.</p>}
              </div>
            </div>

            <div>
              <div className="label mb-3">Premium at Risk — by underlying</div>
              <div className="card px-5 py-4">
                {book.byUnderlying.map((u) => (
                  <div key={u.ticker} className="flex items-baseline justify-between py-1.5">
                    <span className="fin text-[12px] text-parchment-dim">{u.ticker}</span>
                    <span className="fin text-[11px] text-parchment">{money(u.premiumAtRiskUsd)}</span>
                  </div>
                ))}
                {book.byUnderlying.length === 0 && <p className="py-2 text-xs text-parchment-faint">No exposure.</p>}
                <p className="card-rule mt-3 pt-3 text-[10.5px] leading-relaxed text-parchment-faint">
                  Defined-risk only — every structure&apos;s worst case is bounded and counted here against the premium budget.
                </p>
              </div>
            </div>

            {scorecards.length > 0 && (
              <div>
                <div className="label mb-3">Structure Scorecard — overlay alpha by type</div>
                <div className="card divide-y divide-line">
                  {scorecards.map((sc) => (
                    <div key={sc.id} className="flex items-center justify-between px-4 py-2.5">
                      <span className="text-[12px] text-parchment-dim">{strategyLabel(sc.strategy ?? "—")}</span>
                      <span className="flex items-center gap-3">
                        <span className="fin text-[10px] text-parchment-faint">n{sc.sampleSize}</span>
                        <span className="fin text-[11px] text-parchment">{sc.hitRate != null ? `${Math.round(sc.hitRate * 100)}%` : "—"}</span>
                        <span className={`fin text-[11px] ${(sc.avgOverlayAlphaPct ?? 0) >= 0 ? "text-bull" : "text-bear"}`}>
                          {sc.avgOverlayAlphaPct != null ? `${sc.avgOverlayAlphaPct >= 0 ? "+" : ""}${sc.avgOverlayAlphaPct.toFixed(0)}%α` : "—"}
                        </span>
                      </span>
                    </div>
                  ))}
                  <p className="px-4 py-3 text-[10.5px] leading-relaxed text-parchment-faint">
                    Hit rate and average overlay alpha — structure P&amp;L minus the direction-adjusted stock-only return.
                    The moat: which expressions actually beat just owning the shares.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
