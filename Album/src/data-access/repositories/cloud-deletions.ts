import type { Db } from '../../database/connection.js';

/** Cloud records still to delete for photos that left the library (n8n_purge_queue). Survives restarts. */
export class CloudDeletionRepository {
  constructor(private readonly db: Db) {}

  add(assetId: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO n8n_purge_queue (asset_id, requested_at) VALUES (?, ?)').run(assetId, at);
  }

  due(at: string, limit: number): string[] {
    return this.db
      .prepare(`SELECT asset_id FROM n8n_purge_queue WHERE next_attempt_at IS NULL OR next_attempt_at <= ? ORDER BY requested_at LIMIT ?`)
      .pluck()
      .all(at, limit) as string[];
  }

  done(assetId: string): void {
    this.db.prepare(`DELETE FROM n8n_purge_queue WHERE asset_id = ?`).run(assetId);
  }

  /** Records a failed attempt; returns the attempt count. */
  failed(assetId: string, nextAttemptAt: (attempts: number) => string): number {
    const attempts = ((this.db.prepare(`SELECT attempts FROM n8n_purge_queue WHERE asset_id = ?`).pluck().get(assetId) as number | undefined) ?? 0) + 1;
    this.db.prepare(`UPDATE n8n_purge_queue SET attempts = ?, next_attempt_at = ? WHERE asset_id = ?`).run(attempts, nextAttemptAt(attempts), assetId);
    return attempts;
  }
}
