import { NextRequest } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  computeNameQuant,
  computeBookQuant,
  sizingMath,
  getPortfolio,
  MANDATE,
  type SizingOutput,
} from "@/lib/quant";
import { modelFor } from "@/lib/models";
import { CONSTITUTION } from "@/lib/athena";

export const maxDuration = 120;

/** First $-figure in a valuation case string like "$38 — SiPho stalls, 12x trough EPS". */
function parsePrice(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/\$\s*(\d+(?:[,.]\d+)?)/);
  if (!m) return null;
  const v = Number(m[1].replace(",", ""));
  return Number.isFinite(v) && v > 0 ? v : null;
}

const councilSchema = z.object({
  riskView: z.string().describe("Risk agent: the dominant risk to sizing this position, 1-2 sentences"),
  pmView: z.string().describe("PM agent: portfolio-fit view — theme concentration, correlation, conviction, 1-2 sentences"),
  recommendedPct: z.number().min(0).max(15).describe("The council's recommended size, % of NAV — anchored on the math, adjusted only with explicit reasoning"),
  closestRuleToViolation: z.string().describe("The mandate rule this position is closest to violating and how close"),
});

export async function POST(req: NextRequest) {
  const { ticker: raw, memoId } = (await req.json()) as { ticker?: string; memoId?: number };
  const ticker = raw?.trim().toUpperCase();
  if (!ticker) return Response.json({ error: "Ticker required." }, { status: 400 });

  try {
    const [quant, book, portfolio, memo, company] = await Promise.all([
      computeNameQuant(ticker).catch(() => null),
      computeBookQuant().catch(() => null),
      getPortfolio(),
      memoId
        ? db.query.memos.findFirst({ where: eq(tables.memos.id, memoId) })
        : Promise.resolve(undefined),
      db.query.companies.findFirst({ where: eq(tables.companies.ticker, ticker) }),
    ]);

    if (!quant?.spot) {
      return Response.json({ error: `No market data for ${ticker} — sizing math needs a live quote.` }, { status: 422 });
    }

    // Scenario prices from the memo's valuation cases, when parseable
    let bearPrice: number | null = null;
    let basePrice: number | null = null;
    let bullPrice: number | null = null;
    if (memo) {
      try {
        const content = JSON.parse(memo.content) as { valuation?: { bear?: string; base?: string; bull?: string } };
        bearPrice = parsePrice(content.valuation?.bear);
        basePrice = parsePrice(content.valuation?.base);
        bullPrice = parsePrice(content.valuation?.bull);
      } catch {}
    }
    const kellyAvailable = bearPrice != null && basePrice != null && bullPrice != null;

    const sizing: SizingOutput = sizingMath({
      bearPrice: bearPrice ?? quant.spot, // spot scenarios → zero edge → Kelly 0, hard caps still bind
      basePrice: basePrice ?? quant.spot,
      bullPrice: bullPrice ?? quant.spot,
      spot: quant.spot,
      annualizedVol: quant.annualizedVol,
      advDollars: quant.avgDollarVolume,
      navUsd: portfolio.nav,
    });

    // Without scenario prices Kelly is meaningless — recommend from the hard caps instead.
    if (!kellyAvailable) {
      const caps: [SizingOutput["bindingConstraint"], number | null][] = [
        ["vol_target", sizing.volTargetPct],
        ["liquidity", sizing.liquidityCapPct],
        ["mandate", sizing.mandateCapPct],
      ];
      let constraint: SizingOutput["bindingConstraint"] = "mandate";
      let rec = sizing.mandateCapPct;
      for (const [name, value] of caps) {
        if (value != null && value < rec) {
          constraint = name;
          rec = value;
        }
      }
      sizing.recommendedPct = Math.max(rec, 0);
      sizing.bindingConstraint = constraint;
    }

    // Theme headroom under the mandate
    const theme = company?.theme ?? null;
    const themeUsedPct = theme
      ? (book?.themeConcentration.find((t) => t.theme === theme)?.sizePct ?? 0)
      : 0;
    const themeHeadroomPct = theme ? Math.max(MANDATE.maxThemePct - themeUsedPct, 0) : null;

    const keylessResult = {
      ticker,
      spot: quant.spot,
      kellyAvailable,
      scenarioPrices: kellyAvailable ? { bear: bearPrice, base: basePrice, bull: bullPrice } : null,
      sizing,
      mandate: MANDATE,
      theme,
      themeUsedPct,
      themeHeadroomPct,
      navUsd: portfolio.nav,
      annualizedVol: quant.annualizedVol,
      avgDollarVolume: quant.avgDollarVolume,
      correlationClusters: book?.correlationClusters ?? [],
    };

    // Council layer — one structured round, Risk + PM merged in a single call. Optional.
    try {
      const m = modelFor("synthesis");
      const { object: council } = await generateObject({
        model: m.model,
        schema: councilSchema,
        system: `${CONSTITUTION}\n\nYou are the Sizing Council: a Risk agent and a PM agent deliberating one round over a position size. The deterministic math below is ground truth — depart from its recommendation only with explicit reasoning, never upward past a hard cap.`,
        prompt: `Position under sizing: ${ticker}${theme ? ` (theme: ${theme})` : ""}

SIZING MATH (ground truth):
${JSON.stringify({ ...sizing, kellyAvailable, bindingConstraint: sizing.bindingConstraint }, null, 2)}

BOOK STATE:
${JSON.stringify(
  {
    grossExposurePct: book?.grossExposurePct,
    weightedBeta: book?.weightedBeta,
    themeConcentration: book?.themeConcentration,
    correlationClusters: book?.correlationClusters,
    cashPct: book?.cashPct,
    mandate: MANDATE,
    themeHeadroomPct,
  },
  null,
  2,
)}

Deliberate and output the council recommendation.`,
      });
      return Response.json({ ...keylessResult, council, councilModel: m.modelId });
    } catch {
      return Response.json({ ...keylessResult, council: null });
    }
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Sizing failed." },
      { status: 500 },
    );
  }
}
