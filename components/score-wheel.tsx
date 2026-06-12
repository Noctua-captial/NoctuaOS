"use client";

import { useState } from "react";

const COMPONENTS: { key: string; label: string; max: number }[] = [
  { key: "thesisClarity", label: "Thesis clarity", max: 10 },
  { key: "evidenceQuality", label: "Evidence quality", max: 15 },
  { key: "variantPerception", label: "Variant perception", max: 15 },
  { key: "asymmetry", label: "Asymmetry", max: 15 },
  { key: "valuationGap", label: "Valuation gap", max: 10 },
  { key: "catalystStrength", label: "Catalyst strength", max: 10 },
  { key: "managementQuality", label: "Management", max: 5 },
  { key: "balanceSheet", label: "Balance sheet", max: 5 },
  { key: "technicalEdge", label: "Technical edge", max: 10 },
  { key: "liquidityRiskFit", label: "Liquidity / risk fit", max: 5 },
];

function segColor(ratio: number): string {
  if (ratio >= 0.75) return "var(--bull)";
  if (ratio >= 0.5) return "var(--parchment-dim)";
  if (ratio >= 0.3) return "var(--warn)";
  return "var(--bear)";
}

function band(score: number): string {
  if (score >= 90) return "PREDATORY OPPORTUNITY";
  if (score >= 75) return "HIGH CONVICTION";
  if (score >= 60) return "WATCHLIST";
  if (score >= 40) return "NOT INVESTABLE";
  return "REJECT";
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function wedge(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r0, a1);
  const [x3, y3] = polar(cx, cy, r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${x0} ${y0}`,
    `A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3}`,
    "Z",
  ].join(" ");
}

export function ScoreWheel({
  total,
  components,
  size = 280,
}: {
  total: number;
  components: Record<string, number>;
  size?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const c = size / 2;
  const innerR = size * 0.165;
  const maxR = size * 0.46;
  const gap = 3.5;
  const span = 360 / COMPONENTS.length;

  const active = hover != null ? COMPONENTS[hover] : null;
  const activeVal = active ? (components[active.key] ?? 0) : 0;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="block">
        {/* guide rings */}
        {[0.33, 0.66, 1].map((f) => (
          <circle
            key={f}
            cx={c}
            cy={c}
            r={innerR + (maxR - innerR) * f}
            fill="none"
            stroke="var(--platinum-line)"
            strokeWidth={0.75}
          />
        ))}

        {COMPONENTS.map((comp, i) => {
          const val = components[comp.key] ?? 0;
          const ratio = Math.max(0, Math.min(1, val / comp.max));
          const a0 = i * span + gap / 2;
          const a1 = (i + 1) * span - gap / 2;
          const r1 = innerR + (maxR - innerR) * Math.max(ratio, 0.06);
          const color = segColor(ratio);
          const dim = hover != null && hover !== i;
          return (
            <g key={comp.key}>
              {/* full-track ghost */}
              <path
                d={wedge(c, c, innerR, maxR, a0, a1)}
                fill="rgba(174,180,188,0.05)"
              />
              <path
                d={wedge(c, c, innerR, r1, a0, a1)}
                fill={color}
                opacity={dim ? 0.25 : hover === i ? 1 : 0.82}
                style={{ transition: "opacity 0.15s" }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}

        {/* center */}
        <circle cx={c} cy={c} r={innerR - 4} fill="var(--ink-card)" stroke="var(--platinum-line-strong)" strokeWidth={1} />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        {active ? (
          <>
            <span className="fin text-2xl leading-none text-parchment">
              {activeVal}
              <span className="text-parchment-faint">/{active.max}</span>
            </span>
            <span className="label mt-1 max-w-[64px] !text-[7px] leading-tight">{active.label}</span>
          </>
        ) : (
          <>
            <span className="fin text-4xl leading-none text-parchment">{total}</span>
            <span className="label mt-1.5 max-w-[60px] !text-[7px] leading-tight">{band(total)}</span>
          </>
        )}
      </div>
    </div>
  );
}

export function ScoreWheelLegend({ components }: { components: Record<string, number> }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
      {COMPONENTS.map((comp) => {
        const val = components[comp.key] ?? 0;
        const ratio = val / comp.max;
        return (
          <div key={comp.key} className="flex items-baseline justify-between gap-2">
            <span className="flex items-baseline gap-1.5 text-[10.5px] text-parchment-dim">
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 self-center"
                style={{ background: segColor(ratio) }}
              />
              {comp.label}
            </span>
            <span className="fin text-[10.5px] text-parchment">
              {val}
              <span className="text-parchment-faint">/{comp.max}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
