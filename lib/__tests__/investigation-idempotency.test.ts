// Verifies the Track C persistence guarantees against in-process Postgres
// (PGlite) — the real dialect the app now runs on:
//   1. re-running an investigation replaces the prior run's agent claims but
//      preserves analyst-added claims (the idempotency predicate in
//      app/api/athena/route.ts), and
//   2. Postgres transactions roll back atomically on failure (so a failed
//      commit leaves no partial research memory).
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { and, eq, isNotNull } from "drizzle-orm";
import * as schema from "@/db/schema";

type DB = PgliteDatabase<typeof schema>;

async function freshDb(): Promise<DB> {
  const client = new PGlite(); // ephemeral in-memory Postgres
  const db = drizzle(client, { schema });
  await client.exec(`
    CREATE TABLE claims (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      text text NOT NULL,
      kind text NOT NULL DEFAULT 'unverified',
      supports text NOT NULL DEFAULT 'neutral',
      confidence double precision NOT NULL DEFAULT 0.5,
      source text,
      source_type text,
      investigation_id text,
      updated_at timestamptz
    );
  `);
  return db;
}

/** Mirrors the route's replace-then-insert for one company's agent claims. */
async function commitAgentClaims(db: DB, companyId: number, investigationId: string, texts: string[]) {
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.claims)
      .where(and(eq(schema.claims.companyId, companyId), isNotNull(schema.claims.investigationId)));
    await tx.insert(schema.claims).values(texts.map((text) => ({ companyId, text, investigationId })));
  });
}

describe("investigation idempotency (Postgres)", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("replaces a prior run's agent claims while preserving analyst claims", async () => {
    // An analyst adds a claim by hand (no investigationId).
    await db.insert(schema.claims).values({ companyId: 1, text: "analyst: channel checks confirm demand" });
    // First investigation.
    await commitAgentClaims(db, 1, "run-1", ["agent: revenue accelerating", "agent: margins expanding"]);

    expect((await db.select().from(schema.claims)).length).toBe(3);

    // Re-investigate: agent claims are replaced, analyst claim survives.
    await commitAgentClaims(db, 1, "run-2", ["agent: revised — revenue decelerating"]);

    const rows = await db.select().from(schema.claims);
    const analyst = rows.filter((r) => r.investigationId == null);
    const run1 = rows.filter((r) => r.investigationId === "run-1");
    const run2 = rows.filter((r) => r.investigationId === "run-2");
    expect(analyst.length).toBe(1);
    expect(analyst[0].text).toContain("analyst:");
    expect(run1.length).toBe(0); // prior agent claims gone — no duplication
    expect(run2.length).toBe(1);
    expect(rows.length).toBe(2);
  });

  it("does not touch another company's claims", async () => {
    await commitAgentClaims(db, 1, "run-a", ["co1 claim"]);
    await commitAgentClaims(db, 2, "run-b", ["co2 claim"]);
    await commitAgentClaims(db, 1, "run-a2", ["co1 revised"]);
    expect((await db.select().from(schema.claims).where(eq(schema.claims.companyId, 2))).length).toBe(1);
  });

  it("rolls back atomically when the commit throws (no partial write)", async () => {
    await db.insert(schema.claims).values({ companyId: 1, text: "seed", investigationId: "old" });
    await expect(
      db.transaction(async (tx) => {
        await tx.delete(schema.claims).where(isNotNull(schema.claims.investigationId));
        await tx.insert(schema.claims).values({ companyId: 1, text: "new", investigationId: "new" });
        throw new Error("synthesis failed mid-commit");
      }),
    ).rejects.toThrow("synthesis failed mid-commit");

    // The delete + insert both rolled back: the original row is intact.
    const rows = await db.select().from(schema.claims);
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe("seed");
  });
});
