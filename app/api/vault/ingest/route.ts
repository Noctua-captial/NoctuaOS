import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { recentFilings, fetchFilingText } from "@/lib/edgar";
import { storeDocument } from "@/lib/vault";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { ticker: raw } = (await req.json()) as { ticker?: string };
  const ticker = raw?.trim().toUpperCase();
  if (!ticker) return Response.json({ error: "Ticker required." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        emit({ stage: "lookup", message: `Resolving ${ticker} in the EDGAR registry…` });
        const filings = await recentFilings(ticker);
        if (filings.length === 0) {
          emit({ stage: "error", message: `No recent annual/quarterly/current filings found for ${ticker} on EDGAR.` });
          controller.close();
          return;
        }

        const company = await db.query.companies.findFirst({
          where: eq(tables.companies.ticker, ticker),
        });

        let stored = 0;
        for (const f of filings) {
          // skip if already in the Vault
          const existing = await db.query.documents.findFirst({
            where: eq(tables.documents.source, f.url),
          });
          if (existing) {
            emit({ stage: "skip", message: `${f.formType} filed ${f.filedAt} already in the Vault.` });
            continue;
          }

          emit({ stage: "fetch", message: `Fetching ${f.formType} filed ${f.filedAt} (${f.companyName})…` });
          const text = await fetchFilingText(f.url);
          const { chunkCount, embedded } = await storeDocument({
            companyId: company?.id ?? null,
            ticker,
            title: `${f.companyName} — ${f.formType} (${f.filedAt})`,
            docType: "filing",
            formType: f.formType,
            source: f.url,
            filedAt: f.filedAt,
            content: text,
          });
          stored++;
          emit({
            stage: "stored",
            message: `Stored ${f.formType}: ${chunkCount} chunks${embedded ? ", embedded" : ", FTS-indexed (no embeddings — key inactive)"}.`,
          });
        }

        emit({ stage: "done", message: `Vault updated: ${stored} new document${stored === 1 ? "" : "s"} for ${ticker}.`, stored });
      } catch (err) {
        emit({ stage: "error", message: err instanceof Error ? err.message : "Ingestion failed." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
