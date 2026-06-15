// The Symposium — recursive research tree, Logic Auditor, and the Debate Chamber.
// Every question, answer, and debate turn is persisted and traced. Budgeted by design.
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { CONSTITUTION, type DossierResult, type Trace } from "@/lib/athena";
import { modelFor } from "@/lib/models";
import { generateObjectRetry, addUsage, emptyUsage, type RunUsage } from "@/lib/ai";
import { vaultContext } from "@/lib/vault";
import type { NameQuant } from "@/lib/quant";

/** Aggregated telemetry for a multi-call stage, grouped by the model that ran. */
export type StageRun = { agent: string; modelId: string; usage: RunUsage; latencyMs: number; calls: number };

const TREE_BUDGET = Number(process.env.NOCTUA_TREE_BUDGET ?? 6); // max question investigations per run
const MAX_DEPTH = Number(process.env.NOCTUA_TREE_MAX_DEPTH ?? 3);
const SPAWN_THRESHOLD = 0.6; // answers below this confidence may spawn children

export type Emit = (event: Record<string, unknown>) => void;

function quantBlock(quant: NameQuant | null): string {
  if (!quant) return "";
  return `QUANT GROUND TRUTH (computed from real price history and EDGAR fundamentals — treat as fact):
${JSON.stringify(quant, null, 2)}`;
}

// ---------- Recursive research tree ----------

const decomposeSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe("A load-bearing research question: if answered badly, the thesis dies"),
        whyItMatters: z.string(),
        specialty: z.enum(["industry", "accounting", "catalyst", "valuation", "quant", "general"]),
      }),
    )
    .min(3)
    .max(5),
});

const investigateSchema = z.object({
  answer: z.string().describe("Direct answer to the question, grounded in the provided material"),
  confidence: z.number().min(0).max(1).describe("Honest confidence in the answer given available evidence"),
  keyEvidence: z.array(z.string()).max(3).describe("The decisive evidence, citing Vault source titles when used"),
  implication: z.enum(["supports_thesis", "weakens_thesis", "neutral", "unresolved"]),
  childQuestions: z
    .array(z.string())
    .max(2)
    .describe("Deeper follow-up questions ONLY when confidence is low and a sharper question would resolve it; empty otherwise"),
});

export type TreeNode = {
  id: number;
  parentId: number | null;
  depth: number;
  question: string;
  specialty: string;
  answer: string | null;
  confidence: number | null;
  implication: string | null;
};

