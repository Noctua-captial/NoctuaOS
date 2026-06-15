import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";

// Postgres (Supabase) schema. Floats use doublePrecision to match SQLite's
// 8-byte REAL; timestamps use mode:"date" so callers keep getting Date objects.
// JSON payloads remain `text` (the app does JSON.stringify/parse itself).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

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
  createdAt: ts("created_at").$defaultFn(() => new Date()),
  updatedAt: ts("updated_at").$defaultFn(() => new Date()),
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
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const claims = pgTable("claims", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  text: text("text").notNull(),
  kind: text("kind").notNull().default("unverified"), // fact | inference | opinion | model_assumption | unverified
  supports: text("supports").notNull().default("neutral"), // bull | bear | neutral
  confidence: doublePrecision("confidence").notNull().default(0.5),
  source: text("source"),
  sourceType: text("source_type"), // filing | transcript | pricing_data | analyst_note | competitor | news
  // Investigation that produced this claim. NULL = added by a human analyst —
  // re-running Athena replaces agent claims but preserves analyst claims.
  investigationId: text("investigation_id"),
  updatedAt: ts("updated_at").$defaultFn(() => new Date()),
});

export const catalysts = pgTable("catalysts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  title: text("title").notNull(),
  kind: text("kind"), // earnings | product | regulatory | contract | macro | index | guidance
  expectedDate: text("expected_date"), // ISO date or fuzzy ("Q3 2026")
  impact: text("impact"), // what it could change
  investigationId: text("investigation_id"), // NULL = analyst-added; agent rows replaced on re-run
});

export const scores = pgTable("scores", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  total: integer("total").notNull(),
  components: text("components").notNull(), // JSON {thesisClarity, evidenceQuality, ...}
  rationale: text("rationale").notNull(),
  investigationId: text("investigation_id"),
  createdAt: ts("created_at").$defaultFn(() => new Date()),
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
  decidedAt: ts("decided_at"),
  content: text("content").notNull(), // JSON of all 14 memo sections
  investigationId: text("investigation_id"),
  createdAt: ts("created_at").$defaultFn(() => new Date()),
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
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const chunks = pgTable("chunks", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => documents.id),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  embedding: text("embedding"), // JSON number[] when embeddings are enabled
  // NOTE: a generated `tsv tsvector` column + GIN index are added in the
  // migration SQL (drizzle's tsvector support is limited); Vault FTS uses it.
});

export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker"),
  agent: text("agent").notNull(), // dossier | thesis | strix | accounting | industry | catalyst | valuation | evidence_auditor | synthesis | research_tree | debate
  model: text("model"),
  inputSummary: text("input_summary"),
  output: text("output").notNull(), // JSON report
  investigationId: text("investigation_id"), // groups all artifacts from one Athena run
  // Telemetry — populated per run for cost/latency visibility in /lab.
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  latencyMs: integer("latency_ms"),
  llmCalls: integer("llm_calls").default(1), // >1 for aggregated stages (tree, debate)
  createdAt: ts("created_at").$defaultFn(() => new Date()),
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
  confidenceChange: doublePrecision("confidence_change"), // -1..1
  nextAction: text("next_action"),
  reasoningPattern: text("reasoning_pattern"),
  outcome: text("outcome"), // filled in later by postmortems / labeling
  label: text("label"), // human label: strong_signal | weak_signal | false_positive | ...
  investigationId: text("investigation_id"),
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const quotes = pgTable("quotes", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull().unique(),
  price: doublePrecision("price").notNull(),
  prevClose: doublePrecision("prev_close"),
  dayChangePct: doublePrecision("day_change_pct"),
  currency: text("currency"),
  marketCap: doublePrecision("market_cap"), // raw $ when the source provides it
  history: text("history"), // JSON number[] of recent daily closes (oldest → newest) for sparklines
  avgVolume: doublePrecision("avg_volume"), // avg daily share volume over recent sessions, when the source provides it
  fetchedAt: ts("fetched_at").$defaultFn(() => new Date()),
});

