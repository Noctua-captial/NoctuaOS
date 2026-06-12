import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const theses = sqliteTable("theses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").notNull().references(() => companies.id),
  version: integer("version").notNull().default(1),
  oneLiner: text("one_liner").notNull(),
  variantPerception: text("variant_perception"),
  whyMarketWrong: text("why_market_wrong"),
  whyNow: text("why_now"),
  whatMustHappen: text("what_must_happen"), // JSON string[]
  killCriteria: text("kill_criteria"), // JSON string[]
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const claims = sqliteTable("claims", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").notNull().references(() => companies.id),
  text: text("text").notNull(),
  kind: text("kind").notNull().default("unverified"), // fact | inference | opinion | model_assumption | unverified
  supports: text("supports").notNull().default("neutral"), // bull | bear | neutral
  confidence: real("confidence").notNull().default(0.5),
  source: text("source"),
  sourceType: text("source_type"), // filing | transcript | pricing_data | analyst_note | competitor | news
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const catalysts = sqliteTable("catalysts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").notNull().references(() => companies.id),
  title: text("title").notNull(),
  kind: text("kind"), // earnings | product | regulatory | contract | macro | index | guidance
  expectedDate: text("expected_date"), // ISO date or fuzzy ("Q3 2026")
  impact: text("impact"), // what it could change
});

export const scores = sqliteTable("scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").notNull().references(() => companies.id),
  total: integer("total").notNull(),
  components: text("components").notNull(), // JSON {thesisClarity, evidenceQuality, ...}
  rationale: text("rationale").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const memos = sqliteTable("memos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").notNull().references(() => companies.id),
  version: integer("version").notNull().default(1),
  analyst: text("analyst").notNull().default("Athena (draft)"),
  proposedAction: text("proposed_action"),
  proposedSize: text("proposed_size"),
  recommendation: text("recommendation").default("more_work"), // approve | reject | more_work
  decidedBy: text("decided_by"), // human IC member who made the call
  decidedAt: integer("decided_at", { mode: "timestamp" }),
  content: text("content").notNull(), // JSON of all 14 memo sections
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker"),
  title: text("title").notNull(),
  docType: text("doc_type").notNull().default("note"), // filing | transcript | presentation | note | article | expert_call
  formType: text("form_type"), // 10-K | 10-Q | 8-K | ...
  source: text("source"), // URL or provenance
  filedAt: text("filed_at"), // ISO date
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const chunks = sqliteTable("chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  documentId: integer("document_id").notNull().references(() => documents.id),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  embedding: text("embedding"), // JSON number[] when embeddings are enabled
});

export const agentRuns = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker"),
  agent: text("agent").notNull(), // dossier | thesis | strix | accounting | industry | catalyst | valuation | evidence_auditor | synthesis
  model: text("model"),
  inputSummary: text("input_summary"),
  output: text("output").notNull(), // JSON report
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const traces = sqliteTable("traces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const quotes = sqliteTable("quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  price: real("price").notNull(),
  prevClose: real("prev_close"),
  dayChangePct: real("day_change_pct"),
  currency: text("currency"),
  marketCap: real("market_cap"), // raw $ when the source provides it
  history: text("history"), // JSON number[] of recent daily closes (oldest → newest) for sparklines
  avgVolume: real("avg_volume"), // avg daily share volume over recent sessions, when the source provides it
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const fundamentals = sqliteTable("fundamentals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull().unique(),
  companyId: integer("company_id").references(() => companies.id),
  revenue: real("revenue"), // most recent annual, raw $
  operatingIncome: real("operating_income"),
  netIncome: real("net_income"),
  sharesOutstanding: real("shares_outstanding"),
  cash: real("cash"),
  debt: real("debt"),
  fiscalPeriod: text("fiscal_period"), // e.g. "FY2025 (ended 2025-12-31)"
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const positions = sqliteTable("positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const postmortems = sqliteTable("postmortems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  positionId: integer("position_id").references(() => positions.id),
  companyId: integer("company_id").notNull().references(() => companies.id),
  ticker: text("ticker").notNull(),
  outcome: text("outcome").notNull(), // win | loss | scratch
  thesisRight: text("thesis_right").notNull(), // right | wrong | right_for_wrong_reason
  timingRight: integer("timing_right", { mode: "boolean" }).notNull().default(false),
  sizingRight: integer("sizing_right", { mode: "boolean" }).notNull().default(false),
  narrative: text("narrative").notNull(),
  lessons: text("lessons"), // JSON string[]
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const quantSnapshots = sqliteTable("quant_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  companyId: integer("company_id").references(() => companies.id),
  data: text("data").notNull(), // JSON of all computed metrics (NameQuant)
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const researchQuestions = sqliteTable("research_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker").notNull(),
  parentId: integer("parent_id"), // self-reference, no FK
  depth: integer("depth").notNull().default(0),
  question: text("question").notNull(),
  status: text("status").notNull().default("pending"), // pending | answered | spawned
  answer: text("answer"),
  confidence: real("confidence"),
  agent: text("agent"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const debates = sqliteTable("debates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker").notNull(),
  memoId: integer("memo_id").references(() => memos.id),
  verdict: text("verdict"),
  conviction: real("conviction"),
  crux: text("crux"), // the single unresolved disagreement
  resolvingEvidence: text("resolving_evidence"),
  status: text("status").notNull().default("running"), // running | settled | aborted
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const debateTurns = sqliteTable("debate_turns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  debateId: integer("debate_id").notNull().references(() => debates.id),
  round: text("round").notNull(), // opening | rebuttal | cross | final | verdict
  seat: text("seat").notNull(), // advocate | strix | quant | moderator
  content: text("content").notNull(),
  modelId: text("model_id"),
  idx: integer("idx").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const portfolio = sqliteTable("portfolio", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nav: real("nav").notNull(),
  cash: real("cash"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const councilBriefs = sqliteTable("council_briefs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  regime: text("regime"),
  content: text("content").notNull(), // JSON brief
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const signals = sqliteTable("signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  kind: text("kind").notNull(), // options_flow | options_chain | short_pressure | insider | news_burst
  value: real("value"), // the headline metric for the kind (e.g. put/call ratio, short ratio, net insider $)
  z: real("z"), // z-score vs stored history; null until enough observations exist
  asOf: text("as_of").notNull(), // the DATA's own timestamp/date (ISO), never our fetch time
  payload: text("payload"), // JSON full detail
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const newsItems = sqliteTable("news_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull().unique(),
  source: text("source"),
  publishedAt: text("published_at"), // ISO, from the feed
  tag: text("tag"), // bullish | bearish | neutral — keyword tag
  classified: text("classified"), // LLM label into the signal taxonomy, when keys exist
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const directives = sqliteTable("directives", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker"),
  severity: integer("severity").notNull().default(3), // 1 highest – 5 lowest
  kind: text("kind").notNull(), // thesis_break | filing | catalyst | signal | stale_thesis | insider | noise_drop
  message: text("message").notNull(),
  suggestedAction: text("suggested_action"),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});
