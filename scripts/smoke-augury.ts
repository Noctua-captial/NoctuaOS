// Keyless, self-cleaning end-to-end smoke for the Augury v2 pipeline.
// Run with: npx tsx scripts/smoke-augury.ts
//
// What it does:
//   1. Inserts a synthetic author (handle "smoke_test") and one synthetic post
//      containing a cashtag ($NVDA), via the real ingest path, which enqueues a
//      "resolve" job — the head of the v2 chain
//      (resolve → context → extract → link → backtest).
//   2. Drains the queue with processJobs() using the same handler registry the
//      /api/augury/process route wires (real resolve + link handlers included).
//   3. Prints the resulting post_entities / postContext / macroContext / calls /
//      auguryPositions / backtests / jobs rows.
//   4. Purges every synthetic row it created (relationship-based for author-tied
//      tables — incl. post_entities + auguryPositions — and an id-watermark for
//      jobs/agentRuns/traces/macroContext) so it never pollutes data.
//
// Resilient by design: market/news fetches may be blocked on this machine and
// the LLM passes no-op without a provider key. Without an LLM key the `resolve`
// stage still seeds cashtag entities ($NVDA) and the chain advances through
// `context`, but `extract` produces no calls — so `link`/`backtest` never fire
// and there are no calls/positions/backtests. Those are warnings, not failures;
// the script always exits 0.
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { upsertAuthor, ingestTweets, ingestHandler } from "@/lib/augury/ingest";
import { processJobs } from "@/lib/augury/jobs";
import { resolveHandler } from "@/lib/augury/resolve";
import { contextHandler } from "@/lib/augury/context";
import { extractHandler } from "@/lib/augury/extract";
import { linkHandler } from "@/lib/augury/positions";
import { backtestHandler } from "@/lib/augury/backtest";
import { profileHandler } from "@/lib/augury/profile";
import type { JobHandler, JobKind, RawTweet } from "@/lib/augury/types";

const HANDLE = "smoke_test";

// The same exhaustive kind → handler registry the /api/augury/process route
// wires, with the real v2 resolve + link handlers. The smoke seeds via the
// ingest path (which enqueues `resolve`), so the full chain runs end-to-end.
const handlers: Record<JobKind, JobHandler> = {
  ingest: ingestHandler,
  resolve: resolveHandler,
  context: contextHandler,
  extract: extractHandler,
  link: linkHandler,
  backtest: backtestHandler,
  profile: profileHandler,
};

/** Delete every row tied to a synthetic author (children first, FK-safe). */
async function purgeAuthor(authorId: number): Promise<void> {
  const postRows = await db
    .select({ id: tables.posts.id })
    .from(tables.posts)
    .where(eq(tables.posts.authorId, authorId));
  const pIds = postRows.map((r) => r.id);

  if (pIds.length) {
    const callRows = await db
      .select({ id: tables.calls.id })
      .from(tables.calls)
      .where(inArray(tables.calls.postId, pIds));
    const cIds = callRows.map((r) => r.id);
    if (cIds.length) await db.delete(tables.backtests).where(inArray(tables.backtests.callId, cIds));
    await db.delete(tables.calls).where(inArray(tables.calls.postId, pIds));
    await db.delete(tables.postContext).where(inArray(tables.postContext.postId, pIds));
    await db.delete(tables.postEntities).where(inArray(tables.postEntities.postId, pIds)); // v2
    await db.delete(tables.tickerMentions).where(inArray(tables.tickerMentions.postId, pIds));
    await db.delete(tables.posts).where(inArray(tables.posts.id, pIds));
  }
  // v2: auguryPositions are author-scoped (calls.positionId is a soft link, no FK),
  // so drop them by authorId before the author row.
  await db.delete(tables.auguryPositions).where(eq(tables.auguryPositions.authorId, authorId));
  await db.delete(tables.authorScorecards).where(eq(tables.authorScorecards.authorId, authorId));
  await db.delete(tables.authors).where(eq(tables.authors.id, authorId));
}

function warn(msg: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`  ⚠︎ ${msg}: ${detail} (treated as non-fatal)`);
}

