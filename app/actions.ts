"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, tables } from "@/db";
import { fetchChain } from "@/lib/signals";
import { getPortfolio } from "@/lib/quant";
import { getQuote } from "@/lib/market";
import { blackScholes } from "@/lib/options/bs";

export async function resolveAlert(alertId: number) {
  await db.update(tables.alerts).set({ resolved: true }).where(eq(tables.alerts.id, alertId));
  revalidatePath("/");
}

export async function updateCompanyStatus(companyId: number, status: string) {
  if (!["pipeline", "watchlist", "active", "rejected", "exited"].includes(status)) return;
  await db.update(tables.companies)
    .set({ status, updatedAt: new Date() })
    .where(eq(tables.companies.id, companyId));
  revalidatePath("/dossiers");
  revalidatePath("/");
}

export async function updateThesisStatus(companyId: number, thesisStatus: string) {
  if (!["strengthening", "stable", "weakening", "broken"].includes(thesisStatus)) return;
  await db.update(tables.companies)
    .set({ thesisStatus, updatedAt: new Date() })
    .where(eq(tables.companies.id, companyId));

  // A broken thesis must surface at the top of The Perch.
  if (thesisStatus === "broken") {
    const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, companyId) });
    if (company) {
      await db.insert(tables.alerts)
        .values({
          companyId,
          ticker: company.ticker,
          severity: 1,
          kind: "thesis_break",
          message: `Thesis marked BROKEN by analyst. Kill criteria review required for ${company.ticker}.`,
          suggestedAction: "Convene IC. Exit per kill criteria or re-underwrite with a new thesis version.",
        });
    }
  }
  revalidatePath("/dossiers");
  revalidatePath("/");
}

export async function decideMemo(memoId: number, decision: "approve" | "reject" | "more_work", decidedBy: string) {
  const memo = await db.query.memos.findFirst({ where: eq(tables.memos.id, memoId) });
  if (!memo) return;
  const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, memo.companyId) });

  await db.update(tables.memos)
    .set({ recommendation: decision, decidedBy, decidedAt: new Date() })
    .where(eq(tables.memos.id, memoId));

  const newStatus = decision === "approve" ? "active" : decision === "reject" ? "rejected" : company?.status;
  if (company && newStatus && newStatus !== company.status) {
    await db.update(tables.companies)
      .set({
        status: newStatus,
        updatedAt: new Date(),
        rejectionReason:
          decision === "reject"
            ? `Rejected by IC (${decidedBy}, ${new Date().toISOString().slice(0, 10)}) — memo v${memo.version}.`
            : company.rejectionReason,
      })
      .where(eq(tables.companies.id, company.id));
  }

  // Decision becomes part of the record: alert + trace.
  if (company) {
    const verb = decision === "approve" ? "APPROVED" : decision === "reject" ? "REJECTED" : "sent back for MORE WORK";
    await db.insert(tables.alerts)
      .values({
        companyId: company.id,
        ticker: company.ticker,
        severity: decision === "approve" ? 2 : 3,
        kind: "ic_decision",
        message: `IC decision: ${company.ticker} memo v${memo.version} ${verb} by ${decidedBy}.`,
        suggestedAction:
          decision === "approve"
            ? "Open position per sizing in memo. Activate monitoring plan and kill criteria."
            : decision === "reject"
              ? "Rejection reason recorded. Night Vision will watch for the blocker to clear."
              : "Assign next diligence steps from the memo to an analyst.",
      });
    await db.insert(tables.traces)
      .values({
        researcher: decidedBy,
        ticker: company.ticker,
        companyId: company.id,
        currentQuestion: `Should Noctua act on ${company.ticker} memo v${memo.version}?`,
        actionTaken: `IC decision: ${verb}`,
        sourceType: "ic_decision",
        informationSeen: `Memo v${memo.version} (${memo.proposedAction ?? "no action"}; ${memo.proposedSize ?? "no size"})`,
        interpretation: `Human committee ${verb.toLowerCase()} the draft recommendation`,
        signalCategory: decision === "reject" ? "thesis_contradiction" : "thesis_support",
        confidenceChange: decision === "approve" ? 0.2 : decision === "reject" ? -0.4 : 0,
        nextAction:
          decision === "approve" ? "Create position file and monitoring checklist" : "Track next diligence steps",
        reasoningPattern: "Every IC decision is logged with who decided and why — outcomes attach later.",
      });
  }

  revalidatePath(`/ic/${memoId}`);
  revalidatePath("/ic");
  revalidatePath("/dossiers");
  revalidatePath("/");
}

