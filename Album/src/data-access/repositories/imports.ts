import type { Db } from '../../database/connection.js';

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';
export type ItemState = 'pending' | 'running' | 'imported' | 'skipped' | 'failed';

export interface JobRow {
  id: string;
  kind: 'folder' | 'files';
  state: JobState;
  albumId: string | null;
  albumName: string | null;
  sourceLabel: string;
  intakeClosed: number;
  createdAt: string;
  updatedAt: string;
  stats: string | null;
}

export interface FolderItem {
  id: string;
  jobId: string;
  itemKey: string;
  displayFilename: string;
  sourcePath: string;
  albumId: string | null;
}

export interface NewItem {
  key: string;
  name: string;
  size: number | null;
  state: ItemState;
  reason: string | null;
}

/** Import batches and their items (import_jobs, import_items). */
export class ImportRepository {
  constructor(private readonly db: Db) {}

  createJob(j: { id: string; kind: 'folder' | 'files'; albumId: string; label: string; sourcePath: string | null; state: JobState; intakeClosed: boolean; at: string }): void {
    this.db
      .prepare(
        `INSERT INTO import_jobs (id, kind, album_id, source_label, source_path, state, intake_closed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(j.id, j.kind, j.albumId, j.label, j.sourcePath, j.state, j.intakeClosed ? 1 : 0, j.at, j.at);
  }

  addItems(jobId: string, items: NewItem[], newId: () => string, at: string): void {
    const insert = this.db.prepare(
      `INSERT INTO import_items (id, job_id, item_key, display_filename, byte_size, state, reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const i of items) insert.run(newId(), jobId, i.key, i.name, i.size, i.state, i.reason, at);
  }

  job(jobId: string): JobRow | undefined {
    return this.db
      .prepare(
        `SELECT j.id, j.kind, j.state, j.album_id AS albumId, al.name AS albumName, j.source_label AS sourceLabel,
                j.intake_closed AS intakeClosed, j.created_at AS createdAt, j.updated_at AS updatedAt, j.stats
           FROM import_jobs j LEFT JOIN albums al ON al.id = j.album_id WHERE j.id = ?`,
      )
      .get(jobId) as JobRow | undefined;
  }

  item(jobId: string, itemKey: string): { id: string; state: ItemState; reason: string | null; name: string } | undefined {
    return this.db
      .prepare(`SELECT id, state, reason, display_filename AS name FROM import_items WHERE job_id = ? AND item_key = ?`)
      .get(jobId, itemKey) as { id: string; state: ItemState; reason: string | null; name: string } | undefined;
  }

  /** Marks an item running if nobody else is receiving it. */
  claimItem(itemId: string, at: string): boolean {
    return this.db.prepare(`UPDATE import_items SET state = 'running', updated_at = ? WHERE id = ? AND state IN ('pending', 'failed')`).run(at, itemId).changes > 0;
  }

  setItemPending(itemId: string, at: string): void {
    this.db.prepare(`UPDATE import_items SET state = 'pending', updated_at = ? WHERE id = ?`).run(at, itemId);
  }

  setItemOutcome(itemId: string, state: ItemState, reason: string | null, assetId: string | null, at: string): void {
    this.db.prepare(`UPDATE import_items SET state = ?, reason = ?, asset_id = ?, updated_at = ? WHERE id = ?`).run(state, reason, assetId, at, itemId);
  }

  setJobState(jobId: string, state: JobState, at: string, onlyFrom?: readonly JobState[]): number {
    const from = onlyFrom ? ` AND state IN (SELECT value FROM json_each(?))` : '';
    const params: unknown[] = [state, at, jobId, ...(onlyFrom ? [JSON.stringify(onlyFrom)] : [])];
    return this.db.prepare(`UPDATE import_jobs SET state = ?, updated_at = ? WHERE id = ?${from}`).run(...params).changes;
  }

  closeIntake(jobId: string, at: string): number {
    return this.db.prepare(`UPDATE import_jobs SET intake_closed = 1, updated_at = ? WHERE id = ? AND kind = 'files'`).run(at, jobId).changes;
  }

  saveStats(jobId: string, stats: string): void {
    this.db.prepare(`UPDATE import_jobs SET stats = ? WHERE id = ?`).run(stats, jobId);
  }

  itemCounts(jobId: string): { state: ItemState; n: number }[] {
    return this.db.prepare(`SELECT state, count(*) AS n FROM import_items WHERE job_id = ? GROUP BY state`).all(jobId) as { state: ItemState; n: number }[];
  }

  problems(jobId: string): { filename: string; state: ItemState; reason: string | null }[] {
    return this.db
      .prepare(
        `SELECT display_filename AS filename, state, reason FROM import_items
          WHERE job_id = ? AND state IN ('skipped', 'failed') AND COALESCE(reason, '') != 'duplicate_in_album'
          ORDER BY updated_at LIMIT 200`,
      )
      .all(jobId) as { filename: string; state: ItemState; reason: string | null }[];
  }

  missingKeys(jobId: string): string[] {
    return this.db.prepare(`SELECT item_key FROM import_items WHERE job_id = ? AND state = 'pending' LIMIT 5000`).pluck().all(jobId) as string[];
  }

  lastItemAt(jobId: string): string | null {
    return this.db.prepare(`SELECT max(updated_at) FROM import_items WHERE job_id = ? AND state NOT IN ('pending', 'running')`).pluck().get(jobId) as string | null;
  }

  latestJobIds(limit: number): string[] {
    return this.db.prepare(`SELECT id FROM import_jobs ORDER BY created_at DESC LIMIT ?`).pluck().all(limit) as string[];
  }

  /** Unfinished jobs plus those changed since `since`. */
  recentJobIds(since: string): string[] {
    return this.db
      .prepare(`SELECT id FROM import_jobs WHERE state IN ('queued', 'running', 'paused') OR updated_at >= ? ORDER BY created_at DESC LIMIT 20`)
      .pluck()
      .all(since) as string[];
  }

  requeueRunningItems(at: string): number {
    return this.db.prepare(`UPDATE import_items SET state = 'pending', updated_at = ? WHERE state = 'running'`).run(at).changes;
  }

  claimableFolderItems(): number {
    return this.db
      .prepare(
        `SELECT count(*) FROM import_items i JOIN import_jobs j ON j.id = i.job_id
          WHERE j.kind = 'folder' AND j.state IN ('queued', 'running') AND i.state = 'pending'`,
      )
      .pluck()
      .get() as number;
  }

  claimNextFolderItem(at: string): FolderItem | null {
    return this.db.transaction(() => {
      const item = this.db
        .prepare(
          `SELECT i.id, i.job_id AS jobId, i.item_key AS itemKey, i.display_filename AS displayFilename,
                  j.source_path AS sourcePath, j.album_id AS albumId
             FROM import_items i JOIN import_jobs j ON j.id = i.job_id
            WHERE j.kind = 'folder' AND j.state IN ('queued', 'running') AND i.state = 'pending'
            ORDER BY j.created_at, i.rowid LIMIT 1`,
        )
        .get() as FolderItem | undefined;
      if (!item) return null;
      this.db.prepare(`UPDATE import_items SET state = 'running', updated_at = ? WHERE id = ?`).run(at, item.id);
      this.db.prepare(`UPDATE import_jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'`).run(at, item.jobId);
      return item;
    })();
  }

  /**
   * The photo joined the album after the job started and no other item of the job owns it: this very item
   * imported it before a crash.
   */
  importedByThisItem(jobId: string, albumId: string, assetId: string, itemId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM album_assets aa JOIN import_jobs j ON j.id = ?
          WHERE aa.album_id = ? AND aa.asset_id = ? AND aa.added_at >= j.created_at
            AND NOT EXISTS (SELECT 1 FROM import_items WHERE job_id = j.id AND id != ? AND asset_id = aa.asset_id AND state = 'imported')`,
      )
      .get(jobId, albumId, assetId, itemId);
  }
}
