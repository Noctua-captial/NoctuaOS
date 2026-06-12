import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ICChamber() {
  const memos = await db
    .select({ memo: tables.memos, ticker: tables.companies.ticker, name: tables.companies.name })
    .from(tables.memos)
    .innerJoin(tables.companies, eq(tables.memos.companyId, tables.companies.id))
    .orderBy(desc(tables.memos.createdAt));

  return (
    <div>
      <PageHeader kicker="IC Chamber" title="Investment Committee Memos" />
      <div className="px-10 py-8">
        <div className="card divide-y divide-line">
          {memos.map(({ memo, ticker, name }) => (
            <Link
              key={memo.id}
              href={`/ic/${memo.id}`}
              className="flex items-center justify-between px-6 py-4 hover:bg-ink-raised"
            >
              <div className="flex items-baseline gap-4">
                <span className="fin text-base text-parchment">{ticker}</span>
                <span className="text-sm text-parchment-faint">{name}</span>
                <span className="fin text-[11px] text-parchment-faint">v{memo.version}</span>
              </div>
              <div className="flex items-center gap-6">
                <span className="text-xs text-parchment-faint">{memo.analyst}</span>
                <span className="fin text-xs text-parchment-dim">{memo.proposedAction ?? "—"}</span>
                <span
                  className={`fin w-24 text-right text-[10px] tracking-[0.15em] ${
                    memo.recommendation === "approve"
                      ? "text-bull"
                      : memo.recommendation === "reject"
                        ? "text-bear"
                        : "text-warn"
                  }`}
                >
                  {memo.recommendation === "more_work" ? "MORE WORK" : memo.recommendation?.toUpperCase()}
                </span>
              </div>
            </Link>
          ))}
          {memos.length === 0 && (
            <div className="px-6 py-10 text-center text-sm text-parchment-faint">
              No memos. Every trade requires a memo — even a short one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
