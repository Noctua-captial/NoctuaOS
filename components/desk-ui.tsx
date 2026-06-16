"use client";

import { useState, useTransition } from "react";
import { openOptionStructure, closeOptionStructure, createOptionPostmortem, type OpenStructureInput } from "@/app/actions";

type RecStructure = Omit<OpenStructureInput, "qty" | "owner">;

export function OpenStructure({
  structure,
  suggestedQty,
  bindingNote,
}: {
  structure: RecStructure;
  suggestedQty: number;
  bindingNote?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(Math.max(suggestedQty, 1)));
  const [owner, setOwner] = useState("");
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn btn-primary !px-2.5 !py-1 !text-[9px]"
        disabled={suggestedQty <= 0}
        title={suggestedQty <= 0 ? "Budget exhausted — no lots permitted" : "Open this structure on the desk"}
      >
        OPEN →
      </button>
    );
  }

  const q = Number(qty);
  const valid = Number.isFinite(q) && q > 0;

  return (
    <span className="flex items-center justify-end gap-1.5">
      <input
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        placeholder="lots"
        className="fin w-12 border border-line bg-ink px-1.5 py-1 text-[11px] text-parchment focus:border-platinum focus:outline-none"
        title={bindingNote ?? undefined}
      />
      <input
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        placeholder="owner"
        className="fin w-20 border border-line bg-ink px-1.5 py-1 text-[11px] text-parchment placeholder:text-parchment-faint/60 focus:border-platinum focus:outline-none"
      />
      <button
        disabled={pending || !valid}
        onClick={() => start(async () => { await openOptionStructure({ ...structure, qty: q, owner }); setOpen(false); })}
        className="btn btn-primary !px-2.5 !py-1 !text-[9px]"
      >
        {pending ? "…" : "CONFIRM"}
      </button>
      <button disabled={pending} onClick={() => setOpen(false)} className="btn !px-2 !py-1 !text-[9px]">
        ✕
      </button>
    </span>
  );
}

export function CloseOptionStructure({
  structureId,
  suggestedExitPerLot,
  currentUnderlying,
}: {
  structureId: number;
  suggestedExitPerLot: number | null;
  currentUnderlying: number | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [exit, setExit] = useState(suggestedExitPerLot != null ? String(Math.round(suggestedExitPerLot)) : "");
  const [pending, start] = useTransition();

  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} className="btn btn-danger !px-2.5 !py-1 !text-[9px]">
        CLOSE
      </button>
    );
  }

  const value = Number(exit);
  const valid = Number.isFinite(value);

  return (
    <span className="flex items-center justify-end gap-1.5">
      <input
        value={exit}
        onChange={(e) => setExit(e.target.value)}
        placeholder="$/lot to close"
        autoFocus
        className="fin w-24 border border-line bg-ink px-2 py-1 text-[11px] text-parchment placeholder:text-parchment-faint/60 focus:border-platinum focus:outline-none"
      />
      <button
        disabled={pending || !valid}
        onClick={() => start(async () => closeOptionStructure(structureId, value, currentUnderlying))}
        className="btn btn-danger !px-2.5 !py-1 !text-[9px]"
      >
        {pending ? "…" : "CONFIRM"}
      </button>
      <button disabled={pending} onClick={() => setConfirming(false)} className="btn !px-2 !py-1 !text-[9px]">
        ✕
      </button>
    </span>
  );
}

export function OptionPostmortemForm({ structureId, ticker }: { structureId: number; ticker: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn !px-2.5 !py-1 !text-[9px]">
        POSTMORTEM
      </button>
    );
  }

  const inputCls =
    "fin w-full border border-line bg-ink px-2.5 py-1.5 text-[11px] text-parchment placeholder:text-parchment-faint/60 focus:border-platinum focus:outline-none";
  const selectCls =
    "fin w-full cursor-pointer border border-line bg-ink px-2 py-1.5 text-[10px] uppercase tracking-[0.1em] text-parchment-dim focus:border-platinum focus:outline-none";

  return (
    <form action={(fd) => start(async () => createOptionPostmortem(fd))} className="mt-3 border border-line bg-ink px-4 py-4 text-left">
      <div className="flex items-baseline justify-between">
        <span className="label">Options After-Action — {ticker}</span>
        <button type="button" onClick={() => setOpen(false)} className="label !text-[9px] hover:text-parchment-dim">
          CANCEL ✕
        </button>
      </div>

      <input type="hidden" name="structureId" value={structureId} />

      <div className="mt-3 grid grid-cols-4 gap-3">
        <div>
          <div className="label mb-1 !text-[8px]">Outcome</div>
          <select name="outcome" defaultValue="win" className={selectCls}>
            <option value="win">win</option>
            <option value="loss">loss</option>
            <option value="scratch">scratch</option>
          </select>
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Vol view</div>
          <select name="volViewRight" defaultValue="right" className={selectCls}>
            <option value="right">right</option>
            <option value="wrong">wrong</option>
            <option value="mixed">mixed</option>
          </select>
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Direction</div>
          <select name="directionRight" defaultValue="right" className={selectCls}>
            <option value="right">right</option>
            <option value="wrong">wrong</option>
            <option value="mixed">mixed</option>
          </select>
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Structure choice</div>
          <select name="structureChoiceRight" defaultValue="true" className={selectCls}>
            <option value="true">right</option>
            <option value="false">wrong</option>
          </select>
        </div>
      </div>

      <div className="mt-3">
        <div className="label mb-1 !text-[8px]">Theta / decay vs the plan</div>
        <input name="thetaCapture" placeholder="Did decay help or hurt vs expectation?" className={inputCls} />
      </div>

      <div className="mt-3">
        <div className="label mb-1 !text-[8px]">Narrative — what actually happened</div>
        <textarea name="narrative" rows={4} placeholder="Entry logic, IV path, what moved, why we closed/rolled." className={inputCls} />
      </div>

      <div className="mt-3">
        <div className="label mb-1 !text-[8px]">Lessons — one per line</div>
        <textarea name="lessons" rows={3} placeholder={"Sell premium into earnings only when VRP is genuinely rich.\nManage spreads at 50% of max profit, not expiry."} className={inputCls} />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="w-44">
          <div className="label mb-1 !text-[8px]">Filed by</div>
          <input name="createdBy" placeholder="Your name" className={inputCls} />
        </div>
        <button disabled={pending} className="btn btn-primary !py-2">
          {pending ? "FILING…" : "FILE POSTMORTEM"}
        </button>
      </div>
    </form>
  );
}
