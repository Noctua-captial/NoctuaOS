// Live-poll trigger for Augury ingestion. Enqueues one "ingest" job per active
// tracked author and returns immediately — it does NOT drain the queue (that's
// /api/augury/process). POST is the manual UI trigger (throttled in-memory; pass
// { force: true } to override); GET is the CRON_SECRET-guarded Vercel Cron entry.
import { NextRequest } from "next/server";
import { enqueue } from "@/lib/augury/jobs";
import { authorizeCron } from "@/lib/augury/cron";
import { TRACKED_AUTHORS } from "@/lib/augury/authors.config";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Minimum gap between unforced polls. Best-effort (per server instance), like
// Night Vision's in-memory scan throttle.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let lastPollAt: Date | null = null;

/** Enqueue one ingest job per active tracked author. Returns the handles. */
async function enqueueActiveAuthors(): Promise<string[]> {
  const active = TRACKED_AUTHORS.filter((a) => a.active);
  const authors: string[] = [];
  for (const a of active) {
    await enqueue("ingest", { authorHandle: a.handle });
    authors.push(a.handle);
  }
  return authors;
}

// Vercel Cron sends GET. Guarded by CRON_SECRET; enqueues unconditionally (the
// cron schedule is the throttle) and leaves draining to the process cron.
export async function GET(req: NextRequest) {
  if (!authorizeCron(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const authors = await enqueueActiveAuthors();
  lastPollAt = new Date();
  return Response.json({
    enqueued: authors.length,
    authors,
    polledAt: lastPollAt.toISOString(),
    message: "Enqueued ingest jobs (cron). The process cron drains them.",
  });
}

export async function POST(req: NextRequest) {
  let force = false;
  try {
    const body = (await req.json()) as { force?: boolean };
    force = Boolean(body?.force);
  } catch {
    // empty body — treat as a normal (throttled) poll request
  }

  if (!force && lastPollAt && Date.now() - lastPollAt.getTime() < POLL_INTERVAL_MS) {
    return Response.json({
      skipped: true,
      lastPollAt: lastPollAt.toISOString(),
      message: "Augury polled within the last 5 minutes. Pass { force: true } to override.",
    });
  }
  lastPollAt = new Date();

  const authors = await enqueueActiveAuthors();

  return Response.json({
    enqueued: authors.length,
    authors,
    polledAt: lastPollAt.toISOString(),
    message: "Enqueued ingest jobs. Drain them via POST /api/augury/process.",
  });
}
