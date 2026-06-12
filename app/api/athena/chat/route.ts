// Athena chat — dossier copilot. streamText with Vault/market/ledger tools,
// system prompt = Constitution + a compact dossier snapshot fetched server-side.
import { NextRequest } from "next/server";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { modelFor } from "@/lib/models";
import { CONSTITUTION } from "@/lib/athena";
import { searchVault } from "@/lib/vault";
import { getQuote } from "@/lib/market";
import { getFundamentals } from "@/lib/fundamentals";

export const maxDuration = 120;

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function dossierSnapshot(ticker: string): Promise<string> {
  const company = await db.query.companies.findFirst({
    where: eq(tables.companies.ticker, ticker),
  });
  if (!company) return `DOSSIER SNAPSHOT — ${ticker}\nNo dossier on file for this ticker.`;

  const [thesis] = await db
    .select()
    .from(tables.theses)
    .where(eq(tables.theses.companyId, company.id))
    .orderBy(desc(tables.theses.version))
    .limit(1);

  const lines = [
    `DOSSIER SNAPSHOT — ${ticker}`,
    `${company.name} (${company.sector ?? "sector n/a"}) — status ${company.status}, thesis ${company.thesisStatus ?? "stable"}, conviction ${company.convictionScore ?? "—"}, analyst ${company.ownerAnalyst ?? "unassigned"}.`,
    company.businessSummary ? `Business: ${company.businessSummary}` : null,
    company.rejectionReason ? `Rejection on record: ${company.rejectionReason}` : null,
  ];
  if (thesis) {
    lines.push(`Thesis v${thesis.version}: ${thesis.oneLiner}`);
    if (thesis.variantPerception) lines.push(`Variant perception: ${thesis.variantPerception}`);
    if (thesis.whyNow) lines.push(`Why now: ${thesis.whyNow}`);
    const must = parseList(thesis.whatMustHappen);
    if (must.length) lines.push(`What must happen: ${must.map((m, i) => `(${i + 1}) ${m}`).join(" ")}`);
    const kill = parseList(thesis.killCriteria);
    if (kill.length) lines.push(`Kill criteria: ${kill.map((k, i) => `(${i + 1}) ${k}`).join(" ")}`);
  } else {
    lines.push("No formal thesis on file yet.");
  }
  return lines.filter(Boolean).join("\n");
}

export async function POST(req: NextRequest) {
  const { ticker: raw, messages } = (await req.json()) as {
    ticker?: string;
    messages?: UIMessage[];
  };
  const ticker = raw?.trim().toUpperCase();
  if (!ticker) return Response.json({ error: "Ticker required." }, { status: 400 });
  if (!messages?.length) return Response.json({ error: "Messages required." }, { status: 400 });

  let model;
  try {
    model = modelFor("chat").model;
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "No model available." },
      { status: 503 },
    );
  }

  const company = await db.query.companies.findFirst({
    where: eq(tables.companies.ticker, ticker),
  });
  const snapshot = await dossierSnapshot(ticker);

  const result = streamText({
    model,
    system: `${CONSTITUTION}

You are Athena, Noctua's research copilot, answering an analyst inside the ${ticker} dossier. Use the tools to ground answers in the Vault, live market data, and the claim/catalyst ledger before relying on memory — anything time-sensitive without a tool result behind it must be flagged as unverified. Cite Vault source titles when you use excerpts. Keep answers tight; the analyst is reading in a side drawer.

${snapshot}`,
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(8),
    tools: {
      searchVault: tool({
        description:
          "Search the Vault (ingested primary-source documents: filings, transcripts, notes) for this company. Returns the top matching excerpts with source titles.",
        inputSchema: z.object({
          query: z.string().describe("What to look for in the primary documents"),
        }),
        execute: async ({ query }) => {
          const hits = await searchVault(query, { ticker, limit: 6 });
          if (hits.length === 0) return { results: [], note: "No Vault matches." };
          return {
            results: hits.map((h) => ({
              source: h.title,
              formType: h.formType,
              filedAt: h.filedAt,
              excerpt: h.text.slice(0, 1200),
            })),
          };
        },
      }),
      getQuote: tool({
        description: "Live quote: price, day change %, and recent daily closes.",
        inputSchema: z.object({
          ticker: z.string().optional().describe(`Defaults to ${ticker}`),
        }),
        execute: async ({ ticker: t }) => {
          const q = await getQuote(t?.trim() || ticker);
          if (!q) return { error: "No quote available." };
          return {
            ticker: q.ticker,
            price: q.price,
            dayChangePct: q.dayChangePct,
            currency: q.currency,
            marketCap: q.marketCap,
            stale: q.stale,
            recentCloses: q.history.slice(-10),
          };
        },
      }),
      getFundamentals: tool({
        description:
          "Latest annual fundamentals from EDGAR XBRL: revenue, operating income, net income, shares, cash, debt.",
        inputSchema: z.object({
          ticker: z.string().optional().describe(`Defaults to ${ticker}`),
        }),
        execute: async ({ ticker: t }) => {
          const f = await getFundamentals(t?.trim() || ticker);
          if (!f) return { error: "No fundamentals available." };
          return {
            ticker: f.ticker,
            fiscalPeriod: f.fiscalPeriod,
            revenue: f.revenue,
            operatingIncome: f.operatingIncome,
            netIncome: f.netIncome,
            sharesOutstanding: f.sharesOutstanding,
            cash: f.cash,
            debt: f.debt,
          };
        },
      }),
      listClaims: tool({
        description:
          "The claim ledger for this company: every recorded claim with its evidence classification (fact/inference/opinion/model_assumption/unverified), direction, and confidence.",
        inputSchema: z.object({}),
        execute: async () => {
          if (!company) return { claims: [], note: "No dossier on file." };
          const rows = await db
            .select()
            .from(tables.claims)
            .where(eq(tables.claims.companyId, company.id))
            .orderBy(desc(tables.claims.confidence));
          return {
            claims: rows.map((c) => ({
              text: c.text,
              kind: c.kind,
              supports: c.supports,
              confidence: c.confidence,
              source: c.source,
              sourceType: c.sourceType,
            })),
          };
        },
      }),
      listCatalysts: tool({
        description: "The catalyst calendar for this company: title, kind, expected date, impact.",
        inputSchema: z.object({}),
        execute: async () => {
          if (!company) return { catalysts: [], note: "No dossier on file." };
          const rows = await db
            .select()
            .from(tables.catalysts)
            .where(eq(tables.catalysts.companyId, company.id));
          return {
            catalysts: rows.map((c) => ({
              title: c.title,
              kind: c.kind,
              expectedDate: c.expectedDate,
              impact: c.impact,
            })),
          };
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse({
    // A configured-but-dead key surfaces here mid-stream. Never leak provider
    // error bodies (they can include key fragments); degrade in-house tone.
    onError: () =>
      "Athena is offline: the configured model provider rejected the request. Verify the API key in .env.local and restart the dev server.",
  });
}
