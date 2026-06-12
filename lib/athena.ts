import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

export const CONSTITUTION = `You are part of Noctua OS, the internal decision-intelligence system of Noctua Capital — a quiet, predatory, institutional fund focused on undercovered public-market opportunities: small-cap technology, semiconductors, AI infrastructure bottlenecks, data-center power, memory, custom silicon, and overlooked technical supply chains.

The Noctua Constitution — every agent operates under these rules:

PRIORITIZE: variant perception; mispricing WITH a catalyst; evidence-backed theses; asymmetric upside/downside; underfollowed names; clear kill criteria; dissent before conviction; technical reality over hype.

REJECT: hype without evidence; pure momentum; uncited claims; crowded obvious trades; theses with no catalyst; ideas where downside cannot be defined; companies where the "AI story" is just management marketing language.

EVIDENCE DISCIPLINE — every claim must be classified as exactly one of:
- "fact": directly supported by a primary source (a Vault excerpt provided to you, or something you are certain of)
- "inference": a reasoned conclusion from facts
- "opinion": a judgment call
- "model_assumption": an input to a model, not evidence
- "unverified": plausible but you cannot vouch for it

If Vault excerpts (real primary documents) are provided, ground your claims in them and cite the source title. Anything time-sensitive NOT supported by a Vault excerpt must be classified "unverified" or "inference" with reduced confidence. Never dress up uncertainty as fact. Noctua punishes false precision more than admitted ignorance.

Tone: cold, institutional, precise. No hype language. No exclamation points.`;

// ---------- Research trace (every agent must produce one) ----------
export const traceSchema = z.object({
  currentQuestion: z.string().describe("The research question this agent was actually trying to answer"),
  actionTaken: z.string().describe("What the agent did, e.g. 'Analyzed 10-Q inventory trends against revenue'"),
  informationSeen: z.string().describe("The single most decision-relevant observation made"),
  interpretation: z.string().describe("What that observation means for the thesis"),
  signalCategory: z.enum([
    "demand_signal", "supply_signal", "accounting_red_flag", "valuation_gap", "catalyst",
    "competitive_threat", "management_credibility", "liquidity_constraint", "thesis_support",
    "thesis_contradiction", "noise",
  ]),
  confidenceChange: z.number().min(-1).max(1).describe("How much this agent's work should move conviction in the bull thesis, -1 to 1"),
  nextAction: z.string().describe("The single highest-value next research action"),
  reasoningPattern: z.string().describe("The generalizable rule, e.g. 'When inventory diverges from revenue, validate demand quality before trusting the growth story'"),
});
export type Trace = z.infer<typeof traceSchema>;

const claimSchema = z.object({
  text: z.string(),
  kind: z.enum(["fact", "inference", "opinion", "model_assumption", "unverified"]),
  supports: z.enum(["bull", "bear", "neutral"]),
  confidence: z.number().min(0).max(1),
  source: z.string().describe("Vault source title if grounded in provided excerpts, otherwise where this would be verified"),
  sourceType: z.enum(["filing", "transcript", "pricing_data", "analyst_note", "competitor", "news"]),
});

// ---------- Dossier + Thesis Agent ----------
export const dossierSchema = z.object({
  name: z.string(),
  sector: z.string().describe("Formatted like 'Semiconductors — Specialty Foundry'"),
  marketCapEstimate: z.string().describe("Approximate, e.g. '~$5.8B'. May be stale."),
  liquidityNote: z.string(),
  businessSummary: z.string().describe("2-3 sentence cold institutional summary"),
  bullThesis: z.object({
    oneLiner: z.string().describe("'The market prices X as ... while ...'"),
    variantPerception: z.string(),
    whyMarketWrong: z.string(),
    whyNow: z.string(),
    whatMustHappen: z.array(z.string()).min(2).max(4),
  }),
  claims: z.array(claimSchema).min(4).max(8),
  trace: traceSchema,
});
export type DossierResult = z.infer<typeof dossierSchema>;

// ---------- Accounting Agent ----------
export const accountingSchema = z.object({
  redFlags: z.array(z.object({
    issue: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    evidence: z.string().describe("What supports this concern, citing Vault sources when available"),
  })).max(6).describe("Dilution, revenue quality, working capital, adjusted-EBITDA games, customer concentration, aggressive capitalization. Empty if genuinely clean."),
  revenueQuality: z.string(),
  dilutionRisk: z.string(),
  balanceSheetStress: z.string(),
  overallAssessment: z.string().describe("2-3 sentences, cold"),
  claims: z.array(claimSchema).min(1).max(4),
  trace: traceSchema,
});
export type AccountingResult = z.infer<typeof accountingSchema>;

