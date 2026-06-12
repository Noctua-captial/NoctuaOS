"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";

export type GraphNode = {
  id: string;
  kind: "company" | "thesis" | "claim_bull" | "claim_bear" | "claim_neutral" | "catalyst" | "memo" | "agent" | "question";
  label: string;
  sub?: string;
  detail?: string;
  value?: number; // confidence 0-1 or score 0-100
  href?: string;
};

export type GraphEdge = { from: string; to: string };

const KIND_STYLE: Record<
  GraphNode["kind"],
  { r: number; stroke: string; text: string; tag: string }
> = {
  company: { r: 54, stroke: "var(--parchment)", text: "var(--parchment)", tag: "TARGET" },
  thesis: { r: 42, stroke: "var(--platinum)", text: "var(--parchment)", tag: "THESIS" },
  claim_bull: { r: 26, stroke: "var(--bull)", text: "var(--bull)", tag: "BULL EVIDENCE" },
  claim_bear: { r: 26, stroke: "var(--bear)", text: "var(--bear)", tag: "BEAR EVIDENCE" },
  claim_neutral: { r: 24, stroke: "var(--platinum)", text: "var(--platinum)", tag: "EVIDENCE" },
  catalyst: { r: 30, stroke: "var(--warn)", text: "var(--warn)", tag: "CATALYST" },
  memo: { r: 34, stroke: "var(--parchment-dim)", text: "var(--parchment-dim)", tag: "IC MEMO" },
  agent: { r: 22, stroke: "var(--platinum)", text: "var(--platinum)", tag: "AGENT" },
  question: { r: 24, stroke: "var(--warn)", text: "var(--warn)", tag: "RESEARCH QUESTION" },
};

type Pos = { x: number; y: number };

function initialLayout(nodes: GraphNode[]): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const groups: Record<string, GraphNode[]> = {};
  for (const n of nodes) (groups[n.kind] ??= []).push(n);

  pos.set(groups.company?.[0]?.id ?? "company", { x: 0, y: 0 });
  if (groups.thesis?.[0]) pos.set(groups.thesis[0].id, { x: 0, y: -210 });

  // sector helper: spread nodes across an arc (degrees, screen convention: 0=right, 90=down)
  const arc = (items: GraphNode[] | undefined, centerDeg: number, spread: number, radius: number, rStep = 0) => {
    if (!items?.length) return;
    items.forEach((n, i) => {
      const t = items.length === 1 ? 0.5 : i / (items.length - 1);
      const deg = centerDeg - spread / 2 + spread * t;
      const rad = (deg * Math.PI) / 180;
      const r = radius + (i % 2) * rStep;
      // round to avoid SSR/client float drift (hydration mismatch)
      pos.set(n.id, {
        x: Math.round(Math.cos(rad) * r * 100) / 100,
        y: Math.round(Math.sin(rad) * r * 100) / 100,
      });
    });
  };

  arc(groups.claim_bull, 8, 80, 340, 70);     // right
  arc(groups.claim_bear, 188, 80, 340, 70);   // left
  arc(groups.claim_neutral, 90, 40, 300, 60); // below
  arc(groups.catalyst, 122, 50, 380, 60);     // lower-left-of-down
  arc(groups.memo, 322, 30, 245, 0);          // upper-right, inside claim ring
  arc(groups.agent, 62, 44, 460, 50);         // lower-right outer ring
  arc(groups.question, 250, 60, 430, 60);     // upper-left outer ring — the tree
  return pos;
}

