import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { storeDocument } from "@/lib/vault";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    ticker?: string;
    title?: string;
    docType?: string;
    content?: string;
    source?: string;
  };

  if (!body.title?.trim() || !body.content?.trim()) {
    return Response.json({ error: "Title and content are required." }, { status: 400 });
  }
  if (body.content.length < 200) {
    return Response.json({ error: "Content too short to be useful evidence (min 200 chars)." }, { status: 400 });
  }

  const ticker = body.ticker?.trim().toUpperCase() || null;
  const company = ticker
    ? await db.query.companies.findFirst({ where: eq(tables.companies.ticker, ticker) })
    : null;

  const result = await storeDocument({
    companyId: company?.id ?? null,
    ticker,
    title: body.title.trim(),
    docType: body.docType ?? "note",
    source: body.source?.trim() || "manual upload",
    content: body.content,
  });

  return Response.json(result);
}
