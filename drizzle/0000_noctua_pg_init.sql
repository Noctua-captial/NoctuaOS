CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text,
	"agent" text NOT NULL,
	"model" text,
	"input_summary" text,
	"output" text NOT NULL,
	"investigation_id" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"latency_ms" integer,
	"llm_calls" integer DEFAULT 1,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text,
	"severity" integer DEFAULT 3 NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"suggested_action" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalysts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text,
	"expected_date" text,
	"impact" text,
	"investigation_id" text
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" text
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"text" text NOT NULL,
	"kind" text DEFAULT 'unverified' NOT NULL,
	"supports" text DEFAULT 'neutral' NOT NULL,
	"confidence" double precision DEFAULT 0.5 NOT NULL,
	"source" text,
	"source_type" text,
	"investigation_id" text,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"sector" text,
	"market_cap" text,
	"liquidity" text,
	"status" text DEFAULT 'pipeline' NOT NULL,
	"thesis_status" text DEFAULT 'stable',
	"theme" text,
	"conviction_score" integer,
	"owner_analyst" text,
	"business_summary" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "companies_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "council_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"regime" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "debate_turns" (
	"id" serial PRIMARY KEY NOT NULL,
	"debate_id" integer NOT NULL,
	"round" text NOT NULL,
	"seat" text NOT NULL,
	"content" text NOT NULL,
	"model_id" text,
	"idx" integer NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "debates" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text NOT NULL,
	"memo_id" integer,
	"verdict" text,
	"conviction" double precision,
	"crux" text,
	"resolving_evidence" text,
	"status" text DEFAULT 'running' NOT NULL,
	"investigation_id" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "directives" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company_id" integer,
	"action" text NOT NULL,
	"conviction" integer NOT NULL,
	"p_thesis" double precision NOT NULL,
	"expected_move_pct" double precision,
	"ev_90d_pct" double precision,
	"size_target_pct" double precision,
	"reasons" text NOT NULL,
	"biggest_risk" text NOT NULL,
	"flip_condition" text NOT NULL,
	"data_coverage" text NOT NULL,
	"inputs" text NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text,
	"title" text NOT NULL,
	"doc_type" text DEFAULT 'note' NOT NULL,
	"form_type" text,
	"source" text,
	"filed_at" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fundamentals" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company_id" integer,
	"revenue" double precision,
	"operating_income" double precision,
	"net_income" double precision,
	"shares_outstanding" double precision,
	"cash" double precision,
	"debt" double precision,
	"fiscal_period" text,
	"fetched_at" timestamp with time zone,
	CONSTRAINT "fundamentals_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "memos" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"analyst" text DEFAULT 'Athena (draft)' NOT NULL,
	"proposed_action" text,
	"proposed_size" text,
	"recommendation" text DEFAULT 'more_work',
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"content" text NOT NULL,
	"investigation_id" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"source" text,
	"published_at" text,
	"tag" text,
	"classified" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "news_items_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "portfolio" (
	"id" serial PRIMARY KEY NOT NULL,
	"nav" double precision NOT NULL,
	"cash" double precision,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"memo_id" integer,
	"ticker" text NOT NULL,
	"entry_price" double precision NOT NULL,
	"entry_date" text NOT NULL,
	"size_pct" double precision NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"exit_price" double precision,
	"exit_date" text,
	"kill_criteria" text,
	"owner" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "postmortems" (
	"id" serial PRIMARY KEY NOT NULL,
	"position_id" integer,
	"company_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"outcome" text NOT NULL,
	"thesis_right" text NOT NULL,
	"timing_right" boolean DEFAULT false NOT NULL,
	"sizing_right" boolean DEFAULT false NOT NULL,
	"narrative" text NOT NULL,
	"lessons" text,
	"created_by" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quant_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company_id" integer,
	"data" text NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"price" double precision NOT NULL,
	"prev_close" double precision,
	"day_change_pct" double precision,
	"currency" text,
	"market_cap" double precision,
	"history" text,
	"avg_volume" double precision,
	"fetched_at" timestamp with time zone,
	CONSTRAINT "quotes_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "research_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text NOT NULL,
	"parent_id" integer,
	"depth" integer DEFAULT 0 NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"confidence" double precision,
	"agent" text,
	"investigation_id" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"total" integer NOT NULL,
	"components" text NOT NULL,
	"rationale" text NOT NULL,
	"investigation_id" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"kind" text NOT NULL,
	"value" double precision,
	"z" double precision,
	"as_of" text NOT NULL,
	"payload" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "theses" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"one_liner" text NOT NULL,
	"variant_perception" text,
	"why_market_wrong" text,
	"why_now" text,
	"what_must_happen" text,
	"kill_criteria" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" serial PRIMARY KEY NOT NULL,
	"researcher" text NOT NULL,
	"ticker" text,
	"company_id" integer,
	"current_question" text NOT NULL,
	"action_taken" text NOT NULL,
	"source_type" text,
	"information_seen" text,
	"interpretation" text,
	"signal_category" text,
	"confidence_change" double precision,
	"next_action" text,
	"reasoning_pattern" text,
	"outcome" text,
	"label" text,
	"investigation_id" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalysts" ADD CONSTRAINT "catalysts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debate_turns" ADD CONSTRAINT "debate_turns_debate_id_debates_id_fk" FOREIGN KEY ("debate_id") REFERENCES "public"."debates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debates" ADD CONSTRAINT "debates_memo_id_memos_id_fk" FOREIGN KEY ("memo_id") REFERENCES "public"."memos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directives" ADD CONSTRAINT "directives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memos" ADD CONSTRAINT "memos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_memo_id_memos_id_fk" FOREIGN KEY ("memo_id") REFERENCES "public"."memos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quant_snapshots" ADD CONSTRAINT "quant_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_questions" ADD CONSTRAINT "research_questions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;