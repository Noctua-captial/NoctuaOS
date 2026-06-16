// (v2) Position-linking stage. Reconciles a post's extracted `calls` into
// first-class trader Positions (`augury_positions`) — one campaign per
// (author, subjectType, subject) — replacing the render-time `isUpdateOf`
// threading the UI used to do. For each call it opens or advances the matching
// position, stamps the call with its `positionId`, and re-derives the campaign's
// lifecycle state from ALL of its currently-linked calls (so the result is
// idempotent and order-independent — re-running any post re-derives correct
// state). It then fans out a `backtest` job for every ticker call.
//
// Status model: a position is "watching" until a call enters it (entered/adding
// → "open"), stays open through trims, and goes "closed" on exiting/closed.
// sizeTrajectory / thesisEvolution / peakConviction / currentStage are maintained
// from the call history. Cross-slice contract: writes only auguryPositions +
// calls.positionId and hands off via the jobs queue.
import { and, asc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { enqueue } from "@/lib/augury/jobs";
import type {
  JobHandler,
  LifecycleStage,
  PositionStatus,
  SizeTrajectoryEvent,
  SubjectType,
  ThesisEvolutionEvent,
} from "@/lib/augury/types";

type PositionRow = typeof tables.auguryPositions.$inferSelect;

const SIZING_STAGES = new Set(["starter", "add", "trim", "exit"]);
const DIRECTIONAL_STANCES = new Set(["bullish", "bearish", "hedge"]);

function normSubjectType(s: string | null): SubjectType {
  return s === "theme" || s === "macro" ? s : "ticker";
}

/** Find an existing position for (author, subjectType, subject), case-insensitive on subject. */
async function findPosition(
  authorId: number,
  subjectType: SubjectType,
  subject: string,
): Promise<PositionRow | null> {
  const candidates = await db
    .select()
    .from(tables.auguryPositions)
    .where(and(eq(tables.auguryPositions.authorId, authorId), eq(tables.auguryPositions.subjectType, subjectType)));
  const want = subject.trim().toLowerCase();
  const matches = candidates.filter((p) => p.subject.trim().toLowerCase() === want);
  if (matches.length === 0) return null;
  // Prefer a still-active campaign, then the most-recently-updated.
  const rank = (p: PositionRow) => (p.status === "open" ? 2 : p.status === "watching" ? 1 : 0);
  matches.sort((a, b) => rank(b) - rank(a) || (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  return matches[0];
}

/** Resolve (or create) the position a call belongs to: honor a valid same-author/type hint, else find/create by subject. */
async function resolvePositionForCall(call: {
  authorId: number;
  subjectType: SubjectType;
  subject: string;
  positionId: number | null;
}): Promise<number> {
  if (call.positionId != null) {
    const [hinted] = await db
      .select()
      .from(tables.auguryPositions)
      .where(eq(tables.auguryPositions.id, call.positionId))
      .limit(1);
    if (hinted && hinted.authorId === call.authorId && hinted.subjectType === call.subjectType) {
      return hinted.id;
    }
  }

  const existing = await findPosition(call.authorId, call.subjectType, call.subject);
  if (existing) return existing.id;

  const [created] = await db
    .insert(tables.auguryPositions)
    .values({
      authorId: call.authorId,
      subjectType: call.subjectType,
      subject: call.subject,
      status: "watching",
    })
    .returning({ id: tables.auguryPositions.id });
  return created.id;
}

interface LinkedCall {
  id: number;
  stance: string | null;
  lifecycleStage: string | null;
  sizeDelta: string | null;
  conviction: number | null;
  thesisSummary: string | null;
  postedAt: Date | null;
}

/** Re-derive a position's full lifecycle/size/thesis state from all of its currently-linked calls. */
async function recomputePosition(positionId: number): Promise<void> {
  const calls: LinkedCall[] = await db
    .select({
      id: tables.calls.id,
      stance: tables.calls.stance,
      lifecycleStage: tables.calls.lifecycleStage,
      sizeDelta: tables.calls.sizeDelta,
      conviction: tables.calls.conviction,
      thesisSummary: tables.calls.thesisSummary,
      postedAt: tables.posts.postedAt,
    })
    .from(tables.calls)
    .innerJoin(tables.posts, eq(tables.calls.postId, tables.posts.id))
    .where(eq(tables.calls.positionId, positionId))
    .orderBy(asc(tables.posts.postedAt), asc(tables.calls.id));
  if (calls.length === 0) return; // orphaned (all calls re-extracted away) — leave as-is

  let status: PositionStatus = "watching";
  let openedAt: Date | null = null;
  let closedAt: Date | null = null;
  let peakConviction: number | null = null;
  let direction: string | null = null;
  const sizeTrajectory: SizeTrajectoryEvent[] = [];
  const thesisEvolution: ThesisEvolutionEvent[] = [];

  for (const c of calls) {
    const stage = (c.lifecycleStage ?? "commentary") as LifecycleStage;
    const at = (c.postedAt ?? new Date()).toISOString();

    switch (stage) {
      case "entered":
      case "adding":
        status = "open";
        if (!openedAt) openedAt = c.postedAt ?? null;
        closedAt = null; // a re-entry after a close reopens the campaign
        break;
      case "trimming":
        if (status !== "closed") status = "open";
        break;
      case "exiting":
      case "closed":
        status = "closed";
        closedAt = c.postedAt ?? null;
        break;
      case "initiating":
        if (status !== "open") status = "watching";
        break;
      // watching / commentary do not downgrade an already-open campaign
      default:
        break;
    }

    if (c.conviction != null) peakConviction = Math.max(peakConviction ?? 0, c.conviction);
    if (c.stance && DIRECTIONAL_STANCES.has(c.stance)) direction = c.stance;
    else if (direction == null && c.stance) direction = c.stance;

    if (c.sizeDelta && SIZING_STAGES.has(c.sizeDelta)) {
      sizeTrajectory.push({ callId: c.id, stage, sizeDelta: c.sizeDelta as SizeTrajectoryEvent["sizeDelta"], at });
    }
    if (c.thesisSummary) {
      thesisEvolution.push({ callId: c.id, at, thesisSummary: c.thesisSummary });
    }
  }

  const first = calls[0];
  const last = calls[calls.length - 1];
  const currentStage = (last.lifecycleStage ?? null) as LifecycleStage | null;
  const realizedOutcome =
    status === "closed"
      ? `Closed (${currentStage ?? "exited"})${closedAt ? ` on ${closedAt.toISOString().slice(0, 10)}` : ""}`
      : null;

  await db
    .update(tables.auguryPositions)
    .set({
      status,
      currentStage,
      direction,
      openedAt,
      closedAt,
      peakConviction,
      firstCallId: first.id,
      lastCallId: last.id,
      sizeTrajectory: JSON.stringify(sizeTrajectory),
      thesisEvolution: JSON.stringify(thesisEvolution),
      realizedOutcome,
      updatedAt: new Date(),
    })
    .where(eq(tables.auguryPositions.id, positionId));
}

/**
 * Reconcile a post's calls into positions, then enqueue per-ticker backtests.
 * Idempotent: it re-links each call and re-derives every touched position from
 * its full (currently-linked) call history. Safe to re-run after re-extraction.
 */
export async function linkPost(postId: number): Promise<void> {
  if (!Number.isFinite(postId)) return;

  const calls = await db
    .select({
      id: tables.calls.id,
      authorId: tables.calls.authorId,
      subject: tables.calls.ticker, // calls.ticker doubles as the subject (symbol or theme/macro label)
      subjectType: tables.calls.subjectType,
      positionId: tables.calls.positionId,
    })
    .from(tables.calls)
    .where(eq(tables.calls.postId, postId))
    .orderBy(asc(tables.calls.id));
  if (calls.length === 0) return;

  const touched = new Set<number>();
  const backtestCallIds: number[] = [];

  for (const c of calls) {
    if (!c.subject) continue; // no subject → can't form a campaign
    const subjectType = normSubjectType(c.subjectType);
    const positionId = await resolvePositionForCall({
      authorId: c.authorId,
      subjectType,
      subject: c.subject,
      positionId: c.positionId,
    });
    await db.update(tables.calls).set({ positionId }).where(eq(tables.calls.id, c.id));
    touched.add(positionId);
    if (subjectType === "ticker") backtestCallIds.push(c.id);
  }

  for (const positionId of touched) {
    await recomputePosition(positionId);
  }

  // Fan out backtests for ticker calls (themes/macro are tracked qualitatively).
  for (const callId of backtestCallIds) {
    await enqueue("backtest", { callId });
  }
}

/** Job handler for `link` jobs. Payload: { postId }. */
export const linkHandler: JobHandler = async (payload: { postId: number }) => {
  await linkPost(Number(payload?.postId));
};
