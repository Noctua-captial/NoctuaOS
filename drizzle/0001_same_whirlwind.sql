CREATE TABLE "augury_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"subject_type" text NOT NULL,
	"subject" text NOT NULL,
	"direction" text,
	"status" text DEFAULT 'watching' NOT NULL,
	"current_stage" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"peak_conviction" real,
	"first_call_id" integer,
	"last_call_id" integer,
	"size_trajectory" text,
	"thesis_evolution" text,
	"realized_outcome" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "macro_context" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"sp500" real,
	"sp500_return_5d_pct" real,
	"vix" real,
	"rates" text,
	"regime" text,
	"world_digest" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "macro_context_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "post_entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"value" text NOT NULL,
	"role" text DEFAULT 'mention' NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"company_id" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "post_entities_post_id_entity_type_value_unique" UNIQUE("post_id","entity_type","value")
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "subject_type" text DEFAULT 'ticker';--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "size_delta" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "position_id" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "augury_positions" ADD CONSTRAINT "augury_positions_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_entities" ADD CONSTRAINT "post_entities_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_entities" ADD CONSTRAINT "post_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "augury_positions_author_subject_idx" ON "augury_positions" USING btree ("author_id","subject_type","subject");--> statement-breakpoint
CREATE INDEX "posts_embedding_idx" ON "posts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "author_scorecards" ADD CONSTRAINT "author_scorecards_author_id_unique" UNIQUE("author_id");