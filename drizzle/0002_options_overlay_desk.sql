CREATE TABLE "option_backtests" (
	"id" serial PRIMARY KEY NOT NULL,
	"structure_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"eval_date" text,
	"eval_underlying" real,
	"structure_value" real,
	"structure_pnl_pct" real,
	"stock_only_pnl_pct" real,
	"overlay_alpha_pct" real,
	"iv_at_entry" real,
	"iv_at_eval" real,
	"outcome" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "option_legs" (
	"id" serial PRIMARY KEY NOT NULL,
	"structure_id" integer NOT NULL,
	"right" text NOT NULL,
	"action" text NOT NULL,
	"strike" real NOT NULL,
	"expiry" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"entry_mid" real,
	"entry_iv" real,
	"entry_delta" real,
	"entry_gamma" real,
	"entry_vega" real,
	"entry_theta" real,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "option_postmortems" (
	"id" serial PRIMARY KEY NOT NULL,
	"structure_id" integer,
	"company_id" integer,
	"ticker" text NOT NULL,
	"outcome" text NOT NULL,
	"vol_view_right" text NOT NULL,
	"direction_right" text NOT NULL,
	"structure_choice_right" boolean DEFAULT false NOT NULL,
	"theta_capture" text,
	"roll_history" text,
	"narrative" text NOT NULL,
	"lessons" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "option_scorecards" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy" text,
	"vol_regime" text,
	"hit_rate" real,
	"avg_overlay_alpha_pct" real,
	"avg_structure_pnl_pct" real,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"data" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "option_scorecards_strategy_vol_regime_unique" UNIQUE("strategy","vol_regime")
);
--> statement-breakpoint
CREATE TABLE "option_structures" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"ticker" text NOT NULL,
	"memo_id" integer,
	"directive_id" integer,
	"strategy" text NOT NULL,
	"direction" text,
	"status" text DEFAULT 'recommended' NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"net_debit" real,
	"max_loss" real,
	"max_gain" real,
	"breakevens" text,
	"pop" real,
	"ev_pct" real,
	"ev_rnd_pct" real,
	"capital_at_risk_pct" real,
	"entry_greeks" text,
	"entry_underlying" real,
	"expiry" text,
	"rationale" text,
	"binding_constraint" text,
	"created_by" text,
	"exit_net_value" real,
	"exit_underlying" real,
	"realized_pnl" real,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "option_backtests" ADD CONSTRAINT "option_backtests_structure_id_option_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."option_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_legs" ADD CONSTRAINT "option_legs_structure_id_option_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."option_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_postmortems" ADD CONSTRAINT "option_postmortems_structure_id_option_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."option_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_postmortems" ADD CONSTRAINT "option_postmortems_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_structures" ADD CONSTRAINT "option_structures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_structures" ADD CONSTRAINT "option_structures_memo_id_memos_id_fk" FOREIGN KEY ("memo_id") REFERENCES "public"."memos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "option_structures_ticker_idx" ON "option_structures" USING btree ("ticker","status");