// --- Talons — positions ------------------------------------------------------

export async function openPosition(input: {
  companyId: number;
  memoId?: number | null;
  entryPrice: number;
  sizePct: number;
  owner: string;
}) {
  const { companyId, memoId, entryPrice, sizePct, owner } = input;
  if (!companyId || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(sizePct) || sizePct <= 0)
    return;

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, companyId) });
  if (!company) return;

  // Kill criteria are snapshotted at entry — the exit contract cannot drift with later thesis edits.
  const thesis = await db.query.theses.findFirst({
    where: eq(tables.theses.companyId, companyId),
    orderBy: desc(tables.theses.version),
  });

  const today = new Date().toISOString().slice(0, 10);
  await db.insert(tables.positions)
    .values({
      companyId,
      memoId: memoId ?? null,
      ticker: company.ticker,
      entryPrice,
      entryDate: today,
      sizePct,
      status: "open",
      killCriteria: thesis?.killCriteria ?? null,
      owner: owner.trim() || "Unassigned",
    });

  if (company.status !== "active") {
    await db.update(tables.companies)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(tables.companies.id, companyId));
  }

  await db.insert(tables.alerts)
    .values({
      companyId,
      ticker: company.ticker,
      severity: 2,
      kind: "position",
      message: `Position opened: ${company.ticker} ${sizePct.toFixed(1)}% of NAV at $${entryPrice.toFixed(2)} (${owner.trim() || "Unassigned"}).`,
      suggestedAction: "Kill criteria snapshotted at entry. Night Vision monitors from here — review on every alert.",
    });

  await db.insert(tables.traces)
    .values({
      researcher: owner.trim() || "Unassigned",
      ticker: company.ticker,
      companyId,
      currentQuestion: `At what price and size does Noctua enter ${company.ticker}?`,
      actionTaken: `Opened position: ${sizePct.toFixed(1)}% of NAV at $${entryPrice.toFixed(2)}${memoId ? ` per memo #${memoId}` : " (manual entry)"}`,
      sourceType: "position",
      informationSeen: `Live quote at entry $${entryPrice.toFixed(2)}; kill criteria snapshot ${thesis?.killCriteria ? "attached" : "absent — no thesis on record"}`,
      interpretation: "Capital committed. The thesis is now falsifiable with money at risk.",
      signalCategory: "thesis_support",
      confidenceChange: 0,
      nextAction: "Monitor kill criteria and catalysts; close requires an After-Action postmortem",
      reasoningPattern: "Entry terms recorded at the moment of commitment — outcome attaches at close.",
    });

  revalidatePath("/talons");
  revalidatePath(`/dossiers/${company.ticker}`);
  revalidatePath("/dossiers");
  revalidatePath("/");
  if (memoId) revalidatePath(`/ic/${memoId}`);
}

export async function closePosition(positionId: number, exitPrice: number, exitDate?: string) {
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return;
  const position = await db.query.positions.findFirst({ where: eq(tables.positions.id, positionId) });
  if (!position || position.status === "closed") return;

  const date = exitDate?.trim() || new Date().toISOString().slice(0, 10);
  await db.update(tables.positions)
    .set({ status: "closed", exitPrice, exitDate: date })
    .where(eq(tables.positions.id, positionId));

  const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  await db.insert(tables.alerts)
    .values({
      companyId: position.companyId,
      ticker: position.ticker,
      severity: 2,
      kind: "position",
      message: `Position closed: ${position.ticker} at $${exitPrice.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% vs entry). After-Action postmortem required.`,
      suggestedAction: "File the postmortem while the reasoning is fresh. Unexamined exits teach nothing.",
    });

  revalidatePath("/talons");
  revalidatePath(`/dossiers/${position.ticker}`);
  revalidatePath("/");
}

// --- Learning loop -----------------------------------------------------------

const PM_OUTCOMES = ["win", "loss", "scratch"];
const PM_THESIS = ["right", "wrong", "right_for_wrong_reason"];