export const fundamentals = pgTable("fundamentals", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull().unique(),
  companyId: integer("company_id").references(() => companies.id),
  revenue: doublePrecision("revenue"), // most recent annual, raw $
  operatingIncome: doublePrecision("operating_income"),
  netIncome: doublePrecision("net_income"),
  sharesOutstanding: doublePrecision("shares_outstanding"),
  cash: doublePrecision("cash"),
  debt: doublePrecision("debt"),
  fiscalPeriod: text("fiscal_period"), // e.g. "FY2025 (ended 2025-12-31)"
  fetchedAt: ts("fetched_at").$defaultFn(() => new Date()),
});

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  memoId: integer("memo_id").references(() => memos.id),
  ticker: text("ticker").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  entryDate: text("entry_date").notNull(), // ISO date
  sizePct: doublePrecision("size_pct").notNull(), // % of NAV at entry
  status: text("status").notNull().default("open"), // open | closed
  exitPrice: doublePrecision("exit_price"),
  exitDate: text("exit_date"), // ISO date
  killCriteria: text("kill_criteria"), // JSON string[] — thesis kill criteria snapshotted at entry
  owner: text("owner"),
  createdAt: ts("created_at").$defaultFn(() => new Date()),
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
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const quantSnapshots = pgTable("quant_snapshots", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  companyId: integer("company_id").references(() => companies.id),
  data: text("data").notNull(), // JSON of all computed metrics (NameQuant)
  createdAt: ts("created_at").$defaultFn(() => new Date()),
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
  confidence: doublePrecision("confidence"),
  agent: text("agent"),
  investigationId: text("investigation_id"),
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const debates = pgTable("debates", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companies.id),
  ticker: text("ticker").notNull(),
  memoId: integer("memo_id").references(() => memos.id),
  verdict: text("verdict"),
  conviction: doublePrecision("conviction"),
  crux: text("crux"), // the single unresolved disagreement
  resolvingEvidence: text("resolving_evidence"),
  status: text("status").notNull().default("running"), // running | settled | aborted
  investigationId: text("investigation_id"),
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const debateTurns = pgTable("debate_turns", {
  id: serial("id").primaryKey(),
  debateId: integer("debate_id").notNull().references(() => debates.id),
  round: text("round").notNull(), // opening | rebuttal | cross | final | verdict
  seat: text("seat").notNull(), // advocate | strix | quant | moderator
  content: text("content").notNull(),
  modelId: text("model_id"),
  idx: integer("idx").notNull(),
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const portfolio = pgTable("portfolio", {
  id: serial("id").primaryKey(),
  nav: doublePrecision("nav").notNull(),
  cash: doublePrecision("cash"),
  updatedAt: ts("updated_at").$defaultFn(() => new Date()),
});

export const councilBriefs = pgTable("council_briefs", {
  id: serial("id").primaryKey(),
  regime: text("regime"),
  content: text("content").notNull(), // JSON brief
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  kind: text("kind").notNull(), // options_flow | options_chain | short_pressure | insider | news_burst
  value: doublePrecision("value"), // the headline metric for the kind (e.g. put/call ratio, short ratio, net insider $)
  z: doublePrecision("z"), // z-score vs stored history; null until enough observations exist
  asOf: text("as_of").notNull(), // the DATA's own timestamp/date (ISO), never our fetch time
  payload: text("payload"), // JSON full detail
  createdAt: ts("created_at").$defaultFn(() => new Date()),
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
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});

export const directives = pgTable("directives", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  companyId: integer("company_id").references(() => companies.id),
  action: text("action").notNull(), // BUY | ADD | HOLD | TRIM | EXIT | AVOID | HEDGE
  conviction: integer("conviction").notNull(), // 0-100, |posterior − 0.5| × 200 scaled by data coverage
  pThesis: doublePrecision("p_thesis").notNull(), // Bayesian posterior P(thesis)
  expectedMovePct: doublePrecision("expected_move_pct"), // RND implied move by the chosen expiry, %
  ev90dPct: doublePrecision("ev_90d_pct"), // risk-adjusted 90d expected value, %
  sizeTargetPct: doublePrecision("size_target_pct"), // recommended size, % of NAV
  reasons: text("reasons").notNull(), // JSON string[3] — plain English
  biggestRisk: text("biggest_risk").notNull(),
  flipCondition: text("flip_condition").notNull(),
  dataCoverage: text("data_coverage").notNull(), // JSON — which sources were live/stale/missing
  inputs: text("inputs").notNull(), // JSON — the full show-the-work payload
  createdAt: ts("created_at").$defaultFn(() => new Date()),
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
  createdAt: ts("created_at").$defaultFn(() => new Date()),
});
