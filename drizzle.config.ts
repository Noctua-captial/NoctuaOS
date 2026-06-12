import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "./noctua.db" },
  tablesFilter: ["!chunks_fts*"],
});