// ---------- Industry Agent ----------
export const industrySchema = z.object({
  technicalReality: z.string().describe("Does the technology actually matter, or is management just saying 'AI' on calls?"),
  competitivePosition: z.string(),
  supplyChainPosition: z.string().describe("Where this company sits in the chain; who has the leverage"),
  endMarketDemand: z.string(),
  aiExposureReal: z.boolean().describe("Is the AI/infrastructure exposure structurally real?"),
  overallAssessment: z.string(),
  claims: z.array(claimSchema).min(1).max(4),
  trace: traceSchema,
});
export type IndustryResult = z.infer<typeof industrySchema>;

// ---------- Catalyst Agent ----------
export const catalystSchema = z.object({
  catalysts: z.array(z.object({
    title: z.string(),
    kind: z.enum(["earnings", "product", "regulatory", "contract", "macro", "index", "guidance"]),
    expectedDate: z.string().describe("ISO date if known, otherwise fuzzy like 'Q3 2026'"),
    impact: z.string().describe("What this could change about market perception"),
    probability: z.number().min(0).max(1),
  })).min(1).max(5),
  noCatalystRisk: z.string().describe("If no catalyst materializes, how long can this stay cheap? No catalyst, no urgency."),
  trace: traceSchema,
});
export type CatalystResult = z.infer<typeof catalystSchema>;

// ---------- Valuation Agent ----------
export const valuationSchema = z.object({
  bear: z.object({ value: z.string(), logic: z.string() }),
  base: z.object({ value: z.string(), logic: z.string() }),
  bull: z.object({ value: z.string(), logic: z.string() }),
  keyAssumptions: z.array(z.string()).min(2).max(5).describe("The assumptions that actually drive the spread"),
  asymmetryAssessment: z.string().describe("Upside vs downside from here; is the asymmetry investable?"),
  trace: traceSchema,
});
export type ValuationResult = z.infer<typeof valuationSchema>;

// ---------- Strix ----------
export const strixSchema = z.object({
  bearCase: z.string().describe("The strongest version of why this idea is garbage. How Noctua loses money."),
  strongestDissent: z.string().describe("The single best argument against the trade, sharp and specific"),
  accountingConcerns: z.array(z.string()).max(4),
  technicalRealityCheck: z.string(),
  liquidityReview: z.string(),
  killCriteria: z.array(z.string()).min(2).max(4).describe("Concrete, observable conditions that force exit"),
  bearClaims: z.array(claimSchema.omit({ supports: true })).min(2).max(5),
  trace: traceSchema,
});
export type StrixResult = z.infer<typeof strixSchema>;

// ---------- Evidence Auditor ----------
export const auditorSchema = z.object({
  audits: z.array(z.object({
    claim: z.string().describe("The claim text being audited, verbatim or near-verbatim"),
    verdict: z.enum(["supported", "partially_supported", "unsupported", "contradicted"]),
    note: z.string().describe("Why — citing Vault excerpts when they exist"),
    adjustedKind: z.enum(["fact", "inference", "opinion", "model_assumption", "unverified"]),
    adjustedConfidence: z.number().min(0).max(1),
  })).min(3),
  sourceQuality: z.string().describe("Overall assessment of the evidence base: how much rests on primary sources vs model memory?"),
  weakestLink: z.string().describe("The single claim the whole thesis most depends on but is least supported"),
  trace: traceSchema,
});
export type AuditorResult = z.infer<typeof auditorSchema>;

// ---------- IC synthesis ----------
export const synthesisSchema = z.object({
  score: z.object({
    thesisClarity: z.number().min(0).max(10),
    evidenceQuality: z.number().min(0).max(15),
    variantPerception: z.number().min(0).max(15),
    asymmetry: z.number().min(0).max(15),
    valuationGap: z.number().min(0).max(10),
    catalystStrength: z.number().min(0).max(10),
    managementQuality: z.number().min(0).max(5),
    balanceSheet: z.number().min(0).max(5),
    technicalEdge: z.number().min(0).max(10),
    liquidityRiskFit: z.number().min(0).max(5),
    rationale: z.string().describe("Explainable, in Noctua's internal language"),
  }),
  memo: z.object({
    proposedAction: z.string(),
    proposedSize: z.string(),
    recommendation: z.enum(["approve", "reject", "more_work"]),
    businessQuality: z.string(),
    industryContext: z.string(),
    positionSizing: z.string(),
    monitoringPlan: z.string(),
    finalRecommendation: z.string(),
  }),
  nextDiligenceSteps: z.array(z.string()).min(3).max(6),
  trace: traceSchema,
});
export type SynthesisResult = z.infer<typeof synthesisSchema>;

// ============ Agent runners ============

