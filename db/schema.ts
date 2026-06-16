import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  vector,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

// Postgres full-text search vector. pg-core has no native tsvector builder, so we
// declare a thin custom type; the column is populated by a STORED generated
// expression (see `chunks.tsv`) and queried via to_tsvector/websearch_to_tsquery.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull().unique(),
  name: text("name").notNull(),
  sector: text("sector"),
  marketCap: text("market_cap"),
  liquidity: text("liquidity"), // e.g. "$8.4M ADV"
  status: text("status").notNull().default("pipeline"), // pipeline | watchlist | active | rejected | exited
  thesisStatus: text("thesis_status").default("stable"), // strengthening | stable | weakening | broken
  theme: text("theme"), // e.g. "AI optical interconnect", "Data-center power"
  convictionScore: integer("conviction_score"),
  ownerAnalyst: text("owner_analyst"),
  businessSummary: text("business_summary"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const theses = pgTable("theses", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  version: integer("version").notNull().default(1),
  oneLiner: text("one_liner").notNull(),
  variantPerception: text("variant_perception"),
  whyMarketWrong: text("why_market_wrong"),
  whyNow: text("why_now"),
  whatMustHappen: text("what_must_happen"), // JSON string[]
  killCriteria: text("kill_criteria"), // JSON string[]
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const claims = pgTable("claims", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  text: text("text").notNull(),
  kind: text("kind").notNull().default("unverified"), // fact | inference | opinion | model_assumption | unverified
  supports: text("supports").notNull().default("neutral"), // bull | bear | neutral
  confidence: real("confidence").notNull().default(0.5),
  source: text("source"),
  sourceType: text("source_type"), // filing | transcript | pricing_data | analyst_note | competitor | news
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const catalysts = pgTable("catalysts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  title: text("title").notNull(),
  kind: text("kind"), // earnings | product | regulatory | contract | macro | index | guidance
  expectedDate: text("expected_date"), // ISO date or fuzzy ("Q3 2026")
  impact: text("impact"), // what it could change
});

export const scores = pgTable("scores", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  total: integer("total").notNull(),
  components: text("components").notNull(), // JSON {thesisClarity, evidenceQuality, ...}
  rationale: text("rationale").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const memos = pgTable("memos", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  version: integer("version").notNull().default(1),
  analyst: text("analyst").notNull().default("Athena (draft)"),
  proposedAction: text("proposed_action"),
  proposedSize: text("proposed_size"),
  recommendation: text("recommendation").default("more_work"), // approve | reject | more_work
  decidedBy: text("decided_by"), // human IC member who made the call
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  content: text("content").notNull(), // JSON of all 14 memo sections
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker"),
  title: text("title").notNull(),
  docType: text("doc_type").notNull().default("note"), // filing | transcript | presentation | note | article | expert_call
  formType: text("form_type"), // 10-K | 10-Q | 8-K | ...
  source: text("source"), // URL or provenance
  filedAt: text("filed_at"), // ISO date
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const chunks = pgTable(
  "chunks",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id").notNull().references(() => documents.id),
    idx: integer("idx").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }), // pgvector; null when embeddings are disabled
    // STORED generated tsvector for keyword retrieval (works with no API key).
    tsv: tsvector("tsv").generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', "text")`,
    ),
  },
  (t) => ({
    // GIN index over the FTS vector; HNSW cosine index over the embedding.
    tsvIdx: index("chunks_tsv_idx").using("gin", t.tsv),
    embeddingIdx: index("chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);

export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker"),
  agent: text("agent").notNull(), // dossier | thesis | strix | accounting | industry | catalyst | valuation | evidence_auditor | synthesis
  model: text("model"),
  inputSummary: text("input_summary"),
  output: text("output").notNull(), // JSON report
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const traces = pgTable("traces", {
  id: serial("id").primaryKey(),
  researcher: text("researcher").notNull(), // agent name or human analyst
  ticker: text("ticker"),
  companyId: integer("company_id").references(() => companies.id),
  currentQuestion: text("current_question").notNull(),
  actionTaken: text("action_taken").notNull(),
  sourceType: text("source_type"), // SEC filing | transcript | competitor | model | agent_report | ...
  informationSeen: text("information_seen"),
  interpretation: text("interpretation"),
  signalCategory: text("signal_category"), // accounting_red_flag | demand_signal | valuation_gap | catalyst | noise | ...
  confidenceChange: real("confidence_change"), // -1..1
  nextAction: text("next_action"),
  reasoningPattern: text("reasoning_pattern"),
  outcome: text("outcome"), // filled in later by postmortems / labeling
  label: text("label"), // human label: strong_signal | weak_signal | false_positive | ...
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const quotes = pgTable("quotes", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull().unique(),
  price: real("price").notNull(),
  prevClose: real("prev_close"),
  dayChangePct: real("day_change_pct"),
  currency: text("currency"),
  marketCap: real("market_cap"), // raw $ when the source provides it
  history: text("history"), // JSON number[] of recent daily closes (oldest → newest) for sparklines
  avgVolume: real("avg_volume"), // avg daily share volume over recent sessions, when the source provides it
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
});

export const fundamentals = pgTable("fundamentals", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull().unique(),
  companyId: integer("company_id").references(() => companies.id),
  revenue: real("revenue"), // most recent annual, raw $
  operatingIncome: real("operating_income"),
  netIncome: real("net_income"),
  sharesOutstanding: real("shares_outstanding"),
  cash: real("cash"),
  debt: real("debt"),
  fiscalPeriod: text("fiscal_period"), // e.g. "FY2025 (ended 2025-12-31)"
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
});

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  memoId: integer("memo_id").references(() => memos.id),
  ticker: text("ticker").notNull(),
  entryPrice: real("entry_price").notNull(),
  entryDate: text("entry_date").notNull(), // ISO date
  sizePct: real("size_pct").notNull(), // % of NAV at entry
  status: text("status").notNull().default("open"), // open | closed
  exitPrice: real("exit_price"),
  exitDate: text("exit_date"), // ISO date
  killCriteria: text("kill_criteria"), // JSON string[] — thesis kill criteria snapshotted at entry
  owner: text("owner"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const postmortems = pgTable("postmortems", {
  id: serial("id").primaryKey(),
  positionId: integer("position_id").references(() => positions.id),
  companyId: integer("company_id").notNull().references(() => companies.id),
  ticker: text("ticker").notNull(),
  outcome: text("outcome").notNull(), // win | loss | scratch
  thesisRight: text("thesis_right").notNull(), // right | wrong | right_for_wrong_reason
  timingRight: boolean("timing_right").notNull().default(false),
  sizingRight: boolean("sizing_right").notNull().default(false),
  narrative: text("narrative").notNull(),
  lessons: text("lessons"), // JSON string[]
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const quantSnapshots = pgTable("quant_snapshots", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  companyId: integer("company_id").references(() => companies.id),
  data: text("data").notNull(), // JSON of all computed metrics (NameQuant)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const researchQuestions = pgTable("research_questions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker").notNull(),
  parentId: integer("parent_id"), // self-reference, no FK
  depth: integer("depth").notNull().default(0),
  question: text("question").notNull(),
  status: text("status").notNull().default("pending"), // pending | answered | spawned
  answer: text("answer"),
  confidence: real("confidence"),
  agent: text("agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const debates = pgTable("debates", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker").notNull(),
  memoId: integer("memo_id").references(() => memos.id),
  verdict: text("verdict"),
  conviction: real("conviction"),
  crux: text("crux"), // the single unresolved disagreement
  resolvingEvidence: text("resolving_evidence"),
  status: text("status").notNull().default("running"), // running | settled | aborted
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const debateTurns = pgTable("debate_turns", {
  id: serial("id").primaryKey(),
  debateId: integer("debate_id").notNull().references(() => debates.id),
  round: text("round").notNull(), // opening | rebuttal | cross | final | verdict
  seat: text("seat").notNull(), // advocate | strix | quant | moderator
  content: text("content").notNull(),
  modelId: text("model_id"),
  idx: integer("idx").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const portfolio = pgTable("portfolio", {
  id: serial("id").primaryKey(),
  nav: real("nav").notNull(),
  cash: real("cash"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const councilBriefs = pgTable("council_briefs", {
  id: serial("id").primaryKey(),
  regime: text("regime"),
  content: text("content").notNull(), // JSON brief
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  kind: text("kind").notNull(), // options_flow | options_chain | short_pressure | insider | news_burst
  value: real("value"), // the headline metric for the kind (e.g. put/call ratio, short ratio, net insider $)
  z: real("z"), // z-score vs stored history; null until enough observations exist
  asOf: text("as_of").notNull(), // the DATA's own timestamp/date (ISO), never our fetch time
  payload: text("payload"), // JSON full detail
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const newsItems = pgTable("news_items", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  source: text("source"),
  publishedAt: text("published_at"), // ISO, from the feed
  tag: text("tag"), // bullish | bearish | neutral — keyword tag
  classified: text("classified"), // LLM label into the signal taxonomy, when keys exist
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const directives = pgTable("directives", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  companyId: integer("company_id").references(() => companies.id),
  action: text("action").notNull(), // BUY | ADD | HOLD | TRIM | EXIT | AVOID | HEDGE
  conviction: integer("conviction").notNull(), // 0-100, |posterior − 0.5| × 200 scaled by data coverage
  pThesis: real("p_thesis").notNull(), // Bayesian posterior P(thesis)
  expectedMovePct: real("expected_move_pct"), // RND implied move by the chosen expiry, %
  ev90dPct: real("ev_90d_pct"), // risk-adjusted 90d expected value, %
  sizeTargetPct: real("size_target_pct"), // recommended size, % of NAV
  reasons: text("reasons").notNull(), // JSON string[3] — plain English
  biggestRisk: text("biggest_risk").notNull(),
  flipCondition: text("flip_condition").notNull(),
  dataCoverage: text("data_coverage").notNull(), // JSON — which sources were live/stale/missing
  inputs: text("inputs").notNull(), // JSON — the full show-the-work payload
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker"),
  severity: integer("severity").notNull().default(3), // 1 highest – 5 lowest
  kind: text("kind").notNull(), // thesis_break | filing | catalyst | signal | stale_thesis | insider | noise_drop
  message: text("message").notNull(),
  suggestedAction: text("suggested_action"),
  resolved: boolean("resolved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// AUGURY — trader-intelligence module. Self-contained vertical that ingests
// tracked traders' posts, grounds each in point-in-time market context, decodes
// them into structured "calls", and backtests them. Lives under its own
// namespace; reuses companies (FK) and the model router. See the Augury plan.
// ---------------------------------------------------------------------------

// Tracked traders. Seeded from lib/augury/authors.config.ts.
export const authors = pgTable(
  "authors",
  {
    id: serial("id").primaryKey(),
    handle: text("handle").notNull(), // platform handle, without the leading @
    platform: text("platform").notNull().default("x"), // x | ... (TweetSource platform)
    displayName: text("display_name"),
    platformUserId: text("platform_user_id"), // stable id from the platform
    bio: text("bio"),
    active: boolean("active").notNull().default(true),
    firstPostAt: timestamp("first_post_at", { withTimezone: true }), // earliest known post time
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniqHandle: unique().on(t.platform, t.handle),
  }),
);

// Raw posts/tweets, deduped by platformPostId.
export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => authors.id),
  platformPostId: text("platform_post_id").notNull().unique(), // dedupe key from the source
  url: text("url"),
  text: text("text").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }), // the post's own timestamp
  isReply: boolean("is_reply").notNull().default(false),
  isRetweet: boolean("is_retweet").notNull().default(false),
  isQuote: boolean("is_quote").notNull().default(false),
  conversationId: text("conversation_id"),
  replyToId: text("reply_to_id"), // platform id of the post this replies to
  quotedPostId: text("quoted_post_id"), // platform id of the quoted post
  metrics: text("metrics"), // JSON: { likes, retweets, replies, quotes, views, bookmarks } (all optional)
  media: text("media"), // JSON: { type, url, thumbnailUrl?, altText? }[]
  raw: text("raw"), // JSON: original provider payload, stored verbatim
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  embedding: vector("embedding", { dimensions: 1536 }), // v2 (additive): pgvector semantic memory; null when embeddings are disabled (FTS-only fallback)
}, (t) => ({
  // HNSW cosine index over the post embedding (mirrors chunks_embedding_idx).
  embeddingIdx: index("posts_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
}));

// Tickers referenced by a post.
export const tickerMentions = pgTable("ticker_mentions", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => posts.id),
  ticker: text("ticker").notNull(),
  mentionType: text("mention_type").notNull().default("cashtag"), // cashtag | name | implicit
  confidence: real("confidence").notNull().default(1),
  companyId: integer("company_id").references(() => companies.id), // nullable FK to existing companies
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// v2 (additive): LLM-resolved entities referenced by a post — tickers without
// cashtags, company names, themes, macro topics — populated by the `resolve`
// stage. Superset of ticker_mentions; role classifies how the post uses each.
export const postEntities = pgTable(
  "post_entities",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id").notNull().references(() => posts.id),
    entityType: text("entity_type").notNull(), // ticker | theme | macro (EntityType)
    value: text("value").notNull(), // resolved symbol / company name / theme / macro topic
    role: text("role").notNull().default("mention"), // subject | comparison | mention (EntityRole)
    confidence: real("confidence").notNull().default(1), // 0..1
    companyId: integer("company_id").references(() => companies.id), // nullable FK to existing companies
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniqPostEntity: unique().on(t.postId, t.entityType, t.value),
  }),
);

// The interpretation core: one structured "call" per market-relevant post.
export const calls = pgTable("calls", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => authors.id),
  postId: integer("post_id").notNull().references(() => posts.id),
  ticker: text("ticker"), // nullable: a market-relevant post may name no single ticker
  subjectType: text("subject_type").default("ticker"), // v2 (additive): ticker | theme | macro (SubjectType); nullable, defaults to "ticker"
  stance: text("stance").notNull(), // bullish | bearish | neutral | hedge
  lifecycleStage: text("lifecycle_stage").notNull(), // watching | initiating | entered | adding | trimming | exiting | closed | commentary
  sizeDelta: text("size_delta"), // v2 (additive): starter | add | trim | exit | none (SizeDelta); nullable
  conviction: real("conviction"), // 0..1
  horizon: text("horizon"), // intraday | swing | weeks | months | long_term | unspecified
  thesisSummary: text("thesis_summary"),
  catalyst: text("catalyst"),
  priceRefAtPost: real("price_ref_at_post"), // stock price as of the post, for reference
  targetPrice: real("target_price"),
  stopRef: real("stop_ref"),
  isUpdateOf: integer("is_update_of"), // self-reference to calls.id (no FK, like research_questions.parentId) — threads a position
  positionId: integer("position_id"), // v2 (additive): soft link to augury_positions.id (no FK, set by the `link` stage); nullable
  rawQuote: text("raw_quote"), // the verbatim line the call was extracted from
  extractorModel: text("extractor_model"), // model id that produced this call
  reviewedByHuman: boolean("reviewed_by_human").notNull().default(false),
  label: text("label"), // human label, filled in later
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// v2 (additive): first-class trader Positions — one campaign per (author, subject),
// threading calls watching → open → closed. NOTE: namespaced `augury_positions`
// because the IC/portfolio system already owns the `positions` table/export above.
// The new `link` stage opens/advances/closes these.
export const auguryPositions = pgTable(
  "augury_positions",
  {
    id: serial("id").primaryKey(),
    authorId: integer("author_id").notNull().references(() => authors.id),
    subjectType: text("subject_type").notNull(), // ticker | theme | macro (SubjectType)
    subject: text("subject").notNull(), // ticker symbol / theme / macro topic
    direction: text("direction"), // bullish | bearish | hedge | ... (nullable until committed)
    status: text("status").notNull().default("watching"), // watching | open | closed (PositionStatus)
    currentStage: text("current_stage"), // latest LifecycleStage of the campaign
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    peakConviction: real("peak_conviction"), // max conviction seen across the campaign
    firstCallId: integer("first_call_id"), // opening calls.id (no FK)
    lastCallId: integer("last_call_id"), // most-recent calls.id (no FK)
    sizeTrajectory: text("size_trajectory"), // JSON: SizeTrajectoryEvent[] (stage + sizeDelta events)
    thesisEvolution: text("thesis_evolution"), // JSON: ThesisEvolutionEvent[]
    realizedOutcome: text("realized_outcome"), // nullable summary once closed
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    bySubject: index("augury_positions_author_subject_idx").on(
      t.authorId,
      t.subjectType,
      t.subject,
    ),
  }),
);

// Point-in-time daily history, unique per (ticker, date).
export const dailyBars = pgTable(
  "daily_bars",
  {
    id: serial("id").primaryKey(),
    ticker: text("ticker").notNull(),
    date: text("date").notNull(), // ISO date (YYYY-MM-DD)
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close"),
    adjClose: real("adj_close"),
    volume: real("volume"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniqTickerDate: unique().on(t.ticker, t.date),
  }),
);

// Sparse intraday bars cached only around post timestamps, unique per (ticker, ts).
export const intradayBars = pgTable(
  "intraday_bars",
  {
    id: serial("id").primaryKey(),
    ticker: text("ticker").notNull(),
    ts: text("ts").notNull(), // ISO timestamp of the bar's start
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close"),
    volume: real("volume"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniqTickerTs: unique().on(t.ticker, t.ts),
  }),
);

// Cached "what was going on" around a post, unique per post.
export const postContext = pgTable("post_context", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().unique().references(() => posts.id),
  ticker: text("ticker"), // subject ticker for the return windows, when applicable
  returns: text("returns"), // JSON: { "-5d", "-1d", "+1d", "+5d", "+30d" } adjusted % returns around the post (null when out of range)
  marketRegime: text("market_regime"), // risk_on | risk_off | neutral | transition
  vix: real("vix"),
  sectorMovePct: real("sector_move_pct"), // sector ETF % move around the post
  newsSnapshot: text("news_snapshot"), // JSON: { title, url, source, publishedAt }[]
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// v2 (additive): shared point-in-time market + world context, cached once per
// calendar date (no look-ahead). Built by the `context` stage and reused across
// every post from that day.
export const macroContext = pgTable("macro_context", {
  id: serial("id").primaryKey(),
  date: text("date").notNull().unique(), // ISO date (YYYY-MM-DD) — one row per day
  sp500: real("sp500"), // S&P 500 level as of the date
  sp500Return5dPct: real("sp500_return_5d_pct"), // trailing 5d % move
  vix: real("vix"), // historical VIX close for the date
  rates: text("rates"), // JSON: MacroRates (e.g. { us2y, us10y, ... })
  regime: text("regime"), // MarketRegime: risk_on | risk_off | neutral | transition
  worldDigest: text("world_digest"), // point-in-time macro / world-events digest
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Per call × horizon backtest result.
export const backtests = pgTable("backtests", {
  id: serial("id").primaryKey(),
  callId: integer("call_id").notNull().references(() => calls.id),
  ticker: text("ticker").notNull(),
  horizon: text("horizon").notNull(), // label, e.g. 7d | 30d | 90d | 180d | 365d | to_date
  entryDate: text("entry_date"), // ISO date
  entryPrice: real("entry_price"),
  evalDate: text("eval_date"), // ISO date
  evalPrice: real("eval_price"),
  rawReturnPct: real("raw_return_pct"),
  benchmarkReturnPct: real("benchmark_return_pct"),
  alphaPct: real("alpha_pct"),
  outcome: text("outcome"), // right | wrong | partial | too_early | inconclusive
  judgeNotes: text("judge_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Materialized per-author aggregates + synthesized playbook.
export const authorScorecards = pgTable("author_scorecards", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").notNull().references(() => authors.id),
  hitRate: real("hit_rate"), // overall fraction of "right" calls
  avgAlphaPct: real("avg_alpha_pct"), // overall avg benchmark-relative alpha
  sampleSize: integer("sample_size").notNull().default(0), // calls scored
  byHorizon: text("by_horizon"), // JSON: { [horizon]: { hitRate, avgAlphaPct, n } }
  byStance: text("by_stance"), // JSON: { [stance]: { hitRate, avgAlphaPct, n } }
  bySector: text("by_sector"), // JSON: { [sector]: { hitRate, avgAlphaPct, n } }
  convictionCalibration: text("conviction_calibration"), // JSON: { bucket, predicted, realizedHitRate, n }[]
  playbook: text("playbook"), // JSON: AuthorPlaybook synthesis (grounded, cites post ids)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  // v2 (additive): one scorecard per author — upsert target for the profile stage.
  uniqAuthor: unique().on(t.authorId),
}));

// Durable job queue backing the resumable ingest/resolve/context/extract/link/backtest/profile pipeline.
export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // JobKind: ingest | context | extract | backtest | profile | resolve | link
  payload: text("payload").notNull(), // JSON; shape depends on kind
  status: text("status").notNull().default("queued"), // queued | running | done | failed
  attempts: integer("attempts").notNull().default(0),
  runAfter: timestamp("run_after", { withTimezone: true }).defaultNow(), // earliest eligible run time
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
