import Link from "next/link";

export function PageHeader({
  kicker,
  title,
  right,
}: {
  kicker: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between border-b border-line px-10 py-8">
      <div>
        <div className="label mb-2">{kicker}</div>
        <h1 className="serif text-4xl font-medium text-parchment">{title}</h1>
      </div>
      {right}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "ACTIVE", cls: "border-bull/60 text-bull" },
    watchlist: { label: "WATCHLIST", cls: "border-warn/60 text-warn" },
    pipeline: { label: "PIPELINE", cls: "border-platinum/40 text-platinum" },
    rejected: { label: "REJECTED", cls: "border-bear/60 text-bear" },
    exited: { label: "EXITED", cls: "border-parchment-faint/60 text-parchment-faint" },
  };
  const s = map[status] ?? map.pipeline;
  return (
    <span className={`fin inline-block border px-2 py-0.5 text-[10px] tracking-[0.15em] ${s.cls}`}>
      {s.label}
    </span>
  );
}

export function ThesisStatus({ status }: { status: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    strengthening: { label: "▲ STRENGTHENING", cls: "text-bull" },
    stable: { label: "— STABLE", cls: "text-parchment-dim" },
    weakening: { label: "▼ WEAKENING", cls: "text-warn" },
    broken: { label: "✕ BROKEN", cls: "text-bear" },
  };
  const s = map[status ?? "stable"] ?? map.stable;
  return <span className={`fin text-[11px] tracking-wider ${s.cls}`}>{s.label}</span>;
}

export function ScoreRing({ score, size = 56 }: { score: number | null; size?: number }) {
  if (score == null) {
    return (
      <div
        className="flex items-center justify-center border border-line text-parchment-faint"
        style={{ width: size, height: size }}
      >
        <span className="fin text-xs">—</span>
      </div>
    );
  }
  const cls =
    score >= 90
      ? "border-bull text-bull"
      : score >= 75
        ? "border-parchment text-parchment"
        : score >= 60
          ? "border-warn text-warn"
          : score >= 40
            ? "border-parchment-faint text-parchment-dim"
            : "border-bear text-bear";
  return (
    <div
      className={`flex flex-col items-center justify-center border ${cls}`}
      style={{ width: size, height: size }}
    >
      <span className="fin text-lg leading-none">{score}</span>
      <span className="label mt-0.5 !text-[7px]">NOCTUA</span>
    </div>
  );
}

export function scoreBand(score: number): string {
  if (score >= 90) return "Predatory opportunity";
  if (score >= 75) return "High conviction";
  if (score >= 60) return "Watchlist / needs more evidence";
  if (score >= 40) return "Interesting but not investable";
  return "Reject";
}

export function ClaimKind({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    fact: "border-bull/50 text-bull",
    inference: "border-platinum/50 text-platinum",
    opinion: "border-warn/50 text-warn",
    model_assumption: "border-warn/50 text-warn",
    unverified: "border-bear/50 text-bear",
  };
  return (
    <span
      className={`fin inline-block border px-1.5 py-px text-[9px] uppercase tracking-[0.12em] ${map[kind] ?? map.unverified}`}
    >
      {kind.replace("_", " ")}
    </span>
  );
}

export function TickerLink({ ticker }: { ticker: string }) {
  return (
    <Link
      href={`/dossiers/${ticker}`}
      className="fin text-parchment underline-offset-4 hover:underline"
    >
      {ticker}
    </Link>
  );
}