function withVault(prompt: string, vaultCtx: string): string {
  return vaultCtx ? `${vaultCtx}\n\n========\n\n${prompt}` : prompt;
}

export async function runDossierAgent(model: LanguageModel, ticker: string, vaultCtx: string, notes?: string) {
  const { object } = await generateObject({
    model,
    schema: dossierSchema,
    system: CONSTITUTION,
    prompt: withVault(
      `Athena has opened an investigation on ticker ${ticker}.${notes ? ` Analyst context: ${notes}` : ""}

Act as the Dossier Agent and Thesis Agent. Build the dossier and the cleanest possible bull case under the Noctua Constitution. Ground claims in Vault excerpts where provided. Produce your research trace.`,
      vaultCtx,
    ),
  });
  return object;
}

export async function runAccountingAgent(model: LanguageModel, ticker: string, dossier: DossierResult, vaultCtx: string) {
  const { object } = await generateObject({
    model,
    schema: accountingSchema,
    system: CONSTITUTION,
    prompt: withVault(
      `You are the Accounting Agent examining ${ticker} (${dossier.name}).

Bull thesis under review: "${dossier.bullThesis.oneLiner}"

Hunt for what would make this thesis a trap: dilution, revenue quality issues, working-capital divergence, adjusted-EBITDA games, customer concentration, aggressive capitalization, related-party noise. Use Vault excerpts as primary evidence when provided. If the books look clean, say so — false alarms waste committee time. Produce your research trace.`,
      vaultCtx,
    ),
  });
  return object;
}

export async function runIndustryAgent(model: LanguageModel, ticker: string, dossier: DossierResult, vaultCtx: string) {
  const { object } = await generateObject({
    model,
    schema: industrySchema,
    system: CONSTITUTION,
    prompt: withVault(
      `You are the Industry Agent examining ${ticker} (${dossier.name}), sector: ${dossier.sector}.

Bull thesis under review: "${dossier.bullThesis.oneLiner}"

Assess technical reality: supply chain position, who holds pricing leverage, competitive structure, end-market demand, and whether the AI/infrastructure exposure is structurally real or management marketing language. Produce your research trace.`,
      vaultCtx,
    ),
  });
  return object;
}

export async function runCatalystAgent(model: LanguageModel, ticker: string, dossier: DossierResult, vaultCtx: string) {
  const { object } = await generateObject({
    model,
    schema: catalystSchema,
    system: CONSTITUTION,
    prompt: withVault(
      `You are the Catalyst Agent examining ${ticker} (${dossier.name}).

Bull thesis under review: "${dossier.bullThesis.oneLiner}"
Why now (per Thesis Agent): "${dossier.bullThesis.whyNow}"

Map every event that could force the market to reprice this name: earnings, guidance, contracts, regulatory decisions, product launches, index inclusion, competitor earnings. Assign honest probabilities. Then state the no-catalyst risk plainly. Produce your research trace.`,
      vaultCtx,
    ),
  });
  return object;
}

export async function runValuationAgent(model: LanguageModel, ticker: string, dossier: DossierResult, vaultCtx: string) {
  const { object } = await generateObject({
    model,
    schema: valuationSchema,
    system: CONSTITUTION,
    prompt: withVault(
      `You are the Valuation Agent examining ${ticker} (${dossier.name}).

Bull thesis under review: "${dossier.bullThesis.oneLiner}"

Build bear / base / bull cases. State the value logic, not just numbers — what multiple on what earnings power, and why. Identify the 2-5 assumptions that actually drive the spread. Then assess asymmetry: is the downside defined? Mark valuation inputs honestly as model assumptions. Produce your research trace.`,
      vaultCtx,
    ),
  });
  return object;
}

export async function runStrix(
  model: LanguageModel,
  ticker: string,
  dossier: DossierResult,
  reports: { accounting: AccountingResult; industry: IndustryResult; catalyst: CatalystResult; valuation: ValuationResult },
  vaultCtx: string,
) {
  const { object } = await generateObject({
    model,
    schema: strixSchema,
    system: CONSTITUTION,
    prompt: withVault(
      `You are Strix, Noctua's adversarial bear agent. Your job is to kill bad ideas before the market does. You are more valuable than the bull agent: nobody needs software to get excited — they need software to stop them from being stupid.

The full agent bench has reported on ${ticker}:

BULL THESIS:
${JSON.stringify(dossier.bullThesis, null, 2)}

BULL CLAIMS:
${JSON.stringify(dossier.claims, null, 2)}

ACCOUNTING AGENT:
${JSON.stringify({ redFlags: reports.accounting.redFlags, overall: reports.accounting.overallAssessment }, null, 2)}

INDUSTRY AGENT:
${JSON.stringify({ technicalReality: reports.industry.technicalReality, aiExposureReal: reports.industry.aiExposureReal, overall: reports.industry.overallAssessment }, null, 2)}

CATALYST AGENT:
${JSON.stringify({ catalysts: reports.catalyst.catalysts, noCatalystRisk: reports.catalyst.noCatalystRisk }, null, 2)}

VALUATION AGENT:
${JSON.stringify({ bear: reports.valuation.bear, asymmetry: reports.valuation.asymmetryAssessment }, null, 2)}

Attack everything. Exploit every weakness the bench surfaced and find the ones it missed. Be specific, not generically cautious. If the thesis is genuinely strong, say where — but you must still produce the best available case against it. Produce your research trace.`,
      vaultCtx,
    ),
  });
  return object;
}

