CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text,
	"agent" text NOT NULL,
	"model" text,
	"input_summary" text,
	"output" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
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
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "author_scorecards" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"hit_rate" real,
	"avg_alpha_pct" real,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"by_horizon" text,
	"by_stance" text,
	"by_sector" text,
	"conviction_calibration" text,
	"playbook" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "authors" (
	"id" serial PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"platform" text DEFAULT 'x' NOT NULL,
	"display_name" text,
	"platform_user_id" text,
	"bio" text,
	"active" boolean DEFAULT true NOT NULL,
	"first_post_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "authors_platform_handle_unique" UNIQUE("platform","handle")
);
--> statement-breakpoint
CREATE TABLE "backtests" (
	"id" serial PRIMARY KEY NOT NULL,
	"call_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"horizon" text NOT NULL,
	"entry_date" text,
	"entry_price" real,
	"eval_date" text,
	"eval_price" real,
	"raw_return_pct" real,
	"benchmark_return_pct" real,
	"alpha_pct" real,
	"outcome" text,
	"judge_notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	"ticker" text,
	"stance" text NOT NULL,
	"lifecycle_stage" text NOT NULL,
	"conviction" real,
	"horizon" text,
	"thesis_summary" text,
	"catalyst" text,
	"price_ref_at_post" real,
	"target_price" real,
	"stop_ref" real,
	"is_update_of" integer,
	"raw_quote" text,
	"extractor_model" text,
	"reviewed_by_human" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "catalysts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text,
	"expected_date" text,
	"impact" text
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"text" text NOT NULL,
	"kind" text DEFAULT 'unverified' NOT NULL,
	"supports" text DEFAULT 'neutral' NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"source" text,
	"source_type" text,
	"updated_at" timestamp with time zone DEFAULT now()
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
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "companies_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "council_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"regime" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "daily_bars" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"date" text NOT NULL,
	"open" real,
	"high" real,
	"low" real,
	"close" real,
	"adj_close" real,
	"volume" real,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "daily_bars_ticker_date_unique" UNIQUE("ticker","date")
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
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "debates" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text NOT NULL,
	"memo_id" integer,
	"verdict" text,
	"conviction" real,
	"crux" text,
	"resolving_evidence" text,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "directives" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company_id" integer,
	"action" text NOT NULL,
	"conviction" integer NOT NULL,
	"p_thesis" real NOT NULL,
	"expected_move_pct" real,
	"ev_90d_pct" real,
	"size_target_pct" real,
	"reasons" text NOT NULL,
	"biggest_risk" text NOT NULL,
	"flip_condition" text NOT NULL,
	"data_coverage" text NOT NULL,
	"inputs" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
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
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fundamentals" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company_id" integer,
	"revenue" real,
	"operating_income" real,
	"net_income" real,
	"shares_outstanding" real,
	"cash" real,
	"debt" real,
	"fiscal_period" text,
	"fetched_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "fundamentals_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "intraday_bars" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"ts" text NOT NULL,
	"open" real,
	"high" real,
	"low" real,
	"close" real,
	"volume" real,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "intraday_bars_ticker_ts_unique" UNIQUE("ticker","ts")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now(),
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
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
	"created_at" timestamp with time zone DEFAULT now()
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
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "news_items_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "portfolio" (
	"id" serial PRIMARY KEY NOT NULL,
	"nav" real NOT NULL,
	"cash" real,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"memo_id" integer,
	"ticker" text NOT NULL,
	"entry_price" real NOT NULL,
	"entry_date" text NOT NULL,
	"size_pct" real NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"exit_price" real,
	"exit_date" text,
	"kill_criteria" text,
	"owner" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "post_context" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"ticker" text,
	"returns" text,
	"market_regime" text,
	"vix" real,
	"sector_move_pct" real,
	"news_snapshot" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "post_context_post_id_unique" UNIQUE("post_id")
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
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"platform_post_id" text NOT NULL,
	"url" text,
	"text" text NOT NULL,
	"posted_at" timestamp with time zone,
	"is_reply" boolean DEFAULT false NOT NULL,
	"is_retweet" boolean DEFAULT false NOT NULL,
	"is_quote" boolean DEFAULT false NOT NULL,
	"conversation_id" text,
	"reply_to_id" text,
	"quoted_post_id" text,
	"metrics" text,
	"media" text,
	"raw" text,
	"ingested_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "posts_platform_post_id_unique" UNIQUE("platform_post_id")
);
--> statement-breakpoint
CREATE TABLE "quant_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"company_id" integer,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"price" real NOT NULL,
	"prev_close" real,
	"day_change_pct" real,
	"currency" text,
	"market_cap" real,
	"history" text,
	"avg_volume" real,
	"fetched_at" timestamp with time zone DEFAULT now(),
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
	"confidence" real,
	"agent" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"total" integer NOT NULL,
	"components" text NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"kind" text NOT NULL,
	"value" real,
	"z" real,
	"as_of" text NOT NULL,
	"payload" text,
	"created_at" timestamp with time zone DEFAULT now()
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
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ticker_mentions" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"mention_type" text DEFAULT 'cashtag' NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"company_id" integer,
	"created_at" timestamp with time zone DEFAULT now()
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
	"confidence_change" real,
	"next_action" text,
	"reasoning_pattern" text,
	"outcome" text,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_scorecards" ADD CONSTRAINT "author_scorecards_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "post_context" ADD CONSTRAINT "post_context_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quant_snapshots" ADD CONSTRAINT "quant_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_questions" ADD CONSTRAINT "research_questions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticker_mentions" ADD CONSTRAINT "ticker_mentions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticker_mentions" ADD CONSTRAINT "ticker_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);