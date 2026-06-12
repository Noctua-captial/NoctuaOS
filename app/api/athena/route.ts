import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  runDossierAgent,
  runAccountingAgent,
  runIndustryAgent,
  runCatalystAgent,
  runValuationAgent,
  runStrix,
  runEvidenceAuditor,
  runSynthesis,
  type Trace,
} from "@/lib/athena";
import { modelFor } from "@/lib/models";
import { vaultContext } from "@/lib/vault";
import { computeNameQuant, type NameQuant } from "@/lib/quant";
import { runResearchTree, runLogicAuditor, runDebate } from "@/lib/symposium";

export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const { ticker: rawTicker, notes } = (await req.json()) as { ticker?: string; notes?: string };
  const ticker = rawTicker?.trim().toUpperCase();

  if (!ticker || !/^[A-Z.\-]{1,8}$/.test(ticker)) {
    return Response.json({ error: "Provide a valid ticker." }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      const saveRun = (agent: string, output: unknown, inputSummary: string, modelId: string, companyId?: number) => {
        db.insert(tables.agentRuns)
          .values({ companyId: companyId ?? null, ticker, agent, model: modelId, inputSummary, output: JSON.stringify(output) })
          .run();
      };

      const saveTrace = (researcher: string, trace: Trace, companyId?: number) => {
        db.insert(tables.traces)
          .values({
            researcher,
            ticker,
            companyId: companyId ?? null,
            currentQuestion: trace.currentQuestion,
            actionTaken: trace.actionTaken,
            sourceType: "agent_report",
            informationSeen: trace.informationSeen,
            interpretation: trace.interpretation,
            signalCategory: trace.signalCategory,
            confidenceChange: trace.confidenceChange,
            nextAction: trace.nextAction,
            reasoningPattern: trace.reasoningPattern,
          })
          .run();
      };

      try {
        // Resolve every agent's model up front — throws the friendly
        // no-key error before any work starts if no provider is configured.
        const dossierM = modelFor("dossier");
        const accountingM = modelFor("accounting");
        const industryM = modelFor("industry");
        const catalystM = modelFor("catalyst");
        const valuationM = modelFor("valuation");
        const strixM = modelFor("strix");
        const auditorM = modelFor("evidence_auditor");
        const synthesisM = modelFor("synthesis");

        // ---- Vault grounding ----
        emit({ stage: "vault", message: `Pulling primary-source evidence for ${ticker} from the Vault…` });
        const vaultCtx = await vaultContext(ticker, [
          `${ticker} revenue growth segments demand`,
          `${ticker} risks competition customer concentration`,
          `${ticker} guidance outlook margins backlog`,
        ]);
        emit({
          stage: "vault",
          message: vaultCtx
            ? "Vault evidence found — agents will ground claims in primary documents."
            : "No Vault documents for this ticker. Agents will work from model knowledge; claims will be marked unverified. (Ingest filings in The Vault to fix this.)",
        });

        // ---- Stage 1: Dossier + Thesis ----
        emit({ stage: "dossier", message: `Dossier Agent and Thesis Agent assigned to ${ticker}.` });
        const dossier = await runDossierAgent(dossierM.model, ticker, vaultCtx, notes);
        saveRun("dossier", dossier, `Investigation opened${notes ? ` — ${notes.slice(0, 80)}` : ""}`, dossierM.modelId);
        emit({ stage: "dossier", message: `Bull case formed: “${dossier.bullThesis.oneLiner}”` });

        // ---- Stage 1b: Quant snapshot (keyless ground truth) ----
        emit({ stage: "quant", message: "Computing quant profile from real price history and fundamentals…" });
        const quant: NameQuant | null = await computeNameQuant(ticker).catch(() => null);
        emit({
          stage: "quant",
          message: quant
            ? `Quant ground truth: vol ${quant.annualizedVol != null ? (quant.annualizedVol * 100).toFixed(0) + "%" : "—"}, beta ${quant.beta?.toFixed(2) ?? "—"}, ${quant.pctFrom52wHigh != null ? quant.pctFrom52wHigh.toFixed(0) + "% from 52w high" : "52w range unavailable"}, EV/Rev ${quant.evToRevenue?.toFixed(1) ?? "—"}.`
            : "No market data available — agents proceed without quant ground truth.",
        });

        // ---- Stage 2: Specialist bench in parallel ----
        emit({ stage: "bench", message: "Bench assigned: Accounting, Industry, Catalyst, Valuation agents working in parallel." });
        const [accounting, industry, catalyst, valuation] = await Promise.all([
          runAccountingAgent(accountingM.model, ticker, dossier, vaultCtx),
          runIndustryAgent(industryM.model, ticker, dossier, vaultCtx),
          runCatalystAgent(catalystM.model, ticker, dossier, vaultCtx),
          runValuationAgent(valuationM.model, ticker, dossier, vaultCtx),
        ]);
        saveRun("accounting", accounting, "Financial quality review", accountingM.modelId);
        saveRun("industry", industry, "Technical & competitive reality check", industryM.modelId);
        saveRun("catalyst", catalyst, "Re-rating event map", catalystM.modelId);
        saveRun("valuation", valuation, "Bear/base/bull cases", valuationM.modelId);
        emit({
          stage: "bench",
          message: `Bench reported. Accounting: ${accounting.redFlags.length} red flag(s). Industry: AI exposure ${industry.aiExposureReal ? "real" : "NOT structurally real"}. Catalysts mapped: ${catalyst.catalysts.length}.`,
        });

        // ---- Stage 2b: Recursive research tree ----
        emit({ stage: "tree", message: "Athena decomposing the thesis into load-bearing questions for recursive investigation." });
        const tree = await runResearchTree({
          ticker,
          companyId: null, // linked to the company after upsert
          dossier,
          quant,
          vaultCtx,
          emit,
          saveTrace,
        });
        emit({
          stage: "tree",
          message: `Research tree complete: ${tree.nodes.length} questions answered across ${Math.max(...tree.nodes.map((n) => n.depth), 1)} levels (${tree.calls} model calls).`,
        });

        // ---- Stage 2c: Logic Auditor ----
        emit({ stage: "logic", message: "Logic Auditor formalizing the thesis: premises → inference → conclusion." });
        const { audit: logicAudit, modelId: logicModelId } = await runLogicAuditor({
          ticker,
          dossier,
          treeSummary: tree.summary,
          quant,
        });
        saveRun("logic", logicAudit, "Premise-by-premise logic and science audit", logicModelId);
        emit({
          stage: "logic",
          message: `Logic verdict: ${logicAudit.verdict.toUpperCase()}. ${logicAudit.nonSequiturs.length} non-sequitur(s). Weakest premise: ${logicAudit.weakestPremise.slice(0, 120)}`,
        });

        // ---- Stage 3: Strix ----
        emit({ stage: "strix", message: "Releasing Strix to attack the thesis and the bench's findings." });
        const strix = await runStrix(strixM.model, ticker, dossier, { accounting, industry, catalyst, valuation }, vaultCtx);
        saveRun("strix", strix, "Adversarial review of full bench", strixM.modelId);
        emit({ stage: "strix", message: `Dissent recorded: “${strix.strongestDissent.slice(0, 160)}…”` });

        // ---- Stage 4: Evidence Auditor ----
        emit({ stage: "audit", message: "Evidence Auditor checking every claim. No source, no claim." });
        const allClaims = [
          ...dossier.claims,
          ...accounting.claims,
          ...industry.claims,
          ...strix.bearClaims.map((c) => ({ ...c, supports: "bear" as const })),
        ];
        const auditor = await runEvidenceAuditor(
          auditorM.model,
          ticker,
          allClaims.map((c) => ({ text: c.text, kind: c.kind, confidence: c.confidence, source: c.source })),
          vaultCtx,
        );
        saveRun("evidence_auditor", auditor, `Audited ${allClaims.length} claims`, auditorM.modelId);
        const flagged = auditor.audits.filter((a) => a.verdict === "unsupported" || a.verdict === "contradicted").length;
        emit({ stage: "audit", message: `Audit complete: ${flagged} of ${auditor.audits.length} claims unsupported or contradicted. Weakest link: ${auditor.weakestLink.slice(0, 120)}` });

        // ---- Stage 5: The Debate Chamber ----
        emit({ stage: "debate", message: "Convening the Debate Chamber: Advocate vs Strix vs The Quant, Athena moderating." });
        const { debateId, verdict } = await runDebate({
          ticker,
          companyId: null, // linked after upsert
          dossier,
          treeSummary: tree.summary,
          logicAudit,
          quant,
          emit,
        });

        // ---- Stage 6: Synthesis ----
        emit({ stage: "synthesis", message: "Athena scoring and drafting IC memo from the full Symposium." });
        const synthesis = await runSynthesis(synthesisM.model, ticker, dossier, {
          accounting, industry, catalyst, valuation, strix, auditor,
          symposium: {
            treeSummary: tree.summary,
            logicVerdict: logicAudit.verdict,
            weakestPremise: logicAudit.weakestPremise,
            debateVerdict: verdict.verdict,
            debateConviction: verdict.conviction,
            crux: verdict.crux,
          },
        });

        emit({ stage: "persist", message: "Committing investigation to research memory." });

        const s = synthesis.score;
        const total = Math.round(
          s.thesisClarity + s.evidenceQuality + s.variantPerception + s.asymmetry +
          s.valuationGap + s.catalystStrength + s.managementQuality + s.balanceSheet +
          s.technicalEdge + s.liquidityRiskFit,
        );

        const statusFromRec =
          synthesis.memo.recommendation === "approve" ? "watchlist"
          : synthesis.memo.recommendation === "reject" ? "rejected"
          : "pipeline";

        // Upsert company
        const existing = await db.query.companies.findFirst({ where: eq(tables.companies.ticker, ticker) });
        let companyId: number;
        if (existing) {
          companyId = existing.id;
          db.update(tables.companies)
            .set({
              name: dossier.name,
              sector: dossier.sector,
              marketCap: dossier.marketCapEstimate,
              liquidity: dossier.liquidityNote,
              businessSummary: dossier.businessSummary,
              convictionScore: total,
              updatedAt: new Date(),
            })
            .where(eq(tables.companies.id, companyId))
            .run();
        } else {
          const [created] = db
            .insert(tables.companies)
            .values({
              ticker,
              name: dossier.name,
              sector: dossier.sector,
              marketCap: dossier.marketCapEstimate,
              liquidity: dossier.liquidityNote,
              status: statusFromRec,
              thesisStatus: "stable",
              convictionScore: total,
              ownerAnalyst: "Athena (draft)",
              businessSummary: dossier.businessSummary,
              rejectionReason: synthesis.memo.recommendation === "reject" ? synthesis.memo.finalRecommendation : null,
            })
            .returning()
            .all();
          companyId = created.id;
        }

        // Link agent runs, traces, and orphan documents to the company
        db.update(tables.agentRuns).set({ companyId }).where(eq(tables.agentRuns.ticker, ticker)).run();
        db.update(tables.documents).set({ companyId }).where(eq(tables.documents.ticker, ticker)).run();
        db.update(tables.researchQuestions).set({ companyId }).where(eq(tables.researchQuestions.ticker, ticker)).run();
        db.update(tables.debates).set({ companyId }).where(eq(tables.debates.ticker, ticker)).run();
        db.update(tables.quantSnapshots).set({ companyId }).where(eq(tables.quantSnapshots.ticker, ticker)).run();

        // Traces from every agent
        saveTrace("DossierAgent", dossier.trace, companyId);
        saveTrace("AccountingAgent", accounting.trace, companyId);
        saveTrace("IndustryAgent", industry.trace, companyId);
        saveTrace("CatalystAgent", catalyst.trace, companyId);
        saveTrace("ValuationAgent", valuation.trace, companyId);
        saveTrace("Strix", strix.trace, companyId);
        saveTrace("EvidenceAuditor", auditor.trace, companyId);
        saveTrace("Athena", synthesis.trace, companyId);
        db.update(tables.traces).set({ companyId }).where(eq(tables.traces.ticker, ticker)).run();

        // Thesis version
        const priorTheses = await db.select().from(tables.theses).where(eq(tables.theses.companyId, companyId));
        db.insert(tables.theses)
          .values({
            companyId,
            version: priorTheses.length + 1,
            oneLiner: dossier.bullThesis.oneLiner,
            variantPerception: dossier.bullThesis.variantPerception,
            whyMarketWrong: dossier.bullThesis.whyMarketWrong,
            whyNow: dossier.bullThesis.whyNow,
            whatMustHappen: JSON.stringify(dossier.bullThesis.whatMustHappen),
            killCriteria: JSON.stringify(strix.killCriteria),
          })
          .run();

        // Claims with auditor adjustments applied
        const auditByText = new Map(auditor.audits.map((a) => [a.claim.toLowerCase().slice(0, 60), a]));
        db.insert(tables.claims)
          .values(
            allClaims.map((c) => {
              const audit = auditByText.get(c.text.toLowerCase().slice(0, 60));
              return {
                companyId,
                text: c.text,
                kind: audit?.adjustedKind ?? c.kind,
                supports: c.supports,
                confidence: audit?.adjustedConfidence ?? c.confidence,
                source: c.source,
                sourceType: c.sourceType,
              };
            }),
          )
          .run();

        db.insert(tables.catalysts)
          .values(
            catalyst.catalysts.map((c) => ({
              companyId,
              title: c.title,
              kind: c.kind,
              expectedDate: c.expectedDate,
              impact: `${c.impact} (p≈${Math.round(c.probability * 100)}%)`,
            })),
          )
          .run();

        db.insert(tables.scores)
          .values({
            companyId,
            total,
            components: JSON.stringify({
              thesisClarity: s.thesisClarity,
              evidenceQuality: s.evidenceQuality,
              variantPerception: s.variantPerception,
              asymmetry: s.asymmetry,
              valuationGap: s.valuationGap,
              catalystStrength: s.catalystStrength,
              managementQuality: s.managementQuality,
              balanceSheet: s.balanceSheet,
              technicalEdge: s.technicalEdge,
              liquidityRiskFit: s.liquidityRiskFit,
            }),
            rationale: s.rationale,
          })
          .run();

        const priorMemos = await db.select().from(tables.memos).where(eq(tables.memos.companyId, companyId));
        const [memo] = db
          .insert(tables.memos)
          .values({
            companyId,
            version: priorMemos.length + 1,
            analyst: "Athena (draft)",
            proposedAction: synthesis.memo.proposedAction,
            proposedSize: synthesis.memo.proposedSize,
            recommendation: synthesis.memo.recommendation,
            content: JSON.stringify({
              oneSentenceThesis: dossier.bullThesis.oneLiner,
              variantPerception: dossier.bullThesis.variantPerception,
              whyNow: dossier.bullThesis.whyNow,
              businessQuality: synthesis.memo.businessQuality,
              industryContext: synthesis.memo.industryContext,
              evidenceTable: allClaims.slice(0, 10).map((c) => {
                const audit = auditByText.get(c.text.toLowerCase().slice(0, 60));
                return {
                  claim: c.text,
                  evidence: audit ? audit.verdict.replace("_", " ") : c.kind.replace("_", " "),
                  source: c.source,
                  confidence: `${Math.round((audit?.adjustedConfidence ?? c.confidence) * 100)}%`,
                  updated: new Date().toISOString().slice(0, 10),
                };
              }),
              valuation: {
                bear: `${valuation.bear.value} — ${valuation.bear.logic}`,
                base: `${valuation.base.value} — ${valuation.base.logic}`,
                bull: `${valuation.bull.value} — ${valuation.bull.logic}`,
              },
              catalysts: catalyst.catalysts.map((c) => `${c.title} (${c.expectedDate}, p≈${Math.round(c.probability * 100)}%)`),
              bearCase: strix.bearCase,
              killCriteria: strix.killCriteria,
              positionSizing: synthesis.memo.positionSizing,
              monitoringPlan: synthesis.memo.monitoringPlan,
              dissent: `Strix: “${strix.strongestDissent}”`,
              finalRecommendation: synthesis.memo.finalRecommendation,
              nextDiligenceSteps: synthesis.nextDiligenceSteps,
              symposium: {
                debateId,
                verdict: verdict.verdict,
                conviction: verdict.conviction,
                crux: verdict.crux,
                resolvingEvidence: verdict.resolvingEvidence,
                probabilityBullCaseWorks: verdict.probabilityBullCaseWorks,
                logicVerdict: logicAudit.verdict,
                weakestPremise: logicAudit.weakestPremise,
                nonSequiturs: logicAudit.nonSequiturs,
              },
            }),
          })
          .returning()
          .all();

        saveRun("synthesis", synthesis, "IC synthesis", synthesisM.modelId, companyId);
        db.update(tables.debates).set({ memoId: memo.id }).where(eq(tables.debates.id, debateId)).run();

        emit({
          stage: "done",
          message: `Symposium complete. Debate verdict: ${verdict.verdict} (${(verdict.conviction * 100).toFixed(0)}%). Noctua Score: ${total}. Recommendation: ${synthesis.memo.recommendation.replace("_", " ")}. Tree, debate transcript, and traces committed to the Alpha Ledger.`,
          ticker,
          memoId: memo.id,
          debateId,
          score: total,
        });
      } catch (err) {
        emit({
          stage: "error",
          message: err instanceof Error ? err.message : "Unknown failure in the Athena pipeline.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
