import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, asc } from "drizzle-orm";
import { db, tables } from "@/db";
import { ResearchGraph, type GraphNode, type GraphEdge } from "@/components/research-graph";

export const dynamic = "force-dynamic";

export default async function GraphPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: raw } = await params;
  const ticker = raw.toUpperCase();
  const company = await db.query.companies.findFirst({
    where: eq(tables.companies.ticker, ticker),
  });
  if (!company) notFound();

  const [thesisRows, claimRows, catalystRows, memoRows, runRows, questionRows] = await Promise.all([
    db.select().from(tables.theses).where(eq(tables.theses.companyId, company.id)).orderBy(desc(tables.theses.version)).limit(1),
    db.select().from(tables.claims).where(eq(tables.claims.companyId, company.id)).orderBy(desc(tables.claims.confidence)).limit(14),
    db.select().from(tables.catalysts).where(eq(tables.catalysts.companyId, company.id)).orderBy(asc(tables.catalysts.expectedDate)).limit(5),
    db.select().from(tables.memos).where(eq(tables.memos.companyId, company.id)).orderBy(desc(tables.memos.version)).limit(3),
    db.select().from(tables.agentRuns).where(eq(tables.agentRuns.ticker, ticker)).orderBy(desc(tables.agentRuns.createdAt)).limit(20),
    db.select().from(tables.researchQuestions).where(eq(tables.researchQuestions.ticker, ticker)).orderBy(desc(tables.researchQuestions.id)).limit(12),
  ]);

  const thesis = thesisRows[0];

  const nodes: GraphNode[] = [
    {
      id: "company",
      kind: "company",
      label: ticker,
      value: company.convictionScore ?? 0,
      detail: company.businessSummary ?? company.name,
      sub: `${company.name} · ${company.sector ?? ""}`,
    },
  ];
  const edges: GraphEdge[] = [];

  if (thesis) {
    nodes.push({
      id: "thesis",
      kind: "thesis",
      label: `THESIS v${thesis.version}`,
      detail: thesis.oneLiner,
      sub: thesis.variantPerception ?? undefined,
    });
    edges.push({ from: "company", to: "thesis" });
  }

  claimRows.forEach((cl, i) => {
    const kind = cl.supports === "bull" ? "claim_bull" : cl.supports === "bear" ? "claim_bear" : "claim_neutral";
    const id = `claim-${cl.id}`;
    nodes.push({
      id,
      kind,
      label: `C${i + 1}`,
      value: cl.confidence,
      detail: cl.text,
      sub: `${cl.kind.replace("_", " ")} · ${cl.source ?? "unsourced"}`,
    });
    edges.push({ from: thesis ? "thesis" : "company", to: id });
  });

  catalystRows.forEach((ct) => {
    const id = `cat-${ct.id}`;
    nodes.push({
      id,
      kind: "catalyst",
      label: ct.expectedDate ?? "TBD",
      detail: ct.title,
      sub: ct.impact ?? undefined,
    });
    edges.push({ from: "company", to: id });
  });

  memoRows.forEach((m) => {
    const id = `memo-${m.id}`;
    nodes.push({
      id,
      kind: "memo",
      label: `MEMO v${m.version}`,
      detail: `${m.proposedAction ?? "—"} · ${m.recommendation === "more_work" ? "more work needed" : m.recommendation}`,
      sub: m.analyst,
      href: `/ic/${m.id}`,
    });
    edges.push({ from: "company", to: id });
  });

  questionRows.forEach((q) => {
    const id = `q-${q.id}`;
    nodes.push({
      id,
      kind: "question",
      label: `D${q.depth} ${q.confidence != null ? `${Math.round(q.confidence * 100)}%` : "OPEN"}`,
      detail: q.question,
      sub: q.answer ?? `${q.status} · ${q.agent ?? "general"}`,
      value: q.confidence ?? undefined,
    });
    edges.push({
      from: q.parentId != null ? `q-${q.parentId}` : thesis ? "thesis" : "company",
      to: id,
    });
  });

  const seenAgents = new Set<string>();
  runRows.forEach((r) => {
    if (seenAgents.has(r.agent) || r.agent === "synthesis" || r.agent === "dossier") return;
    seenAgents.add(r.agent);
    const id = `agent-${r.agent}`;
    nodes.push({
      id,
      kind: "agent",
      label: r.agent.replace(/_/g, " "),
      detail: `${r.agent.replace(/_/g, " ").toUpperCase()} — ${r.inputSummary ?? "agent run"}`,
      sub: `model: ${r.model ?? "?"}`,
    });
    edges.push({ from: "company", to: id });
  });

  return (
    <div className="relative h-screen">
      <ResearchGraph ticker={ticker} nodes={nodes} edges={edges} />
      <Link
        href={`/dossiers/${ticker}`}
        className="label absolute right-6 bottom-6 border border-line-strong bg-ink-raised px-4 py-2 !text-[10px] hover:bg-ink-card"
      >
        ← Dossier
      </Link>
    </div>
  );
}