export async function runEvidenceAuditor(
  model: LanguageModel,
  ticker: string,
  allClaims: { text: string; kind: string; confidence: number; source: string }[],
  vaultCtx: string,
) {
  const { object } = await generateObject({
    model,
    schema: auditorSchema,
    system: CONSTITUTION,
    prompt: withVault(
      `You are the Evidence Auditor for the ${ticker} investigation. The standard is: no source, no claim.

Audit each claim below. A claim is "supported" ONLY if a provided Vault excerpt or unambiguous public fact backs it. Claims resting on model memory of time-sensitive data are at best "unsupported" → adjust kind to "unverified" and cut confidence. Identify the weakest link: the claim the thesis most depends on but is least supported.

CLAIMS TO AUDIT:
${JSON.stringify(allClaims, null, 2)}

Produce your research trace.`,
      vaultCtx,
    ),
  });
  return object;
}

export async function runSynthesis(
  model: LanguageModel,
  ticker: string,
  dossier: DossierResult,
  reports: {
    accounting: AccountingResult;
    industry: IndustryResult;
    catalyst: CatalystResult;
    valuation: ValuationResult;
    strix: StrixResult;
    auditor: AuditorResult;
    symposium?: {
      treeSummary: string;
      logicVerdict: string;
      weakestPremise: string;
      debateVerdict: string;
      debateConviction: number;
      crux: string;
    };
  },
) {
  const symposiumBlock = reports.symposium
    ? `
THE SYMPOSIUM:
Research tree findings:
${reports.symposium.treeSummary}

Logic audit: ${reports.symposium.logicVerdict} — weakest premise: ${reports.symposium.weakestPremise}
Debate verdict: ${reports.symposium.debateVerdict} (conviction ${(reports.symposium.debateConviction * 100).toFixed(0)}%)
Unresolved crux: ${reports.symposium.crux}

The debate verdict is the committee's strongest signal — your recommendation must engage with it. If you depart from it, justify why.
`
    : "";

  const { object } = await generateObject({
    model,
    schema: synthesisSchema,
    system: CONSTITUTION,
    prompt: `You are Athena, synthesizing the full-bench investigation on ${ticker} for the Investment Committee.

BULL THESIS: ${JSON.stringify(dossier.bullThesis, null, 2)}
${symposiumBlock}
ACCOUNTING: ${JSON.stringify({ redFlags: reports.accounting.redFlags, overall: reports.accounting.overallAssessment }, null, 2)}
INDUSTRY: ${JSON.stringify({ technicalReality: reports.industry.technicalReality, aiExposureReal: reports.industry.aiExposureReal, supplyChain: reports.industry.supplyChainPosition, overall: reports.industry.overallAssessment }, null, 2)}
CATALYSTS: ${JSON.stringify(reports.catalyst.catalysts, null, 2)}
VALUATION: ${JSON.stringify(reports.valuation, null, 2)}
STRIX DISSENT: ${JSON.stringify({ bearCase: reports.strix.bearCase, strongestDissent: reports.strix.strongestDissent, killCriteria: reports.strix.killCriteria }, null, 2)}
EVIDENCE AUDIT: ${JSON.stringify({ sourceQuality: reports.auditor.sourceQuality, weakestLink: reports.auditor.weakestLink, unsupportedCount: reports.auditor.audits.filter((a) => a.verdict === "unsupported" || a.verdict === "contradicted").length }, null, 2)}

Produce the Noctua Score (be stingy — most ideas land 40-74; 75+ requires genuine variant perception with a near-term catalyst; evidence quality must reflect the auditor's findings, not the bull agent's enthusiasm), the memo synthesis sections, and next diligence steps.

Recommendation discipline: "approve" only if the idea survives Strix with asymmetry intact AND the evidence audit holds; "more_work" is the default; "reject" if Constitution rejection criteria apply. Produce your research trace.`,
  });
  return object;
}