export async function createPostmortem(formData: FormData) {
  const companyId = Number(formData.get("companyId"));
  const outcome = String(formData.get("outcome") ?? "");
  const thesisRight = String(formData.get("thesisRight") ?? "");
  const narrative = String(formData.get("narrative") ?? "").trim();
  if (!companyId || !PM_OUTCOMES.includes(outcome) || !PM_THESIS.includes(thesisRight) || narrative.length < 10)
    return;

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, companyId) });
  if (!company) return;

  const positionIdRaw = Number(formData.get("positionId"));
  const lessons = String(formData.get("lessons") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  await db.insert(tables.postmortems)
    .values({
      positionId: Number.isFinite(positionIdRaw) && positionIdRaw > 0 ? positionIdRaw : null,
      companyId,
      ticker: company.ticker,
      outcome,
      thesisRight,
      timingRight: formData.get("timingRight") === "true",
      sizingRight: formData.get("sizingRight") === "true",
      narrative,
      lessons: JSON.stringify(lessons),
      createdBy: String(formData.get("createdBy") ?? "").trim() || "Unnamed analyst",
    });

  // Outcome flows back into the ledger: every unresolved trace on this name gets stamped.
  await db.update(tables.traces)
    .set({ outcome })
    .where(and(eq(tables.traces.ticker, company.ticker), isNull(tables.traces.outcome)));

  revalidatePath("/talons");
  revalidatePath("/ledger");
  revalidatePath(`/dossiers/${company.ticker}`);
}

const TRACE_LABELS = ["strong_signal", "weak_signal", "false_positive", "noise"];

export async function resizePosition(positionId: number, newSizePct: number, actor: string) {
  if (!Number.isFinite(newSizePct) || newSizePct <= 0 || newSizePct > 100) return;
  const position = await db.query.positions.findFirst({ where: eq(tables.positions.id, positionId) });
  if (!position || position.status !== "open") return;

  const oldSize = position.sizePct;
  await db.update(tables.positions).set({ sizePct: newSizePct }).where(eq(tables.positions.id, positionId));

  await db.insert(tables.traces)
    .values({
      researcher: actor,
      ticker: position.ticker,
      companyId: position.companyId,
      currentQuestion: `Is ${position.ticker} sized correctly at ${oldSize.toFixed(1)}%?`,
      actionTaken: `Resized ${position.ticker}: ${oldSize.toFixed(1)}% → ${newSizePct.toFixed(1)}% of NAV`,
      sourceType: "position_management",
      informationSeen: `War Room ${newSizePct > oldSize ? "add" : "trim"} executed`,
      interpretation: newSizePct > oldSize ? "Conviction or headroom increased" : "Risk reduced or mandate respected",
      signalCategory: "liquidity_constraint",
      confidenceChange: 0,
      nextAction: "Monitor against kill criteria at the new size",
      reasoningPattern: "Sizing changes are decisions: logged, attributed, and reviewable like any other.",
    });

  revalidatePath("/war-room");
  revalidatePath("/talons");
  revalidatePath("/");
}

export async function updatePortfolioNav(nav: number, cash: number | null) {
  if (!Number.isFinite(nav) || nav <= 0) return;
  const rows = await db.select().from(tables.portfolio).limit(1);
  if (rows[0]) {
    await db.update(tables.portfolio)
      .set({ nav, cash, updatedAt: new Date() })
      .where(eq(tables.portfolio.id, rows[0].id));
  } else {
    await db.insert(tables.portfolio).values({ nav, cash });
  }
  revalidatePath("/war-room");
  revalidatePath("/talons");
}

export async function labelTrace(traceId: number, label: string | null) {
  if (label !== null && !TRACE_LABELS.includes(label)) return;
  await db.update(tables.traces).set({ label }).where(eq(tables.traces.id, traceId));
  revalidatePath("/ledger");
}

export async function addClaim(formData: FormData) {
  const companyId = Number(formData.get("companyId"));
  const text = String(formData.get("text") ?? "").trim();
  const source = String(formData.get("source") ?? "").trim();
  if (!companyId || text.length < 10 || source.length < 3) return;

  await db.insert(tables.claims)
    .values({
      companyId,
      text,
      kind: String(formData.get("kind") ?? "unverified"),
      supports: String(formData.get("supports") ?? "neutral"),
      confidence: Math.max(0, Math.min(1, Number(formData.get("confidence") ?? 0.5))),
      source,
      sourceType: String(formData.get("sourceType") ?? "analyst_note"),
    });

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, companyId) });
  if (company) revalidatePath(`/dossiers/${company.ticker}`);
}

// --- Derivatives Desk — option structures -----------------------------------

