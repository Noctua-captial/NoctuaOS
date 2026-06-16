// Augury v2 presentational chips that didn't exist in the v1 taxonomy:
// position status, subject type (ticker/theme/macro), relative size deltas, and
// LLM-resolved post entities. Server components (no interactivity), same house
// palette + chip geometry as components/augury-ui.tsx so everything lines up.
import type { EntityType, EntityRole, PostEntity } from "@/lib/augury/types";

// Mirrors the private `chip()` in augury-ui.tsx (kept identical on purpose so the
// two chip families render at the same size/weight).
function chip(cls: string, label: string) {
  return (
    <span className={`fin inline-block border px-1.5 py-px text-[9px] uppercase tracking-[0.1em] ${cls}`}>
      {label}
    </span>
  );
}

const POSITION_STATUS_CLS: Record<string, string> = {
  watching: "border-warn/50 text-warn",
  open: "border-bull/50 text-bull",
  closed: "border-parchment-faint/60 text-parchment-faint",
};

/** watching | open | closed — the lifecycle status of a whole campaign. */
export function PositionStatusChip({ status }: { status: string | null }) {
  if (!status) return null;
  return chip(POSITION_STATUS_CLS[status] ?? "border-line text-parchment-faint", status);
}

const SUBJECT_TYPE_CLS: Record<string, string> = {
  ticker: "border-platinum/40 text-platinum",
  theme: "border-warn/50 text-warn",
  macro: "border-parchment-dim/50 text-parchment-dim",
};

/** ticker | theme | macro — what kind of thing a position/call is about. */
export function SubjectTypeChip({ subjectType }: { subjectType: string | null }) {
  if (!subjectType) return null;
  return chip(SUBJECT_TYPE_CLS[subjectType] ?? "border-line text-parchment-faint", subjectType);
}

const SIZE_DELTA_CLS: Record<string, string> = {
  starter: "border-platinum/40 text-platinum",
  add: "border-bull/50 text-bull",
  trim: "border-warn/50 text-warn",
  exit: "border-bear/50 text-bear",
};

/** starter | add | trim | exit — relative sizing change. "none"/null render nothing. */
export function SizeDeltaChip({ sizeDelta }: { sizeDelta: string | null }) {
  if (!sizeDelta || sizeDelta === "none") return null;
  return chip(SIZE_DELTA_CLS[sizeDelta] ?? "border-line text-parchment-faint", sizeDelta);
}

const ENTITY_TYPE_CLS: Record<EntityType, string> = {
  ticker: "border-platinum/40 text-platinum",
  theme: "border-warn/50 text-warn",
  macro: "border-parchment-dim/50 text-parchment-dim",
};

const ROLE_LABEL: Record<EntityRole, string> = {
  subject: "subject",
  comparison: "vs",
  mention: "mention",
};

/**
 * One LLM-resolved entity (a ticker without a cashtag, a company name, a theme,
 * or a macro topic). Shows the entity type + value, and the role unless it's the
 * plain subject. Hovering reveals confidence.
 */
export function EntityChip({ entity }: { entity: PostEntity }) {
  const cls = ENTITY_TYPE_CLS[entity.entityType] ?? "border-line text-parchment-dim";
  const showRole = entity.role && entity.role !== "subject";
  return (
    <span
      title={`${entity.entityType} · ${entity.role} · confidence ${(entity.confidence ?? 0).toFixed(2)}`}
      className={`fin inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[10px] ${cls}`}
    >
      <span className="text-[7px] uppercase tracking-[0.12em] text-parchment-faint">{entity.entityType}</span>
      <span className="tracking-wide">{entity.value}</span>
      {showRole && (
        <span className="text-[7px] uppercase tracking-[0.12em] text-parchment-faint">
          {ROLE_LABEL[entity.role] ?? entity.role}
        </span>
      )}
    </span>
  );
}
