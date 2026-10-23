import type { Db } from '../../database/connection.js';

/** Answers kept for repeated submissions (idempotency_keys). */
export class IdempotencyRepository {
  constructor(private readonly db: Db) {}

  find(key: string): { fingerprint: string; response: string } | undefined {
    return this.db.prepare('SELECT fingerprint, response FROM idempotency_keys WHERE key = ?').get(key) as { fingerprint: string; response: string } | undefined;
  }

  save(key: string, operation: string, fingerprint: string, response: string, at: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO idempotency_keys (key, operation, fingerprint, response, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(key, operation, fingerprint, response, at);
  }

  deleteBefore(at: string): number {
    return this.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(at).changes;
  }
}
