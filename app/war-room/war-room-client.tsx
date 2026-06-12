"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resizePosition, closePosition, updatePortfolioNav } from "@/app/actions";
import type { CouncilBrief } from "@/lib/warroom";

export function ConveneButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function convene() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/warroom/brief", { method: "POST" });
      const j = await res.json();
      if (!res.ok) setError(j.error ?? "Council unavailable.");
      else router.refresh();
    } catch {
      setError("Connection lost while the council deliberated.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="text-right">
      <button onClick={convene} disabled={running} className="btn btn-primary">
        {running ? "COUNCIL DELIBERATING…" : "CONVENE THE COUNCIL"}
      </button>
      {error && <p className="mt-2 max-w-xs text-[10.5px] leading-relaxed text-warn">{error}</p>}
    </div>
  );
}

export function RefreshDirectivesButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/oracle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const j = await res.json();
      if (!res.ok) setError(j.error ?? "The Oracle is unavailable.");
      else router.refresh();
    } catch {
      setError("Connection lost while the Oracle deliberated.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <span className="text-right">
      <button onClick={refresh} disabled={running} className="btn !px-3 !py-1.5 !text-[9px]">
        {running ? "THE ORACLE DELIBERATES…" : "REFRESH DIRECTIVES"}
      </button>
      {error && <p className="mt-1 text-[10px] leading-relaxed text-warn">{error}</p>}
    </span>
  );
}

