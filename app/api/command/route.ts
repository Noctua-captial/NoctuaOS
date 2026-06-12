import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";

export async function GET() {
  const [companies, memos] = await Promise.all([
    db
      .select({
        ticker: tables.companies.ticker,
        name: tables.companies.name,
        status: tables.companies.status,
        score: tables.companies.convictionScore,
        thesisStatus: tables.companies.thesisStatus,
      })
      .from(tables.companies)
      .orderBy(desc(tables.companies.updatedAt)),
    db
      .select({
        id: tables.memos.id,
        version: tables.memos.version,
        recommendation: tables.memos.recommendation,
        ticker: tables.companies.ticker,
      })
      .from(tables.memos)
      .innerJoin(tables.companies, eq(tables.memos.companyId, tables.companies.id))
      .orderBy(desc(tables.memos.createdAt))
      .limit(20),
  ]);

  return Response.json({ companies, memos });
}
