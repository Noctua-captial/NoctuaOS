import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";

const dbPath = process.env.NOCTUA_DB_PATH ?? path.join(process.cwd(), "noctua.db");

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

// FTS5 index over chunks for keyword retrieval (works with no API key).
sqlite.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`);

export const sqliteRaw = sqlite;
export const db = drizzle(sqlite, { schema });
export * as tables from "./schema";