// One row of the Action Plan: the directive's verdict on an open position with
// a one-click execute path through the same position actions the council uses.
export function DirectiveActionRow({
  ticker,
  action,
  conviction,
  reason,
  impactPct,
  sizeTargetPct,
  position,
  livePrice,
}: {
  ticker: string;
  action: string;
  conviction: number;
  reason: string;
  impactPct: number | null; // |EV90d × sizePct| in %·% — expected dollar-impact rank
  sizeTargetPct: number | null;
  position: { id: number; sizePct: number } | null;
  livePrice: number | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  const tone =
    action === "BUY" || action === "ADD" ? "text-bull border-bull/50"
    : action === "TRIM" || action === "EXIT" || action === "AVOID" ? "text-bear border-bear/50"
    : action === "HEDGE" ? "text-warn border-warn/50"
    : "text-parchment-dim border-line";

  const executable =
    position != null &&
    !done &&
    (action === "EXIT" || ((action === "TRIM" || action === "ADD") && sizeTargetPct != null));

  function execute() {
    if (!position) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    start(async () => {
      if (action === "EXIT") {
        if (livePrice != null) await closePosition(position.id, livePrice);
      } else if (sizeTargetPct != null && sizeTargetPct > 0) {
        await resizePosition(position.id, sizeTargetPct, "Oracle Directive");
      }
      setDone(true);
      setConfirm(false);
    });
  }

  return (
    <div className="card flex items-start gap-4 px-5 py-3.5">
      <span className={`fin mt-0.5 w-14 shrink-0 border px-1.5 py-0.5 text-center text-[9px] tracking-[0.15em] ${tone}`}>
        {action}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <a href={`/dossiers/${ticker}`} className="fin text-sm text-parchment underline-offset-4 hover:underline">
            {ticker}
          </a>
          <span className="fin text-[10px] text-parchment-faint">conviction {conviction}/100</span>
          {position && sizeTargetPct != null && sizeTargetPct !== position.sizePct && (
            <span className="fin text-[10px] text-parchment-faint">
              {position.sizePct.toFixed(1)}% → {sizeTargetPct.toFixed(1)}% NAV
            </span>
          )}
          {impactPct != null && (
            <span className="fin ml-auto shrink-0 text-[9px] text-parchment-faint">
              book impact ±{impactPct.toFixed(2)}% NAV
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-parchment-dim">{reason}</p>
      </div>
      {executable ? (
        <button
          onClick={execute}
          disabled={pending}
          className={`btn shrink-0 !px-3 !py-1.5 !text-[9px] ${action === "EXIT" ? "btn-danger" : ""}`}
        >
          {pending ? "…" : confirm ? "CONFIRM?" : action === "EXIT" ? `EXIT @ ${livePrice != null ? `$${livePrice.toFixed(2)}` : "MKT"}` : "EXECUTE"}
        </button>
      ) : done ? (
        <span className="fin shrink-0 text-[10px] text-bull">EXECUTED</span>
      ) : (
        <a href={`/dossiers/${ticker}`} className="label shrink-0 !text-[9px] hover:text-parchment-dim">
          DOSSIER →
        </a>
      )}
    </div>
  );
}

export function ProposalCard({
  proposal,
  position,
  livePrice,
}: {
  proposal: CouncilBrief["perPosition"][number];
  position: { id: number; sizePct: number } | null;
  livePrice: number | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  const actionColor =
    proposal.action === "add" ? "text-bull border-bull/50"
    : proposal.action === "exit" ? "text-bear border-bear/50"
    : proposal.action === "trim" ? "text-warn border-warn/50"
    : "text-parchment-dim border-line";

  const executable = position != null && proposal.action !== "hold" && !done;
  const newSize =
    position != null && proposal.sizeDeltaPct != null
      ? Math.max(position.sizePct + proposal.sizeDeltaPct, 0)
      : null;

  function execute() {
    if (!position) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    start(async () => {
      if (proposal.action === "exit") {
        if (livePrice != null) await closePosition(position.id, livePrice);
      } else if (newSize != null && newSize > 0) {
        await resizePosition(position.id, newSize, "War Room Council");
      }
      setDone(true);
      setConfirm(false);
    });
  }

  return (
    <div className="card flex items-start gap-4 px-5 py-3.5">
      <span className={`fin mt-0.5 w-14 shrink-0 border px-1.5 py-0.5 text-center text-[9px] tracking-[0.15em] ${actionColor}`}>
        {proposal.action.toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className="fin text-sm text-parchment">{proposal.ticker}</span>
          {proposal.sizeDeltaPct != null && proposal.action !== "hold" && (
            <span className="fin text-[11px] text-parchment-faint">
              {proposal.sizeDeltaPct > 0 ? "+" : ""}
              {proposal.sizeDeltaPct.toFixed(1)}% NAV
              {newSize != null ? ` → ${newSize.toFixed(1)}%` : ""}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-parchment-dim">{proposal.rationale}</p>
      </div>
      {executable && (
        <button onClick={execute} disabled={pending} className={`btn shrink-0 !px-3 !py-1.5 !text-[9px] ${proposal.action === "exit" ? "btn-danger" : ""}`}>
          {pending ? "…" : confirm ? "CONFIRM?" : proposal.action === "exit" ? `EXIT @ ${livePrice != null ? `$${livePrice.toFixed(2)}` : "MKT"}` : "EXECUTE"}
        </button>
      )}
      {done && <span className="fin shrink-0 text-[10px] text-bull">EXECUTED</span>}
    </div>
  );
}

export function NavEditor({ nav, cash }: { nav: number; cash: number | null }) {
  const [navStr, setNavStr] = useState(String(nav));
  const [cashStr, setCashStr] = useState(cash != null ? String(cash) : "");
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="label !text-[9px] opacity-60 hover:opacity-100">
        EDIT NAV ✎
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <input
        value={navStr}
        onChange={(e) => setNavStr(e.target.value)}
        placeholder="NAV $"
        className="fin w-28 border border-line bg-ink px-2 py-1 text-[10px] text-parchment focus:border-platinum focus:outline-none"
      />
      <input
        value={cashStr}
        onChange={(e) => setCashStr(e.target.value)}
        placeholder="Cash $ (blank = derived)"
        className="fin w-36 border border-line bg-ink px-2 py-1 text-[10px] text-parchment focus:border-platinum focus:outline-none"
      />
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            await updatePortfolioNav(Number(navStr), cashStr.trim() ? Number(cashStr) : null);
            setEditing(false);
          })
        }
        className="btn !px-2 !py-1 !text-[8px]"
      >
        SAVE
      </button>
    </span>
  );
}
