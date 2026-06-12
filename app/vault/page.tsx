import { desc } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader } from "@/components/ui";
import { VaultIngest, VaultAsk, VaultUpload } from "./vault-client";

export const dynamic = "force-dynamic";

export default async function VaultPage({
  searchParams,
}: {
  searchParams: Promise<{ ticker?: string }>;
}) {
  const { ticker } = await searchParams;
  const docs = await db
    .select()
    .from(tables.documents)
    .orderBy(desc(tables.documents.createdAt))
    .limit(50);

  return (
    <div>
      <PageHeader kicker="The Vault — Evidence & Documents" title="No source, no claim." />

      <div className="grid grid-cols-12 gap-6 px-10 py-8">
        <div className="col-span-5 space-y-6">
          <VaultIngest initialTicker={ticker?.toUpperCase() ?? ""} />
          <VaultUpload />
        </div>

        <div className="col-span-7 space-y-8">
          <VaultAsk />

          <section>
            <div className="label mb-3">Documents on file — {docs.length}</div>
            <div className="card divide-y divide-line">
              {docs.map((d) => (
                <div key={d.id} className="flex items-start justify-between gap-4 px-5 py-3.5">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      {d.ticker && <span className="fin text-sm text-parchment">{d.ticker}</span>}
                      <span className="truncate text-[13px] text-parchment-dim">{d.title}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3">
                      <span className="fin border border-line px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-parchment-faint">
                        {d.formType ?? d.docType}
                      </span>
                      {d.filedAt && <span className="fin text-[10px] text-parchment-faint">filed {d.filedAt}</span>}
                      <span className="fin text-[10px] text-parchment-faint">
                        {(d.content.length / 1000).toFixed(0)}k chars
                      </span>
                    </div>
                  </div>
                  {d.source?.startsWith("http") && (
                    <a
                      href={d.source}
                      target="_blank"
                      rel="noreferrer"
                      className="label shrink-0 !text-[9px] hover:text-parchment-dim"
                    >
                      source ↗
                    </a>
                  )}
                </div>
              ))}
              {docs.length === 0 && (
                <div className="px-5 py-8 text-center text-sm text-parchment-faint">
                  The Vault is empty. Ingest filings from EDGAR or upload research material.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
