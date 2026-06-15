ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "chunks"."text")) STORED;--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_document_id_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_ticker_idx" ON "documents" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "signals_ticker_kind_idx" ON "signals" USING btree ("ticker","kind");