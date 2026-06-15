import Link from "next/link";
import { desc, eq, asc } from "drizzle-orm";
import { db, tables } from "@/db";
import { StatusBadge, ThesisStatus, ScoreRing, TickerLink } from "@/components/ui";
import { ResolveAlertButton } from "@/components/resolve-alert-button";
import { computeRegime, checkMandate } from "@/lib/warroom";
import { computeBookQuant } from "@/lib/quant";
import { getQuotes } from "@/lib/market";
import { lastScan } from "@/lib/nightvision";
import { ScanButton } from "@/components/scan-button";

export const dynamic = "force-dynamic";

const severityLabel: Record<number, { label: string; cls: string; border: string }> = {
  1: { label: "CRITICAL", cls: "text-bear border-bear/60", border: "border-l-bear" },
  2: { label: "HIGH", cls: "text-warn border-warn/60", border: "border-l-warn" },
  3: { label: "MEDIUM", cls: "text-platinum border-platinum/40", border: "border-l-platinum/50" },
  4: { label: "LOW", cls: "text-parchment-faint border-line", border: "border-l-line" },
  5: { label: "INFO", cls: "text-parchment-faint border-line", border: "border-l-line" },
};

const kindLabel: Record<string, string> = {
  thesis_break: "THESIS BREAK",
  filing: "FILING",
  catalyst: "CATALYST",
  signal: "NIGHT VISION",
  stale_thesis: "STALE THESIS",
  insider: "INSIDER",
  noise_drop: "NOISE",
  ic_decision: "IC DECISION",
  position: "TALONS",
  directive: "DIRECTIVE",
};

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export default async function Perch() {
  const [alerts, companies, catalystRows, memoRows, openPositions, lastScanAt] = await Promise.all([
    db
      .select()
      .from(tables.alerts)
      .where(eq(tables.alerts.resolved, false))
      .orderBy(asc(tables.alerts.severity), desc(tables.alerts.createdAt))
      .limit(12),
    db.select().from(tables.companies).orderBy(desc(tables.companies.convictionScore)),
    db
      .select({ catalyst: tables.catalysts, ticker: tables.companies.ticker })
      .from(tables.catalysts)
      .innerJoin(tables.companies, eq(tables.catalysts.companyId, tables.companies.id))
      .orderBy(asc(tables.catalysts.expectedDate)),
    db
      .select({ memo: tables.memos, ticker: tables.companies.ticker })
      .from(tables.memos)
      .innerJoin(tables.companies, eq(tables.memos.companyId, tables.companies.id))
      .orderBy(desc(tables.memos.createdAt))
      .limit(5),
    db.select().from(tables.positions).where(eq(tables.positions.status, "open")),
    lastScan(),
  ]);

  // Live P&L for the Talons panel — quotes fail silently, panel still renders.
  const positionQuotes = await getQuotes(openPositions.map((p) => p.ticker)).catch(
    () => new Map<string, never>(),
  );

  // War Room strip — regime read + mandate flags, all keyless math, never blocks the page.
  const [regime, bookForMandate] = await Promise.all([
    computeRegime().catch(() => null),
    computeBookQuant().catch(() => null),
  ]);
  const mandateFlags = bookForMandate ? checkMandate(bookForMandate) : [];
  const mandateViolations = mandateFlags.filter((v) => v.severity === "violation");
  const positionsByCompany = new Map(
    openPositions.map((p) => {
      const quote = positionQuotes.get(p.ticker) ?? null;
      const pnlPct = quote ? ((quote.price - p.entryPrice) / p.entryPrice) * 100 : null;
      return [p.companyId, { sizePct: p.sizePct, pnlPct }];
    }),
  );

  const active = companies.filter((c) => c.status === "active");
  const watchpipe = companies.filter((c) => c.status === "watchlist" || c.status === "pipeline");
  const atRisk = companies.filter((c) => c.thesisStatus === "weakening" || c.thesisStatus === "broken");
  const pendingMemos = memoRows.filter(({ memo }) => !memo.decidedBy);
  const upcoming = catalystRows
    .map((c) => ({ ...c, days: daysUntil(c.catalyst.expectedDate) }))
    .filter((c) => c.days != null && c.days >= 0)
    .sort((a, b) => a.days! - b.days!);
  const near = upcoming.filter((c) => c.days! <= 30);

  // Thesis exposure across the live book + pipeline
  const themeCounts = new Map<string, { n: number; active: number }>();
  for (const c of companies) {
    if (c.status === "rejected" || c.status === "exited") continue;
    const t = c.theme ?? "Unthemed";
    const e = themeCounts.get(t) ?? { n: 0, active: 0 };
    e.n += 1;
    if (c.status === "active") e.active += 1;
    themeCounts.set(t, e);
  }
  const themes = [...themeCounts.entries()].sort((a, b) => b[1].n - a[1].n);
  const themeMax = Math.max(1, ...themes.map(([, v]) => v.n));

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const stats: { label: string; value: string; href: string; tone?: string }[] = [
    { label: "Active positions", value: String(active.length), href: "/dossiers" },
    { label: "Watch / pipeline", value: String(watchpipe.length), href: "/dossiers" },
    {
      label: "Theses at risk",
      value: String(atRisk.length),
      href: "/dossiers",
      tone: atRisk.length > 0 ? "text-warn" : undefined,
    },
    {
      label: "Memos undecided",
      value: String(pendingMemos.length),
      href: "/ic",
      tone: pendingMemos.length > 0 ? "text-warn" : undefined,
    },
    { label: "Catalysts ≤ 30d", value: String(near.length), href: "/dossiers" },
    {
      label: "Open alerts",
      value: String(alerts.length),
      href: "#queue",
      tone: alerts.some((a) => a.severity === 1) ? "text-bear" : undefined,
    },
  ];

  return (
    <div>
      <div className="border-b border-line px-10 py-8">
        <div className="flex items-end justify-between">
          <div>
            <div className="label mb-2">The Perch — {today}</div>
            <h1 className="serif text-4xl font-medium text-parchment">
              What deserves our attention today?
            </h1>
          </div>
          <div className="flex items-start gap-3">
            <ScanButton lastScanAt={lastScanAt?.toISOString() ?? null} />
            <Link href="/new" className="btn btn-primary">
              + NEW INVESTIGATION
            </Link>
          </div>
        </div>

        {/* War Room strip — regime + mandate */}
        {(regime?.read || mandateFlags.length > 0) && (
          <Link
            href="/war-room"
            className="mt-5 flex items-center gap-5 border border-line bg-ink-card px-5 py-2.5 transition-colors hover:border-line-strong"
          >
            <span className="label !text-[8px]">War Room</span>
            {regime?.read && (
              <span
                className={`fin text-[11px] tracking-[0.15em] ${
                  regime.read === "risk_on" ? "text-bull" : regime.read === "risk_off" ? "text-bear" : "text-warn"
                }`}
              >
                {regime.read.replace("_", " ").toUpperCase()}
              </span>
            )}
            {regime?.trend && regime.trend !== "unknown" && (
              <span className="fin text-[10px] text-parchment-faint">
                {regime.benchmark} {regime.trend} · vol {regime.volRegime}
              </span>
            )}
            <span className="ml-auto flex items-center gap-4">
              {mandateViolations.length > 0 ? (
                <span className="fin text-[10px] text-bear">
                  {mandateViolations.length} MANDATE VIOLATION{mandateViolations.length > 1 ? "S" : ""}
                </span>
              ) : mandateFlags.length > 0 ? (
                <span className="fin text-[10px] text-warn">
                  {mandateFlags.length} MANDATE WARNING{mandateFlags.length > 1 ? "S" : ""}
                </span>
              ) : (
                <span className="fin text-[10px] text-parchment-faint">MANDATE COMPLIANT</span>
              )}
              <span className="label !text-[8px]">→</span>
            </span>
          </Link>
        )}

        {/* stat strip */}
        <div className="mt-5 grid grid-cols-6 divide-x divide-line border border-line bg-ink-card">
          {stats.map((s) => (
            <Link key={s.label} href={s.href} className="group px-5 py-4 transition-colors hover:bg-ink-raised">
              <div className={`fin text-2xl leading-none ${s.tone ?? "text-parchment"}`}>{s.value}</div>
              <div className="label mt-1.5 !text-[8.5px]">{s.label}</div>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        {/* Attention queue */}
        <section id="queue" className="col-span-7">
          <div className="label mb-3">Attention Queue — ranked by importance, not price moves</div>
          <div className="space-y-3">
            {alerts.map((a) => {
              const sev = severityLabel[a.severity] ?? severityLabel[3];
              return (
                <div key={a.id} className={`card border-l-2 ${sev.border} px-5 py-4`}>
                  <div className="mb-2 flex items-center gap-3">
                    <span className={`fin border px-1.5 py-px text-[9px] tracking-[0.15em] ${sev.cls}`}>
                      {sev.label}
                    </span>
                    <span className="label !text-[9px]">{kindLabel[a.kind] ?? a.kind}</span>
                    <span className="ml-auto flex items-center gap-3">
                      {a.ticker && <TickerLink ticker={a.ticker} />}
                      <ResolveAlertButton id={a.id} />
                    </span>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-parchment">{a.message}</p>
                  {a.suggestedAction && (
                    <p className="mt-2 border-l border-line-strong pl-3 text-xs text-parchment-dim">
                      <span className="label !text-[9px]">Suggested — </span>
                      {a.suggestedAction}
                    </p>
                  )}
                </div>
              );
            })}
            {alerts.length === 0 && (
              <div className="card px-5 py-10 text-center text-sm text-parchment-faint">
                Queue clear. The owl waits.
              </div>
            )}
          </div>

          {/* Thesis exposure */}
          <div className="mt-8">
            <div className="label mb-3">Thesis Exposure — one bet can wear five tickers</div>
            <div className="card px-5 py-4">
              {themes.map(([theme, v]) => (
                <div key={theme} className="py-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] text-parchment-dim">{theme}</span>
                    <span className="fin text-[11px] text-parchment">
                      {v.active} active<span className="text-parchment-faint"> · {v.n} names</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-[3px] w-full bg-line">
                    <div className="h-full bg-platinum/60" style={{ width: `${(v.n / themeMax) * 100}%` }}>
                      <div className="h-full bg-bull" style={{ width: `${v.n ? (v.active / v.n) * 100 : 0}%` }} />
                    </div>
                  </div>
                </div>
              ))}
              <p className="card-rule mt-3 pt-3 text-[10.5px] leading-relaxed text-parchment-faint">
                A portfolio can look diversified by ticker and still be one giant correlated bet.
                Green = active capital, platinum = research coverage.
              </p>
            </div>
          </div>
        </section>

        {/* Right rail */}
        <section className="col-span-5 space-y-8">
          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <Link href="/talons" className="label hover:text-parchment-dim">
                Talons — Active Positions
              </Link>
              <Link href="/talons" className="label !text-[9px] hover:text-parchment-dim">
                ALL →
              </Link>
            </div>
            <div className="card divide-y divide-line">
              {active.map((c) => {
                const pos = positionsByCompany.get(c.id);
                return (
                  <Link
                    key={c.id}
                    href={`/dossiers/${c.ticker}`}
                    className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-ink-raised"
                  >
                    <ScoreRing score={c.convictionScore} size={44} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="fin text-sm text-parchment">{c.ticker}</span>
                        <span className="truncate text-xs text-parchment-faint">{c.name}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3">
                        <ThesisStatus status={c.thesisStatus} />
                        {c.theme && <span className="label !text-[8px]">{c.theme}</span>}
                      </div>
                    </div>
                    {pos && (
                      <div className="text-right">
                        {pos.pnlPct != null && (
                          <div
                            className={`fin text-[12px] ${pos.pnlPct > 0 ? "text-bull" : pos.pnlPct < 0 ? "text-bear" : "text-parchment-faint"}`}
                          >
                            {pos.pnlPct > 0 ? "▲ +" : pos.pnlPct < 0 ? "▼ " : ""}
                            {pos.pnlPct.toFixed(1)}%
                          </div>
                        )}
                        <div className="fin mt-0.5 text-[10px] text-parchment-faint">
                          {pos.sizePct.toFixed(1)}% NAV
                        </div>
                      </div>
                    )}
                  </Link>
                );
              })}
              {active.length === 0 && (
                <div className="px-4 py-5 text-xs text-parchment-faint">No active positions.</div>
              )}
            </div>
          </div>

          <div>
            <div className="label mb-3">Research Pipeline</div>
            <div className="card divide-y divide-line">
              {watchpipe.map((c) => (
                <Link
                  key={c.id}
                  href={`/dossiers/${c.ticker}`}
                  className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-ink-raised"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="fin text-sm text-parchment">{c.ticker}</span>
                    <span className="text-xs text-parchment-faint">{c.sector}</span>
                  </div>
                  <StatusBadge status={c.status} />
                </Link>
              ))}
              {watchpipe.length === 0 && (
                <div className="px-4 py-5 text-xs text-parchment-faint">Pipeline empty.</div>
              )}
            </div>
          </div>

          <div>
            <div className="label mb-3">Flight Path — Upcoming Catalysts</div>
            <div className="card divide-y divide-line">
              {(upcoming.length ? upcoming : catalystRows.map((c) => ({ ...c, days: null }))).slice(0, 6).map(({ catalyst: ct, ticker, days }) => (
                <div key={ct.id} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <TickerLink ticker={ticker} />
                    <span className={`fin text-[11px] ${days != null && days <= 14 ? "text-warn" : "text-parchment-faint"}`}>
                      {days != null ? `T−${days}d` : ct.expectedDate}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-parchment-dim">{ct.title}</p>
                </div>
              ))}
              {catalystRows.length === 0 && (
                <div className="px-4 py-5 text-xs text-parchment-faint">
                  No catalyst, no urgency.
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="label">IC Chamber — Recent Memos</span>
              <Link href="/ic" className="label !text-[9px] hover:text-parchment-dim">
                ALL →
              </Link>
            </div>
            <div className="card divide-y divide-line">
              {memoRows.map(({ memo, ticker }) => (
                <Link
                  key={memo.id}
                  href={`/ic/${memo.id}`}
                  className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-ink-raised"
                >
                  <span className="fin text-sm text-parchment">
                    {ticker} <span className="text-parchment-faint">v{memo.version}</span>
                    {!memo.decidedBy && <span className="label ml-2 !text-[8px] !text-warn">AWAITING IC</span>}
                  </span>
                  <span
                    className={`fin text-[10px] tracking-[0.15em] ${
                      memo.recommendation === "approve"
                        ? "text-bull"
                        : memo.recommendation === "reject"
                          ? "text-bear"
                          : "text-warn"
                    }`}
                  >
                    {memo.recommendation === "more_work" ? "MORE WORK" : memo.recommendation?.toUpperCase()}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
