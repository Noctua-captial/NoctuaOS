// Shared presentational chips + formatters for the Augury pages. Server
// components (no interactivity) so the timeline / deep-dive pages stay lean and
// the call taxonomy renders consistently. Colors follow the house palette:
// bull (green) / bear (red) / warn (gold) / platinum / parchment-faint.

function chip(cls: string, label: string) {
  return (
    <span className={`fin inline-block border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${cls}`}>
      {label}
    </span>
  );
}

const STANCE_CLS: Record<string, string> = {
  bullish: "border-bull/50 text-bull",
  bearish: "border-bear/50 text-bear",
  neutral: "border-line text-parchment-faint",
  hedge: "border-warn/50 text-warn",
};

export function StanceChip({ stance }: { stance: string | null }) {
  if (!stance) return null;
  return chip(STANCE_CLS[stance] ?? "border-line text-parchment-faint", stance);
}

export function LifecycleChip({ stage }: { stage: string | null }) {
  if (!stage) return null;
  // Commentary is non-actionable → muted; everything else is a position action.
  const cls = stage === "commentary" ? "border-line text-parchment-faint" : "border-platinum/40 text-platinum";
  return chip(cls, stage);
}

export function HorizonChip({ horizon }: { horizon: string | null }) {
  if (!horizon || horizon === "unspecified") return null;
  return chip("border-line text-parchment-dim", horizon.replace(/_/g, " "));
}

export function ConvictionChip({ conviction }: { conviction: number | null }) {
  if (conviction == null) return null;
  const pct = Math.round(conviction * 100);
  const cls =
    conviction >= 0.75
      ? "border-parchment/50 text-parchment"
      : conviction >= 0.4
        ? "border-line text-parchment-dim"
        : "border-line text-parchment-faint";
  return chip(cls, `conv ${pct}%`);
}

const OUTCOME_CLS: Record<string, string> = {
  right: "border-bull/50 text-bull",
  wrong: "border-bear/50 text-bear",
  partial: "border-warn/50 text-warn",
  too_early: "border-line text-parchment-faint",
  inconclusive: "border-line text-parchment-faint",
};

export function OutcomeChip({ outcome }: { outcome: string | null }) {
  if (!outcome) return null;
  return chip(OUTCOME_CLS[outcome] ?? "border-line text-parchment-faint", outcome.replace(/_/g, " "));
}

const REGIME_CLS: Record<string, string> = {
  risk_on: "text-bull",
  risk_off: "text-bear",
  neutral: "text-parchment-dim",
  transition: "text-warn",
};

export function RegimeChip({ regime }: { regime: string | null }) {
  if (!regime) return null;
  return (
    <span className={`fin text-[10px] tracking-[0.12em] ${REGIME_CLS[regime] ?? "text-parchment-faint"}`}>
      {regime.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

/** Signed percent, e.g. +4.2% / −1.1% / — when null. */
export function fmtSignedPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}

/** Plain percent (no forced sign), — when null. */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function alphaClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "text-parchment-faint";
  return v > 0 ? "text-bull" : v < 0 ? "text-bear" : "text-parchment-faint";
}
