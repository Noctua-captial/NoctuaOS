"use client";

import { useState, useRef } from "react";
import Link from "next/link";

type StageEvent = {
  stage: string;
  message: string;
  ticker?: string;
  memoId?: number;
  score?: number;
};

const stageOrder = ["vault", "dossier", "quant", "bench", "tree", "logic", "strix", "audit", "debate", "synthesis", "persist", "done"];

const stageMeta: Record<string, { agent: string; title: string }> = {
  vault: { agent: "THE VAULT", title: "Retrieving primary-source evidence" },
  dossier: { agent: "ATHENA · DOSSIER AGENT", title: "Building dossier & bull thesis" },
  quant: { agent: "QUANT BENCH", title: "Computing ground truth from price history" },
  bench: { agent: "AGENT BENCH", title: "Accounting · Industry · Catalyst · Valuation" },
  tree: { agent: "RECURSIVE TREE", title: "Load-bearing questions, investigated in depth" },
  logic: { agent: "LOGIC AUDITOR", title: "Premises → inference → conclusion" },
  strix: { agent: "STRIX · BEAR AGENT", title: "Attacking the thesis" },
  audit: { agent: "EVIDENCE AUDITOR", title: "No source, no claim" },
  debate: { agent: "DEBATE CHAMBER", title: "Advocate vs Strix vs The Quant" },
  synthesis: { agent: "ATHENA · IC SYNTHESIS", title: "Scoring & drafting memo" },
  persist: { agent: "ALPHA LEDGER", title: "Committing to research memory" },
  done: { agent: "IC CHAMBER", title: "Investigation complete" },
  error: { agent: "SYSTEM", title: "Pipeline failure" },
};

export function NewInvestigation({ initialTicker = "" }: { initialTicker?: string }) {
  const [ticker, setTicker] = useState(initialTicker);
  const [notes, setNotes] = useState("");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [result, setResult] = useState<StageEvent | null>(null);
  const doneRef = useRef<StageEvent | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim() || running) return;
    setRunning(true);
    setEvents([]);
    setResult(null);
    doneRef.current = null;

    try {
      const res = await fetch("/api/athena", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: ticker.trim(), notes: notes.trim() || undefined }),
      });

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        setEvents([{ stage: "error", message: j?.error ?? `Request failed (${res.status})` }]);
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as StageEvent;
            setEvents((prev) => [...prev, ev]);
            if (ev.stage === "done") doneRef.current = ev;
          } catch {}
        }
      }

      if (doneRef.current?.ticker) setResult(doneRef.current);
    } catch {
      setEvents((prev) => [...prev, { stage: "error", message: "Connection lost mid-investigation." }]);
    } finally {
      setRunning(false);
    }
  }

  const currentStageIdx = events.length
    ? stageOrder.indexOf(events[events.length - 1].stage)
    : -1;
  const failed = events.some((e) => e.stage === "error");

  return (
    <div>
      <div className="border-b border-line px-10 py-8">
        <div className="label mb-2">Athena — New Investigation</div>
        <h1 className="serif text-4xl font-medium text-parchment">
          From raw curiosity to IC memo.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-parchment-dim">
          Enter a ticker. Athena assigns the Dossier and Thesis agents, Strix attacks the result,
          and the synthesis is scored and committed to research memory as a draft IC memo —
          with evidence, bear case, kill criteria, and next diligence steps.
        </p>
      </div>

      <div className="grid grid-cols-12 gap-8 px-10 py-8">
        <form onSubmit={run} className="col-span-5">
          <div className="card px-6 py-6">
            <label className="label mb-2 block">Ticker</label>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="TSEM"
              maxLength={8}
              disabled={running}
              className="fin w-full border border-line-strong bg-ink px-4 py-3 text-2xl tracking-[0.2em] text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
            />
            <label className="label mb-2 mt-5 block">Analyst context — optional</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why did this catch our attention? Any angle Athena should pursue?"
              rows={4}
              disabled={running}
              className="w-full resize-none border border-line bg-ink px-4 py-3 text-sm text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
            />
            <button
              type="submit"
              disabled={running || !ticker.trim()}
              className="fin mt-5 w-full border border-line-strong px-4 py-3 text-xs tracking-[0.25em] text-parchment transition-colors hover:bg-ink-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "INVESTIGATION IN PROGRESS…" : "OPEN INVESTIGATION"}
            </button>
            <p className="mt-4 text-[11px] leading-relaxed text-parchment-faint">
              Draft research is generated from model knowledge, not live filings. Every claim is
              classified (fact / inference / unverified) and must be verified by a human analyst
              before capital is committed.
            </p>
          </div>
        </form>

        <div className="col-span-7">
          <div className="label mb-3">Pipeline</div>
          <div className="card divide-y divide-line">
            {events.length === 0 && (
              <div className="px-6 py-10 text-center text-sm text-parchment-faint">
                {running ? "Assigning agents…" : "Awaiting target."}
              </div>
            )}
            {events.map((ev, i) => {
              const meta = stageMeta[ev.stage] ?? stageMeta.error;
              const isLast = i === events.length - 1;
              const isError = ev.stage === "error";
              return (
                <div key={i} className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <span
                      className={`fin text-[9px] tracking-[0.2em] ${
                        isError ? "text-bear" : ev.stage === "done" ? "text-bull" : "text-platinum"
                      }`}
                    >
                      {meta.agent}
                    </span>
                    {isLast && running && (
                      <span className="fin animate-pulse text-[9px] text-warn">WORKING…</span>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-parchment">{meta.title}</div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-parchment-dim">{ev.message}</p>
                </div>
              );
            })}
          </div>

          {/* completion panel */}
          {result && !failed && (
            <div className="fade-up card mt-4 border-bull/30 px-6 py-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="label !text-bull">Investigation complete</div>
                  <div className="fin mt-1 text-sm text-parchment">
                    {result.ticker} · Noctua Score {result.score}
                  </div>
                </div>
                <div className="flex gap-2.5">
                  <Link href={`/dossiers/${result.ticker}`} className="btn btn-primary !text-[9px]">
                    OPEN DOSSIER
                  </Link>
                  {result.memoId && (
                    <Link href={`/ic/${result.memoId}`} className="btn !text-[9px]">
                      IC MEMO
                    </Link>
                  )}
                  <Link href={`/dossiers/${result.ticker}/graph`} className="btn !text-[9px]">
                    GRAPH
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Stage tracker */}
          <div className="mt-4 flex items-center gap-1">
            {stageOrder.map((s, i) => (
              <div
                key={s}
                className={`h-px flex-1 ${
                  failed
                    ? "bg-bear/40"
                    : i <= currentStageIdx
                      ? "bg-platinum"
                      : "bg-line"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
