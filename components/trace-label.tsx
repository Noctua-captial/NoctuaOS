"use client";

import { useTransition } from "react";
import { labelTrace } from "@/app/actions";

const LABELS = ["strong_signal", "weak_signal", "false_positive", "noise"] as const;

const activeCls: Record<string, string> = {
  strong_signal: "border-bull/60 text-bull",
  weak_signal: "border-platinum/50 text-platinum",
  false_positive: "border-bear/60 text-bear",
  noise: "border-line-strong text-parchment-dim",
};

export function TraceLabelButtons({ traceId, current }: { traceId: number; current: string | null }) {
  const [pending, start] = useTransition();

  return (
    <div className={`flex items-center gap-1.5 ${pending ? "opacity-50" : ""}`}>
      <span className="label mr-1 !text-[8px]">Label</span>
      {LABELS.map((l) => {
        const active = current === l;
        return (
          <button
            key={l}
            disabled={pending}
            // Re-clicking the active label clears it.
            onClick={() => start(async () => labelTrace(traceId, active ? null : l))}
            className={`fin cursor-pointer border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] transition-colors disabled:cursor-not-allowed ${
              active
                ? activeCls[l]
                : "border-line text-parchment-faint/60 hover:border-line-strong hover:text-parchment-dim"
            }`}
          >
            {l.replace(/_/g, " ")}
          </button>
        );
      })}
    </div>
  );
}
