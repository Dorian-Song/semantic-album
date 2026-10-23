import { ServiceUnavailableError } from '../../data-access/egress/errors.js';
import { purge } from '../../data-access/egress/n8n.js';
import { FileStore } from '../../data-access/file-store/file-store.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import type { SearchStore } from '../../data-access/search-store/search-store.js';
import type { Artifact } from '../../infra/artifact/artifact.js';
import type { Logger } from '../../infra/observability/log.js';
import type { SettingsService } from '../../infra/settings/settings.js';
import { nowIso } from '../../shared/ids.js';
import type { Processing } from '../processing/processing.js';

const SHA = /^[0-9a-f]{64}$/;

/**
 * Permanently removes photos that no album uses, once the grace period has passed, and cleans up after crashes.
 * Each owner deletes its own data; this module decides the order and keeps retrying cloud deletions.
 */
export class Lifecycle {
  private purging = false;

  constructor(
    private readonly repos: Repositories,
    private readonly files: FileStore,
    private readonly artifact: Artifact,
    private readonly search: SearchStore,
    private readonly processing: Processing,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly graceMs: number,
  ) {}

  /** Removes photos unused for longer than the grace period. Returns how many were removed. */
  async removeUnused(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - this.graceMs).toISOString();
    let removed = 0;
    for (const c of this.repos.assets.unusedSince(cutoff)) {
      const gone = await this.artifact.remove(c, () => {
        // Re-checked under the file lock: the photo may have joined an album since it was listed.
        if (!this.repos.assets.stillUnused(c.id, c.orphanedAt)) return false;
        this.search.removePhoto(c.id);
        this.processing.forget(c.id);
        this.repos.cloudDeletions.add(c.id, nowIso());
        this.repos.assets.delete(c.id);
        return true;
      });
      if (!gone) continue;
      this.search.forget(c.id);
      removed++;
    }
    if (removed) this.log.info({ removed }, 'removed unused photos');
    return removed;
  }

  /** Deletes the n8n records of removed photos, with growing intervals while n8n is unavailable. */
  async deleteCloudRecords(): Promise<number> {
    const { webhookUrl, secret } = this.settings.get().n8n;
    if (!webhookUrl || !secret || this.purging) return 0;
    this.purging = true;
    const queue = this.repos.cloudDeletions;
    let done = 0;
    try {
      for (const assetId of queue.due(nowIso(), 50)) {
        try {
          await purge({ webhookUrl, secret }, assetId);
          queue.done(assetId);
          done++;
        } catch (err) {
          queue.failed(assetId, (attempts) => new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** (attempts - 1))).toISOString());
          if (err instanceof ServiceUnavailableError) break; // n8n is down: do not try the rest now
        }
      }
    } finally {
      this.purging = false;
    }
    if (done) this.log.info({ deleted: done }, 'deleted n8n records of removed photos');
    return done;
  }

  /**
   * Start-up clean-up. Storing a file and writing its record cannot share a transaction, so a crash can leave a
   * temporary file or a stored file without a record. Anything older than `minAgeMs` without a record is removed;
   * files of a known photo are never touched.
   */
  async removeLeftovers(minAgeMs = 3_600_000): Promise<{ staging: number; unowned: number }> {
    const cutoff = Date.now() - minAgeMs;
    let staging = 0;
    for (const f of await this.files.list('staging')) {
      if (f.mtimeMs < cutoff) {
        await this.files.removePath(f.file);
        staging++;
      }
    }
    const known = this.repos.assets.knownShas();
    let unowned = 0;
    for (const { dir, sha } of FileStore.CONTENT_DIRS) {
      for (const f of await this.files.list(dir)) {
        const hash = sha(f.name);
        if (!SHA.test(hash) || known.has(hash) || f.mtimeMs >= cutoff) continue;
        await this.artifact.whileLocked(hash, async () => {
          if (this.repos.assets.shaKnown(hash)) return;
          await this.files.removePath(f.file);
          unowned++;
        });
      }
    }
    if (staging || unowned) this.log.info({ staging, unowned }, 'removed leftover files from interrupted work');
    return { staging, unowned };
  }
}