export function ResearchGraph({
  ticker,
  nodes,
  edges,
}: {
  ticker: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}) {
  const [positions, setPositions] = useState<Map<string, Pos>>(() => initialLayout(nodes));
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 0.9 });
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    | { type: "node"; id: string; startX: number; startY: number; origX: number; origY: number }
    | { type: "pan"; startX: number; startY: number; origX: number; origY: number }
    | null
  >(null);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selectedNode = selected ? nodeById.get(selected) : null;

  const connected = useMemo(() => {
    if (!selected) return null;
    const set = new Set<string>([selected]);
    for (const e of edges) {
      if (e.from === selected) set.add(e.to);
      if (e.to === selected) set.add(e.from);
    }
    return set;
  }, [selected, edges]);

  function onPointerDown(e: React.PointerEvent, nodeId?: string) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (nodeId) {
      const p = positions.get(nodeId)!;
      dragRef.current = { type: "node", id: nodeId, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y };
    } else {
      dragRef.current = { type: "pan", startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.type === "node") {
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(d.id, { x: d.origX + dx / view.k, y: d.origY + dy / view.k });
        return next;
      });
    } else {
      setView((v) => ({ ...v, x: d.origX + dx / v.k, y: d.origY + dy / v.k }));
    }
  }

  function onPointerUp(e: React.PointerEvent, nodeId?: string) {
    const d = dragRef.current;
    if (d?.type === "node" && nodeId) {
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (moved < 4) setSelected((s) => (s === nodeId ? null : nodeId));
    } else if (d?.type === "pan") {
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (moved < 4) setSelected(null);
    }
    dragRef.current = null;
  }

  function onWheel(e: React.WheelEvent) {
    const factor = e.deltaY < 0 ? 1.08 : 0.93;
    setView((v) => ({ ...v, k: Math.max(0.35, Math.min(2.2, v.k * factor)) }));
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <svg
        ref={svgRef}
        className="dot-grid h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e)}
        onWheel={onWheel}
      >
        <g
          style={{
            transform: `translate(50%, 50%) scale(${view.k}) translate(${view.x}px, ${view.y}px)`,
          }}
        >
          {/* edges */}
          {edges.map((e, i) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return null;
            const toNode = nodeById.get(e.to);
            const stroke = toNode ? KIND_STYLE[toNode.kind].stroke : "var(--platinum)";
            const lit = connected ? connected.has(e.from) && connected.has(e.to) : true;
            const mx = Math.round(((a.x + b.x) / 2) * 100) / 100;
            const my = Math.round(((a.y + b.y) / 2 - 26) * 100) / 100;
            return (
              <path
                key={i}
                d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                fill="none"
                stroke={stroke}
                strokeWidth={1}
                opacity={lit ? 0.32 : 0.06}
                style={{ transition: "opacity 0.2s" }}
              />
            );
          })}

          {/* nodes */}
          {nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const st = KIND_STYLE[n.kind];
            const isSel = selected === n.id;
            const lit = connected ? connected.has(n.id) : true;
            const display =
              n.kind === "company"
                ? String(Math.round(n.value ?? 0))
                : n.kind === "claim_bull" || n.kind === "claim_bear" || n.kind === "claim_neutral"
                  ? `${Math.round((n.value ?? 0) * 100)}`
                  : null;
            return (
              <g
                key={n.id}
                style={{ opacity: lit ? 1 : 0.22, transition: "opacity 0.2s", cursor: "pointer" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onPointerDown(e, n.id);
                }}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  onPointerUp(e, n.id);
                }}
              >
                {n.kind === "company" && (
                  <circle className="node-pulse" cx={p.x} cy={p.y} r={st.r + 14} fill="none" stroke={st.stroke} strokeWidth={1} />
                )}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={st.r}
                  fill="var(--ink-card)"
                  stroke={st.stroke}
                  strokeWidth={isSel ? 2.5 : 1.25}
                />
                {display != null ? (
                  <>
                    <text
                      x={p.x}
                      y={n.kind === "company" ? p.y - 4 : p.y + 1}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill={st.text}
                      style={{ font: `${n.kind === "company" ? 24 : 12}px var(--font-plex-mono)` }}
                    >
                      {display}
                    </text>
                    {n.kind === "company" && (
                      <text
                        x={p.x}
                        y={p.y + 18}
                        textAnchor="middle"
                        fill="var(--parchment-faint)"
                        style={{ font: "9px var(--font-plex-mono)", letterSpacing: "0.2em" }}
                      >
                        {n.label}
                      </text>
                    )}
                  </>
                ) : (
                  <text
                    x={p.x}
                    y={p.y + 1}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={st.text}
                    style={{ font: "9px var(--font-plex-mono)", letterSpacing: "0.08em" }}
                  >
                    {n.label.slice(0, 10).toUpperCase()}
                  </text>
                )}
                {/* caption under node */}
                {n.kind !== "company" && (
                  <text
                    x={p.x}
                    y={p.y + st.r + 15}
                    textAnchor="middle"
                    fill="var(--parchment-faint)"
                    style={{ font: "9.5px var(--font-geist-sans)" }}
                  >
                    {(n.sub ?? n.label).slice(0, 34)}
                    {(n.sub ?? n.label).length > 34 ? "…" : ""}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* top-left HUD */}
      <div className="pointer-events-none absolute left-6 top-6">
        <div className="label">Research Graph</div>
        <div className="serif mt-1 text-3xl text-parchment">{ticker}</div>
        <div className="fin mt-2 text-[10px] text-parchment-faint">
          drag nodes · drag canvas to pan · scroll to zoom · click to inspect
        </div>
      </div>

      {/* legend */}
      <div className="absolute bottom-6 left-6 flex items-center gap-4">
        {(
          [
            ["claim_bull", "Bull evidence"],
            ["claim_bear", "Bear evidence"],
            ["catalyst", "Catalyst"],
            ["question", "Question"],
            ["memo", "Memo"],
            ["agent", "Agent"],
          ] as const
        ).map(([kind, label]) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full border"
              style={{ borderColor: KIND_STYLE[kind].stroke }}
            />
            <span className="label !text-[8px]">{label}</span>
          </span>
        ))}
      </div>

      {/* inspector panel */}
      {selectedNode && (
        <aside className="fade-up absolute right-6 top-6 w-80 border border-line-strong bg-ink-raised/95 px-5 py-5 backdrop-blur">
          <div
            className="fin text-[9px] tracking-[0.2em]"
            style={{ color: KIND_STYLE[selectedNode.kind].stroke }}
          >
            {KIND_STYLE[selectedNode.kind].tag}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-parchment">
            {selectedNode.detail ?? selectedNode.label}
          </p>
          {selectedNode.sub && (
            <p className="mt-2 text-[11px] text-parchment-faint">{selectedNode.sub}</p>
          )}
          {selectedNode.value != null && selectedNode.kind.startsWith("claim") && (
            <div className="mt-3">
              <div className="flex items-baseline justify-between">
                <span className="label !text-[8px]">Confidence</span>
                <span className="fin text-[11px] text-parchment">
                  {Math.round(selectedNode.value * 100)}%
                </span>
              </div>
              <div className="mt-1 h-px w-full bg-line">
                <div
                  className="h-px"
                  style={{
                    width: `${selectedNode.value * 100}%`,
                    background: KIND_STYLE[selectedNode.kind].stroke,
                  }}
                />
              </div>
            </div>
          )}
          {selectedNode.href && (
            <Link
              href={selectedNode.href}
              className="label mt-4 inline-block border border-line px-3 py-1.5 !text-[9px] hover:bg-ink-card"
            >
              Open →
            </Link>
          )}
        </aside>
      )}
    </div>
  );
}
