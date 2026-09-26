import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import { nowIso } from '../shared/ids.js';

interface Candidate {
  id: string;
  sha256: string;
  orphanedAt: string;
  objectKey: string;
  derivativeKey: string | null;
  thumbnailKey: string | null;
}

/**
 * Deletes assets that have had no album membership for the grace period. Rechecks under a write transaction,
 * holds the per-SHA lock so a concurrent import of the same bytes cannot lose its file, and queues deletion
 * of the photo's n8n row. The grace period is crash/retry safety, not an undo feature.
 */
export class GarbageCollector {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
    /** Other periodic clean-ups (expired export files) run on the same timer. */
    private readonly extraCleanup: (() => Promise<unknown>)[] = [],
  ) {}

  start(intervalMs = 10 * 60_000): void {
    const tick = () => void this.runOnce().catch((err) => this.log.error({ err }, 'garbage collection failed'));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = Date.now()): Promise<number> {
    const { db, store, shaLocks, env } = this.ctx;
    const cutoff = new Date(now - env.assetGraceMs).toISOString();
    const candidates = db
      .prepare(
        `SELECT id, sha256, orphaned_at AS orphanedAt, object_key AS objectKey,
                derivative_key AS derivativeKey, thumbnail_key AS thumbnailKey
           FROM assets WHERE orphaned_at IS NOT NULL AND orphaned_at <= ?`,
      )
      .all(cutoff) as Candidate[];

    let deleted = 0;
    for (const c of candidates) {
      await shaLocks.run(c.sha256, async () => {
        const gone = db.transaction(() => {
          const still = db
            .prepare(
              `SELECT 1 FROM assets WHERE id = ? AND orphaned_at = ?
                 AND NOT EXISTS (SELECT 1 FROM album_assets WHERE asset_id = assets.id)`,
            )
            .get(c.id, c.orphanedAt);
          if (!still) return false;
          db.prepare('DELETE FROM photo_fts WHERE asset_id = ?').run(c.id);
          db.prepare('DELETE FROM assets WHERE id = ?').run(c.id); // cascades to descriptions and tasks
          db.prepare('INSERT OR IGNORE INTO n8n_purge_queue (asset_id, requested_at) VALUES (?, ?)').run(c.id, nowIso());
          return true;
        })();
        if (!gone) return;
        await Promise.all([store.remove(c.objectKey), store.remove(c.derivativeKey), store.remove(c.thumbnailKey)]);
        deleted++;
      });
    }
    if (deleted) this.log.info({ deleted }, 'removed unreferenced photos');
    for (const cleanup of this.extraCleanup) await cleanup();
    return deleted;
  }
}
