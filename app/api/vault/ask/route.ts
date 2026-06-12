import { NextRequest } from "next/server";
import { generateText } from "ai";
import { searchVault } from "@/lib/vault";
import { CONSTITUTION } from "@/lib/athena";
import { modelFor } from "@/lib/models";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const { question, ticker } = (await req.json()) as { question?: string; ticker?: string };
  if (!question?.trim()) return Response.json({ error: "Question required." }, { status: 400 });

  const hits = await searchVault(question, { ticker: ticker?.trim() || undefined, limit: 8 });

  if (hits.length === 0) {
    return Response.json({
      answer: null,
      excerpts: [],
      note: "No matching evidence in the Vault. Ingest filings or upload documents first.",
    });
  }

  const excerpts = hits.map((h) => ({
    title: h.title,
    formType: h.formType,
    filedAt: h.filedAt,
    source: h.source,
    text: h.text.slice(0, 1200),
  }));

  // Try LLM synthesis; degrade to raw excerpts if no working key.
  try {
    const { model } = modelFor("chat");
    const { text } = await generateText({
      model,
      system: CONSTITUTION,
      prompt: `Answer the analyst's question using ONLY the Vault excerpts below. Cite source titles inline in brackets. If the excerpts do not answer the question, say exactly what evidence is missing — do not improvise. Classify any conclusion you draw as fact (directly stated), inference (reasoned from excerpts), or unanswerable.

QUESTION: ${question}

VAULT EXCERPTS:
${excerpts.map((e, i) => `[${i + 1}] ${e.title}${e.filedAt ? ` (filed ${e.filedAt})` : ""}\n${e.text}`).join("\n\n---\n\n")}`,
    });
    return Response.json({ answer: text, excerpts });
  } catch {
    return Response.json({
      answer: null,
      excerpts,
      note: "LLM synthesis unavailable (no working API key) — showing the strongest matching excerpts instead.",
    });
  }
}
