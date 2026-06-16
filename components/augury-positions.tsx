// Augury v2 — first-class trader Positions. A Position is one campaign per
// (author, subject) that the `link` stage threads from its calls
// (watching → open → closed). Server-renderable; reuses the v1 chips from
// augury-ui plus the v2 chips from augury-chips so the taxonomy stays consistent.
import Link from "next/link";
import {
  StanceChip,
  LifecycleChip,
  ConvictionChip,
} from "@/components/augury-ui";
import { PositionStatusChip, SubjectTypeChip } from "@/components/augury-chips";
import type { Position } from "@/lib/augury/types";

/** The slice of a `calls` row a position needs to render its lifecycle sequence. */
export type PositionCall = {
  id: number;
  postId: number;
  lifecycleStage: string | null;
  sizeDelta: string | null;
  conviction: number | null;
  postedAt: Date | null;
};

// One step in a position's lifecycle, unified across two sources: the linked
// calls (preferred — they carry a postId we can deep-link to) and, as a
// fallback, the position's stored sizeTrajectory JSON (no postId).
type LifecycleEvent = {
  postId: number | null;
  stage: string | null;
  sizeDelta: string | null;
  at: Date | null;
};

function shortDate(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(5, 10); // MM-DD
}

function fmtDay(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildEvents(position: Position, calls: PositionCall[]): LifecycleEvent[] {
  if (calls.length > 0) {
    return calls.map((c) => ({
      postId: c.postId,
      stage: c.lifecycleStage,
      sizeDelta: c.sizeDelta,
      at: c.postedAt,
    }));
  }
  // Fallback to the materialized trajectory (no postId to link to).
  return (position.sizeTrajectory ?? []).map((e) => ({
    postId: null,
    stage: e.stage,
    sizeDelta: e.sizeDelta,
    at: e.at ? new Date(e.at) : null,
  }));
}

function LifecycleSequence({ events }: { events: LifecycleEvent[] }) {
  if (events.length === 0) {
    return <p className="text-[10.5px] text-parchment-faint">No linked calls yet.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {events.map((e, i) => {
        const inner = (
          <>
            <span className="fin text-[10px] text-platinum">{e.stage ?? "—"}</span>
            {e.sizeDelta && e.sizeDelta !== "none" && (
              <span className="fin text-[8.5px] text-parchment-faint">{e.sizeDelta}</span>
            )}
            <span className="fin text-[9px] text-parchment-faint">{shortDate(e.at)}</span>
          </>
        );
        return (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span className="text-parchment-faint">→</span>}
            {e.postId != null ? (
              <Link
                href={`/augury/post/${e.postId}`}
                className="flex items-center gap-1.5 border border-line px-2 py-1 transition-colors hover:border-line-strong"
              >
                {inner}
              </Link>
            ) : (
              <span className="flex items-center gap-1.5 border border-line px-2 py-1">{inner}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function PositionCard({ position, calls }: { position: Position; calls: PositionCall[] }) {
  const events = buildEvents(position, calls);
  const latestThesis = position.thesisEvolution?.[position.thesisEvolution.length - 1] ?? null;
  const thesisRevisions = position.thesisEvolution?.length ?? 0;

  return (
    <div className="card px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="fin text-sm text-parchment">{position.subject}</span>
        <SubjectTypeChip subjectType={position.subjectType} />
        <StanceChip stance={position.direction} />
        <PositionStatusChip status={position.status} />
        <span className="ml-auto flex items-center gap-2">
          {position.peakConviction != null && (
            <>
              <span className="label !text-[7.5px]">peak</span>
              <ConvictionChip conviction={position.peakConviction} />
            </>
          )}
          {position.currentStage && <LifecycleChip stage={position.currentStage} />}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="fin text-[10px] text-parchment-faint">
          opened {fmtDay(position.openedAt)}
          {position.status === "closed" ? ` · closed ${fmtDay(position.closedAt)}` : ""}
        </span>
        <span className="fin text-[10px] text-parchment-faint">
          {events.length} step{events.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-3">
        <LifecycleSequence events={events} />
      </div>

      {latestThesis?.thesisSummary && (
        <p className="mt-3 border-l border-line-strong pl-3 text-[12px] leading-relaxed text-parchment-dim">
          {latestThesis.thesisSummary}
          {thesisRevisions > 1 && (
            <span className="fin ml-2 text-[9px] text-parchment-faint">· {thesisRevisions} revisions</span>
          )}
        </p>
      )}

      {position.realizedOutcome && (
        <div className="card-rule mt-3 pt-3">
          <span className="label mr-2 !text-[8.5px]">Realized</span>
          <span className="text-[12px] text-parchment-dim">{position.realizedOutcome}</span>
        </div>
      )}
    </div>
  );
}

/**
 * A titled list of position cards with a count and a graceful empty state.
 * Used for both the tradable (ticker) timeline and the theme/macro view.
 */
export function PositionsTimeline({
  title,
  countLabel = "positions",
  positions,
  callsByPosition,
  emptyState,
}: {
  title: string;
  countLabel?: string;
  positions: Position[];
  callsByPosition: Map<number, PositionCall[]>;
  emptyState: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="label">{title}</span>
        <span className="label !text-[8px]">
          {positions.length} {countLabel}
        </span>
      </div>
      {positions.length > 0 ? (
        <div className="space-y-3">
          {positions.map((p) => (
            <PositionCard key={p.id} position={p} calls={callsByPosition.get(p.id) ?? []} />
          ))}
        </div>
      ) : (
        <div className="card px-5 py-8 text-center text-sm leading-relaxed text-parchment-faint">{emptyState}</div>
      )}
    </section>
  );
}