export type OpenStructureInput = {
  ticker: string;
  companyId?: number | null;
  memoId?: number | null;
  directiveId?: number | null;
  strategy: string;
  direction?: string | null;
  expiry?: string | null;
  legs: { right: string; action: string; strike: number; expiry: string; qty: number; mid: number | null }[];
  netDebit?: number | null;
  maxLoss?: number | null;
  maxGain?: number | null;
  breakevens?: number[];
  pop?: number | null;
  evPct?: number | null;
  greeks?: { delta: number; gamma: number; vega: number; theta: number } | null;
  entryUnderlying?: number | null;
  rationale?: string | null;
  bindingConstraint?: string | null;
  qty: number;
  owner: string;
};

/**
 * Open an options structure on the paper book. Enriches each leg's entry mark
 * and greeks from the live chain (Black-Scholes theta), snapshots max loss and
 * capital-at-risk, and logs the commitment as an alert + trace — the same
 * discipline as opening an equity position.
 */
export async function openOptionStructure(input: OpenStructureInput) {
  const t = input.ticker?.toUpperCase();
  if (!t || !Number.isFinite(input.qty) || input.qty <= 0 || !input.legs?.length) return;

  const company = input.companyId
    ? await db.query.companies.findFirst({ where: eq(tables.companies.id, input.companyId) })
    : await db.query.companies.findFirst({ where: eq(tables.companies.ticker, t) });

  const [portfolio, chain] = await Promise.all([getPortfolio(), fetchChain(t).catch(() => null)]);
  const underlying = chain?.spot ?? input.entryUnderlying ?? (await getQuote(t).catch(() => null))?.price ?? null;
  const asOf = chain?.asOf ?? new Date().toISOString();
  const refMs = Date.parse(asOf) || Date.now();

  const capitalAtRisk = (input.maxLoss ?? 0) * input.qty;
  const capitalAtRiskPct = portfolio.nav > 0 ? (capitalAtRisk / portfolio.nav) * 100 : null;

  const [structure] = await db
    .insert(tables.optionStructures)
    .values({
      companyId: company?.id ?? null,
      ticker: t,
      memoId: input.memoId ?? null,
      directiveId: input.directiveId ?? null,
      strategy: input.strategy,
      direction: input.direction ?? null,
      status: "open",
      qty: input.qty,
      netDebit: input.netDebit ?? null,
      maxLoss: input.maxLoss ?? null,
      maxGain: input.maxGain ?? null,
      breakevens: JSON.stringify(input.breakevens ?? []),
      pop: input.pop ?? null,
      evPct: input.evPct ?? null,
      capitalAtRiskPct,
      entryGreeks: input.greeks ? JSON.stringify(input.greeks) : null,
      entryUnderlying: underlying,
      expiry: input.expiry ?? null,
      rationale: input.rationale ?? null,
      bindingConstraint: input.bindingConstraint ?? null,
      createdBy: input.owner.trim() || "Unassigned",
    })
    .returning();

  for (const leg of input.legs) {
    const right = leg.right === "P" ? "P" : "C";
    const found =
      chain?.contracts.find((c) => c.type === right && c.strike === leg.strike && c.expiry === leg.expiry) ?? null;
    const years = Math.max((Date.parse(`${leg.expiry.slice(0, 10)}T21:00:00Z`) - refMs) / (365 * 86_400_000), 1 / 365);
    const iv = found?.iv ?? null;
    const bs = iv != null && iv > 0 && underlying != null ? blackScholes(right, underlying, leg.strike, iv, years) : null;
    await db.insert(tables.optionLegs).values({
      structureId: structure.id,
      right,
      action: leg.action === "short" ? "short" : "long",
      strike: leg.strike,
      expiry: leg.expiry,
      qty: leg.qty,
      entryMid: leg.mid ?? found?.mid ?? null,
      entryIv: iv,
      entryDelta: found?.delta ?? bs?.delta ?? null,
      entryGamma: found?.gamma ?? bs?.gamma ?? null,
      entryVega: found?.vega ?? bs?.vega ?? null,
      entryTheta: bs?.theta ?? null,
    });
  }

  await db.insert(tables.alerts).values({
    companyId: company?.id ?? null,
    ticker: t,
    severity: 2,
    kind: "position",
    message: `Options structure opened: ${input.qty}× ${input.strategy.replace(/_/g, " ")} on ${t} — max loss $${Math.round(capitalAtRisk).toLocaleString()} (${(capitalAtRiskPct ?? 0).toFixed(1)}% of NAV).`,
    suggestedAction: "Night Vision monitors DTE, breakeven, assignment, and vega from here. Close requires an After-Action review.",
  });

  await db.insert(tables.traces).values({
    researcher: input.owner.trim() || "Unassigned",
    ticker: t,
    companyId: company?.id ?? null,
    currentQuestion: `How should Noctua express the ${t} thesis in the options market?`,
    actionTaken: `Opened ${input.qty}× ${input.strategy.replace(/_/g, " ")} (${input.direction ?? "—"}), defined risk $${Math.round(capitalAtRisk).toLocaleString()}`,
    sourceType: "options_structure",
    informationSeen: `${input.legs.length} legs, expiry ${input.expiry ?? "—"}, POP ${input.pop != null ? `${Math.round(input.pop * 100)}%` : "n/a"}, binding ${input.bindingConstraint ?? "—"}`,
    interpretation: input.rationale ?? "Defined-risk options expression of the equity thesis.",
    signalCategory: input.direction === "bearish" ? "thesis_contradiction" : "thesis_support",
    confidenceChange: 0,
    nextAction: "Manage to plan: roll/close at the DTE or profit target; review on any Night Vision alert.",
    reasoningPattern: "The options branch expresses the same edge at defined risk — sized by premium and vega budget, not share count.",
  });

  revalidatePath("/desk");
  revalidatePath("/war-room");
  revalidatePath("/");
  if (company) revalidatePath(`/dossiers/${t}`);
}

