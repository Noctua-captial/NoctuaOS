import Link from "next/link";
import { desc, eq, isNull, type SQL } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader, TickerLink } from "@/components/ui";
import { TraceLabelButtons } from "@/components/trace-label";

export const dynamic = "force-dynamic";

const signalColor: Record<string, string> = {
  thesis_support: "text-bull border-bull/50",
  demand_signal: "text-bull border-bull/50",
  supply_signal: "text-platinum border-platinum/40",
  catalyst: "text-warn border-warn/50",
  valuation_gap: "text-platinum border-platinum/40",
  thesis_contradiction: "text-bear border-bear/50",
  accounting_red_flag: "text-bear border-bear/50",
  competitive_threat: "text-bear border-bear/50",
  management_credibility: "text-warn border-warn/50",
  liquidity_constraint: "text-warn border-warn/50",
  noise: "text-parchment-faint border-line",
};

const outcomeColor: Record<string, string> = {
  win: "text-bull border-bull/50",
  loss: "text-bear border-bear/50",
  scratch: "text-parchment-faint border-line",
};

const FILTERS = [
  { key: "all", label: "ALL" },
  { key: "strong_signal", label: "STRONG SIGNAL" },
  { key: "weak_signal", label: "WEAK SIGNAL" },
  { key: "false_positive", label: "FALSE POSITIVE" },
  { key: "noise", label: "NOISE" },
  { key: "unlabeled", label: "UNLABELED" },
] as const;

