"use client";

// The Directive card — the answer before the research. One action word, the
// conviction behind it, three reasons in English, the risk, and what flips it.
// All Greek letters stay inside the SHOW THE WORK drawer.
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Directive, DirectiveAction } from "@/lib/oracle";

const ACTION_TONE: Record<DirectiveAction, string> = {
  BUY: "text-bull",
  ADD: "text-bull",
  HOLD: "text-parchment",
  TRIM: "text-bear",
  EXIT: "text-bear",
  AVOID: "text-bear",
  HEDGE: "text-warn",
};

const ACTION_BAR: Record<DirectiveAction, string> = {
  BUY: "var(--bull)",
  ADD: "var(--bull)",
  HOLD: "var(--parchment-dim)",
  TRIM: "var(--bear)",
  EXIT: "var(--bear)",
  AVOID: "var(--bear)",
  HEDGE: "var(--warn)",
};

function dash(v: number | null | undefined, render: (x: number) => string): string {
  return v == null || !Number.isFinite(v) ? "—" : render(v);
}

const fmtPct = (digits = 1) => (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;
const fmtP = (x: number) => `${(x * 100).toFixed(0)}%`;
const fmtNum = (digits = 2) => (x: number) => x.toFixed(digits);
const fmtMoneyShort = (x: number) => {
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${x.toFixed(0)}`;
};

function WorkRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="fin text-[10px] text-parchment-faint">{label}</span>
      <span className="fin text-[11px] text-parchment">{value}</span>
    </div>
  );
}

function WorkSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-line bg-ink px-3.5 py-3">
      <div className="label mb-1.5 !text-[8px]">{title}</div>
      {children}
    </div>
  );
}

export function DirectiveCard({ ticker, directive }: { ticker: string; directive: Directive | null }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWork, setShowWork] = useState(false);

  async function recompute() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/oracle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "The Oracle could not rule.");
      } else {
        router.refresh();
      }
    } catch {
      setError("Connection lost while the Oracle deliberated.");
    } finally {
      setRunning(false);
    }
  }

  const recomputeBtn = (
    <button onClick={recompute} disabled={running} className="btn !px-3 !py-1.5 !text-[9px]">
      {running ? "THE ORACLE DELIBERATES…" : "RECOMPUTE"}
    </button>
  );

  if (!directive) {
    return (
      <section id="directive" className="card scroll-mt-16 px-6 py-5">
        <div className="flex items-center justify-between">
          <div className="label">The Directive — The Oracle</div>
          {recomputeBtn}
        </div>
        <p className="mt-4 text-sm text-parchment-faint">
          No directive on record. The Oracle has not ruled on {ticker}.
        </p>
        {error && <p className="mt-2 text-[10.5px] leading-relaxed text-warn">{error}</p>}
      </section>
    );
  }

  const d = directive;
  const inp = d.inputs;
  const tone = ACTION_TONE[d.action] ?? "text-parchment";

  const coverageLine = d.dataCoverage
    .map((c) => `${c.source.replace(/_/g, " ")} ${c.status}${c.status !== "live" && c.note ? ` (${c.note})` : ""}`)
    .join(" · ");

  return (
    <section id="directive" className="card scroll-mt-16 px-6 py-5" style={{ borderTop: `2px solid ${ACTION_BAR[d.action]}` }}>
      <div className="flex items-center justify-between">
        <div className="label">The Directive — The Oracle</div>
        <div className="flex items-center gap-3">
          <span className="fin text-[10px] text-parchment-faint">{d.createdAt.slice(0, 16).replace("T", " ")} UTC</span>
          {recomputeBtn}
        </div>
      </div>
      {error && <p className="mt-2 text-[10.5px] leading-relaxed text-warn">{error}</p>}

      <div className="mt-4 flex items-start justify-between gap-8">
        <div className="shrink-0">
          <div className={`serif text-6xl font-medium leading-none ${tone}`}>{d.action}</div>
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="label !text-[8.5px]">Conviction</span>
              <span className="fin text-[11px] text-parchment">{d.conviction}/100</span>
            </div>
            <div className="mt-1 h-[3px] w-44 bg-line">
              <div
                className="h-full"
                style={{ width: `${Math.min(d.conviction, 100)}%`, background: ACTION_BAR[d.action], opacity: 0.85 }}
              />
            </div>
          </div>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-2.5 pt-1">
          {(
            [
              ["P(thesis)", fmtP(d.pThesis)],
              ["Expected move", dash(d.expectedMovePct, (x) => `±${x.toFixed(1)}%${inp.rnd ? ` by ${inp.rnd.expiry.slice(5)}` : ""}`)],
              ["EV 90d (risk-adj)", dash(d.ev90dPct, fmtPct(1))],
              ["Size target", dash(d.sizeTargetPct, (x) => `${x.toFixed(1)}% NAV`)],
            ] as [string, string][]
          ).map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-2 border-b border-line pb-1.5">
              <span className="label !text-[8.5px]">{label}</span>
              <span className="fin text-[13px] text-parchment">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <ol className="card-rule mt-5 space-y-2 pt-4">
        {d.reasons.map((r, i) => (
          <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-parchment-dim">
            <span className="fin shrink-0 text-[11px] text-parchment-faint">{i + 1}.</span>
            <span>{r}</span>
          </li>
        ))}
      </ol>

      <div className="card-rule mt-4 grid grid-cols-2 gap-x-8 pt-4">
        <div>
          <div className="label mb-1 !text-[8.5px] !text-bear">Biggest risk</div>
          <p className="text-[12px] leading-relaxed text-parchment-dim">{d.biggestRisk}</p>
        </div>
        <div>
          <div className="label mb-1 !text-[8.5px] !text-warn">What flips it</div>
          <p className="text-[12px] leading-relaxed text-parchment-dim">{d.flipCondition}</p>
        </div>
      </div>

      <p className="card-rule mt-4 pt-3 text-[9.5px] leading-relaxed text-parchment-faint">
        Coverage: {coverageLine}
      </p>

      <button
        onClick={() => setShowWork((s) => !s)}
        className="label mt-3 !text-[9px] !tracking-[0.2em] opacity-70 transition-opacity hover:opacity-100"
      >
        {showWork ? "▾ HIDE THE WORK" : "▸ SHOW THE WORK"}
      </button>

      {showWork && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <WorkSection title="The market's odds — risk-neutral density">
            {inp.rnd ? (
              <>
                <WorkRow label={`Expiry (${inp.rnd.dte}d out)`} value={inp.rnd.expiry} />
                <WorkRow
                  label={`P(≥ bull ${inp.valuation?.bull != null ? `$${inp.valuation.bull}` : ""})`}
                  value={dash(inp.rnd.pAboveBull, fmtP)}
                />
                <WorkRow
                  label={`P(≥ base ${inp.valuation?.base != null ? `$${inp.valuation.base}` : ""})`}
                  value={dash(inp.rnd.pAboveBase, fmtP)}
                />
                <WorkRow
                  label={`P(≤ bear ${inp.valuation?.bear != null ? `$${inp.valuation.bear}` : ""})`}
                  value={dash(inp.rnd.pBelowBear, fmtP)}
                />
                <WorkRow label="Implied move (1σ)" value={dash(inp.rnd.impliedMovePct, (x) => `±${x.toFixed(1)}%`)} />
                <WorkRow label="Tail asymmetry P(+20%)/P(−20%)" value={dash(inp.rnd.tailAsymmetry, fmtNum(2))} />
                <WorkRow label="Usable strikes" value={String(inp.rnd.usableStrikes)} />
              </>
            ) : (
              <p className="text-[10.5px] text-parchment-faint">No usable density — chain missing or too thin.</p>
            )}
          </WorkSection>

          <WorkSection title="Volatility — GARCH(1,1) vs implied">
            {inp.garch ? (
              <>
                <WorkRow label="σ forecast 30d (annualized)" value={fmtP(inp.garch.forecastVol30d)} />
                <WorkRow label="IV30 (CBOE)" value={dash(inp.garch.iv30, fmtP)} />
                <WorkRow label="Variance risk premium" value={dash(inp.garch.vrp, (x) => fmtPct(0)(x * 100))} />
                <WorkRow label="α / β" value={`${inp.garch.alpha.toFixed(3)} / ${inp.garch.beta.toFixed(3)}`} />
                <WorkRow label="Long-run σ" value={fmtP(inp.garch.longRunVol)} />
              </>
            ) : (
              <p className="text-[10.5px] text-parchment-faint">Insufficient return history for a GARCH fit (needs 250 sessions).</p>
            )}
          </WorkSection>

          <WorkSection title="Posterior ledger — log-odds fusion">
            <WorkRow label="Prior" value={`${(inp.prior.value * 100).toFixed(0)}% — ${inp.prior.source}`} />
            {inp.contributions.length > 0 ? (
              <div className="mt-1.5 border-t border-line pt-1.5">
                {inp.contributions.map((c) => (
                  <div key={c.name} className="flex items-baseline justify-between gap-3 py-0.5">
                    <span className="fin text-[10px] text-parchment-faint">{c.name}</span>
                    <span className="fin text-[10.5px] text-parchment-dim">
                      LR {c.lr.toFixed(2)} ·{" "}
                      <span className={c.deltaLogOdds > 1e-9 ? "text-bull" : c.deltaLogOdds < -1e-9 ? "text-bear" : "text-parchment-faint"}>
                        Δln {c.deltaLogOdds >= 0 ? "+" : ""}
                        {c.deltaLogOdds.toFixed(3)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[10.5px] text-parchment-faint">No live evidence — posterior equals the prior.</p>
            )}
            <div className="mt-1.5 flex items-baseline justify-between border-t border-line pt-1.5">
              <span className="fin text-[10px] text-parchment">Posterior P(thesis)</span>
              <span className="fin text-[11px] text-parchment">{(inp.posterior * 100).toFixed(1)}%</span>
            </div>
          </WorkSection>

          <WorkSection title="Monte Carlo — Merton jump-diffusion, 10k paths">
            {inp.monteCarlo ? (
              <>
                <WorkRow
                  label={`P(touch kill ${inp.monteCarlo.killPrice != null ? `$${inp.monteCarlo.killPrice.toFixed(0)}` : "—"})`}
                  value={dash(inp.monteCarlo.pHitKill, fmtP)}
                />
                <WorkRow
                  label={`P(≥ target ${inp.monteCarlo.targetPrice != null ? `$${inp.monteCarlo.targetPrice.toFixed(0)}` : "—"})`}
                  value={dash(inp.monteCarlo.pAboveTarget, fmtP)}
                />
                <WorkRow label="CVaR-95 (90d)" value={fmtPct(1)(inp.monteCarlo.cvar95Pct)} />
                <WorkRow label="P(−20% drawdown)" value={fmtP(inp.monteCarlo.pDrawdown20)} />
                <WorkRow
                  label="Jump calibration"
                  value={`λ ${inp.monteCarlo.calibration.jumpIntensity.toFixed(1)}/yr · μⱼ ${(inp.monteCarlo.calibration.jumpMean * 100).toFixed(1)}% · σ_diff ${fmtP(inp.monteCarlo.calibration.diffusionVol)}`}
                />
                <WorkRow label="Kill source" value={inp.monteCarlo.killSource} />
              </>
            ) : (
              <p className="text-[10.5px] text-parchment-faint">No simulation — price data missing.</p>
            )}
          </WorkSection>

          <WorkSection title="Options flow">
            {inp.optionsFlow ? (
              <>
                <WorkRow label="Put/call (volume)" value={dash(inp.optionsFlow.putCallVolumeRatio, fmtNum(2))} />
                <WorkRow label="Put/call (open interest)" value={dash(inp.optionsFlow.putCallOiRatio, fmtNum(2))} />
                <WorkRow label="25Δ skew" value={dash(inp.optionsFlow.skew25Delta, (x) => `${(x * 100).toFixed(1)} vol pts`)} />
                <WorkRow label="Term slope (90d − near)" value={dash(inp.optionsFlow.termSlope, (x) => `${(x * 100).toFixed(1)} vol pts`)} />
                <WorkRow label="Straddle move (nearest)" value={dash(inp.optionsFlow.impliedEarningsMovePct, (x) => `±${x.toFixed(1)}%`)} />
                <WorkRow label="Dealer gamma (GEX)" value={dash(inp.optionsFlow.gex, fmtMoneyShort)} />
                <WorkRow label="Unusual volume z" value={dash(inp.optionsFlow.unusualVolumeZ, fmtNum(1))} />
                <WorkRow
                  label="Volume / OI / contracts"
                  value={`${inp.optionsFlow.totalVolume.toLocaleString()} / ${inp.optionsFlow.totalOpenInterest.toLocaleString()} / ${inp.optionsFlow.contractCount.toLocaleString()}`}
                />
              </>
            ) : (
              <p className="text-[10.5px] text-parchment-faint">No options chain for this name.</p>
            )}
          </WorkSection>

          <WorkSection title="Tape — short / insider / news">
            {inp.short ? (
              <WorkRow
                label={`Short ratio (${inp.short.asOf})`}
                value={`${(inp.short.ratio * 100).toFixed(0)}% of volume · z ${inp.short.z != null ? inp.short.z.toFixed(1) : `— (${inp.short.daysOfHistory}d history)`}`}
              />
            ) : (
              <WorkRow label="Short flow" value="—" />
            )}
            {inp.insider && inp.insider.asOf != null ? (
              <>
                <WorkRow
                  label={`Insiders (as of ${inp.insider.asOf})`}
                  value={`${inp.insider.transactions} txns · net ${fmtMoneyShort(inp.insider.netValue)}`}
                />
                <WorkRow
                  label="Cluster buy"
                  value={inp.insider.clusterBuy ? `YES — ${inp.insider.distinctBuyers} buyers/14d` : `no (${inp.insider.distinctBuyers} buyer${inp.insider.distinctBuyers === 1 ? "" : "s"})`}
                />
              </>
            ) : (
              <WorkRow label="Insiders" value="dark — no Form 4 tape" />
            )}
            {inp.news ? (
              <WorkRow
                label="News"
                value={`${inp.news.count} items · ${inp.news.bullish}↑ ${inp.news.bearish}↓${inp.news.burst ? ` · BURST ${inp.news.burstCount}/48h` : ""}`}
              />
            ) : (
              <WorkRow label="News" value="—" />
            )}
            {inp.regime && (
              <WorkRow
                label="Market regime"
                value={`${inp.regime.read.replace("_", " ")} · P(stressed) ${inp.regime.pStressed != null ? (inp.regime.pStressed * 100).toFixed(0) + "%" : "—"}`}
              />
            )}
            {inp.hedge && (
              <WorkRow
                label="Collar suggestion"
                value={`${inp.hedge.expiry} ${inp.hedge.putStrike}P / ${inp.hedge.callStrike}C${inp.hedge.netCostPerShare != null ? ` · net ${inp.hedge.netCostPerShare >= 0 ? "cost" : "credit"} $${Math.abs(inp.hedge.netCostPerShare).toFixed(2)}` : ""}`}
              />
            )}
          </WorkSection>

          <div className="col-span-2 border border-line bg-ink px-3.5 py-2.5">
            <span className="fin text-[10px] text-parchment-faint">Decision path: {inp.decisionPath}</span>
            {inp.ev && (
              <span className="fin ml-4 text-[10px] text-parchment-faint">
                EV raw {fmtPct(1)(inp.ev.rawPct)} + CVaR penalty {fmtPct(1)(inp.ev.cvarPenaltyPct)} = {fmtPct(1)(inp.ev.riskAdjustedPct)}
              </span>
            )}
            {inp.sizing && (
              <span className="fin ml-4 text-[10px] text-parchment-faint">
                Sizing: {inp.sizing.method === "multi" ? "correlation-aware Kelly" : "scenario Kelly"} → {inp.sizing.recommendedPct.toFixed(1)}% (binding: {inp.sizing.bindingConstraint.replace("_", " ")})
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
