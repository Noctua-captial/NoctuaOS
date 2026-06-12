import { NextRequest } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { modelFor } from "@/lib/models";

export const maxDuration = 120;

const draftSchema = z.object({
  outcome: z.enum(["win", "loss", "scratch"]),
  thesisRight: z.enum(["right", "wrong", "right_for_wrong_reason"]),
  timingRight: z.boolean(),
  sizingRight: z.boolean(),
  narrative: z.string().describe("3-6 sentences: entry logic, what happened, what we got right/wrong, why we exited"),
  lessons: z.array(z.string()).describe("2-4 transferable lessons, each one sentence"),
});

export async function POST(req: NextRequest) {
  const { positionId, companyId } = (await req.json()) as {
    positionId?: number | null;
    companyId?: number;
  };

  const position = positionId
    ? await db.query.positions.findFirst({ where: eq(tables.positions.id, positionId) })
    : null;
  const resolvedCompanyId = position?.companyId ?? companyId;
  if (!resolvedCompanyId) return Response.json({ error: "Position or company required." }, { status: 400 });

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, resolvedCompanyId) });
  if (!company) return Response.json({ error: "Company not found." }, { status: 404 });

  const [thesis, claimRows] = await Promise.all([
    db.query.theses.findFirst({
      where: eq(tables.theses.companyId, company.id),
      orderBy: desc(tables.theses.version),
    }),
    db
      .select()
      .from(tables.claims)
      .where(eq(tables.claims.companyId, company.id))
      .orderBy(desc(tables.claims.confidence))
      .limit(12),
  ]);

  const realized =
    position?.exitPrice != null
      ? (((position.exitPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(1) + "%"
      : "not closed / unknown";

  // No working key → degrade gracefully; the client falls back to the manual form.
  let model;
  try {
    ({ model } = modelFor("synthesis"));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "No model available." },
      { status: 503 },
    );
  }

  try {
    const { object } = await generateObject({
      model,
      schema: draftSchema,
      prompt: `You are Noctua Capital's Postmortem Agent. Draft a brutally honest After-Action review of this position. Judge the thesis on process, not just outcome — a win on a wrong thesis is "right_for_wrong_reason". Lessons must be transferable rules, not restatements of what happened.

COMPANY: ${company.ticker} — ${company.name} (${company.sector ?? "sector unknown"}; theme: ${company.theme ?? "—"})
THESIS STATUS AT REVIEW: ${company.thesisStatus ?? "unknown"}

POSITION:
${
  position
    ? `Entered ${position.entryDate} at $${position.entryPrice.toFixed(2)}, ${position.sizePct.toFixed(1)}% of NAV, owner ${position.owner ?? "—"}.
Exited ${position.exitDate ?? "—"} at ${position.exitPrice != null ? `$${position.exitPrice.toFixed(2)}` : "—"}. Realized P&L vs entry: ${realized}.
Kill criteria snapshot at entry: ${position.killCriteria ?? "none recorded"}`
    : "No position record — review the research call itself."
}

THESIS (v${thesis?.version ?? "—"}): ${thesis?.oneLiner ?? "No thesis on record."}
Variant perception: ${thesis?.variantPerception ?? "—"}
What must happen: ${thesis?.whatMustHappen ?? "—"}
Kill criteria (current): ${thesis?.killCriteria ?? "—"}

TOP EVIDENCE CLAIMS:
${claimRows.map((c) => `- [${c.kind}/${c.supports}, conf ${c.confidence.toFixed(2)}] ${c.text}`).join("\n") || "- none on record"}`,
    });
    return Response.json({ draft: object });
  } catch {
    return Response.json(
      { error: "Draft failed — the configured model did not respond. File the postmortem manually." },
      { status: 502 },
    );
  }
}
