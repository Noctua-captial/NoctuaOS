"use client";

import { useMemo, useState } from "react";
import { addClaim } from "@/app/actions";
import { ClaimKind } from "@/components/ui";

export type ClaimRow = {
  id: number;
  text: string;
  kind: string;
  supports: string;
  confidence: number;
  source: string | null;
  sourceType: string | null;
};

const SIDE_FILTERS = ["all", "bull", "bear"] as const;
const KIND_FILTERS = ["all", "fact", "inference", "model_assumption", "unverified"] as const;

export function EvidenceTable({ companyId, claims }: { companyId: number; claims: ClaimRow[] }) {
  const [side, setSide] = useState<(typeof SIDE_FILTERS)[number]>("all");
  const [kind, setKind] = useState<(typeof KIND_FILTERS)[number]>("all");
  const [adding, setAdding] = useState(false);

  const filtered = useMemo(
    () =>
      claims.filter(
        (c) => (side === "all" || c.supports === side) && (kind === "all" || c.kind === kind),
      ),
    [claims, side, kind],
  );

  const chip = (active: boolean) =>
    `fin border px-2 py-1 text-[9px] uppercase tracking-[0.12em] transition-colors cursor-pointer ${
      active
        ? "border-parchment-dim text-parchment"
        : "border-line text-parchment-faint hover:border-line-strong hover:text-parchment-dim"
    }`;

  return (
    <section id="evidence">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="serif text-2xl text-parchment">The Vault — Evidence</h2>
        <div className="flex items-center gap-4">
          <span className="label">
            {filtered.length}/{claims.length} claims
          </span>
          <button onClick={() => setAdding((a) => !a)} className="btn !px-3 !py-1.5 !text-[9px]">
            {adding ? "CANCEL" : "+ ADD CLAIM"}
          </button>
        </div>
      </div>

      {/* filters */}
      <div className="mb-3 flex items-center gap-2">
        {SIDE_FILTERS.map((s) => (
          <button key={s} onClick={() => setSide(s)} className={chip(side === s)}>
            {s}
          </button>
        ))}
        <span className="mx-1 h-3 w-px bg-line" />
        {KIND_FILTERS.map((k) => (
          <button key={k} onClick={() => setKind(k)} className={chip(kind === k)}>
            {k.replace("_", " ")}
          </button>
        ))}
      </div>

      {/* inline add-claim — the human analyst path into research memory */}
      {adding && (
        <form
          action={async (fd) => {
            await addClaim(fd);
            setAdding(false);
          }}
          className="fade-up card mb-3 px-5 py-4"
        >
          <input type="hidden" name="companyId" value={companyId} />
          <textarea
            name="text"
            required
            minLength={10}
            placeholder="The claim. One sentence. It will be held to the same audit standard as agent claims."
            rows={2}
            className="w-full resize-none border border-line bg-ink px-3 py-2 text-[13px] text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
          />
          <div className="mt-3 grid grid-cols-5 gap-3">
            <select name="kind" className="fin border border-line bg-ink px-2 py-1.5 text-[10px] text-parchment-dim">
              <option value="fact">fact</option>
              <option value="inference">inference</option>
              <option value="opinion">opinion</option>
              <option value="model_assumption">model assumption</option>
              <option value="unverified" selected>unverified</option>
            </select>
            <select name="supports" className="fin border border-line bg-ink px-2 py-1.5 text-[10px] text-parchment-dim">
              <option value="bull">bull</option>
              <option value="bear">bear</option>
              <option value="neutral" selected>neutral</option>
            </select>
            <select name="sourceType" className="fin border border-line bg-ink px-2 py-1.5 text-[10px] text-parchment-dim">
              <option value="filing">filing</option>
              <option value="transcript">transcript</option>
              <option value="pricing_data">pricing data</option>
              <option value="analyst_note" selected>analyst note</option>
              <option value="competitor">competitor</option>
              <option value="news">news</option>
            </select>
            <input
              name="confidence"
              type="number"
              min={0}
              max={1}
              step={0.05}
              defaultValue={0.6}
              className="fin border border-line bg-ink px-2 py-1.5 text-[10px] text-parchment-dim"
              title="Confidence 0–1"
            />
            <button type="submit" className="btn btn-primary !px-2 !py-1.5 !text-[9px]">
              COMMIT
            </button>
          </div>
          <input
            name="source"
            required
            minLength={3}
            placeholder="Source — no source, no claim. e.g. 'Q1 FY26 transcript, p.4'"
            className="mt-3 w-full border border-line bg-ink px-3 py-2 text-[11px] text-parchment placeholder:text-parchment-faint/50 focus:border-platinum focus:outline-none"
          />
        </form>
      )}

      <div className="card divide-y divide-line">
        {filtered.map((cl) => (
          <div key={cl.id} className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-ink-raised/60">
            <div className="flex w-24 shrink-0 flex-col gap-1.5">
              <ClaimKind kind={cl.kind} />
              <span
                className={`fin text-[10px] ${
                  cl.supports === "bull" ? "text-bull" : cl.supports === "bear" ? "text-bear" : "text-parchment-faint"
                }`}
              >
                {cl.supports.toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] leading-relaxed text-parchment">{cl.text}</p>
              <p className="mt-1 text-[11px] text-parchment-faint">
                {cl.source} {cl.sourceType ? `· ${cl.sourceType}` : ""}
              </p>
            </div>
            <div className="fin shrink-0 text-right text-xs text-parchment-dim">
              <div className="label !text-[8px]">CONF</div>
              {(cl.confidence * 100).toFixed(0)}%
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-5 py-6 text-xs text-parchment-faint">
            {claims.length === 0
              ? "No evidence captured yet. Every claim must be linked to a source."
              : "No claims match the current filter."}
          </div>
        )}
      </div>
    </section>
  );
}
