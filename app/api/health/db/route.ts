import { sql } from "drizzle-orm";
import { db } from "@/db";

export const maxDuration = 20;
export const dynamic = "force-dynamic";

// Liveness probe for the Postgres (Supabase) connection. Returns whether the
// app can reach the database and a redacted view of how it's configured, so
// connection problems can be diagnosed without exposing any secret. Never
// returns credentials — only the host/port/db and a sanitized error string.
function describeConnection(): {
  envVar: string | null;
  host: string | null;
  port: string | null;
  database: string | null;
  pooled: boolean | null;
} {
  const envVar = process.env.DATABASE_URL
    ? "DATABASE_URL"
    : process.env.POSTGRES_URL
      ? "POSTGRES_URL"
      : process.env.POSTGRES_PRISMA_URL
        ? "POSTGRES_PRISMA_URL"
        : null;
  const raw =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.POSTGRES_PRISMA_URL ?? "";
  if (!raw) return { envVar, host: null, port: null, database: null, pooled: null };
  try {
    const u = new URL(raw);
    return {
      envVar,
      host: u.hostname,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, "") || null,
      // Supabase Supavisor pooler hostnames contain "pooler.supabase.com".
      pooled: /pooler\.supabase\.com$/i.test(u.hostname),
    };
  } catch {
    return { envVar, host: null, port: null, database: null, pooled: null };
  }
}

function redact(message: string): string {
  // Strip any user:pass@ that might appear in a driver error.
  return message.replace(/\/\/[^@\s]*@/g, "//***:***@").slice(0, 400);
}

export async function GET() {
  const connection = describeConnection();
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1 as ok`);
    return Response.json({
      ok: true,
      latencyMs: Date.now() - startedAt,
      connection,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    const e = err as { message?: string; code?: string; name?: string; errno?: string };
    return Response.json(
      {
        ok: false,
        latencyMs: Date.now() - startedAt,
        connection,
        error: {
          name: e?.name ?? "Error",
          code: e?.code ?? e?.errno ?? null,
          message: redact(e?.message ?? String(err)),
        },
        checkedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
