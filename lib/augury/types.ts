// Shared TypeScript contracts for the Augury module. Downstream workers
// (market, ingest, extract, context, backtest, profile, UI) import from here so
// the seams between them are fixed. Field names mirror the db/schema.ts columns.
// Pure types only — no runtime imports.

// --- platforms / authors -----------------------------------------------------

/** Source platform for a tracked author. Only X/Twitter today; extend as sources are added. */
export type Platform = "x";

// --- jobs queue --------------------------------------------------------------

/** The kinds of work the durable queue dispatches. Stored as `jobs.kind`. */
export type JobKind =
  | "ingest"
  | "context"
  | "extract"
  | "backtest"
  | "profile"
  | "resolve" // (v2) LLM entity resolution + post embedding, before context
  | "link"; // (v2) reconcile calls into auguryPositions

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

// --- entities (v2) -----------------------------------------------------------

/** Classification of an entity referenced by a post (→ postEntities.entityType). */
export type EntityType = "ticker" | "theme" | "macro";

/** The type of subject a Position tracks (→ auguryPositions.subjectType, calls.subjectType). Same members as EntityType. */
export type SubjectType = "ticker" | "theme" | "macro";

/** How a post uses an entity (→ postEntities.role). */
export type EntityRole = "subject" | "comparison" | "mention";

/**
 * (NEW v2) An LLM-resolved entity referenced by a post (→ postEntities). The
 * logical extracted shape (id/postId/createdAt are added at insert time),
 * mirroring the TickerMention convention above. Superset of TickerMention:
 * covers tickers without cashtags, company names, themes, and macro topics.
 */
export interface PostEntity {
  entityType: EntityType;
  value: string; // resolved symbol / company name / theme / macro topic
  role: EntityRole;
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

// --- macro context (v2) ------------------------------------------------------

/**
 * Treasury / policy rates snapshot stored in `macroContext.rates` (JSON). Tenors
 * are optional; the index signature keeps it open for additional series.
 */
export interface MacroRates {
  us2y?: number | null;
  us10y?: number | null;
  us30y?: number | null;
  fedFunds?: number | null;
  [series: string]: number | null | undefined;
}

/**
 * (NEW v2) Parsed contents of a `macroContext` row — shared point-in-time market
 * + world context for one calendar date (no look-ahead). Mirrors macro_context;
 * `rates` is surfaced parsed, following the PostContextData convention.
 */
export interface MacroContextData {
  date: string; // ISO date (YYYY-MM-DD)
  sp500: number | null;
  sp500Return5dPct: number | null;
  vix: number | null;
  rates: MacroRates | null;
  regime: MarketRegime | null;
  worldDigest: string | null;
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

/** (NEW v2) Relative position-sizing change a call expresses (→ calls.sizeDelta). */
export type SizeDelta = "starter" | "add" | "trim" | "exit" | "none";

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

/**
 * (NEW v2) One call within a post's extraction set. A post may name several
 * entities/claims, each emitted as its own item (vs. the single-subject
 * `ExtractedCall` above, which is kept as-is). Reuses the call enums. The
 * extract worker maps each item onto a `calls` row; `positionRef` links an open
 * position by id, or is null to open a new campaign.
 */
export interface ExtractedCallItem {
  subject: string; // ticker symbol / theme / macro topic this call is about
  subjectType: SubjectType;
  stance: Stance;
  lifecycleStage: LifecycleStage;
  sizeDelta: SizeDelta;
  conviction: number; // 0..1
  horizon: Horizon;
  thesisSummary: string;
  catalyst: string | null;
  targetPrice: number | null;
  isMarketRelevant: boolean;
  rawQuote: string;
  positionRef: number | null; // auguryPositions.id to advance, or null to open a new one
}

/** (NEW v2) The full multi-call extraction output for one post. */
export interface ExtractedCallSet {
  calls: ExtractedCallItem[];
}

// --- positions (v2) ----------------------------------------------------------

/** Lifecycle status of a campaign (→ auguryPositions.status). */
export type PositionStatus = "watching" | "open" | "closed";

/** One sizing event in a position's trajectory (→ auguryPositions.sizeTrajectory JSON). */
export interface SizeTrajectoryEvent {
  callId: number; // the call that produced this event
  stage: LifecycleStage;
  sizeDelta: SizeDelta;
  at: string; // ISO timestamp (the post's time)
}

/** One thesis snapshot as a position evolves (→ auguryPositions.thesisEvolution JSON). */
export interface ThesisEvolutionEvent {
  callId: number;
  at: string; // ISO timestamp
  thesisSummary: string;
}

/**
 * (NEW v2) A first-class trader Position — one campaign per (author, subject) —
 * mirroring the `auguryPositions` table (namespaced because the IC/portfolio
 * `positions` table is unrelated). The JSON text columns are surfaced here in
 * parsed form (sizeTrajectory / thesisEvolution), following the PostContextData
 * convention.
 */
export interface Position {
  id: number;
  authorId: number;
  subjectType: SubjectType;
  subject: string;
  direction: string | null; // bullish | bearish | hedge | ... (free text until committed)
  status: PositionStatus;
  currentStage: LifecycleStage | null;
  openedAt: Date | null;
  closedAt: Date | null;
  peakConviction: number | null;
  firstCallId: number | null;
  lastCallId: number | null;
  sizeTrajectory: SizeTrajectoryEvent[]; // parsed from JSON text
  thesisEvolution: ThesisEvolutionEvent[]; // parsed from JSON text
  realizedOutcome: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
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
 * (NEW v2) Campaign-level (Position) track record for an author, aggregated
 * alongside the per-call/horizon slices. The `profile` stage derives this from
 * the author's `auguryPositions` and their linked calls' backtests: each
 * Position's outcome is "did the campaign work" measured entry → exit/now,
 * benchmark-relative and direction-adjusted. Counts span ALL positions on
 * record; the hit-rate / alpha aggregate only the scored (conclusive) ones.
 */
export interface PositionScorecard {
  totalPositions: number; // all positions on record for the author
  scoredPositions: number; // positions with a conclusive linked backtest
  hitRate: number | null; // mean per-position hit (right=1, partial=0.5, wrong=0)
  avgAlphaPct: number | null; // mean per-position benchmark-relative alpha
  bySubjectType: Record<string, number>; // position counts by subjectType (ticker/theme/macro)
  byStage: Record<string, number>; // position counts by currentStage
  byStatus: Record<string, number>; // position counts by status (watching/open/closed)
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
  positionScorecard?: PositionScorecard; // (NEW v2) campaign-level track record; optional/additive
}
