// Drain the Augury job queue, streaming NDJSON progress. Wires the concrete
// per-kind handlers into processJobs and emits one line per JobEvent (a job
// flipping to running / done / failed / requeued), then a final summary line.
// Pattern mirrors app/api/nightvision/scan/route.ts (ReadableStream + NDJSON).
import { NextRequest } from "next/server";
import { processJobs } from "@/lib/augury/jobs";
import { authorizeCron } from "@/lib/augury/cron";
import { ingestHandler } from "@/lib/augury/ingest";
import { resolveHandler } from "@/lib/augury/resolve";
import { contextHandler } from "@/lib/augury/context";
import { extractHandler } from "@/lib/augury/extract";
import { linkHandler } from "@/lib/augury/positions";
import { backtestHandler } from "@/lib/augury/backtest";
import { profileHandler } from "@/lib/augury/profile";
import type { JobEvent, JobHandler, JobKind } from "@/lib/augury/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// How many jobs a single scheduled drain will process before returning, so the
// invocation stays within maxDuration. Overridable per-call via `?max=`.
const CRON_BATCH = Number(process.env.AUGURY_CRON_BATCH ?? 25);

// Concrete kind → handler registry. processJobs dispatches each claimed job by
// its kind; the v2 pipeline threads ingest → resolve → context → extract →
// link → backtest (each stage enqueues the next), with profile refreshed at the
// end of an ingest/backfill run.
const handlers: Record<JobKind, JobHandler> = {
  ingest: ingestHandler,
  resolve: resolveHandler,
  context: contextHandler,
  extract: extractHandler,
  link: linkHandler,
  backtest: backtestHandler,
  profile: profileHandler,
};

/** Human-readable one-liner for a job transition, surfaced as the line's `message`. */
function describe(e: JobEvent): string {
  const tag = `${e.job.kind}#${e.job.id}`;
  switch (e.status) {
    case "running":
      return `Running ${tag}…`;
    case "done":
      return `Completed ${tag}.`;
    case "queued":
      return `Requeued ${tag}${e.error ? ` — ${e.error}` : ""} (retry pending).`;
    case "failed":
      return `Failed ${tag}${e.error ? ` — ${e.error}` : ""}.`;
    default:
      return `${tag}: ${e.status}${e.error ? ` — ${e.error}` : ""}`;
  }
}

// Vercel Cron sends GET. Guarded by CRON_SECRET; drains a bounded batch so each
// invocation finishes within maxDuration, then returns a JSON summary (no
// NDJSON streaming — a cron has no client to consume the progress lines).
export async function GET(req: NextRequest) {
  if (!authorizeCron(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const maxParam = Number(new URL(req.url).searchParams.get("max"));
  const max = Number.isFinite(maxParam) && maxParam > 0 ? Math.floor(maxParam) : CRON_BATCH;
  try {
    const summary = await processJobs(handlers, { max });
    return Response.json({
      message:
        summary.processed === 0
          ? "Queue empty — nothing to process."
          : `Drained ${summary.processed} job${summary.processed === 1 ? "" : "s"}: ${summary.done} done, ${summary.requeued} requeued, ${summary.failed} failed.`,
      summary,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Augury pipeline run failed." },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let max: number | undefined;
  try {
    const body = (await req.json()) as { max?: number };
    const n = Number(body?.max);
    if (Number.isFinite(n) && n > 0) max = Math.floor(n);
  } catch {
    // empty/invalid body — drain the whole queue (no cap)
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const summary = await processJobs(handlers, {
          max,
          onEvent: (e) =>
            write({
              stage: "job",
              jobId: e.job.id,
              kind: e.job.kind,
              status: e.status,
              message: describe(e),
              error: e.error,
            }),
        });
        write({
          stage: "summary",
          message:
            summary.processed === 0
              ? "Queue empty — nothing to process."
              : `Drained ${summary.processed} job${summary.processed === 1 ? "" : "s"}: ${summary.done} done, ${summary.requeued} requeued, ${summary.failed} failed.`,
          summary,
        });
      } catch (err) {
        write({
          stage: "error",
          message: err instanceof Error ? err.message : "Augury pipeline run failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