export async function runResearchTree(opts: {
  ticker: string;
  companyId: number | null;
  dossier: DossierResult;
  quant: NameQuant | null;
  vaultCtx: string;
  emit: Emit;
  saveTrace: (researcher: string, trace: Trace) => void;
}): Promise<{ nodes: TreeNode[]; summary: string; calls: number; modelId: string; usage: RunUsage; latencyMs: number }> {
  const { ticker, companyId, dossier, quant, vaultCtx, emit } = opts;
  const investigatorM = modelFor("investigator");
  let calls = 0;
  let usage = emptyUsage();
  let latencyMs = 0;

  // 1. Decompose the thesis into load-bearing questions
  const { object: decomposition, meta: decMeta } = await generateObjectRetry({
    model: investigatorM.model,
    modelId: investigatorM.modelId,
    schema: decomposeSchema,
    system: CONSTITUTION,
    prompt: `Athena is decomposing the ${ticker} thesis into its load-bearing research questions.

THESIS: ${JSON.stringify(dossier.bullThesis, null, 2)}

${quantBlock(quant)}

Identify the 3-5 questions on which this thesis actually stands or falls. Not background questions — the ones where a bad answer kills the trade. Route each to the right specialty.`,
  });
  calls++;
  usage = addUsage(usage, decMeta.usage);
  latencyMs += decMeta.latencyMs;

  const nodes: TreeNode[] = [];
  type QueueItem = { question: string; specialty: string; parentId: number | null; depth: number };
  const queue: QueueItem[] = decomposition.questions.map((q) => ({
    question: q.question,
    specialty: q.specialty,
    parentId: null,
    depth: 1,
  }));

  emit({
    stage: "tree",
    message: `Thesis decomposed into ${queue.length} load-bearing questions. Recursive investigation begins (budget: ${TREE_BUDGET}).`,
  });

  // 2. Investigate breadth-first with depth + budget caps
  while (queue.length > 0 && calls - 1 < TREE_BUDGET) {
    const item = queue.shift()!;

    const [row] = db
      .insert(tables.researchQuestions)
      .values({
        companyId,
        ticker,
        parentId: item.parentId,
        depth: item.depth,
        question: item.question,
        status: "pending",
        agent: item.specialty,
      })
      .returning()
      .all();

    // Question-specific vault retrieval sharpens grounding beyond the global context
    const localCtx = await vaultContext(ticker, [item.question], 3).catch(() => "");

    const { object: result, meta: invMeta } = await generateObjectRetry({
      model: investigatorM.model,
      modelId: investigatorM.modelId,
      schema: investigateSchema,
      system: CONSTITUTION,
      prompt: `${vaultCtx}\n\n${localCtx}\n\n========\n\nYou are a ${item.specialty} specialist investigating one question in the ${ticker} research tree (depth ${item.depth} of ${MAX_DEPTH}).

THESIS UNDER TEST: "${dossier.bullThesis.oneLiner}"

${quantBlock(quant)}

QUESTION: ${item.question}

Answer it as directly as the evidence allows. Be honest about confidence. Spawn child questions ONLY if your confidence is below ${SPAWN_THRESHOLD} AND a sharper, narrower question would genuinely resolve the uncertainty.`,
    });
    calls++;
    usage = addUsage(usage, invMeta.usage);
    latencyMs += invMeta.latencyMs;

    const willSpawn =
      result.confidence < SPAWN_THRESHOLD && result.childQuestions.length > 0 && item.depth < MAX_DEPTH;

    db.update(tables.researchQuestions)
      .set({
        status: willSpawn ? "spawned" : "answered",
        answer: result.answer,
        confidence: result.confidence,
      })
      .where(eq(tables.researchQuestions.id, row.id))
      .run();

    nodes.push({
      id: row.id,
      parentId: item.parentId,
      depth: item.depth,
      question: item.question,
      specialty: item.specialty,
      answer: result.answer,
      confidence: result.confidence,
      implication: result.implication,
    });

    opts.saveTrace(`Investigator(${item.specialty})`, {
      currentQuestion: item.question,
      actionTaken: `Depth-${item.depth} tree investigation, grounded in Vault + quant data`,
      informationSeen: result.keyEvidence[0] ?? result.answer.slice(0, 140),
      interpretation: result.answer.slice(0, 200),
      signalCategory:
        result.implication === "supports_thesis"
          ? "thesis_support"
          : result.implication === "weakens_thesis"
            ? "thesis_contradiction"
            : "noise",
      confidenceChange:
        result.implication === "supports_thesis"
          ? result.confidence * 0.2
          : result.implication === "weakens_thesis"
            ? -result.confidence * 0.2
            : 0,
      nextAction: willSpawn ? result.childQuestions[0] : "Feed into debate",
      reasoningPattern: "Recursive decomposition: answer the load-bearing question or spawn a sharper one.",
    });

    emit({
      stage: "tree",
      message: `D${item.depth} [${item.specialty}] ${item.question.slice(0, 90)}… → confidence ${(result.confidence * 100).toFixed(0)}%${willSpawn ? `, spawning ${result.childQuestions.length} deeper` : ""}`,
    });

    if (willSpawn) {
      for (const child of result.childQuestions) {
        queue.push({ question: child, specialty: item.specialty, parentId: row.id, depth: item.depth + 1 });
      }
    }
  }

  // Be honest when the budget cuts the investigation short rather than silently
  // dropping the remaining queue.
  if (queue.length > 0) {
    emit({
      stage: "tree",
      message: `Budget reached (${TREE_BUDGET} investigations). ${queue.length} deeper question(s) deferred to a future run.`,
    });
  }

  const summary = nodes
    .map(
      (n) =>
        `${"  ".repeat(n.depth - 1)}Q[${n.specialty}, conf ${((n.confidence ?? 0) * 100).toFixed(0)}%, ${n.implication}]: ${n.question}\n${"  ".repeat(n.depth - 1)}A: ${n.answer}`,
    )
    .join("\n");

  return { nodes, summary, calls, modelId: investigatorM.modelId, usage, latencyMs };
}

