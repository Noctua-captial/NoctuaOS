// Durable, resumable job queue backed by the `jobs` table. Replaces one-shot
// request handlers for the Augury pipeline: work is enqueued, claimed, run, and
// either marked done or requeued with exponential backoff until a max-attempts
// cap. Concrete handlers live in the worker modules; processJobs receives a
// kind→handler registry and dispatches to it.
import { eq } from "drizzle-orm";
import { db, tables, sql } from "@/db";
import type { JobEvent, JobHandler, JobKind, JobRecord, JobStatus } from "@/lib/augury/types";

/** Requeue a failed job up to this many attempts before giving up (status → "failed"). */
const MAX_ATTEMPTS = 5;
/** Exponential backoff base; delay = BASE × 2^(attempts−1): 30s, 60s, 120s, 240s. */
const BASE_BACKOFF_MS = 30_000;

type JobRow = typeof tables.jobs.$inferSelect;

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function rowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    payload: parsePayload(row.payload),
    status: row.status as JobStatus,
    attempts: row.attempts,
    runAfter: row.runAfter ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** Enqueue a job. `opts.runAfter` defers it (defaults to "now", i.e. eligible immediately). */
export async function enqueue(
  kind: JobKind,
  payload: unknown,
  opts: { runAfter?: Date } = {},
): Promise<JobRecord> {
  const now = new Date();
  const [row] = await db
    .insert(tables.jobs)
    .values({
      kind,
      payload: JSON.stringify(payload ?? null),
      status: "queued",
      attempts: 0,
      runAfter: opts.runAfter ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rowToRecord(row);
}

// Raw row shape returned by the atomic-claim statement (postgres-js maps
// timestamptz → Date, int → number, text → string).
type RawJobRow = {
  id: number;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  run_after: Date | null;
  last_error: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

function rawRowToRecord(row: RawJobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    payload: parsePayload(row.payload),
    status: row.status as JobStatus,
    attempts: row.attempts,
    runAfter: row.run_after ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Atomically claim the oldest due job and flip it to "running". A single
 * `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` statement is
 * safe under concurrent cron drains: SKIP LOCKED guarantees two invocations
 * never claim the same row (the second skips it and takes the next), and the
 * whole thing runs in one implicit transaction — compatible with the Supavisor
 * transaction pooler. Returns null when nothing is due.
 */
export async function claimNext(): Promise<JobRecord | null> {
  const rows = await sql<RawJobRow[]>`
    UPDATE jobs
    SET status = 'running', updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND (run_after IS NULL OR run_after <= now())
      ORDER BY run_after ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `;
  if (!rows[0]) return null; // queue drained (or nothing due)
  return rawRowToRecord(rows[0]);
}

/** Mark a job completed. Terminal. */
export async function markDone(id: number): Promise<void> {
  await db
    .update(tables.jobs)
    .set({ status: "done", lastError: null, updatedAt: new Date() })
    .where(eq(tables.jobs.id, id));
}

/**
 * Record a failure: increment attempts, store the error, and either requeue with
 * exponential-backoff `runAfter` or — once attempts hit MAX_ATTEMPTS — mark the
 * job permanently "failed". Returns the updated record (status tells which path).
 */
export async function markFailed(id: number, err: unknown): Promise<JobRecord | null> {
  const message = err instanceof Error ? err.message : String(err);
  const current = await db.select().from(tables.jobs).where(eq(tables.jobs.id, id)).limit(1);
  if (!current[0]) return null;

  const attempts = (current[0].attempts ?? 0) + 1;
  const now = new Date();

  if (attempts >= MAX_ATTEMPTS) {
    const failed = await db
      .update(tables.jobs)
      .set({ status: "failed", attempts, lastError: message, updatedAt: now })
      .where(eq(tables.jobs.id, id))
      .returning();
    return failed[0] ? rowToRecord(failed[0]) : null;
  }

  const backoffMs = BASE_BACKOFF_MS * 2 ** (attempts - 1);
  const requeued = await db
    .update(tables.jobs)
    .set({
      status: "queued",
      attempts,
      lastError: message,
      runAfter: new Date(now.getTime() + backoffMs),
      updatedAt: now,
    })
    .where(eq(tables.jobs.id, id))
    .returning();
  return requeued[0] ? rowToRecord(requeued[0]) : null;
}

export interface ProcessSummary {
  processed: number; // jobs claimed and run this drain
  done: number;
  failed: number; // hit the max-attempts cap
  requeued: number; // failed but scheduled for another attempt
}

/**
 * Drain due jobs, dispatching each by kind to the provided handler registry.
 * Handlers are supplied by the caller (the integration worker wires concrete
 * handlers) — none are defined here. Stops when the queue is drained or `max`
 * jobs have been processed. `onEvent` observes every transition.
 */
export async function processJobs(
  handlers: Record<JobKind, JobHandler>,
  opts: { max?: number; onEvent?: (e: JobEvent) => void } = {},
): Promise<ProcessSummary> {
  const max = opts.max ?? Infinity;
  const onEvent = opts.onEvent;
  const summary: ProcessSummary = { processed: 0, done: 0, failed: 0, requeued: 0 };

  while (summary.processed < max) {
    const job = await claimNext();
    if (!job) break; // queue drained (or nothing due)
    summary.processed++;
    onEvent?.({ job, status: "running" });

    const handler = handlers[job.kind];
    if (!handler) {
      const error = `No handler registered for job kind "${job.kind}"`;
      const updated = await markFailed(job.id, error);
      const status = updated?.status ?? "failed";
      if (status === "failed") summary.failed++;
      else summary.requeued++;
      onEvent?.({ job: updated ?? job, status, error });
      continue;
    }

    try {
      await handler(job.payload, {
        job,
        emit: (status, error) => onEvent?.({ job, status, error }),
      });
      await markDone(job.id);
      summary.done++;
      onEvent?.({ job: { ...job, status: "done" }, status: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = await markFailed(job.id, err);
      const status = updated?.status ?? "failed";
      if (status === "failed") summary.failed++;
      else summary.requeued++;
      onEvent?.({ job: updated ?? job, status, error: message });
    }
  }

  return summary;
}
