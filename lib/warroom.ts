// The War Room — regime read, mandate compliance, and the council brief.
// Regime and book health are pure keyless math; the brief needs a model key.
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getBenchmark, getQuotes } from "@/lib/market";
import { regimeRead } from "@/lib/mathlab/regime";
import { computeBookQuant, MANDATE, type BookQuant } from "@/lib/quant";

function sma(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  const slice = closes.slice(-window);
  return slice.reduce((s, c) => s + c, 0) / window;
}

function realizedVol(closes: number[], window: number): number | null {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-(window + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) rets.push(slice[i] / slice[i - 1] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export type Regime = {
  benchmark: string;
  level: number;
  above50d: boolean | null;
  above200d: boolean | null;
  trend: "uptrend" | "downtrend" | "mixed" | "unknown";
  vol20d: number | null; // annualized decimal
  vol1y: number | null;
  volRegime: "calm" | "normal" | "stressed" | "unknown";
  pStressed: number | null; // HMM smoothed P(stressed) when ≥150 returns; null = heuristic regime
  breadth: { above50d: number; total: number } | null; // book tickers above their own 50d
  read: "risk_on" | "neutral" | "risk_off" | "unknown";
};

export async function computeRegime(): Promise<Regime> {
  const bench = await getBenchmark().catch(() => null);
  if (!bench || bench.history.length < 60) {
    return {
      benchmark: "—", level: 0, above50d: null, above200d: null, trend: "unknown",
      vol20d: null, vol1y: null, volRegime: "unknown", pStressed: null, breadth: null, read: "unknown",
    };
  }

  const closes = bench.history.filter((c) => Number.isFinite(c) && c > 0);
  const level = closes[closes.length - 1];
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const above50d = sma50 != null ? level > sma50 : null;
  const above200d = sma200 != null ? level > sma200 : null;
  const trend =
    above50d == null ? "unknown"
    : above50d && (above200d ?? true) ? "uptrend"
    : !above50d && above200d === false ? "downtrend"
    : "mixed";

  const vol20d = realizedVol(closes, 20);
  const vol1y = realizedVol(closes, Math.min(252, closes.length - 1));

  // Regime via the Math Lab's 2-state HMM when the series is long enough:
  // pStressed sets volRegime (and through it the read), replacing the
  // 20d-vs-1y realized-vol heuristic. SMA trend fields stay untouched, and
  // the heuristic remains the fallback when the HMM cannot fit.
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const hmm = rets.length >= 150 ? regimeRead(rets) : null;
  const pStressed = hmm?.pStressed ?? null;
  const volRegime: Regime["volRegime"] = hmm
    ? hmm.label === "calm" ? "calm"
    : hmm.label === "stressed" ? "stressed"
    : "normal"
    : vol20d == null || vol1y == null ? "unknown"
    : vol20d < vol1y * 0.8 ? "calm"
    : vol20d > vol1y * 1.3 ? "stressed"
    : "normal";

  // Breadth: how many book tickers trade above their own 50d
  const open = await db
    .select({ ticker: tables.positions.ticker })
    .from(tables.positions)
    .where(eq(tables.positions.status, "open"));
  let breadth: Regime["breadth"] = null;
  if (open.length > 0) {
    const quoteMap = await getQuotes([...new Set(open.map((p) => p.ticker))]).catch(
      () => new Map<string, never>(),
    );
    let above = 0;
    let total = 0;
    for (const q of quoteMap.values()) {
      const s50 = sma(q.history, 50);
      if (s50 == null) continue;
      total++;
      if (q.price > s50) above++;
    }
    if (total > 0) breadth = { above50d: above, total };
  }

  const read: Regime["read"] =
    trend === "unknown" ? "unknown"
    : trend === "uptrend" && volRegime !== "stressed" ? "risk_on"
    : trend === "downtrend" || volRegime === "stressed" ? "risk_off"
    : "neutral";

  return { benchmark: bench.ticker, level, above50d, above200d, trend, vol20d, vol1y, volRegime, pStressed, breadth, read };
}

export type MandateViolation = {
  rule: string;
  severity: "violation" | "warning";
  detail: string;
};

export function checkMandate(book: BookQuant): MandateViolation[] {
  const out: MandateViolation[] = [];

  for (const p of book.positions) {
    if (p.sizePct > MANDATE.maxPositionPct) {
      out.push({
        rule: "Max position size",
        severity: "violation",
        detail: `${p.ticker} at ${p.sizePct.toFixed(1)}% exceeds the ${MANDATE.maxPositionPct}% cap.`,
      });
    } else if (p.sizePct > MANDATE.maxPositionPct * 0.85) {
      out.push({
        rule: "Max position size",
        severity: "warning",
        detail: `${p.ticker} at ${p.sizePct.toFixed(1)}% is within 15% of the ${MANDATE.maxPositionPct}% cap.`,
      });
    }
  }

  for (const t of book.themeConcentration) {
    if (t.sizePct > MANDATE.maxThemePct) {
      out.push({
        rule: "Max theme concentration",
        severity: "violation",
        detail: `"${t.theme}" at ${t.sizePct.toFixed(1)}% exceeds the ${MANDATE.maxThemePct}% theme cap.`,
      });
    }
  }

  if (book.cashPct != null && book.cashPct < MANDATE.minCashPct) {
    out.push({
      rule: "Cash floor",
      severity: "violation",
      detail: `Cash at ${book.cashPct.toFixed(1)}% is below the ${MANDATE.minCashPct}% floor.`,
    });
  }

  if (book.weightedBeta != null && book.weightedBeta > MANDATE.maxBookBeta) {
    out.push({
      rule: "Max book beta",
      severity: "violation",
      detail: `Weighted beta ${book.weightedBeta.toFixed(2)} exceeds the ${MANDATE.maxBookBeta} ceiling.`,
    });
  }

  for (const c of book.correlationClusters) {
    out.push({
      rule: "Correlation cluster",
      severity: "warning",
      detail: `${c.a} and ${c.b} correlate at ${c.corr.toFixed(2)} — two tickers, one bet.`,
    });
  }

  return out;
}

export type CouncilBrief = {
  regimeStance: string;
  perPosition: {
    ticker: string;
    action: "hold" | "trim" | "add" | "exit";
    sizeDeltaPct: number | null;
    rationale: string;
  }[];
  cashStance: string;
  whatWouldChangeOurMind: string;
};

export async function latestBrief(): Promise<{ id: number; content: CouncilBrief; regime: string | null; createdAt: Date | null } | null> {
  const rows = await db
    .select()
    .from(tables.councilBriefs)
    .orderBy(desc(tables.councilBriefs.createdAt))
    .limit(1);
  if (!rows[0]) return null;
  try {
    return {
      id: rows[0].id,
      content: JSON.parse(rows[0].content) as CouncilBrief,
      regime: rows[0].regime,
      createdAt: rows[0].createdAt,
    };
  } catch {
    return null;
  }
}

export { computeBookQuant, MANDATE };
