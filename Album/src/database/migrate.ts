import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Applies migrations/NNNN_name.sql in order, each in its own transaction. Returns the names applied now. */
export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const pending = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().filter((f) => !done.has(f));

  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  for (const name of pending) {
    const sql = fs.readFileSync(dir + name, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(name);
    })();
  }
  return pending;
}