export async function closeOptionStructure(structureId: number, exitNetValuePerLot: number, exitUnderlying?: number | null) {
  if (!Number.isFinite(exitNetValuePerLot)) return;
  const s = await db.query.optionStructures.findFirst({ where: eq(tables.optionStructures.id, structureId) });
  if (!s || s.status === "closed") return;

  const realizedPnl = (exitNetValuePerLot - (s.netDebit ?? 0)) * s.qty;
  await db
    .update(tables.optionStructures)
    .set({
      status: "closed",
      exitNetValue: exitNetValuePerLot,
      exitUnderlying: exitUnderlying ?? null,
      realizedPnl,
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tables.optionStructures.id, structureId));

  await db.insert(tables.alerts).values({
    companyId: s.companyId,
    ticker: s.ticker,
    severity: 2,
    kind: "position",
    message: `Options structure closed: ${s.qty}× ${s.strategy.replace(/_/g, " ")} on ${s.ticker} — realized ${realizedPnl >= 0 ? "+" : ""}$${Math.round(realizedPnl).toLocaleString()}. After-Action review required.`,
    suggestedAction: "File the options postmortem: was the vol view right, did theta behave, would another structure have paid more.",
  });

  revalidatePath("/desk");
  revalidatePath("/war-room");
  revalidatePath("/");
}

const OPT_PM_OUTCOMES = ["win", "loss", "scratch"];
const OPT_PM_RIGHT = ["right", "wrong", "mixed"];

export async function createOptionPostmortem(formData: FormData) {
  const structureId = Number(formData.get("structureId"));
  const outcome = String(formData.get("outcome") ?? "");
  const volViewRight = String(formData.get("volViewRight") ?? "");
  const directionRight = String(formData.get("directionRight") ?? "");
  const narrative = String(formData.get("narrative") ?? "").trim();
  if (
    !Number.isFinite(structureId) ||
    !OPT_PM_OUTCOMES.includes(outcome) ||
    !OPT_PM_RIGHT.includes(volViewRight) ||
    !OPT_PM_RIGHT.includes(directionRight) ||
    narrative.length < 10
  )
    return;

  const structure = await db.query.optionStructures.findFirst({ where: eq(tables.optionStructures.id, structureId) });
  if (!structure) return;

  const lessons = String(formData.get("lessons") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  await db.insert(tables.optionPostmortems).values({
    structureId,
    companyId: structure.companyId,
    ticker: structure.ticker,
    outcome,
    volViewRight,
    directionRight,
    structureChoiceRight: formData.get("structureChoiceRight") === "true",
    thetaCapture: String(formData.get("thetaCapture") ?? "").trim() || null,
    narrative,
    lessons: JSON.stringify(lessons),
    createdBy: String(formData.get("createdBy") ?? "").trim() || "Unnamed analyst",
  });

  // Stamp the options decision traces for this name with the realized outcome.
  await db
    .update(tables.traces)
    .set({ outcome })
    .where(
      and(
        eq(tables.traces.ticker, structure.ticker),
        eq(tables.traces.sourceType, "options_structure"),
        isNull(tables.traces.outcome),
      ),
    );

  revalidatePath("/desk");
  revalidatePath("/ledger");
}