// ---------- Logic Auditor ----------

export const logicAuditSchema = z.object({
  premises: z
    .array(
      z.object({
        premise: z.string(),
        supported: z.boolean().describe("Is this premise actually supported by the research tree / evidence?"),
        support: z.string().describe("What supports it, or what is missing"),
      }),
    )
    .min(2)
    .max(6),
  inferenceChain: z.string().describe("The thesis restated as: premises → inference → conclusion"),
  nonSequiturs: z.array(z.string()).max(4).describe("Steps where the conclusion does not follow. Empty if the logic holds."),
  weakestPremise: z.string(),
  scienceCheck: z.string().describe("Does the technical/physical/economic mechanism actually work the way the thesis requires?"),
  verdict: z.enum(["sound", "shaky", "broken"]),
});
export type LogicAudit = z.infer<typeof logicAuditSchema>;

export async function runLogicAuditor(opts: {
  ticker: string;
  dossier: DossierResult;
  treeSummary: string;
  quant: NameQuant | null;
}): Promise<{ audit: LogicAudit; modelId: string; usage: RunUsage; latencyMs: number }> {
  const m = modelFor("logic");
  const { object, meta } = await generateObjectRetry({
    model: m.model,
    modelId: m.modelId,
    schema: logicAuditSchema,
    system: CONSTITUTION,
    prompt: `You are the Logic Auditor. Your job is formal rigor: formalize the ${opts.ticker} thesis as premises → inference → conclusion and stress-test the logic and the science. You do not care about the story; you care whether the argument is valid and the mechanism physically and economically real.

THESIS: ${JSON.stringify(opts.dossier.bullThesis, null, 2)}

RESEARCH TREE FINDINGS:
${opts.treeSummary}

${quantBlock(opts.quant)}

Identify every premise the conclusion depends on, check each against the tree findings, flag non-sequiturs, and name the weakest premise. "Sound" requires every load-bearing premise supported AND a valid inference chain.`,
  });
  return { audit: object, modelId: m.modelId, usage: meta.usage, latencyMs: meta.latencyMs };
}

// ---------- The Debate Chamber ----------

const SEATS = ["advocate", "strix", "quant"] as const;
export type Seat = (typeof SEATS)[number];

const seatAgent: Record<Seat, "dossier" | "strix" | "valuation"> = {
  advocate: "dossier",
  strix: "strix",
  quant: "valuation",
};

const seatBrief: Record<Seat, string> = {
  advocate:
    "You are the Advocate — the strongest fundamental bull. Argue from the thesis, the research tree, and the evidence. You are not a cheerleader: concede weak points and rebuild the case on what survives.",
  strix:
    "You are Strix — the bear. Your job is to kill this idea before the market does. Attack the thesis, the evidence quality, the logic audit's weakest premise, and the quant reality. Be specific, not generically cautious.",
  quant:
    "You are The Quant. You argue ONLY from the quant ground truth provided (volatility, beta, momentum, valuation ratios, correlations, liquidity) and the math of asymmetry. If the numbers contradict the narrative, say so. If they support it, quantify it. Never invent a number.",
};

const turnSchema = z.object({
  argument: z.string().describe("The argument for this round. Dense, specific, 80-200 words. No preamble."),
  strongestOpposingPoint: z.string().describe("The single best point made against your position so far (or expected)"),
  probabilityBullCaseWorks: z.number().min(0).max(1),
});

