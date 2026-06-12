import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader, ThesisStatus, TickerLink } from "@/components/ui";
import { ClosePosition } from "@/components/close-position";
import { PostmortemForm } from "@/components/postmortem-form";
import { getQuotes } from "@/lib/market";
import { getProviderStatus } from "@/lib/models";

export const dynamic = "force-dynamic";

function Pnl({ pct, arrows = true }: { pct: number | null; arrows?: boolean }) {
  if (pct == null) return <span className="fin text-[11px] text-parchment-faint">—</span>;
  const cls = pct > 0 ? "text-bull" : pct < 0 ? "text-bear" : "text-parchment-faint";
  const arrow = pct > 0 ? "▲ +" : pct < 0 ? "▼ " : "";
  return (
    <span className={`fin text-[12px] ${cls}`}>
      {arrows ? arrow : pct > 0 ? "+" : ""}
      {pct.toFixed(1)}%
    </span>
  );
}

export default async function Talons() {
  const rows = await db
    .select({ position: tables.positions, company: tables.companies })
    .from(tables.positions)
    .innerJoin(tables.companies, eq(tables.positions.companyId, tables.companies.id))
    .orderBy(desc(tables.positions.createdAt));

  const open = rows.filter((r) => r.position.status === "open");
  const closed = rows.filter((r) => r.position.status === "closed");

  const [quoteMap, postmortemRows] = await Promise.all([
    getQuotes(open.map((r) => r.position.ticker)).catch(() => new Map<string, never>()),
    db.select().from(tables.postmortems).orderBy(desc(tables.postmortems.createdAt)),
  ]);
  const pmByPosition = new Map(postmortemRows.filter((p) => p.positionId != null).map((p) => [p.positionId, p]));
  const aiAvailable = getProviderStatus().some((p) => p.configured);

  // Live unrealized P&L per open position; null when no quote is available.
  const openWithPnl = open.map((r) => {
    const quote = quoteMap.get(r.position.ticker) ?? null;
    const pnlPct = quote ? ((quote.price - r.position.entryPrice) / r.position.entryPrice) * 100 : null;
    return { ...r, quote, pnlPct };
  });

  const grossExposure = open.reduce((s, r) => s + r.position.sizePct, 0);
  const priced = openWithPnl.filter((r) => r.pnlPct != null);
  const pricedWeight = priced.reduce((s, r) => s + r.position.sizePct, 0);
  const weightedPnl =
    pricedWeight > 0 ? priced.reduce((s, r) => s + r.pnlPct! * r.position.sizePct, 0) / pricedWeight : null;
  const worstFromEntry = priced.length > 0 ? Math.min(...priced.map((r) => r.pnlPct!)) : null;

  // Theme exposure weighted by actual position size, not name count.
  const themeExposure = new Map<string, number>();
  for (const r of open) {
    const t = r.company.theme ?? "Unthemed";
    themeExposure.set(t, (themeExposure.get(t) ?? 0) + r.position.sizePct);
  }
  const themes = [...themeExposure.entries()].sort((a, b) => b[1] - a[1]);
  const themeMax = Math.max(1, ...themes.map(([, v]) => v));

  const stats: { label: string; value: React.ReactNode; tone?: string }[] = [
    { label: "Gross exposure", value: `${grossExposure.toFixed(1)}%` },
    { label: "Open positions", value: String(open.length) },
    {
      label: "Weighted avg P&L",
      value: weightedPnl != null ? `${weightedPnl >= 0 ? "+" : ""}${weightedPnl.toFixed(1)}%` : "—",
      tone: weightedPnl == null ? undefined : weightedPnl >= 0 ? "text-bull" : "text-bear",
    },
    {
      label: "Worst from entry",
      value: worstFromEntry != null ? `${worstFromEntry >= 0 ? "+" : ""}${worstFromEntry.toFixed(1)}%` : "—",
      tone: worstFromEntry != null && worstFromEntry < 0 ? "text-bear" : undefined,
    },
  ];

  return (
    <div>
      <PageHeader
        kicker="Talons — Positions"
        title="Capital committed, claws in"
        right={
          <span className="fin text-[11px] text-parchment-faint">
            {open.length} open · {closed.length} closed
          </span>
        }
      />

      <div className="px-10 py-8">
        {/* summary strip */}
        <div className="grid grid-cols-4 divide-x divide-line border border-line bg-ink-card">
          {stats.map((s) => (
            <div key={s.label} className="px-5 py-4">
              <div className={`fin text-2xl leading-none ${s.tone ?? "text-parchment"}`}>{s.value}</div>
              <div className="label mt-1.5 !text-[8.5px]">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-8 grid grid-cols-12 gap-6">
          <section className="col-span-8">
            <div className="label mb-3">Open Positions — live P&L vs entry</div>
            <div className="card">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-line text-left">
                    {["Ticker", "Thesis", "Size", "Owner", "Entry", "Last", "P&L", ""].map((h, i) => (
                      <th key={i} className={`label px-4 py-2.5 !text-[8.5px] font-normal ${i >= 4 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {openWithPnl.map(({ position: p, company: c, quote, pnlPct }) => (
                    <tr key={p.id} className="transition-colors hover:bg-ink-raised">
                      <td className="px-4 py-3">
                        <TickerLink ticker={p.ticker} />
                      </td>
                      <td className="px-4 py-3">
                        <ThesisStatus status={c.thesisStatus} />
                      </td>
                      <td className="fin px-4 py-3 text-[12px] text-parchment">{p.sizePct.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-[11px] text-parchment-dim">{p.owner}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="fin text-[12px] text-parchment">${p.entryPrice.toFixed(2)}</span>
                        <span className="fin ml-2 text-[10px] text-parchment-faint">{p.entryDate}</span>
                      </td>
                      <td className="fin px-4 py-3 text-right text-[12px] text-parchment">
                        {quote ? `$${quote.price.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Pnl pct={pnlPct} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ClosePosition positionId={p.id} ticker={p.ticker} quotePrice={quote?.price ?? null} />
                      </td>
                    </tr>
                  ))}
                  {open.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-parchment-faint">
                        No open positions. Approval without commitment is just an opinion — open
                        positions from approved IC memos.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-8">
              <div className="label mb-3">Closed Positions — realized, on the record</div>
              <div className="card divide-y divide-line">
                {closed.map(({ position: p }) => {
                  const realized =
                    p.exitPrice != null ? ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100 : null;
                  const pm = pmByPosition.get(p.id);
                  return (
                    <div key={p.id} className="px-4 py-3">
                      <div className="flex items-center gap-4">
                        <TickerLink ticker={p.ticker} />
                        <span className="fin text-[11px] text-parchment-faint">
                          {p.sizePct.toFixed(1)}% · {p.owner}
                        </span>
                        <span className="fin text-[11px] text-parchment-dim">
                          ${p.entryPrice.toFixed(2)} → {p.exitPrice != null ? `$${p.exitPrice.toFixed(2)}` : "—"}
                        </span>
                        <span className="fin text-[10px] text-parchment-faint">
                          {p.entryDate} → {p.exitDate ?? "—"}
                        </span>
                        <span className="ml-auto flex items-center gap-3">
                          <Pnl pct={realized} arrows={false} />
                          {pm ? (
                            <Link
                              href={`/dossiers/${p.ticker}#after-action`}
                              className={`fin border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${
                                pm.outcome === "win"
                                  ? "border-bull/50 text-bull"
                                  : pm.outcome === "loss"
                                    ? "border-bear/50 text-bear"
                                    : "border-line text-parchment-faint"
                              }`}
                            >
                              PM · {pm.outcome} →
                            </Link>
                          ) : (
                            <span className="label !text-[8px] !text-warn">PM DUE</span>
                          )}
                        </span>
                      </div>
                      {!pm && (
                        <div className="mt-2 text-right">
                          <PostmortemForm
                            positionId={p.id}
                            companyId={p.companyId}
                            ticker={p.ticker}
                            aiAvailable={aiAvailable}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                {closed.length === 0 && (
                  <div className="px-4 py-6 text-xs text-parchment-faint">
                    Nothing closed yet. Every exit ends in an After-Action postmortem.
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="col-span-4">
            <div className="label mb-3">Theme Exposure — weighted by size</div>
            <div className="card px-5 py-4">
              {themes.map(([theme, pct]) => (
                <div key={theme} className="py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] text-parchment-dim">{theme}</span>
                    <span className="fin text-[11px] text-parchment">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="mt-1.5 h-[3px] w-full bg-line">
                    <div className="h-full bg-bull" style={{ width: `${(pct / themeMax) * 100}%` }} />
                  </div>
                </div>
              ))}
              {themes.length === 0 && (
                <p className="py-2 text-xs text-parchment-faint">No open exposure.</p>
              )}
              <p className="card-rule mt-3 pt-3 text-[10.5px] leading-relaxed text-parchment-faint">
                Sized exposure, not name count. One theme wearing three tickers is still one bet.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
