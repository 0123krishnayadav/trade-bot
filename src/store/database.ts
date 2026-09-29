import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Migration {
  /** Increasing integer. Never change or reorder a migration after it has been applied; add a new one. */
  id: number;
  name: string;
  /** One or more SQL statements. */
  up: string;
}

/** Opens (creating if needed) the SQLite file. Pass ":memory:" for a throwaway database in tests. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  // strict: named parameters are written without the $ prefix in objects, and unknown ones throw.
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL"); // readers don't block the writer
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Applies migrations that haven't run yet, each in its own transaction, and returns their ids.
 * Applied migrations are recorded in the `schema_migrations` table.
 */
export function migrate(db: Database, migrations: readonly Migration[]): number[] {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.id <= migrations[i - 1]!.id) {
      throw new Error(`Migration ids must be strictly increasing (${migrations[i - 1]!.id} then ${migrations[i]!.id})`);
    }
  }

  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const done = new Set(
    (db.query("SELECT id FROM schema_migrations").all() as { id: number }[]).map((row) => row.id),
  );
  const record = db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES ($id, $name, $appliedAt)");

  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.run(m.up);
      record.run({ id: m.id, name: m.name, appliedAt: new Date().toISOString() });
    })();
    applied.push(m.id);
  }
  return applied;
}