const verdictSchema = z.object({
  verdict: z.enum(["pursue", "watchlist", "reject"]),
  conviction: z.number().min(0).max(1).describe("Conviction-weighted confidence in the verdict"),
  reasoning: z.string().describe("How the debate resolved: who carried which point, 100-200 words"),
  crux: z.string().describe("The single unresolved disagreement that matters most"),
  resolvingEvidence: z.string().describe("The specific, obtainable evidence that would resolve the crux"),
  probabilityBullCaseWorks: z.number().min(0).max(1),
});
export type DebateVerdict = z.infer<typeof verdictSchema>;

export async function runDebate(opts: {
  ticker: string;
  companyId: number | null;
  dossier: DossierResult;
  treeSummary: string;
  logicAudit: LogicAudit | null;
  quant: NameQuant | null;
  emit: Emit;
}): Promise<{ debateId: number; verdict: DebateVerdict; runs: StageRun[] }> {
  const { ticker, companyId, dossier, treeSummary, logicAudit, quant, emit } = opts;

  const [debate] = db
    .insert(tables.debates)
    .values({ companyId, ticker, status: "running" })
    .returning()
    .all();

  // Accumulate token/latency telemetry per model — the debate spans 4 models,
  // so attributing cost to a single one would be misleading.
  const runsByModel = new Map<string, StageRun>();
  const accrue = (modelId: string, usage: RunUsage, latencyMs: number) => {
    const prev = runsByModel.get(modelId);
    if (prev) {
      prev.usage = addUsage(prev.usage, usage);
      prev.latencyMs += latencyMs;
      prev.calls += 1;
    } else {
      runsByModel.set(modelId, { agent: "debate", modelId, usage, latencyMs, calls: 1 });
    }
  };

  let turnIdx = 0;
  const saveTurn = (round: string, seat: string, content: string, modelId: string) => {
    db.insert(tables.debateTurns)
      .values({ debateId: debate.id, round, seat, content, modelId, idx: turnIdx++ })
      .run();
  };

  const dossierBlock = `TICKER: ${ticker}
THESIS: ${JSON.stringify(dossier.bullThesis, null, 2)}

RESEARCH TREE FINDINGS:
${treeSummary}

LOGIC AUDIT: ${logicAudit ? JSON.stringify({ verdict: logicAudit.verdict, weakestPremise: logicAudit.weakestPremise, nonSequiturs: logicAudit.nonSequiturs }, null, 2) : "unavailable"}

${quantBlock(quant)}`;

  const transcript: { round: string; seat: string; argument: string }[] = [];
  const transcriptBlock = () =>
    transcript.map((t) => `[${t.round.toUpperCase()} — ${t.seat.toUpperCase()}]\n${t.argument}`).join("\n\n");

  async function seatTurn(seat: Seat, round: string, instruction: string) {
    const m = modelFor(seatAgent[seat]);
    const { object, meta } = await generateObjectRetry({
      model: m.model,
      modelId: m.modelId,
      schema: turnSchema,
      system: `${CONSTITUTION}\n\n${seatBrief[seat]}`,
      prompt: `${dossierBlock}\n\nDEBATE SO FAR:\n${transcriptBlock() || "(none — this is the opening round)"}\n\n${instruction}`,
    });
    accrue(m.modelId, meta.usage, meta.latencyMs);
    transcript.push({ round, seat, argument: object.argument });
    saveTurn(round, seat, JSON.stringify(object), m.modelId);
    return object;
  }

  // Round 1 — openings (parallel)
  emit({ stage: "debate", message: "The Chamber convenes: Advocate, Strix, and The Quant take their seats." });
  await Promise.all(
    SEATS.map((s) => seatTurn(s, "opening", "Deliver your opening statement on whether Noctua should pursue this trade.")),
  );
  emit({ stage: "debate", message: "Openings delivered. Rebuttal round — each seat must address the strongest opposing point." });

  // Round 2 — rebuttals (parallel, each sees all openings)
  await Promise.all(
    SEATS.map((s) =>
      seatTurn(
        s,
        "rebuttal",
        "Rebut. You MUST directly address the strongest point made against your position — name it, then dismantle or concede it.",
      ),
    ),
  );

  // Round 3 — cross-examination: moderator poses the crux question
  const moderatorM = modelFor("synthesis");
  const cruxQ = await generateObjectRetry({
    model: moderatorM.model,
    modelId: moderatorM.modelId,
    schema: z.object({ cruxQuestion: z.string().describe("The single question whose answer decides this debate") }),
    system: `${CONSTITUTION}\n\nYou are Athena, moderating the Investment Committee debate.`,
    prompt: `${dossierBlock}\n\nDEBATE SO FAR:\n${transcriptBlock()}\n\nIdentify the crux: the single question whose answer decides this debate. Pose it to all three seats.`,
  });
  accrue(moderatorM.modelId, cruxQ.meta.usage, cruxQ.meta.latencyMs);
  saveTurn("cross", "moderator", JSON.stringify(cruxQ.object), moderatorM.modelId);
  emit({ stage: "debate", message: `Cross-examination. Athena poses the crux: "${cruxQ.object.cruxQuestion.slice(0, 140)}"` });

  await Promise.all(
    SEATS.map((s) =>
      seatTurn(s, "cross", `Answer the moderator's crux question directly: "${cruxQ.object.cruxQuestion}"`),
    ),
  );

  // Round 4 — final positions with explicit probabilities
  const finals = await Promise.all(
    SEATS.map((s) =>
      seatTurn(
        s,
        "final",
        "Final position. State your recommendation (pursue / watchlist / reject) and your explicit probability that the bull case plays out over the thesis horizon.",
      ),
    ),
  );
  emit({
    stage: "debate",
    message: `Final positions: P(bull) — Advocate ${(finals[0].probabilityBullCaseWorks * 100).toFixed(0)}%, Strix ${(finals[1].probabilityBullCaseWorks * 100).toFixed(0)}%, Quant ${(finals[2].probabilityBullCaseWorks * 100).toFixed(0)}%.`,
  });

  // Verdict
  const { object: verdict, meta: verdictMeta } = await generateObjectRetry({
    model: moderatorM.model,
    modelId: moderatorM.modelId,
    schema: verdictSchema,
    system: `${CONSTITUTION}\n\nYou are Athena, moderating. Weigh arguments by evidence quality, not eloquence. Strix being wrong must be demonstrated, not asserted.`,
    prompt: `${dossierBlock}\n\nFULL DEBATE TRANSCRIPT:\n${transcriptBlock()}\n\nDeliver the verdict: pursue / watchlist / reject, your conviction, how the debate resolved, the remaining crux, and the specific obtainable evidence that would resolve it.`,
  });
  accrue(moderatorM.modelId, verdictMeta.usage, verdictMeta.latencyMs);
  saveTurn("verdict", "moderator", JSON.stringify(verdict), moderatorM.modelId);

  db.update(tables.debates)
    .set({
      verdict: verdict.verdict,
      conviction: verdict.conviction,
      crux: verdict.crux,
      resolvingEvidence: verdict.resolvingEvidence,
      status: "done",
    })
    .where(eq(tables.debates.id, debate.id))
    .run();

  // The crux's resolving evidence becomes a pending research question
  db.insert(tables.researchQuestions)
    .values({
      companyId,
      ticker,
      parentId: null,
      depth: 1,
      question: `[CRUX] ${verdict.crux} — resolve via: ${verdict.resolvingEvidence}`,
      status: "pending",
      agent: "general",
    })
    .run();

  emit({
    stage: "debate",
    message: `Verdict: ${verdict.verdict.toUpperCase()} (conviction ${(verdict.conviction * 100).toFixed(0)}%). Crux logged as a pending research question.`,
  });

  return { debateId: debate.id, verdict, runs: [...runsByModel.values()] };
}
