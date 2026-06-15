import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { computeRegime, checkMandate, type CouncilBrief } from "@/lib/warroom";
import { computeBookQuant, computeNameQuant, MANDATE } from "@/lib/quant";
import { getQuotes } from "@/lib/market";
import { modelFor } from "@/lib/models";
import { generateObjectRetry } from "@/lib/ai";
import { CONSTITUTION } from "@/lib/athena";

export const maxDuration = 300;

const briefSchema = z.object({
  regimeStance: z.string().describe("The council's read on conditions and what they imply for the book, 2-3 sentences"),
  perPosition: z.array(
    z.object({
      ticker: z.string(),
      action: z.enum(["hold", "trim", "add", "exit"]),
      sizeDeltaPct: z.number().nullable().describe("Proposed change in % of NAV (negative = trim); null for hold"),
      rationale: z.string().describe("1-2 sentences. Thesis status + quant reality, not vibes."),
    }),
  ),
  cashStance: z.string().describe("Deploy, hold, or raise cash — and why, 1-2 sentences"),
  whatWouldChangeOurMind: z.string().describe("The specific market or thesis evidence that would flip this brief"),
});

export async function POST() {
  try {
    const [regime, book] = await Promise.all([computeRegime(), computeBookQuant()]);
    const violations = checkMandate(book);

    const open = await db
      .select({ position: tables.positions, company: tables.companies })
      .from(tables.positions)
      .innerJoin(tables.companies, eq(tables.positions.companyId, tables.companies.id))
      .where(eq(tables.positions.status, "open"));

    if (open.length === 0) {
      return Response.json({ error: "No open positions — nothing to navigate. Open a position in Talons first." }, { status: 422 });
    }

    const quoteMap = await getQuotes(open.map((o) => o.position.ticker)).catch(() => new Map());
    const positionState = await Promise.all(
      open.map(async ({ position, company }) => {
        const q = quoteMap.get(position.ticker.toUpperCase());
        const quant = await computeNameQuant(position.ticker).catch(() => null);
        return {
          ticker: position.ticker,
          theme: company.theme,
          thesisStatus: company.thesisStatus,
          sizePct: position.sizePct,
          entryPrice: position.entryPrice,
          livePrice: q?.price ?? null,
          pnlPct: q?.price != null ? ((q.price - position.entryPrice) / position.entryPrice) * 100 : null,
          quant: quant
            ? { annualizedVol: quant.annualizedVol, beta: quant.beta, rsi14: quant.rsi14, momentum3m: quant.momentum3m, pctFrom52wHigh: quant.pctFrom52wHigh }
            : null,
        };
      }),
    );

    // Three short seat views merged by the moderator in a single structured call
    // (PM + Risk + Strix perspectives are demanded inside the prompt to keep cost at one call).
    const m = modelFor("synthesis");
    const { object: brief } = await generateObjectRetry({
      model: m.model,
      modelId: m.modelId,
      schema: briefSchema,
      system: `${CONSTITUTION}\n\nYou are the War Room council: a PM (owns the book), a Risk officer (owns the mandate), and Strix (owns the downside) deliberating the daily navigation brief. The PM proposes, Risk constrains, Strix attacks. Output the merged brief. Hard rules: never propose breaching the mandate; a "broken" thesis cannot be "add"; respect the regime read.`,
      prompt: `REGIME (keyless math, ground truth):
${JSON.stringify(regime, null, 2)}

BOOK:
${JSON.stringify({ nav: book.navUsd, grossExposurePct: book.grossExposurePct, cashPct: book.cashPct, weightedBeta: book.weightedBeta, themeConcentration: book.themeConcentration, correlationClusters: book.correlationClusters }, null, 2)}

MANDATE: ${JSON.stringify(MANDATE)}
ACTIVE VIOLATIONS/WARNINGS: ${JSON.stringify(violations, null, 2)}

POSITIONS:
${JSON.stringify(positionState, null, 2)}

Produce today's navigation brief: a stance per position (hold/trim/add/exit with size delta), the cash stance, and what would change the council's mind.`,
    });

    const [row] = db
      .insert(tables.councilBriefs)
      .values({ regime: regime.read, content: JSON.stringify(brief satisfies CouncilBrief) })
      .returning()
      .all();

    db.insert(tables.traces)
      .values({
        researcher: "WarRoomCouncil",
        ticker: null,
        currentQuestion: "How should the book be navigated today?",
        actionTaken: `Council brief #${row.id} produced (regime: ${regime.read})`,
        sourceType: "council_brief",
        informationSeen: `Gross ${book.grossExposurePct.toFixed(1)}%, ${violations.length} mandate flags, regime ${regime.read}`,
        interpretation: brief.regimeStance.slice(0, 200),
        signalCategory: regime.read === "risk_off" ? "thesis_contradiction" : "thesis_support",
        confidenceChange: 0,
        nextAction: brief.cashStance.slice(0, 160),
        reasoningPattern: "The book is navigated daily: regime read, mandate check, per-position stance, cash decision.",
      })
      .run();

    return Response.json({ briefId: row.id, regime, brief, model: m.modelId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Council unavailable.";
    // Never leak provider auth detail; map key problems to the institutional offline message.
    const keyProblem = /api key|unauthorized|authentication|401/i.test(raw);
    const msg = keyProblem
      ? "The council is offline: no working model provider key is configured. Add XAI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to .env.local — the regime and mandate dashboards work without one."
      : raw;
    return Response.json({ error: msg }, { status: keyProblem ? 503 : 500 });
  }
}
