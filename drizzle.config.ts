import { defineConfig } from "drizzle-kit";

// Migrations are generated from ./db/schema.ts and applied over the DIRECT
// (non-pooled, :5432) connection — Supavisor's transaction pooler (:6543) is for
// the app's runtime queries, not DDL. `generate` works without a live DB.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DIRECT_URL ?? "" },
});
