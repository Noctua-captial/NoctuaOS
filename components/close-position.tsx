"use client";

import { useState, useTransition } from "react";
import { closePosition } from "@/app/actions";

export function ClosePosition({
  positionId,
  ticker,
  quotePrice,
}: {
  positionId: number;
  ticker: string;
  quotePrice: number | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [exitPrice, setExitPrice] = useState(quotePrice != null ? quotePrice.toFixed(2) : "");
  const [pending, start] = useTransition();

  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} className="btn btn-danger !px-2.5 !py-1 !text-[9px]">
        CLOSE
      </button>
    );
  }

  const price = Number(exitPrice);
  const valid = Number.isFinite(price) && price > 0;

  return (
    <span className="flex items-center justify-end gap-1.5">
      <input
        value={exitPrice}
        onChange={(e) => setExitPrice(e.target.value)}
        placeholder="Exit $"
        autoFocus
        className="fin w-20 border border-line bg-ink px-2 py-1 text-[11px] text-parchment placeholder:text-parchment-faint/60 focus:border-platinum focus:outline-none"
      />
      <button
        disabled={pending || !valid}
        onClick={() => start(async () => closePosition(positionId, price))}
        className="btn btn-danger !px-2.5 !py-1 !text-[9px]"
        title={`Close ${ticker} at $${exitPrice || "—"}`}
      >
        {pending ? "…" : "CONFIRM"}
      </button>
      <button disabled={pending} onClick={() => setConfirming(false)} className="btn !px-2 !py-1 !text-[9px]">
        ✕
      </button>
    </span>
  );
}
