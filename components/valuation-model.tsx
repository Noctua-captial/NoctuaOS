"use client";

import { useMemo, useState } from "react";

type Inputs = {
  baseRevenue: number; // $M
  growth: number; // % CAGR
  margin: number; // operating margin %
  multiple: number; // EV/EBIT exit multiple
  netCash: number; // $M
  shares: number; // M
  dilution: number; // % per year
  years: number;
  spot: number; // current price $
};

const DEFAULTS: Inputs = {
  baseRevenue: 1500,
  growth: 12,
  margin: 18,
  multiple: 14,
  netCash: 500,
  shares: 110,
  dilution: 1.5,
  years: 3,
  spot: 50,
};

function fmt(n: number, digits = 1): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}B`;
  return `$${n.toFixed(digits)}M`;
}

const SLIDERS: {
  key: keyof Inputs;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}[] = [
  { key: "baseRevenue", label: "Base revenue", min: 50, max: 20000, step: 50, unit: "$M" },
  { key: "growth", label: "Revenue CAGR", min: -20, max: 60, step: 1, unit: "%" },
  { key: "margin", label: "Operating margin (exit)", min: 0, max: 60, step: 1, unit: "%" },
  { key: "multiple", label: "Exit EV/EBIT multiple", min: 4, max: 40, step: 0.5, unit: "x" },
  { key: "netCash", label: "Net cash (debt)", min: -5000, max: 5000, step: 50, unit: "$M" },
  { key: "shares", label: "Shares outstanding", min: 10, max: 2000, step: 5, unit: "M" },
  { key: "dilution", label: "Annual dilution", min: 0, max: 10, step: 0.25, unit: "%" },
  { key: "years", label: "Horizon", min: 1, max: 7, step: 1, unit: "y" },
  { key: "spot", label: "Current price", min: 1, max: 1000, step: 0.5, unit: "$" },
];

export type ValuationSeed = {
  baseRevenue?: number; // $M
  margin?: number; // %
  netCash?: number; // $M
  shares?: number; // M
  spot?: number; // $
};

export function ValuationModel({
  ticker,
  baseRevenue,
  margin,
  netCash,
  shares,
  spot,
}: { ticker: string } & ValuationSeed) {
  // Server-computed real fundamentals/quote override the generic defaults.
  const initial = useMemo<Inputs>(
    () => ({
      ...DEFAULTS,
      ...(baseRevenue != null ? { baseRevenue } : {}),
      ...(margin != null ? { margin } : {}),
      ...(netCash != null ? { netCash } : {}),
      ...(shares != null ? { shares } : {}),
      ...(spot != null ? { spot } : {}),
    }),
    [baseRevenue, margin, netCash, shares, spot],
  );
  const [inp, setInp] = useState<Inputs>(initial);

  const out = useMemo(() => {
    const exitRevenue = inp.baseRevenue * Math.pow(1 + inp.growth / 100, inp.years);
    const ebit = exitRevenue * (inp.margin / 100);
    const ev = ebit * inp.multiple;
    const equity = ev + inp.netCash;
    const exitShares = inp.shares * Math.pow(1 + inp.dilution / 100, inp.years);
    const perShare = equity / exitShares;
    const upside = inp.spot > 0 ? (perShare / inp.spot - 1) * 100 : 0;
    const irr = inp.spot > 0 ? (Math.pow(perShare / inp.spot, 1 / inp.years) - 1) * 100 : 0;
    return { exitRevenue, ebit, ev, equity, perShare, upside, irr };
  }, [inp]);

  const upsideColor = out.upside > 30 ? "text-bull" : out.upside < 0 ? "text-bear" : "text-warn";

  return (
    <section className="card">
      <div className="flex items-baseline justify-between border-b border-line px-6 py-4">
        <div>
          <h2 className="serif text-2xl text-parchment">Model — {ticker}</h2>
          <span className="label !text-[9px]">Interactive valuation · all inputs are model assumptions</span>
        </div>
        <button
          onClick={() => setInp(initial)}
          className="label border border-line px-2.5 py-1 !text-[9px] hover:bg-ink-raised"
        >
          Reset
        </button>
      </div>

      <div className="grid grid-cols-12 gap-0">
        {/* sliders */}
        <div className="col-span-5 space-y-4 border-r border-line px-6 py-5">
          {SLIDERS.map((s) => (
            <div key={s.key}>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-parchment-dim">{s.label}</span>
                <span className="fin text-[11px] text-parchment">
                  {inp[s.key]}
                  <span className="text-parchment-faint">{s.unit}</span>
                </span>
              </div>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={inp[s.key]}
                onChange={(e) => setInp((p) => ({ ...p, [s.key]: Number(e.target.value) }))}
                className="mt-1.5 h-px w-full cursor-pointer appearance-none bg-line accent-[var(--parchment)] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-1.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-parchment"
              />
            </div>
          ))}
        </div>

        {/* outputs */}
        <div className="col-span-7 flex flex-col px-8 py-6">
          <div className="label">Implied equity value at exit</div>
          <div className="fin mt-2 text-5xl leading-none text-parchment">{fmt(out.equity)}</div>

          <div className="mt-6 grid grid-cols-3 gap-x-6 gap-y-5">
            <div>
              <div className="label !text-[8px]">Per share</div>
              <div className="fin mt-1 text-xl text-parchment">${out.perShare.toFixed(2)}</div>
            </div>
            <div>
              <div className="label !text-[8px]">Upside vs spot</div>
              <div className={`fin mt-1 text-xl ${upsideColor}`}>
                {out.upside >= 0 ? "+" : ""}
                {out.upside.toFixed(0)}%
              </div>
            </div>
            <div>
              <div className="label !text-[8px]">Implied IRR</div>
              <div className={`fin mt-1 text-xl ${upsideColor}`}>
                {out.irr >= 0 ? "+" : ""}
                {out.irr.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="label !text-[8px]">Exit revenue</div>
              <div className="fin mt-1 text-sm text-parchment-dim">{fmt(out.exitRevenue)}</div>
            </div>
            <div>
              <div className="label !text-[8px]">Exit EBIT</div>
              <div className="fin mt-1 text-sm text-parchment-dim">{fmt(out.ebit)}</div>
            </div>
            <div>
              <div className="label !text-[8px]">Enterprise value</div>
              <div className="fin mt-1 text-sm text-parchment-dim">{fmt(out.ev)}</div>
            </div>
          </div>

          {/* upside bar */}
          <div className="mt-auto pt-6">
            <div className="flex justify-between">
              <span className="label !text-[8px]">-50%</span>
              <span className="label !text-[8px]">0</span>
              <span className="label !text-[8px]">+150%</span>
            </div>
            <div className="relative mt-1 h-1.5 w-full bg-line">
              <div className="absolute left-1/4 top-0 h-full w-px bg-platinum/50" />
              <div
                className="absolute top-0 h-full"
                style={{
                  left: out.upside >= 0 ? "25%" : `${Math.max(0, 25 + (out.upside / 50) * 25)}%`,
                  width: `${Math.min(75, Math.abs(out.upside) / (out.upside >= 0 ? 150 : 50) * (out.upside >= 0 ? 75 : 25))}%`,
                  background: out.upside >= 0 ? "var(--bull)" : "var(--bear)",
                  opacity: 0.85,
                }}
              />
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-parchment-faint">
              Every input above is a <span className="text-warn">model assumption</span>, not evidence.
              The spread that matters is which assumptions the thesis actually depends on — see the
              Valuation Agent&apos;s key assumptions in the memo.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
