"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, tables } from "@/db";

export async function resolveAlert(alertId: number) {
  db.update(tables.alerts).set({ resolved: true }).where(eq(tables.alerts.id, alertId)).run();
  revalidatePath("/");
}

export async function updateCompanyStatus(companyId: number, status: string) {
  if (!["pipeline", "watchlist", "active", "rejected", "exited"].includes(status)) return;
  db.update(tables.companies)
    .set({ status, updatedAt: new Date() })
    .where(eq(tables.companies.id, companyId))
    .run();
  revalidatePath("/dossiers");
  revalidatePath("/");
}

export async function updateThesisStatus(companyId: number, thesisStatus: string) {
  if (!["strengthening", "stable", "weakening", "broken"].includes(thesisStatus)) return;
  db.update(tables.companies)
    .set({ thesisStatus, updatedAt: new Date() })
    .where(eq(tables.companies.id, companyId))
    .run();

  // A broken thesis must surface at the top of The Perch.
  if (thesisStatus === "broken") {
    const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, companyId) });
    if (company) {
      db.insert(tables.alerts)
        .values({
          companyId,
          ticker: company.ticker,
          severity: 1,
          kind: "thesis_break",
          message: `Thesis marked BROKEN by analyst. Kill criteria review required for ${company.ticker}.`,
          suggestedAction: "Convene IC. Exit per kill criteria or re-underwrite with a new thesis version.",
        })
        .run();
    }
  }
  revalidatePath("/dossiers");
  revalidatePath("/");
}

export async function decideMemo(memoId: number, decision: "approve" | "reject" | "more_work", decidedBy: string) {
  const memo = await db.query.memos.findFirst({ where: eq(tables.memos.id, memoId) });
  if (!memo) return;
  const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, memo.companyId) });

  db.update(tables.memos)
    .set({ recommendation: decision, decidedBy, decidedAt: new Date() })
    .where(eq(tables.memos.id, memoId))
    .run();

  const newStatus = decision === "approve" ? "active" : decision === "reject" ? "rejected" : company?.status;
  if (company && newStatus && newStatus !== company.status) {
    db.update(tables.companies)
      .set({
        status: newStatus,
        updatedAt: new Date(),
        rejectionReason:
          decision === "reject"
            ? `Rejected by IC (${decidedBy}, ${new Date().toISOString().slice(0, 10)}) — memo v${memo.version}.`
            : company.rejectionReason,
      })
      .where(eq(tables.companies.id, company.id))
      .run();
  }

  // Decision becomes part of the record: alert + trace.
  if (company) {
    const verb = decision === "approve" ? "APPROVED" : decision === "reject" ? "REJECTED" : "sent back for MORE WORK";
    db.insert(tables.alerts)
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
      })
      .run();
    db.insert(tables.traces)
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
      })
      .run();
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
  db.insert(tables.positions)
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
    })
    .run();

  if (company.status !== "active") {
    db.update(tables.companies)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(tables.companies.id, companyId))
      .run();
  }

  db.insert(tables.alerts)
    .values({
      companyId,
      ticker: company.ticker,
      severity: 2,
      kind: "position",
      message: `Position opened: ${company.ticker} ${sizePct.toFixed(1)}% of NAV at $${entryPrice.toFixed(2)} (${owner.trim() || "Unassigned"}).`,
      suggestedAction: "Kill criteria snapshotted at entry. Night Vision monitors from here — review on every alert.",
    })
    .run();

  db.insert(tables.traces)
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
    })
    .run();

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
  db.update(tables.positions)
    .set({ status: "closed", exitPrice, exitDate: date })
    .where(eq(tables.positions.id, positionId))
    .run();

  const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
  db.insert(tables.alerts)
    .values({
      companyId: position.companyId,
      ticker: position.ticker,
      severity: 2,
      kind: "position",
      message: `Position closed: ${position.ticker} at $${exitPrice.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% vs entry). After-Action postmortem required.`,
      suggestedAction: "File the postmortem while the reasoning is fresh. Unexamined exits teach nothing.",
    })
    .run();

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

  db.insert(tables.postmortems)
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
    })
    .run();

  // Outcome flows back into the ledger: every unresolved trace on this name gets stamped.
  db.update(tables.traces)
    .set({ outcome })
    .where(and(eq(tables.traces.ticker, company.ticker), isNull(tables.traces.outcome)))
    .run();

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
  db.update(tables.positions).set({ sizePct: newSizePct }).where(eq(tables.positions.id, positionId)).run();

  db.insert(tables.traces)
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
    })
    .run();

  revalidatePath("/war-room");
  revalidatePath("/talons");
  revalidatePath("/");
}

export async function updatePortfolioNav(nav: number, cash: number | null) {
  if (!Number.isFinite(nav) || nav <= 0) return;
  const rows = await db.select().from(tables.portfolio).limit(1);
  if (rows[0]) {
    db.update(tables.portfolio)
      .set({ nav, cash, updatedAt: new Date() })
      .where(eq(tables.portfolio.id, rows[0].id))
      .run();
  } else {
    db.insert(tables.portfolio).values({ nav, cash }).run();
  }
  revalidatePath("/war-room");
  revalidatePath("/talons");
}

export async function labelTrace(traceId: number, label: string | null) {
  if (label !== null && !TRACE_LABELS.includes(label)) return;
  db.update(tables.traces).set({ label }).where(eq(tables.traces.id, traceId)).run();
  revalidatePath("/ledger");
}

export async function addClaim(formData: FormData) {
  const companyId = Number(formData.get("companyId"));
  const text = String(formData.get("text") ?? "").trim();
  const source = String(formData.get("source") ?? "").trim();
  if (!companyId || text.length < 10 || source.length < 3) return;

  db.insert(tables.claims)
    .values({
      companyId,
      text,
      kind: String(formData.get("kind") ?? "unverified"),
      supports: String(formData.get("supports") ?? "neutral"),
      confidence: Math.max(0, Math.min(1, Number(formData.get("confidence") ?? 0.5))),
      source,
      sourceType: String(formData.get("sourceType") ?? "analyst_note"),
    })
    .run();

  const company = await db.query.companies.findFirst({ where: eq(tables.companies.id, companyId) });
  if (company) revalidatePath(`/dossiers/${company.ticker}`);
}
