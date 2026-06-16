import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Lazy, import-safe Postgres (Supabase) DB layer.
//
// Importing this module NEVER connects and NEVER throws — even with
// DATABASE_URL unset. This is required so `next build` and keyless local dev can
// import any module transitively pulling in `@/db` without crashing. The
// postgres-js client is constructed on the FIRST ACTUAL use (first property
// access on `db`, or first call/property access on `sql`); if the env is missing
// at that point we throw one clear, actionable error.
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof postgres>;
type DB = PostgresJsDatabase<typeof schema>;

// Cache on globalThis so Next.js hot-reload / serverless reuse doesn't open a new
// pool on every module re-evaluation.
const globalForDb = globalThis as unknown as {
  __noctuaClient?: Sql;
  __noctuaDb?: DB;
};

function createClient(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the Supabase pooled (Supavisor) connection string " +
        "— host *.pooler.supabase.com, port 6543, with ?pgbouncer=true — before querying the database.",
    );
  }

  // SSL negotiation: Supabase/managed Postgres require TLS (incl. the pooled
  // :6543 handshake), while plain local Postgres usually does not.
  //  - If the URL already pins `sslmode` (e.g. ?sslmode=require|disable), pass
  //    NOTHING extra so postgres-js honors the URL verbatim — an explicit `ssl`
  //    option would otherwise override the URL's sslmode.
  //  - Otherwise default `ssl: 'require'` for non-local hosts, leaving
  //    localhost/127.0.0.1/::1 as a plaintext connection for local dev.
  // (`'require'` does TLS without strict cert-chain verification, as the pooler
  // expects.)
  let ssl: "require" | undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("sslmode")) {
      const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const isLocal =
        host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLocal) ssl = "require";
    }
  } catch {
    // Unparseable URL: assume a remote target and require TLS; postgres-js will
    // surface its own clear connection-string error if the URL is truly invalid.
    ssl = "require";
  }

  // The Supavisor transaction pooler (PgBouncer) is incompatible with prepared
  // statements, so `prepare: false` is mandatory for the pooled runtime URL.
  return postgres(url, { prepare: false, ...(ssl ? { ssl } : {}) });
}

function getClient(): Sql {
  if (!globalForDb.__noctuaClient) globalForDb.__noctuaClient = createClient();
  return globalForDb.__noctuaClient;
}

function getDb(): DB {
  if (!globalForDb.__noctuaDb) globalForDb.__noctuaDb = drizzle(getClient(), { schema });
  return globalForDb.__noctuaDb;
}

/**
 * The Drizzle ORM instance. Use for all schema-typed queries
 * (`db.select()`, `db.insert()`, `db.query.*`, `db.execute()`, …). Backed by a
 * Proxy that defers client construction to first property access, so a bare
 * `import { db } from "@/db"` is side-effect-free and connection-free.
 */
export const db = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
});

/**
 * The raw postgres-js client (tagged-template + helpers), for the few queries
 * Drizzle's builder can't express — Postgres full-text search
 * (`to_tsvector`/`websearch_to_tsquery`/`ts_rank`) and pgvector cosine search
 * (`embedding <=> $vec`). Usage: `await sql\`SELECT …\``. Lazily initialized
 * exactly like `db`; importing it never connects.
 */
export const sql = new Proxy(function () {} as unknown as Sql, {
  apply(_target, _thisArg, args) {
    const client = getClient() as unknown as (...a: unknown[]) => unknown;
    return client(...args);
  },
  get(_target, prop) {
    const real = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
});

export * as tables from "./schema";