function parseLessons(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default async function Ledger({
  searchParams,
}: {
  searchParams: Promise<{ label?: string }>;
}) {
  const { label } = await searchParams;
  const filter = FILTERS.some((f) => f.key === label) ? (label as string) : "all";

  let where: SQL | undefined;
  if (filter === "unlabeled") where = isNull(tables.traces.label);
  else if (filter !== "all") where = eq(tables.traces.label, filter);

  const [traceRows, runRows, postmortemRows] = await Promise.all([
    db.select().from(tables.traces).where(where).orderBy(desc(tables.traces.createdAt)).limit(60),
    db.select().from(tables.agentRuns).orderBy(desc(tables.agentRuns.createdAt)).limit(30),
    db.select().from(tables.postmortems).orderBy(desc(tables.postmortems.createdAt)).limit(15),
  ]);

  return (
    <div>
      <PageHeader
        kicker="Alpha Ledger — Decision History"
        title="Research state → action → inference → next action"
        right={
          <a href="/api/export/traces" className="btn !px-3 !py-1.5 !text-[9px]">
            ↓ EXPORT JSONL
          </a>
        }
      />

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        <section className="col-span-8">
          <div className="mb-3 flex items-center justify-between gap-4">
            <span className="label">Research Traces — {traceRows.length} on record. This is the moat.</span>
            <div className="flex items-center gap-1">
              {FILTERS.map((f) => (
                <Link
                  key={f.key}
                  href={f.key === "all" ? "/ledger" : `/ledger?label=${f.key}`}
                  className={`fin border px-2 py-1 text-[9px] tracking-[0.12em] transition-colors ${
                    filter === f.key
                      ? "border-platinum/50 bg-ink-card text-parchment"
                      : "border-line text-parchment-faint hover:border-line-strong hover:text-parchment-dim"
                  }`}
                >
                  {f.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {traceRows.map((t) => (
              <div key={t.id} className="card px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="fin text-[10px] tracking-[0.15em] text-platinum">{t.researcher}</span>
                  {t.signalCategory && (
                    <span
                      className={`fin border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${signalColor[t.signalCategory] ?? "text-parchment-faint border-line"}`}
                    >
                      {t.signalCategory.replace(/_/g, " ")}
                    </span>
                  )}
                  {t.outcome && (
                    <span
                      className={`fin border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${outcomeColor[t.outcome] ?? "text-parchment-faint border-line"}`}
                    >
                      → {t.outcome}
                    </span>
                  )}
                  {t.confidenceChange != null && (
                    <span
                      className={`fin text-[10px] ${t.confidenceChange > 0 ? "text-bull" : t.confidenceChange < 0 ? "text-bear" : "text-parchment-faint"}`}
                    >
                      Δconf {t.confidenceChange > 0 ? "+" : ""}
                      {t.confidenceChange.toFixed(2)}
                    </span>
                  )}
                  {t.ticker && (
                    <span className="ml-auto">
                      <TickerLink ticker={t.ticker} />
                    </span>
                  )}
                </div>

                <p className="mt-2.5 text-[13px] text-parchment">
                  <span className="label mr-2 !text-[9px]">Q</span>
                  {t.currentQuestion}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] leading-relaxed text-parchment-dim">
                  <p>
                    <span className="label mr-2 !text-[9px]">Action</span>
                    {t.actionTaken}
                  </p>
                  <p>
                    <span className="label mr-2 !text-[9px]">Seen</span>
                    {t.informationSeen}
                  </p>
                  <p>
                    <span className="label mr-2 !text-[9px]">Read</span>
                    {t.interpretation}
                  </p>
                  <p>
                    <span className="label mr-2 !text-[9px]">Next</span>
                    {t.nextAction}
                  </p>
                </div>
                {t.reasoningPattern && (
                  <p className="card-rule mt-3 pt-3 text-[11.5px] italic leading-relaxed text-parchment-faint">
                    Pattern: {t.reasoningPattern}
                  </p>
                )}
                <div className="card-rule mt-3 pt-3">
                  <TraceLabelButtons traceId={t.id} current={t.label} />
                </div>
              </div>
            ))}
            {traceRows.length === 0 && (
              <div className="card px-5 py-10 text-center text-sm text-parchment-faint">
                {filter === "all"
                  ? "No traces yet. Run an Athena investigation — every agent action becomes a structured trace here. Once labeled, these become Noctua's training data."
                  : `No traces under this filter. Label traces to build the training set.`}
              </div>
            )}
          </div>
        </section>

        <section className="col-span-4 space-y-8">
          <div>
            <div className="label mb-3">After-Action — Postmortems on Record</div>
            <div className="card divide-y divide-line">
              {postmortemRows.map((pm) => {
                const lessons = parseLessons(pm.lessons);
                return (
                  <div key={pm.id} className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <TickerLink ticker={pm.ticker} />
                      <span
                        className={`fin border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${outcomeColor[pm.outcome] ?? "text-parchment-faint border-line"}`}
                      >
                        {pm.outcome}
                      </span>
                      <span className="fin ml-auto text-[9px] text-parchment-faint">
                        {pm.createdAt?.toISOString().slice(0, 10)}
                      </span>
                    </div>
                    <p className="fin mt-1.5 text-[10px] text-parchment-faint">
                      Thesis {pm.thesisRight.replace(/_/g, " ")} · timing {pm.timingRight ? "right" : "wrong"} ·
                      sizing {pm.sizingRight ? "right" : "wrong"}
                    </p>
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-parchment-dim">{pm.narrative}</p>
                    {lessons.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {lessons.map((l, i) => (
                          <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-parchment-faint">
                            <span className="text-platinum">·</span>
                            {l}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
              {postmortemRows.length === 0 && (
                <div className="px-4 py-6 text-xs text-parchment-faint">
                  No postmortems filed. Closed positions without an After-Action review are tuition
                  paid for no lesson.
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="label mb-3">Agent Runs — {runRows.length}</div>
            <div className="card divide-y divide-line">
              {runRows.map((r) => (
                <div key={r.id} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="fin text-[11px] tracking-[0.1em] text-parchment">
                      {r.agent.replace(/_/g, " ").toUpperCase()}
                    </span>
                    {r.ticker && <TickerLink ticker={r.ticker} />}
                  </div>
                  <p className="mt-1 text-[11px] text-parchment-faint">{r.inputSummary}</p>
                  <p className="fin mt-1 text-[9px] text-parchment-faint/70">
                    {r.model} · {r.createdAt?.toISOString().slice(0, 16).replace("T", " ")}
                  </p>
                </div>
              ))}
              {runRows.length === 0 && (
                <div className="px-4 py-6 text-xs text-parchment-faint">No agent runs logged.</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
