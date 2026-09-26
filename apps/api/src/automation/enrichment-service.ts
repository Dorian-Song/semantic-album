import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import { postEnrichment, postPurge } from '../egress/n8n-client.js';
import { ServiceUnavailableError, type ClaimedTask, type TaskHandler } from '../processing/task-service.js';
import { refreshPhotoText } from '../search/fts-index.js';
import type { SettingsService } from '../settings/settings-service.js';
import { nowIso } from '../shared/ids.js';

/**
 * Sends a finished AI caption through the n8n workflow, which normalises it, writes a Data Table row,
 * reads it back, and returns it. The result updates the local AI draft only; SQLite stays authoritative
 * and a manual description is never touched. If n8n is down the raw caption is already saved and searchable.
 */
export class EnrichmentWorker implements TaskHandler {
  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
  ) {}

  concurrency(): number {
    return this.settings.get().enrichmentConcurrency;
  }

  async run(task: ClaimedTask): Promise<{ provider: string } | void> {
    const { webhookUrl, secret } = this.settings.get().n8n;
    if (!webhookUrl || !secret) throw new ServiceUnavailableError('Connect n8n in Settings', 60_000);
    const { db } = this.ctx;

    const latestCaption = db
      .prepare(`SELECT max(revision) FROM processing_tasks WHERE asset_id = ? AND kind = 'caption' AND state = 'succeeded'`)
      .pluck()
      .get(task.assetId) as number | null;
    if (latestCaption !== null && task.revision < latestCaption) return; // superseded by a newer caption
    const d = db.prepare(`SELECT ai_caption AS caption, ai_tags AS tags FROM descriptions WHERE asset_id = ?`).get(task.assetId) as
      | { caption: string | null; tags: string }
      | undefined;
    if (!d?.caption) return; // nothing to enrich

    const r = await postEnrichment(webhookUrl, secret, {
      assetId: task.assetId,
      taskId: task.id,
      revision: task.revision,
      caption: d.caption,
      tags: JSON.parse(d.tags) as string[],
    });

    db.transaction(() => {
      const still = db
        .prepare(`SELECT max(revision) FROM processing_tasks WHERE asset_id = ? AND kind = 'caption' AND state = 'succeeded'`)
        .pluck()
        .get(task.assetId) as number | null;
      if (still !== null && task.revision < still) return;
      db.prepare(
        `UPDATE descriptions SET ai_caption = ?, ai_tags = ?, enrichment = ?, enrichment_state = 'done', updated_at = ? WHERE asset_id = ?`,
      ).run(
        r.caption,
        JSON.stringify(r.tags),
        JSON.stringify({ categories: r.categories, keywords: r.keywords, wordCount: r.wordCount, rowId: r.rowId, storedAt: r.storedAt }),
        nowIso(),
        task.assetId,
      );
      refreshPhotoText(db, task.assetId);
    })();
    return { provider: 'n8n' };
  }
}

/** Deletes n8n Data Table rows of photos that left the library, with backoff while n8n is unavailable. */
export class PurgeWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly settings: SettingsService,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(intervalMs = 60_000): void {
    const tick = () => void this.runOnce().catch((err) => this.log.error({ err }, 'n8n purge failed'));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    const { webhookUrl, secret } = this.settings.get().n8n;
    if (!webhookUrl || !secret || this.running) return 0;
    this.running = true;
    const { db } = this.ctx;
    let done = 0;
    try {
      const due = db
        .prepare(`SELECT asset_id FROM n8n_purge_queue WHERE next_attempt_at IS NULL OR next_attempt_at <= ? ORDER BY requested_at LIMIT 50`)
        .pluck()
        .all(nowIso()) as string[];
      for (const assetId of due) {
        try {
          await postPurge(webhookUrl, secret, assetId);
          db.prepare(`DELETE FROM n8n_purge_queue WHERE asset_id = ?`).run(assetId);
          done++;
        } catch (err) {
          const attempts = (db.prepare(`SELECT attempts FROM n8n_purge_queue WHERE asset_id = ?`).pluck().get(assetId) as number) + 1;
          const delay = Math.min(3_600_000, 30_000 * 2 ** (attempts - 1));
          db.prepare(`UPDATE n8n_purge_queue SET attempts = ?, next_attempt_at = ? WHERE asset_id = ?`).run(
            attempts,
            new Date(Date.now() + delay).toISOString(),
            assetId,
          );
          if (err instanceof ServiceUnavailableError) break; // n8n is down: do not try the rest now
        }
      }
    } finally {
      this.running = false;
    }
    if (done) this.log.info({ purged: done }, 'deleted n8n rows of removed photos');
    return done;
  }
}
