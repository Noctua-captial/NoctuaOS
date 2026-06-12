"use client";

import { useState, useTransition } from "react";
import { createPostmortem } from "@/app/actions";

type Draft = {
  outcome?: string;
  thesisRight?: string;
  timingRight?: boolean;
  sizingRight?: boolean;
  narrative?: string;
  lessons?: string[];
};

export function PostmortemForm({
  positionId,
  companyId,
  ticker,
  aiAvailable,
}: {
  positionId: number | null;
  companyId: number;
  ticker: string;
  aiAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState("win");
  const [thesisRight, setThesisRight] = useState("right");
  const [timingRight, setTimingRight] = useState("true");
  const [sizingRight, setSizingRight] = useState("true");
  const [narrative, setNarrative] = useState("");
  const [lessons, setLessons] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn !px-2.5 !py-1 !text-[9px]">
        POSTMORTEM
      </button>
    );
  }

  async function draftWithAi() {
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await fetch("/api/postmortem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId, companyId }),
      });
      const data = (await res.json()) as { draft?: Draft; error?: string };
      if (!res.ok || !data.draft) throw new Error(data.error ?? "Draft failed.");
      const d = data.draft;
      if (d.outcome) setOutcome(d.outcome);
      if (d.thesisRight) setThesisRight(d.thesisRight);
      if (d.timingRight != null) setTimingRight(String(d.timingRight));
      if (d.sizingRight != null) setSizingRight(String(d.sizingRight));
      if (d.narrative) setNarrative(d.narrative);
      if (d.lessons?.length) setLessons(d.lessons.join("\n"));
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : "Draft failed.");
    } finally {
      setDrafting(false);
    }
  }

  const valid = narrative.trim().length >= 10;
  const inputCls =
    "fin w-full border border-line bg-ink px-2.5 py-1.5 text-[11px] text-parchment placeholder:text-parchment-faint/60 focus:border-platinum focus:outline-none";
  const selectCls =
    "fin w-full cursor-pointer border border-line bg-ink px-2 py-1.5 text-[10px] uppercase tracking-[0.1em] text-parchment-dim focus:border-platinum focus:outline-none";

  return (
    <form
      action={(fd) => start(async () => createPostmortem(fd))}
      className="mt-3 border border-line bg-ink px-4 py-4 text-left"
    >
      <div className="flex items-baseline justify-between">
        <span className="label">After-Action — {ticker}</span>
        <span className="flex items-center gap-2">
          {aiAvailable && (
            <button type="button" disabled={drafting} onClick={draftWithAi} className="btn !px-2.5 !py-1 !text-[9px]">
              {drafting ? "DRAFTING…" : "DRAFT WITH AI"}
            </button>
          )}
          <button type="button" onClick={() => setOpen(false)} className="label !text-[9px] hover:text-parchment-dim">
            CANCEL ✕
          </button>
        </span>
      </div>
      {draftError && <p className="mt-2 text-[10.5px] text-bear">{draftError}</p>}

      <input type="hidden" name="companyId" value={companyId} />
      {positionId != null && <input type="hidden" name="positionId" value={positionId} />}

      <div className="mt-3 grid grid-cols-4 gap-3">
        <div>
          <div className="label mb-1 !text-[8px]">Outcome</div>
          <select name="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className={selectCls}>
            <option value="win">win</option>
            <option value="loss">loss</option>
            <option value="scratch">scratch</option>
          </select>
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Thesis</div>
          <select name="thesisRight" value={thesisRight} onChange={(e) => setThesisRight(e.target.value)} className={selectCls}>
            <option value="right">right</option>
            <option value="wrong">wrong</option>
            <option value="right_for_wrong_reason">right, wrong reason</option>
          </select>
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Timing</div>
          <select name="timingRight" value={timingRight} onChange={(e) => setTimingRight(e.target.value)} className={selectCls}>
            <option value="true">right</option>
            <option value="false">wrong</option>
          </select>
        </div>
        <div>
          <div className="label mb-1 !text-[8px]">Sizing</div>
          <select name="sizingRight" value={sizingRight} onChange={(e) => setSizingRight(e.target.value)} className={selectCls}>
            <option value="true">right</option>
            <option value="false">wrong</option>
          </select>
        </div>
      </div>

      <div className="mt-3">
        <div className="label mb-1 !text-[8px]">Narrative — what actually happened</div>
        <textarea
          name="narrative"
          value={narrative}
          onChange={(e) => setNarrative(e.target.value)}
          rows={4}
          placeholder="Entry logic, what the market did, what we missed, why we exited."
          className={inputCls}
        />
      </div>

      <div className="mt-3">
        <div className="label mb-1 !text-[8px]">Lessons — one per line</div>
        <textarea
          name="lessons"
          value={lessons}
          onChange={(e) => setLessons(e.target.value)}
          rows={3}
          placeholder={"Weight channel checks over management guidance.\nSize down when the catalyst date is soft."}
          className={inputCls}
        />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="w-44">
          <div className="label mb-1 !text-[8px]">Filed by</div>
          <input name="createdBy" value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} placeholder="Your name" className={inputCls} />
        </div>
        <button disabled={pending || !valid} className="btn btn-primary !py-2">
          {pending ? "FILING…" : "FILE POSTMORTEM"}
        </button>
      </div>
      <p className="mt-2.5 text-[10.5px] leading-relaxed text-parchment-faint">
        Filing stamps every open-outcome trace on {ticker} with this result. The ledger learns; the
        fund compounds judgment.
      </p>
    </form>
  );
}
