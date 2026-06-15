// Shared TypeScript contracts for the Augury module. Downstream workers
// (market, ingest, extract, context, backtest, profile, UI) import from here so
// the seams between them are fixed. Field names mirror the db/schema.ts columns.
// Pure types only — no runtime imports.

// --- platforms / authors -----------------------------------------------------

/** Source platform for a tracked author. Only X/Twitter today; extend as sources are added. */
export type Platform = "x";

// --- jobs queue --------------------------------------------------------------

/** The kinds of work the durable queue dispatches. Stored as `jobs.kind`. */
export type JobKind = "ingest" | "context" | "extract" | "backtest" | "profile";

/** Lifecycle of a queued job. Stored as `jobs.status`. */
export type JobStatus = "queued" | "running" | "done" | "failed";

/** A row from the `jobs` table, with `payload` parsed back into an object. */
export interface JobRecord {
  id: number;
  kind: JobKind;
  payload: unknown; // parsed JSON; shape depends on kind (see the per-kind handler payloads)
  status: JobStatus;
  attempts: number;
  runAfter: Date | null;
  lastError: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Progress/transition event surfaced by processJobs and handler ctx.emit. */
export interface JobEvent {
  job: JobRecord;
  status: string; // "running" | "done" | "queued" | "failed" | any handler-defined progress label
  error?: string;
}

/** Small context handed to a JobHandler so it can report progress for its own job. */
export interface JobContext {
  job: JobRecord;
  emit: (status: string, error?: string) => void;
}

/**
 * A unit of work. The integration worker builds a Record<JobKind, JobHandler>
 * registry; processJobs dispatches by kind. `ctx` is optional so trivial
 * handlers can ignore it. `payload` is intentionally `any`: each handler
 * declares its own concrete payload type, which stays assignable here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobHandler = (payload: any, ctx?: JobContext) => Promise<void>;

// --- ingest / sources --------------------------------------------------------

/** Engagement counts on a post; every field optional (sources vary). */
export interface TweetMetrics {
  likes?: number;
  retweets?: number;
  replies?: number;
  quotes?: number;
  views?: number;
  bookmarks?: number;
}

/** A media attachment on a post. */
export interface TweetMedia {
  type: "photo" | "video" | "gif" | string;
  url: string;
  thumbnailUrl?: string;
  altText?: string | null;
}

/** Raw scraper shape, before normalization. Mirrors what a TweetSource yields. */
export interface RawTweet {
  id: string; // the platform's own post id (→ posts.platformPostId)
  url: string;
  text: string;
  createdAt: string; // ISO 8601 — the post's own timestamp
  authorHandle: string; // without the leading @
  isReply: boolean;
  isRetweet: boolean;
  isQuote: boolean;
  conversationId: string | null;
  replyToId: string | null; // platform id of the post this replies to
  quotedId: string | null; // platform id of the quoted post
  metrics: TweetMetrics;
  media: TweetMedia[];
  raw: unknown; // original provider payload, kept verbatim for re-parsing
}

/** A RawTweet normalized and ready to upsert into `posts`. Field names match the columns. */
export interface NormalizedPost {
  authorId: number;
  platformPostId: string;
  url: string | null;
  text: string;
  postedAt: Date | null; // the post's own timestamp
  isReply: boolean;
  isRetweet: boolean;
  isQuote: boolean;
  conversationId: string | null;
  replyToId: string | null;
  quotedPostId: string | null;
  metrics: TweetMetrics;
  media: TweetMedia[];
  raw: unknown;
}

/** A ticker reference detected in a post (→ tickerMentions). */
export type MentionType = "cashtag" | "name" | "implicit";

export interface TickerMention {
  ticker: string;
  mentionType: MentionType;
  confidence: number; // 0..1
  companyId?: number | null; // resolved against existing companies when known
}

// --- market bars -------------------------------------------------------------

/** One adjusted daily bar (→ dailyBars), unique per (ticker, date). */
export interface MarketBar {
  ticker: string;
  date: string; // ISO date (YYYY-MM-DD)
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjClose: number | null;
  volume: number | null;
}

/** One intraday bar (→ intradayBars), unique per (ticker, ts). */
export interface IntradayBar {
  ticker: string;
  ts: string; // ISO timestamp of the bar's start
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

// --- post context ------------------------------------------------------------

/** Adjusted % returns around a post, by window. Null when forward/back data is out of range. */
export interface ReturnWindows {
  "-5d": number | null;
  "-1d": number | null;
  "+1d": number | null;
  "+5d": number | null;
  "+30d": number | null;
}

export type MarketRegime = "risk_on" | "risk_off" | "neutral" | "transition";

export interface NewsSnapshotItem {
  title: string;
  url: string;
  source: string | null;
  publishedAt: string | null; // ISO
}

/** Parsed contents of a `postContext` row — "what was going on" when the post landed. */
export interface PostContextData {
  ticker: string | null; // subject ticker for the return windows
  returns: ReturnWindows;
  marketRegime: MarketRegime | null;
  vix: number | null;
  sectorMovePct: number | null;
  newsSnapshot: NewsSnapshotItem[];
}

// --- extraction (calls) ------------------------------------------------------

export type Stance = "bullish" | "bearish" | "neutral" | "hedge";

export type LifecycleStage =
  | "watching"
  | "initiating"
  | "entered"
  | "adding"
  | "trimming"
  | "exiting"
  | "closed"
  | "commentary";

export type Horizon = "intraday" | "swing" | "weeks" | "months" | "long_term" | "unspecified";

/**
 * The LLM extraction output for a single post. Mirrors the `callSchema` in the
 * Augury plan; the extract worker maps this onto the `calls` columns
 * (isUpdateOfCallId → calls.isUpdateOf, etc.).
 */
export interface ExtractedCall {
  isMarketRelevant: boolean;
  ticker: string | null;
  stance: Stance;
  lifecycleStage: LifecycleStage;
  conviction: number; // 0..1
  horizon: Horizon;
  thesisSummary: string;
  catalyst: string | null;
  targetPrice: number | null;
  isUpdateOfCallId: number | null; // prior calls.id this updates — threads watching → entered → trimmed → exited
  rawQuote: string;
}

// --- backtest ----------------------------------------------------------------

export type BacktestOutcome = "right" | "wrong" | "partial" | "too_early" | "inconclusive";

/** One call × horizon backtest result (→ backtests). No-lookahead by construction. */
export interface BacktestResult {
  callId: number;
  ticker: string;
  horizon: string; // label, e.g. "7d" | "30d" | "90d" | "180d" | "365d" | "to_date"
  entryDate: string; // ISO date
  entryPrice: number | null;
  evalDate: string; // ISO date
  evalPrice: number | null;
  rawReturnPct: number | null;
  benchmarkReturnPct: number | null;
  alphaPct: number | null; // rawReturnPct − benchmarkReturnPct, direction-adjusted
  outcome: BacktestOutcome;
  judgeNotes: string | null;
}

// --- author scorecard / playbook --------------------------------------------

/** Aggregate stats for a slice (a horizon, stance, or sector). */
export interface SliceStat {
  hitRate: number | null;
  avgAlphaPct: number | null;
  n: number;
}

/** One conviction-calibration bucket: stated conviction vs realized hit-rate. */
export interface ConvictionCalibrationBucket {
  bucket: string; // e.g. "0.0-0.2"
  predicted: number; // mean stated conviction in the bucket
  realizedHitRate: number | null;
  n: number;
}

/**
 * Synthesized per-author playbook (→ authorScorecards.playbook). Grounded:
 * `citedPostIds` point back at the posts the narrative is built from.
 */
export interface AuthorPlaybook {
  authorId: number;
  handle: string;
  summary: string; // narrative playbook, grounded with cited post ids
  citedPostIds: number[];
  hitRate: number | null;
  avgAlphaPct: number | null;
  sampleSize: number;
  byHorizon: Record<string, SliceStat>;
  byStance: Record<string, SliceStat>;
  bySector: Record<string, SliceStat>;
  convictionCalibration: ConvictionCalibrationBucket[];
  edges: string[]; // recurring setups where they tend to be right
  weaknesses: string[]; // recurring setups where they tend to be wrong
}
