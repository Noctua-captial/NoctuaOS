import { asc } from "drizzle-orm";
import { db, tables } from "@/db";

// Training-data export — one JSON object per line, tagged by record type:
// research traces (with label/outcome), debate transcripts, council briefs,
// and directives (labeled outcomes accrue as positions resolve).
// This file is the fine-tuning dataset.
export async function GET() {
  const [traces, debates, turns, briefs, directives] = await Promise.all([
    db.select().from(tables.traces).orderBy(asc(tables.traces.id)),
    db.select().from(tables.debates).orderBy(asc(tables.debates.id)),
    db.select().from(tables.debateTurns).orderBy(asc(tables.debateTurns.idx)),
    db.select().from(tables.councilBriefs).orderBy(asc(tables.councilBriefs.id)),
    db.select().from(tables.directives).orderBy(asc(tables.directives.id)),
  ]);

  const turnsByDebate = new Map<number, typeof turns>();
  for (const t of turns) {
    const arr = turnsByDebate.get(t.debateId) ?? [];
    arr.push(t);
    turnsByDebate.set(t.debateId, arr);
  }

  const lines: string[] = [
    ...traces.map((r) => JSON.stringify({ type: "trace", ...r })),
    ...debates.map((d) =>
      JSON.stringify({
        type: "debate",
        ...d,
        turns: (turnsByDebate.get(d.id) ?? []).map((t) => ({
          round: t.round,
          seat: t.seat,
          modelId: t.modelId,
          content: safeParse(t.content),
        })),
      }),
    ),
    ...briefs.map((b) => JSON.stringify({ type: "council_brief", ...b, content: safeParse(b.content) })),
    ...directives.map((d) =>
      JSON.stringify({
        type: "directive",
        ...d,
        reasons: safeParse(d.reasons),
        dataCoverage: safeParse(d.dataCoverage),
        inputs: safeParse(d.inputs),
      }),
    ),
  ];

  return new Response(lines.join("\n") + (lines.length > 0 ? "\n" : ""), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="noctua-training-data.jsonl"',
    },
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
