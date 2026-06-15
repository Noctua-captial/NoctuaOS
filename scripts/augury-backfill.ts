// One-time (resumable) deep-history pull for every active tracked author.
// Run with: npx tsx scripts/augury-backfill.ts
//
// Resumable by construction: ingestTweets dedupes by platformPostId, so a
// re-run only inserts tweets not already stored. Tolerates a missing
// APIFY_TOKEN (prints a notice and exits 0). Per-author errors are logged and
// skipped so one bad handle doesn't abort the whole run.
//
// Env:
//   APIFY_TOKEN                  required to actually fetch (else graceful no-op)
//   AUGURY_BACKFILL_MAX_ITEMS    per-author cap (default 3000)
import { TRACKED_AUTHORS } from "@/lib/augury/authors.config";
import { backfillAuthor } from "@/lib/augury/ingest";
import { enqueue } from "@/lib/augury/jobs";

const MAX_ITEMS = Number(process.env.AUGURY_BACKFILL_MAX_ITEMS ?? 3000);

async function main(): Promise<void> {
  if (!process.env.APIFY_TOKEN) {
    console.log(
      "APIFY_TOKEN not set — nothing to backfill (the tweet source is a no-op without it).\n" +
        "Set APIFY_TOKEN in .env.local to enable deep-history pulls, then re-run.",
    );
    process.exit(0);
  }

  const active = TRACKED_AUTHORS.filter((a) => a.active);
  console.log(
    `Augury backfill — ${active.length} active author(s), up to ${MAX_ITEMS} tweets each.\n`,
  );

  let totalFetched = 0;
  let totalNew = 0;
  const lines: string[] = [];

  for (const a of active) {
    const label = `@${a.handle}`;
    try {
      process.stdout.write(`→ ${label} … `);
      const { authorId, fetched, newPostIds } = await backfillAuthor(a.handle, { maxItems: MAX_ITEMS });
      totalFetched += fetched;
      totalNew += newPostIds.length;
      console.log(`fetched ${fetched}, ${newPostIds.length} new (authorId=${authorId})`);
      lines.push(`  ${label}: fetched=${fetched} new=${newPostIds.length}`);
      // End-of-backfill for this author: refresh the playbook/scorecard.
      await enqueue("profile", { authorId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR — ${msg}`);
      lines.push(`  ${label}: ERROR — ${msg}`);
    }
  }

  console.log("\n=== Backfill summary ===");
  console.log(lines.join("\n"));
  console.log(
    `\nauthors=${active.length}  tweets fetched=${totalFetched}  new posts=${totalNew}`,
  );
  console.log("New posts each enqueued a 'context' job; each author enqueued a 'profile' job.");
  console.log("Drain the queue via POST /api/augury/process to run the rest of the pipeline.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
