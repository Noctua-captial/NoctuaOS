import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { MemoDecision } from "@/components/memo-decision";
import { getQuote } from "@/lib/market";

export const dynamic = "force-dynamic";

type EvidenceRow = {
  claim: string;
  evidence: string;
  source: string;
  confidence: string;
  updated: string;
};

type MemoContent = {
  oneSentenceThesis?: string;
  variantPerception?: string;
  whyNow?: string;
  businessQuality?: string;
  industryContext?: string;
  evidenceTable?: EvidenceRow[];
  valuation?: { bear?: string; base?: string; bull?: string };
  catalysts?: string[];
  bearCase?: string;
  killCriteria?: string[];
  positionSizing?: string;
  monitoringPlan?: string;
  dissent?: string;
  finalRecommendation?: string;
  nextDiligenceSteps?: string[];
  symposium?: {
    debateId?: number;
    verdict?: string;
    conviction?: number;
    crux?: string;
    resolvingEvidence?: string;
    probabilityBullCaseWorks?: number;
    logicVerdict?: string;
    weakestPremise?: string;
    nonSequiturs?: string[];
  };
};

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-2 flex items-baseline gap-3 text-lg font-semibold">
        <span className="fin text-xs opacity-50">{String(n).padStart(2, "0")}</span>
        {title}
      </h3>
      <div className="pl-8 text-[13.5px] leading-relaxed">{children}</div>
    </section>
  );
}

