import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Supabase Postgres via the Supavisor transaction pooler (serverless-safe).
// `prepare: false` is REQUIRED for the transaction pooler (it can't keep
// prepared statements across pooled connections). Keep the pool small — each
// serverless instance opens its own connections behind the pooler.
const connectionString =
  process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.POSTGRES_PRISMA_URL ?? "";

function makeClient() {
  return postgres(connectionString, {
    prepare: false,
    max: Number(process.env.NOCTUA_PG_MAX ?? 3),
    idle_timeout: 20,
    connect_timeout: 15,
  });
}

// Reuse one client across HMR reloads (dev) and warm serverless invocations so
// we don't exhaust connections.
const globalForDb = globalThis as unknown as { __noctuaPg?: ReturnType<typeof makeClient> };
export const sqlClient = globalForDb.__noctuaPg ?? makeClient();
if (process.env.NODE_ENV !== "production") globalForDb.__noctuaPg = sqlClient;

export const db = drizzle(sqlClient, { schema });
export * as tables from "./schema";
