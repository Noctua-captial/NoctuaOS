"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { decideMemo, openPosition } from "@/app/actions";

/** "4.5% of NAV" → 4.5; null when no number is present. */
function parseSizePct(proposedSize: string | null): number | null {
  const m = proposedSize?.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

type SizingResponse = {
  kellyAvailable: boolean;
  sizing: {
    kellyPct: number;
    kellyHalfPct: number;
    volTargetPct: number | null;
    liquidityCapPct: number | null;
    mandateCapPct: number;
    recommendedPct: number;
    bindingConstraint: string;
  };
  themeHeadroomPct: number | null;
  theme: string | null;
  council: {
    riskView: string;
    pmView: string;
    recommendedPct: number;
    closestRuleToViolation: string;
  } | null;
  error?: string;
};

function SizingCouncil({
  ticker,
  memoId,
  onAdopt,
}: {
  ticker: string;
  memoId: number;
  onAdopt: (pct: number) => void;
}) {
  const [data, setData] = useState<SizingResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sizing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker, memoId }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.error) setFailed(true);
        else setData(j);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [ticker, memoId]);

  if (failed) return null;
  if (!data) {
    return (
      <div className="card-rule mt-3 pt-3">
        <span className="fin animate-pulse text-[10px] text-parchment-faint">
          SIZING COUNCIL — running the math…
        </span>
      </div>
    );
  }

  const s = data.sizing;
  const rows: { label: string; value: number | null; binding: boolean }[] = [
    { label: data.kellyAvailable ? "Half-Kelly" : "Half-Kelly (no scenario prices)", value: data.kellyAvailable ? s.kellyHalfPct : null, binding: s.bindingConstraint === "kelly" },
    { label: "Vol target", value: s.volTargetPct, binding: s.bindingConstraint === "vol_target" },
    { label: "Liquidity cap", value: s.liquidityCapPct, binding: s.bindingConstraint === "liquidity" },
    { label: "Mandate cap", value: s.mandateCapPct, binding: s.bindingConstraint === "mandate" },
  ];
  const adoptPct = data.council?.recommendedPct ?? s.recommendedPct;

  return (
    <div className="card-rule mt-3 pt-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="label !text-[9px]">Sizing Council — deterministic constraints</span>
        {data.theme && data.themeHeadroomPct != null && (
          <span className="fin text-[10px] text-parchment-faint">
            {data.theme}: {data.themeHeadroomPct.toFixed(1)}% theme headroom
          </span>
        )}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className={`border px-2 py-1.5 ${r.binding ? "border-warn/60" : "border-line"}`}
          >
            <div className="label !text-[7px]">{r.label}{r.binding ? " · BINDS" : ""}</div>
            <div className={`fin text-[12px] ${r.binding ? "text-warn" : "text-parchment-dim"}`}>
              {r.value != null ? `${r.value.toFixed(1)}%` : "—"}
            </div>
          </div>
        ))}
        <button
          onClick={() => onAdopt(Number(adoptPct.toFixed(1)))}
          className="btn btn-primary !px-2 !py-1 !text-[9px]"
          title="Adopt the council's recommended size"
        >
          ADOPT {adoptPct.toFixed(1)}%
        </button>
      </div>
      {data.council ? (
        <div className="mt-2 space-y-1 text-[10.5px] leading-relaxed text-parchment-faint">
          <p><span className="label !text-[8px]">RISK — </span>{data.council.riskView}</p>
          <p><span className="label !text-[8px]">PM — </span>{data.council.pmView}</p>
          <p><span className="label !text-[8px]">WATCH — </span>{data.council.closestRuleToViolation}</p>
        </div>
      ) : (
        <p className="mt-2 text-[10.5px] text-parchment-faint">
          Council deliberation offline (no model key) — math-only recommendation shown.
        </p>
      )}
    </div>
  );
}

function OpenPositionPanel({
  memoId,
  companyId,
  ticker,
  quotePrice,
  proposedSize,
  decidedBy,
}: {
  memoId: number;
  companyId: number;
  ticker: string;
  quotePrice: number | null;
  proposedSize: string | null;
  decidedBy: string;
}) {
  const [entryPrice, setEntryPrice] = useState(quotePrice != null ? quotePrice.toFixed(2) : "");
  const [sizePct, setSizePct] = useState(() => {
    const s = parseSizePct(proposedSize);
    return s != null ? String(s) : "";
  });
  const [owner, setOwner] = useState(decidedBy);
  const [pending, start] = useTransition();

  const price = Number(entryPrice);
  const size = Number(sizePct);
  const valid = Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0;

  const inputCls =
    "fin w-full border border-line bg-ink px-2.5 py-1.5 text-[11px] text-parchment placeholder:text-parchment-faint/60 focus:border-platinum focus:outline-none";

  return (
    <div className="mx-auto mb-5 max-w-3xl border border-bull/40 bg-ink-card px-5 py-4">
      <div className="flex items-baseline justify-between">
        <span className="label !text-bull">Open position — memo approved, capital uncommitted</span>
        <span className="fin text-[10px] text-parchment-faint">
          {quotePrice != null ? `Live quote $${quotePrice.toFixed(2)}` : "No live quote — enter price manually"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-3">
        <div>
          <div className="label mb-1 !text-[8px]">Entry price $</div>
          <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} placeholder="0.00" className={inputCls} />
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Size % of NAV</div>
          <input value={sizePct} onChange={(e) => setSizePct(e.target.value)} placeholder="0.0" className={inputCls} />
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Owner</div>
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Analyst" className={inputCls} />
        </div>
        <div className="flex items-end">
          <button
            disabled={pending || !valid}
            onClick={() =>
              start(async () => {
                await openPosition({ companyId, memoId, entryPrice: price, sizePct: size, owner });
              })
            }
            className="btn btn-bull w-full !py-2"
          >
            {pending ? "OPENING…" : `OPEN ${ticker}`}
          </button>
        </div>
      </div>
      <p className="mt-2.5 text-[10.5px] leading-relaxed text-parchment-faint">
        Proposed in memo: {proposedSize ?? "no size stated"}. Kill criteria are snapshotted from the
        current thesis at entry. Closing later requires an After-Action postmortem.
      </p>
      <SizingCouncil ticker={ticker} memoId={memoId} onAdopt={(pct) => setSizePct(String(pct))} />
    </div>
  );
}