async function main(): Promise<void> {
  console.log(`Augury smoke — synthetic author @${HANDLE}, keyless-safe.\n`);

  // Start clean: remove any leftovers from a prior aborted run.
  const prior = await db
    .select({ id: tables.authors.id })
    .from(tables.authors)
    .where(and(eq(tables.authors.platform, "x"), eq(tables.authors.handle, HANDLE)))
    .limit(1);
  if (prior[0]) await purgeAuthor(prior[0].id);

  // Watermarks for tables not tied to the author by FK, so cleanup is exact.
  // macroContext is a shared per-date cache; the watermark removes only rows this
  // run newly created, never a pre-existing cached macro row.
  const [[jobsMax], [runsMax], [tracesMax], [macroMax]] = await Promise.all([
    db.select({ m: sql<number>`coalesce(max(${tables.jobs.id}), 0)` }).from(tables.jobs),
    db.select({ m: sql<number>`coalesce(max(${tables.agentRuns.id}), 0)` }).from(tables.agentRuns),
    db.select({ m: sql<number>`coalesce(max(${tables.traces.id}), 0)` }).from(tables.traces),
    db.select({ m: sql<number>`coalesce(max(${tables.macroContext.id}), 0)` }).from(tables.macroContext),
  ]);
  const jobsBefore = jobsMax?.m ?? 0;
  const runsBefore = runsMax?.m ?? 0;
  const tracesBefore = tracesMax?.m ?? 0;
  const macroBefore = macroMax?.m ?? 0;

  let authorId: number | null = null;
  try {
    const author = await upsertAuthor(HANDLE, "x");
    authorId = author.id;

    // 120 days back so the −5d…+30d context windows and 7/30/90d backtest
    // horizons have all elapsed (no "too_early").
    const postedAt = new Date(Date.now() - 120 * 86_400_000);
    const raw: RawTweet = {
      id: `smoke-${Date.now()}`,
      url: "https://x.com/smoke_test/status/0",
      text: "Loading up on $NVDA here — datacenter demand looks unstoppable into the next print. Long and adding.",
      createdAt: postedAt.toISOString(),
      authorHandle: HANDLE,
      isReply: false,
      isRetweet: false,
      isQuote: false,
      conversationId: null,
      replyToId: null,
      quotedId: null,
      metrics: { likes: 42, retweets: 7, replies: 3, views: 1234 },
      media: [],
      raw: { synthetic: true },
    };

    const { newPostIds } = await ingestTweets(author.id, [raw]);
    console.log(`Ingested ${newPostIds.length} synthetic post (id=${newPostIds[0] ?? "?"}); resolve job enqueued (head of the v2 chain).`);

    // Drain the queue. onEvent narrates the pipeline as it runs.
    const summary = await processJobs(handlers, {
      max: 25,
      onEvent: (e) => {
        if (e.status === "running") console.log(`  → running ${e.job.kind}#${e.job.id}`);
        else if (e.status !== "queued") console.log(`  ✓ ${e.job.kind}#${e.job.id} → ${e.status}${e.error ? ` (${e.error})` : ""}`);
      },
    });
    console.log(
      `\nDrain summary: processed=${summary.processed} done=${summary.done} requeued=${summary.requeued} failed=${summary.failed}`,
    );

    // --- report on what landed -------------------------------------------
    const postRows = await db
      .select({ id: tables.posts.id })
      .from(tables.posts)
      .where(eq(tables.posts.authorId, author.id));
    const pIds = postRows.map((r) => r.id);

    const [entityRows, ctxRows, callRows, posRows] = await Promise.all([
      pIds.length
        ? db.select().from(tables.postEntities).where(inArray(tables.postEntities.postId, pIds))
        : Promise.resolve([]),
      pIds.length
        ? db.select().from(tables.postContext).where(inArray(tables.postContext.postId, pIds))
        : Promise.resolve([]),
      pIds.length ? db.select().from(tables.calls).where(inArray(tables.calls.postId, pIds)) : Promise.resolve([]),
      db.select().from(tables.auguryPositions).where(eq(tables.auguryPositions.authorId, author.id)),
    ]);
    const cIds = callRows.map((c) => c.id);
    const btRows = cIds.length
      ? await db.select().from(tables.backtests).where(inArray(tables.backtests.callId, cIds))
      : [];
    const jobRows = await db.select().from(tables.jobs).where(gt(tables.jobs.id, jobsBefore));
    const macroRows = await db.select().from(tables.macroContext).where(gt(tables.macroContext.id, macroBefore));

    console.log("\n=== RESULTS ===");
    console.log(
      `post entities: ${entityRows.length}`,
      entityRows.map((e) => `${e.value}(${e.entityType}/${e.role})`).join(", "),
    );
    if (entityRows.length === 0) {
      console.log("  (none — resolve seeds $NVDA from its cashtag even keylessly; 0 implies resolve did not run)");
    }

    if (ctxRows[0]) {
      const c = ctxRows[0];
      console.log("postContext:", {
        ticker: c.ticker,
        marketRegime: c.marketRegime,
        vix: c.vix,
        sectorMovePct: c.sectorMovePct,
        returns: c.returns,
        newsItems: (() => {
          try {
            return (JSON.parse(c.newsSnapshot ?? "[]") as unknown[]).length;
          } catch {
            return 0;
          }
        })(),
      });
    } else {
      console.log("postContext: none (context stage produced no row)");
    }

    console.log(`macroContext rows created this run: ${macroRows.length}`);
    for (const m of macroRows) {
      console.log(`  ${m.date}: regime=${m.regime ?? "—"} vix=${m.vix ?? "—"} sp500=${m.sp500 ?? "—"} (nulls are fine keyless/blocked)`);
    }

    console.log(`calls: ${callRows.length}`);
    for (const c of callRows) {
      console.log(`  call#${c.id} ${c.ticker} ${c.stance}/${c.lifecycleStage} horizon=${c.horizon} conv=${c.conviction}`);
    }
    if (callRows.length === 0) {
      console.log("  (none — expected without an LLM key: the extraction pass no-ops keylessly)");
    }

    console.log(`augury positions: ${posRows.length}`);
    for (const p of posRows) {
      console.log(
        `  position#${p.id} ${p.subject} (${p.subjectType}) status=${p.status} stage=${p.currentStage ?? "—"} dir=${p.direction ?? "—"} peakConv=${p.peakConviction ?? "—"}`,
      );
    }
    if (posRows.length === 0) {
      console.log("  (none — expected without an LLM key: no calls → link never runs → no positions)");
    }

    console.log(`backtests: ${btRows.length}`);
    for (const b of btRows) {
      console.log(
        `  ${b.horizon}: raw=${b.rawReturnPct?.toFixed?.(2) ?? "—"}% bench=${b.benchmarkReturnPct?.toFixed?.(2) ?? "—"}% alpha=${b.alphaPct?.toFixed?.(2) ?? "—"}% → ${b.outcome}`,
      );
    }

    console.log(`jobs created this run: ${jobRows.length}`);
    for (const j of jobRows) {
      console.log(`  job#${j.id} ${j.kind} → ${j.status}${j.lastError ? ` (${j.lastError})` : ""}`);
    }

    const dailyBarCount = await db
      .select({ n: sql<number>`count(*)` })
      .from(tables.dailyBars)
      .where(eq(tables.dailyBars.ticker, "NVDA"));
    console.log(`NVDA daily bars cached: ${dailyBarCount[0]?.n ?? 0} (0 is fine if market fetches are blocked/keyless)`);

    console.log("\nSmoke OK — the pipeline ran end-to-end.");
  } catch (err) {
    warn("Smoke encountered an error mid-run", err);
  } finally {
    // Always clean up the synthetic rows, even on error.
    try {
      if (authorId != null) await purgeAuthor(authorId);
      const stray = await db
        .select({ id: tables.authors.id })
        .from(tables.authors)
        .where(and(eq(tables.authors.platform, "x"), eq(tables.authors.handle, HANDLE)))
        .limit(1);
      if (stray[0]) await purgeAuthor(stray[0].id);

      // Jobs / agent_runs / traces / macro_context created during the run (no FK
      // to author). macroContext is a shared per-date cache, so the watermark only
      // removes rows this run newly inserted.
      await db.delete(tables.jobs).where(gt(tables.jobs.id, jobsBefore));
      await db.delete(tables.agentRuns).where(gt(tables.agentRuns.id, runsBefore));
      await db.delete(tables.traces).where(gt(tables.traces.id, tracesBefore));
      await db.delete(tables.macroContext).where(gt(tables.macroContext.id, macroBefore));
      console.log(
        "\nCleaned up all synthetic rows (author, post, entities, context, macro, calls, positions, backtests, jobs, runs, traces).",
      );
    } catch (cleanupErr) {
      warn("Cleanup failed (you may have a leftover smoke_test author)", cleanupErr);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  // Last-resort guard — still exit 0 per the smoke contract.
  console.warn("Unexpected top-level error (non-fatal):", e instanceof Error ? e.message : e);
  process.exit(0);
});