export default async function MemoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await db
    .select({ memo: tables.memos, company: tables.companies })
    .from(tables.memos)
    .innerJoin(tables.companies, eq(tables.memos.companyId, tables.companies.id))
    .where(eq(tables.memos.id, Number(id)));

  const row = rows[0];
  if (!row) notFound();
  const { memo, company } = row;

  // Live quote (P&L prefill) and any position already opened from this memo.
  // Market data must never break the page — null on any failure.
  const [quote, existingPosition] = await Promise.all([
    getQuote(company.ticker).catch(() => null),
    db.query.positions.findFirst({ where: eq(tables.positions.memoId, memo.id) }),
  ]);

  let content: MemoContent = {};
  try {
    content = JSON.parse(memo.content);
  } catch {}

  return (
    <div className="px-10 py-8">
      <div className="mb-5 flex items-center justify-between">
        <Link href="/ic" className="label hover:text-parchment-dim">
          ← IC Chamber
        </Link>
        <Link href={`/dossiers/${company.ticker}`} className="label hover:text-parchment-dim">
          Open dossier →
        </Link>
      </div>

      <MemoDecision
        memoId={memo.id}
        decidedBy={memo.decidedBy}
        decidedAt={memo.decidedAt ? memo.decidedAt.toISOString() : null}
        recommendation={memo.recommendation}
        companyId={company.id}
        ticker={company.ticker}
        quotePrice={quote?.price ?? null}
        proposedSize={memo.proposedSize}
        hasPosition={Boolean(existingPosition)}
      />

      <article className="parchment-doc mx-auto max-w-3xl px-12 py-12">
        <header className="mb-9 border-b border-[#211d14]/20 pb-7 text-center">
          <div className="fin text-[10px] tracking-[0.3em] opacity-60">NOCTUA CAPITAL — CONFIDENTIAL</div>
          <h1 className="serif mt-3 text-3xl font-semibold">Investment Memorandum</h1>
          <div className="fin mt-4 grid grid-cols-3 gap-y-1 text-[11px]">
            <span className="opacity-60">COMPANY</span>
            <span className="opacity-60">TICKER</span>
            <span className="opacity-60">VERSION</span>
            <span>{company.name}</span>
            <span>{company.ticker}</span>
            <span>v{memo.version}</span>
            <span className="mt-2 opacity-60">ANALYST</span>
            <span className="mt-2 opacity-60">ACTION</span>
            <span className="mt-2 opacity-60">SIZE</span>
            <span>{memo.analyst}</span>
            <span>{memo.proposedAction ?? "—"}</span>
            <span>{memo.proposedSize ?? "—"}</span>
          </div>
        </header>

        {content.oneSentenceThesis && (
          <Section n={1} title="One-Sentence Thesis">
            <p className="serif text-lg italic">“{content.oneSentenceThesis}”</p>
          </Section>
        )}
        {content.variantPerception && (
          <Section n={2} title="Variant Perception">
            {content.variantPerception}
          </Section>
        )}
        {content.whyNow && (
          <Section n={3} title="Why Now">
            {content.whyNow}
          </Section>
        )}
        {content.businessQuality && (
          <Section n={4} title="Business Quality">
            {content.businessQuality}
          </Section>
        )}
        {content.industryContext && (
          <Section n={5} title="Industry Context">
            {content.industryContext}
          </Section>
        )}

        {content.evidenceTable && content.evidenceTable.length > 0 && (
          <Section n={6} title="Evidence Table">
            <table className="fin w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-[#211d14]/30 text-left">
                  <th className="py-1.5 pr-3 font-semibold">Claim</th>
                  <th className="py-1.5 pr-3 font-semibold">Evidence</th>
                  <th className="py-1.5 pr-3 font-semibold">Source</th>
                  <th className="py-1.5 pr-3 font-semibold">Conf.</th>
                  <th className="py-1.5 font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody>
                {content.evidenceTable.map((r, i) => (
                  <tr key={i} className="border-b border-[#211d14]/10 align-top">
                    <td className="py-2 pr-3">{r.claim}</td>
                    <td className="py-2 pr-3">{r.evidence}</td>
                    <td className="py-2 pr-3">{r.source}</td>
                    <td className="py-2 pr-3">{r.confidence}</td>
                    <td className="py-2">{r.updated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {content.valuation && (
          <Section n={7} title="Valuation">
            <div className="fin space-y-1.5 text-[12px]">
              <p><span className="inline-block w-14 font-semibold">BEAR</span>{content.valuation.bear}</p>
              <p><span className="inline-block w-14 font-semibold">BASE</span>{content.valuation.base}</p>
              <p><span className="inline-block w-14 font-semibold">BULL</span>{content.valuation.bull}</p>
            </div>
          </Section>
        )}

        {content.catalysts && content.catalysts.length > 0 && (
          <Section n={8} title="Catalysts">
            <ul className="list-disc space-y-1 pl-4">
              {content.catalysts.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </Section>
        )}

        {content.bearCase && (
          <Section n={9} title="Bear Case — How We Lose Money">
            {content.bearCase}
          </Section>
        )}

        {content.killCriteria && content.killCriteria.length > 0 && (
          <Section n={10} title="Kill Criteria">
            <ul className="space-y-1">
              {content.killCriteria.map((k, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-semibold">✕</span>
                  {k}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {content.positionSizing && (
          <Section n={11} title="Position Sizing">
            {content.positionSizing}
          </Section>
        )}
        {content.monitoringPlan && (
          <Section n={12} title="Monitoring Plan">
            {content.monitoringPlan}
          </Section>
        )}
        {content.dissent && (
          <Section n={13} title="Dissent — Best Argument Against">
            <p className="border-l-2 border-[#211d14]/40 pl-4 italic">{content.dissent}</p>
          </Section>
        )}
        {content.finalRecommendation && (
          <Section n={14} title="Final Recommendation">
            <p className="font-semibold">{content.finalRecommendation}</p>
          </Section>
        )}

        {content.nextDiligenceSteps && content.nextDiligenceSteps.length > 0 && (
          <Section n={15} title="Required Next Diligence">
            <ol className="list-decimal space-y-1 pl-4">
              {content.nextDiligenceSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </Section>
        )}

        {content.symposium?.verdict && (
          <Section n={16} title="The Symposium — Debate Record">
            <div className="fin space-y-1.5 text-[12px]">
              <p>
                <span className="inline-block w-32 font-semibold">VERDICT</span>
                {content.symposium.verdict.toUpperCase()}
                {content.symposium.conviction != null &&
                  ` — conviction ${(content.symposium.conviction * 100).toFixed(0)}%`}
              </p>
              {content.symposium.probabilityBullCaseWorks != null && (
                <p>
                  <span className="inline-block w-32 font-semibold">P(BULL)</span>
                  {(content.symposium.probabilityBullCaseWorks * 100).toFixed(0)}%
                </p>
              )}
              {content.symposium.logicVerdict && (
                <p>
                  <span className="inline-block w-32 font-semibold">LOGIC AUDIT</span>
                  {content.symposium.logicVerdict.toUpperCase()}
                </p>
              )}
            </div>
            {content.symposium.crux && (
              <p className="mt-3 border-l-2 border-[#211d14]/40 pl-4">
                <span className="font-semibold">The crux: </span>
                {content.symposium.crux}
                {content.symposium.resolvingEvidence && (
                  <>
                    {" "}
                    <span className="font-semibold">Resolves with: </span>
                    {content.symposium.resolvingEvidence}
                  </>
                )}
              </p>
            )}
            {content.symposium.weakestPremise && (
              <p className="mt-2 text-[12px] italic">Weakest premise: {content.symposium.weakestPremise}</p>
            )}
            {content.symposium.debateId && (
              <Link
                href={`/debates/${content.symposium.debateId}`}
                className="fin mt-3 inline-block border border-[#211d14]/40 px-3 py-1.5 text-[10px] tracking-[0.15em]"
              >
                READ THE FULL TRANSCRIPT →
              </Link>
            )}
          </Section>
        )}

        <footer className="mt-10 border-t border-[#211d14]/20 pt-5 text-center">
          <div className="serif text-2xl">α</div>
          <div className="fin mt-1 text-[9px] tracking-[0.3em] opacity-50">
            NOCTUA SEES IN THE DARK
          </div>
        </footer>
      </article>
    </div>
  );
}
