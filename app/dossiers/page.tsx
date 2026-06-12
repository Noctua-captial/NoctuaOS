import Link from "next/link";
import { desc } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader, StatusBadge, ThesisStatus, ScoreRing } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Dossiers() {
  const companies = await db
    .select()
    .from(tables.companies)
    .orderBy(desc(tables.companies.convictionScore));

  return (
    <div>
      <PageHeader
        kicker="Dossiers — Living Research"
        title="Coverage Universe"
        right={
          <Link
            href="/new"
            className="fin border border-line-strong px-4 py-2 text-xs tracking-[0.15em] text-parchment hover:bg-ink-card"
          >
            + OPEN DOSSIER
          </Link>
        }
      />

      <div className="px-10 py-8">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line-strong text-left">
              {["Ticker", "Company", "Sector", "Mkt Cap", "Status", "Thesis", "Score", "Analyst"].map(
                (h) => (
                  <th key={h} className="label pb-3 pr-4 !text-[10px]">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id} className="group border-b border-line hover:bg-ink-card">
                <td className="py-4 pr-4">
                  <Link href={`/dossiers/${c.ticker}`} className="fin text-sm text-parchment">
                    {c.ticker}
                  </Link>
                </td>
                <td className="pr-4 text-[13px] text-parchment-dim">
                  <Link href={`/dossiers/${c.ticker}`}>{c.name}</Link>
                </td>
                <td className="pr-4 text-xs text-parchment-faint">{c.sector}</td>
                <td className="fin pr-4 text-xs text-parchment-dim">{c.marketCap ?? "—"}</td>
                <td className="pr-4">
                  <StatusBadge status={c.status} />
                </td>
                <td className="pr-4">
                  <ThesisStatus status={c.thesisStatus} />
                </td>
                <td className="pr-4">
                  <ScoreRing score={c.convictionScore} size={40} />
                </td>
                <td className="text-xs text-parchment-faint">{c.ownerAnalyst ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
