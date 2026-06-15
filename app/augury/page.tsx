import Link from "next/link";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, tables } from "@/db";
import { PageHeader } from "@/components/ui";
import { AuguryControls } from "@/components/augury-run-button";
import { fmtSignedPct, alphaClass } from "@/components/augury-ui";
import { providerStatus } from "@/lib/augury/market/provider";
import { getProviderStatus } from "@/lib/models";
import { TRACKED_AUTHORS } from "@/lib/augury/authors.config";

export const dynamic = "force-dynamic";

const PLACEHOLDER_HANDLES = new Set(["trader_one", "trader_two"]);

function daysAgo(d: Date | null): string {
  if (!d) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export default async function AuguryOverview() {
  const trackedHandles = TRACKED_AUTHORS.map((a) => a.handle);

  const authorRows = trackedHandles.length
    ? await db
        .select()
        .from(tables.authors)
        .where(and(eq(tables.authors.platform, "x"), inArray(tables.authors.handle, trackedHandles)))
    : [];
  const authorIds = authorRows.map((a) => a.id);

  const [scoreRows, postCountRows, callCountRows, jobRows, totals] = await Promise.all([
    authorIds.length
      ? db.select().from(tables.authorScorecards).where(inArray(tables.authorScorecards.authorId, authorIds))
      : Promise.resolve([]),
    authorIds.length
      ? db
          .select({ authorId: tables.posts.authorId, n: sql<number>`count(*)` })
          .from(tables.posts)
          .where(inArray(tables.posts.authorId, authorIds))
          .groupBy(tables.posts.authorId)
      : Promise.resolve([]),
    authorIds.length
      ? db
          .select({ authorId: tables.calls.authorId, n: sql<number>`count(*)` })
          .from(tables.calls)
          .where(inArray(tables.calls.authorId, authorIds))
          .groupBy(tables.calls.authorId)
      : Promise.resolve([]),
    db.select({ status: tables.jobs.status, n: sql<number>`count(*)` }).from(tables.jobs).groupBy(tables.jobs.status),
    Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(tables.posts),
      db.select({ n: sql<number>`count(*)` }).from(tables.calls),
      db.select({ n: sql<number>`count(*)` }).from(tables.backtests),
    ]),
  ]);

  // Latest post per tracked author (drizzle maps the timestamp back to a Date).
  const latestByAuthor = new Map<number, Date | null>();
  await Promise.all(
    authorRows.map(async (a) => {
      const [p] = await db
        .select({ postedAt: tables.posts.postedAt })
        .from(tables.posts)
        .where(eq(tables.posts.authorId, a.id))
        .orderBy(desc(tables.posts.postedAt))
        .limit(1);
      latestByAuthor.set(a.id, p?.postedAt ?? null);
    }),
  );

  const scoreByAuthor = new Map(scoreRows.map((s) => [s.authorId, s]));
  const postCountByAuthor = new Map(postCountRows.map((r) => [r.authorId, r.n]));
  const callCountByAuthor = new Map(callCountRows.map((r) => [r.authorId, r.n]));
  const jobCounts = new Map(jobRows.map((r) => [r.status, r.n]));
  const [[posts], [calls], [backtests]] = totals;

  const queued = jobCounts.get("queued") ?? 0;
  const running = jobCounts.get("running") ?? 0;
  const failed = jobCounts.get("failed") ?? 0;
  const doneJobs = jobCounts.get("done") ?? 0;

  const market = providerStatus();
  const apifySet = Boolean(process.env.APIFY_TOKEN);
  const llmProviders = getProviderStatus().filter((p) => p.configured).map((p) => p.provider);
  const hasPosts = (posts?.n ?? 0) > 0;
  const usingPlaceholders = trackedHandles.every((h) => PLACEHOLDER_HANDLES.has(h));

  const stats = [
    { label: "Tracked authors", value: String(TRACKED_AUTHORS.length) },
    { label: "Posts ingested", value: String(posts?.n ?? 0) },
    { label: "Calls extracted", value: String(calls?.n ?? 0) },
    { label: "Backtests", value: String(backtests?.n ?? 0) },
    {
      label: "Queue (q+run)",
      value: String(queued + running),
      tone: queued + running > 0 ? "text-warn" : undefined,
    },
    {
      label: "Failed jobs",
      value: String(failed),
      tone: failed > 0 ? "text-bear" : undefined,
    },
  ];

  return (
    <div>
      <PageHeader
        kicker="Augury — Trader Intelligence"
        title="Whose calls actually work?"
        right={<AuguryControls />}
      />

      {/* stat strip */}
      <div className="px-10 pt-8">
        <div className="grid grid-cols-6 divide-x divide-line border border-line bg-ink-card">
          {stats.map((s) => (
            <div key={s.label} className="px-5 py-4">
              <div className={`fin text-2xl leading-none ${s.tone ?? "text-parchment"}`}>{s.value}</div>
              <div className="label mt-1.5 !text-[8.5px]">{s.label}</div>
            </div>
          ))}
        </div>

        {/* data sources strip */}
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border border-line bg-ink-card px-5 py-3">
          <span className="label !text-[8px]">Sources</span>
          <span className="fin text-[10px] text-parchment-faint">
            Market{" "}
            <span className={market.keyed ? "text-bull" : "text-warn"}>
              {market.provider.toUpperCase()}
            </span>
          </span>
          <span className="fin text-[10px] text-parchment-faint">
            Tweets{" "}
            <span className={apifySet ? "text-bull" : "text-warn"}>{apifySet ? "APIFY SET" : "NO APIFY_TOKEN"}</span>
          </span>
          <span className="fin text-[10px] text-parchment-faint">
            LLM{" "}
            <span className={llmProviders.length ? "text-bull" : "text-warn"}>
              {llmProviders.length ? llmProviders.join(", ").toUpperCase() : "NO KEYS"}
            </span>
          </span>
          <span className="fin ml-auto text-[10px] text-parchment-faint">
            {doneJobs} job{doneJobs === 1 ? "" : "s"} completed · {market.note ?? market.source}
          </span>
        </div>
      </div>

      <div className="px-10 py-8">
        <div className="label mb-3">Tracked Authors — ranked by realized edge</div>

        {!hasPosts ? (
          <div className="card px-6 py-10">
            <p className="serif text-xl text-parchment">No posts ingested yet.</p>
            <div className="mt-4 space-y-2 text-[13px] leading-relaxed text-parchment-dim">
              <p>To bring Augury to life:</p>
              <ol className="ml-1 list-inside list-decimal space-y-1.5 text-parchment-dim">
                {usingPlaceholders && (
                  <li>
                    Replace the placeholder handles in{" "}
                    <span className="fin text-parchment">lib/augury/authors.config.ts</span> with the two real
                    trader handles to track.
                  </li>
                )}
                <li>
                  Set <span className="fin text-parchment">APIFY_TOKEN</span> (tweet scraper) and, optionally,{" "}
                  <span className="fin text-parchment">POLYGON_API_KEY</span> (deep market history) in{" "}
                  <span className="fin text-parchment">.env.local</span>.
                </li>
                <li>
                  Run the deep-history pull:{" "}
                  <span className="fin text-parchment">npx tsx scripts/augury-backfill.ts</span>.
                </li>
                <li>
                  Come back here and hit <span className="fin text-parchment">RUN PIPELINE</span> to build context,
                  extract calls, and backtest them.
                </li>
              </ol>
              <p className="card-rule mt-4 pt-4 text-[11px] text-parchment-faint">
                Without an LLM key the interpretation pass no-ops (no calls), but ingestion, market context, and
                backtests still run. Market history falls back to a keyless ~2y source when{" "}
                <span className="fin">POLYGON_API_KEY</span> is absent.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {TRACKED_AUTHORS.map((tracked) => {
              const author = authorRows.find((a) => a.handle === tracked.handle);
              const score = author ? scoreByAuthor.get(author.id) : undefined;
              const postCount = author ? postCountByAuthor.get(author.id) ?? 0 : 0;
              const callCount = author ? callCountByAuthor.get(author.id) ?? 0 : 0;
              const latest = author ? latestByAuthor.get(author.id) ?? null : null;
              const hitRate = score?.hitRate ?? null;

              return (
                <Link
                  key={tracked.handle}
                  href={`/augury/${encodeURIComponent(tracked.handle)}`}
                  className="card px-5 py-4 transition-colors hover:bg-ink-raised"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="serif text-xl text-parchment">@{tracked.handle}</span>
                        {!tracked.active && <span className="label !text-[8px]">PAUSED</span>}
                      </div>
                      {author?.displayName && (
                        <div className="truncate text-xs text-parchment-faint">{author.displayName}</div>
                      )}
                    </div>
                    <div className="text-right">
                      <div
                        className={`fin text-2xl leading-none ${
                          hitRate == null
                            ? "text-parchment-faint"
                            : hitRate >= 0.55
                              ? "text-bull"
                              : hitRate >= 0.45
                                ? "text-warn"
                                : "text-bear"
                        }`}
                      >
                        {hitRate == null ? "—" : `${(hitRate * 100).toFixed(0)}%`}
                      </div>
                      <div className="label !text-[7.5px]">hit-rate</div>
                    </div>
                  </div>

                  <div className="card-rule mt-4 grid grid-cols-4 gap-2 pt-3">
                    <div>
                      <div className={`fin text-[13px] ${alphaClass(score?.avgAlphaPct ?? null)}`}>
                        {fmtSignedPct(score?.avgAlphaPct ?? null)}
                      </div>
                      <div className="label !text-[7.5px]">avg alpha</div>
                    </div>
                    <div>
                      <div className="fin text-[13px] text-parchment">{score?.sampleSize ?? 0}</div>
                      <div className="label !text-[7.5px]">scored</div>
                    </div>
                    <div>
                      <div className="fin text-[13px] text-parchment">{callCount}</div>
                      <div className="label !text-[7.5px]">calls</div>
                    </div>
                    <div>
                      <div className="fin text-[13px] text-parchment">{postCount}</div>
                      <div className="label !text-[7.5px]">posts</div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <span className="label !text-[8px]">
                      {author ? `latest ${daysAgo(latest)}` : "not yet ingested"}
                    </span>
                    <span className="label !text-[8px] text-parchment-dim">View timeline →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
