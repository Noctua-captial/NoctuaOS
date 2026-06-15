// Verifies the Track C persistence guarantees against a throwaway in-memory DB:
//   1. re-running an investigation replaces the prior run's agent claims but
//      preserves analyst-added claims (the idempotency predicate used in
//      app/api/athena/route.ts), and
//   2. better-sqlite3 transactions roll back atomically on failure (so a failed
//      commit leaves no partial research memory).
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, isNotNull } from "drizzle-orm";
import * as schema from "@/db/schema";

type DB = BetterSQLite3Database<typeof schema>;

function freshDb(): DB {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'unverified',
      supports TEXT NOT NULL DEFAULT 'neutral',
      confidence REAL NOT NULL DEFAULT 0.5,
      source TEXT,
      source_type TEXT,
      investigation_id TEXT,
      updated_at INTEGER
    );
  `);
  return drizzle(sqlite, { schema });
}

/** Mirrors the route's replace-then-insert for one company's agent claims. */
function commitAgentClaims(db: DB, companyId: number, investigationId: string, texts: string[]) {
  db.transaction(() => {
    db.delete(schema.claims)
      .where(and(eq(schema.claims.companyId, companyId), isNotNull(schema.claims.investigationId)))
      .run();
    db.insert(schema.claims)
      .values(texts.map((text) => ({ companyId, text, investigationId })))
      .run();
  });
}

describe("investigation idempotency", () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it("replaces a prior run's agent claims while preserving analyst claims", () => {
    // An analyst adds a claim by hand (no investigationId).
    db.insert(schema.claims).values({ companyId: 1, text: "analyst: channel checks confirm demand" }).run();
    // First investigation.
    commitAgentClaims(db, 1, "run-1", ["agent: revenue accelerating", "agent: margins expanding"]);

    let rows = db.select().from(schema.claims).all();
    expect(rows.length).toBe(3);

    // Re-investigate: agent claims are replaced, analyst claim survives.
    commitAgentClaims(db, 1, "run-2", ["agent: revised — revenue decelerating"]);

    rows = db.select().from(schema.claims).all();
    const analyst = rows.filter((r) => r.investigationId == null);
    const run1 = rows.filter((r) => r.investigationId === "run-1");
    const run2 = rows.filter((r) => r.investigationId === "run-2");
    expect(analyst.length).toBe(1);
    expect(analyst[0].text).toContain("analyst:");
    expect(run1.length).toBe(0); // prior agent claims gone — no duplication
    expect(run2.length).toBe(1);
    expect(rows.length).toBe(2);
  });

  it("does not touch another company's claims", () => {
    commitAgentClaims(db, 1, "run-a", ["co1 claim"]);
    commitAgentClaims(db, 2, "run-b", ["co2 claim"]);
    commitAgentClaims(db, 1, "run-a2", ["co1 revised"]);
    expect(db.select().from(schema.claims).where(eq(schema.claims.companyId, 2)).all().length).toBe(1);
  });

  it("rolls back atomically when the commit throws (no partial write)", () => {
    db.insert(schema.claims).values({ companyId: 1, text: "seed", investigationId: "old" }).run();
    expect(() =>
      db.transaction(() => {
        db.delete(schema.claims).where(isNotNull(schema.claims.investigationId)).run();
        db.insert(schema.claims).values({ companyId: 1, text: "new", investigationId: "new" }).run();
        throw new Error("synthesis failed mid-commit");
      }),
    ).toThrow("synthesis failed mid-commit");

    // The delete + insert both rolled back: the original row is intact.
    const rows = db.select().from(schema.claims).all();
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe("seed");
  });
});
