import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, tables } from "@/db";

export const dynamic = "force-dynamic";

const seatStyle: Record<string, { label: string; color: string; align: string }> = {
  advocate: { label: "ADVOCATE", color: "var(--bull)", align: "" },
  strix: { label: "STRIX", color: "var(--bear)", align: "" },
  quant: { label: "THE QUANT", color: "var(--platinum)", align: "" },
  moderator: { label: "ATHENA · MODERATOR", color: "var(--parchment)", align: "" },
};

const roundLabel: Record<string, string> = {
  opening: "Round I — Opening Statements",
  rebuttal: "Round II — Rebuttals",
  cross: "Round III — Cross-Examination",
  final: "Round IV — Final Positions",
  verdict: "The Verdict",
};

type TurnContent = {
  argument?: string;
  strongestOpposingPoint?: string;
  probabilityBullCaseWorks?: number;
  cruxQuestion?: string;
  verdict?: string;
  conviction?: number;
  reasoning?: string;
  crux?: string;
  resolvingEvidence?: string;
};

export default async function DebatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const debate = await db.query.debates.findFirst({ where: eq(tables.debates.id, Number(id)) });
  if (!debate) notFound();

  const turns = await db
    .select()
    .from(tables.debateTurns)
    .where(eq(tables.debateTurns.debateId, debate.id))
    .orderBy(asc(tables.debateTurns.idx));

  const roundStarts = new Set<number>();
  {
    let r = "";
    turns.forEach((t, i) => {
      if ((t.round ?? "") !== r) {
        roundStarts.add(i);
        r = t.round ?? "";
      }
    });
  }

  return (
    <div className="px-10 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href={`/dossiers/${debate.ticker}`} className="label hover:text-parchment-dim">
          ← {debate.ticker} dossier
        </Link>
        {debate.memoId && (
          <Link href={`/ic/${debate.memoId}`} className="label hover:text-parchment-dim">
            IC memo →
          </Link>
        )}
      </div>

      <div className="mx-auto max-w-3xl">
        <div className="mb-8 text-center">
          <div className="label">The Debate Chamber</div>
          <h1 className="serif mt-2 text-4xl text-parchment">{debate.ticker}</h1>
          {debate.verdict && (
            <div className="mt-4 inline-flex items-center gap-4 border border-line-strong bg-ink-card px-5 py-3">
              <span
                className={`fin text-sm tracking-[0.2em] ${
                  debate.verdict === "pursue" ? "text-bull" : debate.verdict === "reject" ? "text-bear" : "text-warn"
                }`}
              >
                {debate.verdict.toUpperCase()}
              </span>
              {debate.conviction != null && (
                <span className="fin text-xs text-parchment-dim">
                  conviction {(debate.conviction * 100).toFixed(0)}%
                </span>
              )}
            </div>
          )}
        </div>

        {debate.crux && (
          <div className="card mb-8 border-warn/40 px-6 py-4">
            <div className="label mb-1 !text-warn">The Crux — unresolved</div>
            <p className="text-[13.5px] leading-relaxed text-parchment">{debate.crux}</p>
            {debate.resolvingEvidence && (
              <p className="mt-2 border-l border-line-strong pl-3 text-xs text-parchment-dim">
                <span className="label !text-[9px]">Resolves with — </span>
                {debate.resolvingEvidence}
              </p>
            )}
          </div>
        )}

        <div className="space-y-4">
          {turns.map((turn, i) => {
            let content: TurnContent = {};
            try {
              content = JSON.parse(turn.content);
            } catch {}
            const seat = seatStyle[turn.seat] ?? seatStyle.moderator;
            const showRound = roundStarts.has(i);

            return (
              <div key={turn.id}>
                {showRound && (
                  <div className="mb-4 mt-8 flex items-center gap-4">
                    <div className="h-px flex-1 bg-line" />
                    <span className="serif text-lg text-parchment-dim">
                      {roundLabel[turn.round ?? ""] ?? turn.round}
                    </span>
                    <div className="h-px flex-1 bg-line" />
                  </div>
                )}

                <div className="card px-6 py-4" style={{ borderLeft: `2px solid ${seat.color}` }}>
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="fin text-[10px] tracking-[0.2em]" style={{ color: seat.color }}>
                      {seat.label}
                    </span>
                    <span className="flex items-center gap-3">
                      {content.probabilityBullCaseWorks != null && (
                        <span className="fin text-[10px] text-parchment-faint">
                          P(bull) {(content.probabilityBullCaseWorks * 100).toFixed(0)}%
                        </span>
                      )}
                      {turn.modelId && (
                        <span className="fin text-[9px] text-parchment-faint/60">{turn.modelId}</span>
                      )}
                    </span>
                  </div>

                  {content.cruxQuestion ? (
                    <p className="serif text-lg italic leading-relaxed text-parchment">
                      “{content.cruxQuestion}”
                    </p>
                  ) : content.verdict ? (
                    <div>
                      <p className="text-[13.5px] leading-relaxed text-parchment">{content.reasoning}</p>
                      <div className="card-rule mt-3 grid grid-cols-2 gap-x-6 gap-y-2 pt-3 text-xs text-parchment-dim">
                        <p>
                          <span className="label !text-[9px]">Verdict — </span>
                          {content.verdict} ({((content.conviction ?? 0) * 100).toFixed(0)}%)
                        </p>
                        <p>
                          <span className="label !text-[9px]">P(bull) — </span>
                          {((content.probabilityBullCaseWorks ?? 0) * 100).toFixed(0)}%
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-[13.5px] leading-relaxed text-parchment">{content.argument}</p>
                      {content.strongestOpposingPoint && (
                        <p className="mt-2.5 border-l border-line-strong pl-3 text-[11.5px] italic leading-relaxed text-parchment-faint">
                          Strongest point against: {content.strongestOpposingPoint}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {turns.length === 0 && (
            <div className="card px-6 py-10 text-center text-sm text-parchment-faint">
              No transcript. The debate may still be running.
            </div>
          )}
        </div>

        <footer className="mt-10 border-t border-line pt-5 text-center">
          <div className="serif text-2xl text-parchment-faint">α</div>
          <div className="label mt-1 !text-[8px]">Dissent before conviction</div>
        </footer>
      </div>
    </div>
  );
}