export function MemoDecision({
  memoId,
  decidedBy,
  decidedAt,
  recommendation,
  companyId,
  ticker,
  quotePrice,
  proposedSize,
  hasPosition,
}: {
  memoId: number;
  decidedBy: string | null;
  decidedAt: string | null;
  recommendation: string | null;
  companyId: number;
  ticker: string;
  quotePrice: number | null;
  proposedSize: string | null;
  hasPosition: boolean;
}) {
  const [analyst, setAnalyst] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "reject" | "more_work" | null>(null);
  const [pending, start] = useTransition();

  if (decidedBy) {
    const verdict =
      recommendation === "approve" ? "APPROVED" : recommendation === "reject" ? "REJECTED" : "MORE WORK";
    const cls =
      recommendation === "approve" ? "text-bull border-bull/50" : recommendation === "reject" ? "text-bear border-bear/50" : "text-warn border-warn/50";
    return (
      <>
        <div className="mx-auto mb-5 flex max-w-3xl items-center justify-between border border-line bg-ink-card px-5 py-3.5">
          <span className={`fin border px-2 py-1 text-[10px] tracking-[0.2em] ${cls}`}>{verdict}</span>
          <span className="fin text-[11px] text-parchment-faint">
            Decided by {decidedBy}
            {decidedAt ? ` · ${decidedAt.slice(0, 10)}` : ""} — decision is on the record
          </span>
        </div>
        {recommendation === "approve" && !hasPosition && (
          <OpenPositionPanel
            memoId={memoId}
            companyId={companyId}
            ticker={ticker}
            quotePrice={quotePrice}
            proposedSize={proposedSize}
            decidedBy={decidedBy}
          />
        )}
        {recommendation === "approve" && hasPosition && (
          <div className="mx-auto mb-5 flex max-w-3xl items-center justify-between border border-line bg-ink-card px-5 py-3">
            <span className="label">Position on the book per this memo</span>
            <Link href="/talons" className="label !text-[9px] hover:text-parchment-dim">
              VIEW IN TALONS →
            </Link>
          </div>
        )}
      </>
    );
  }

  function act(decision: "approve" | "reject" | "more_work") {
    if (confirm !== decision) {
      setConfirm(decision);
      return;
    }
    start(async () => {
      await decideMemo(memoId, decision, analyst.trim() || "Unnamed IC member");
      setConfirm(null);
    });
  }

  return (
    <div className="mx-auto mb-5 max-w-3xl border border-warn/40 bg-ink-card px-5 py-4">
      <div className="flex items-center justify-between">
        <span className="label !text-warn">IC Decision required — this memo is undecided</span>
        <input
          value={analyst}
          onChange={(e) => setAnalyst(e.target.value)}
          placeholder="Your name"
          className="fin w-36 border border-line bg-ink px-2.5 py-1.5 text-[11px] text-parchment placeholder:text-parchment-faint/60 focus:border-platinum focus:outline-none"
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <button disabled={pending} onClick={() => act("approve")} className="btn btn-bull !py-2.5">
          {confirm === "approve" ? "CONFIRM APPROVE?" : "APPROVE"}
        </button>
        <button disabled={pending} onClick={() => act("more_work")} className="btn !py-2.5">
          {confirm === "more_work" ? "CONFIRM MORE WORK?" : "MORE WORK NEEDED"}
        </button>
        <button disabled={pending} onClick={() => act("reject")} className="btn btn-danger !py-2.5">
          {confirm === "reject" ? "CONFIRM REJECT?" : "REJECT"}
        </button>
      </div>
      <p className="mt-2.5 text-[10.5px] leading-relaxed text-parchment-faint">
        Approve activates the position workflow. Reject records the reason — Night Vision watches
        rejected names for the blocker to clear. Every decision becomes a trace in the Alpha Ledger.
      </p>
    </div>
  );
}
