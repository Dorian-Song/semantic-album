import type { Db } from '../../database/connection.js';

export type TaskKind = 'caption' | 'embedding' | 'enrichment' | 'text_embedding';
export const TASK_KINDS: readonly TaskKind[] = ['caption', 'embedding', 'enrichment', 'text_embedding'];

export interface ClaimedTask {
  id: string;
  assetId: string;
  kind: TaskKind;
  revision: number;
  /** Including the current run. */
  attempts: number;
}

export interface TaskStatus {
  state: string;
  error: string | null;
  provider: string | null;
}

/** Per-kind task counts for a set of photos (latest revision of each). */
export interface TaskStats {
  kind: TaskKind;
  state: string;
  n: number;
}

export interface TaskClock {
  kind: TaskKind;
  first: string | null;
  last: string | null;
  avgMs: number | null;
  done: number;
}

// Tasks of photos marked unused are left alone, so nothing of a removed photo is sent anywhere.
const IN_USE = `NOT EXISTS (SELECT 1 FROM assets WHERE id = processing_tasks.asset_id AND orphaned_at IS NOT NULL)`;
const LATEST = `t.revision = (SELECT max(revision) FROM processing_tasks t2 WHERE t2.asset_id = t.asset_id AND t2.kind = t.kind)`;

/** Background work per photo (processing_tasks). */
export class TaskRepository {
  constructor(private readonly db: Db) {}

  /** Safe to repeat. */
  add(id: string, assetId: string, kind: TaskKind, revision: number, at: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processing_tasks (id, asset_id, kind, revision, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, assetId, kind, revision, at, at);
  }

  requeueRunning(at: string): number {
    return this.db.prepare(`UPDATE processing_tasks SET state = 'pending', started_at = NULL, updated_at = ? WHERE state = 'running'`).run(at).changes;
  }

  claim(kind: TaskKind, at: string): ClaimedTask | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id, asset_id AS assetId, kind, revision, attempts FROM processing_tasks
            WHERE kind = ? AND state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND ${IN_USE}
            ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(kind, at) as ClaimedTask | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE processing_tasks SET state = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ?`).run(at, at, row.id);
      return { ...row, attempts: row.attempts + 1 };
    })();
  }

  succeeded(id: string, provider: string | null, at: string, durationMs: number): void {
    this.db
      .prepare(
        `UPDATE processing_tasks SET state = 'succeeded', error = NULL, next_attempt_at = NULL, provider = COALESCE(?, provider),
                finished_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
      )
      .run(provider, at, durationMs, at, id);
  }

  /** Back to the queue without using up an attempt. */
  putBack(id: string, error: string, at: string): void {
    this.db
      .prepare(`UPDATE processing_tasks SET state = 'pending', attempts = attempts - 1, started_at = NULL, error = ?, updated_at = ? WHERE id = ?`)
      .run(error, at, id);
  }

  failed(id: string, error: string, at: string, durationMs: number): void {
    this.db
      .prepare(`UPDATE processing_tasks SET state = 'failed', error = ?, finished_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?`)
      .run(error, at, durationMs, at, id);
  }

  retryLater(id: string, error: string, nextAttemptAt: string, at: string): void {
    this.db
      .prepare(`UPDATE processing_tasks SET state = 'pending', error = ?, started_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
      .run(error, nextAttemptAt, at, id);
  }

  latestRevision(assetId: string, kind: TaskKind): number | null {
    return this.db.prepare(`SELECT max(revision) FROM processing_tasks WHERE asset_id = ? AND kind = ?`).pluck().get(assetId, kind) as number | null;
  }

  /** Revision of a queued or running task of this kind, if any. */
  openRevision(assetId: string, kind: TaskKind): number | undefined {
    return this.db
      .prepare(`SELECT revision FROM processing_tasks WHERE asset_id = ? AND kind = ? AND state IN ('pending', 'running') ORDER BY revision DESC LIMIT 1`)
      .pluck()
      .get(assetId, kind) as number | undefined;
  }

  latestSucceededRevision(assetId: string, kind: TaskKind): number | null {
    return this.db
      .prepare(`SELECT max(revision) FROM processing_tasks WHERE asset_id = ? AND kind = ? AND state = 'succeeded'`)
      .pluck()
      .get(assetId, kind) as number | null;
  }

  newerExists(assetId: string, kind: TaskKind, revision: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM processing_tasks WHERE asset_id = ? AND kind = ? AND revision > ? LIMIT 1`).get(assetId, kind, revision);
  }

  statusOf(assetId: string): (TaskStatus & { kind: TaskKind })[] {
    return this.db
      .prepare(
        `SELECT kind, state, error, provider FROM processing_tasks t
          WHERE asset_id = ? AND revision = (SELECT max(revision) FROM processing_tasks WHERE asset_id = t.asset_id AND kind = t.kind)`,
      )
      .all(assetId) as (TaskStatus & { kind: TaskKind })[];
  }

  state(id: string): string | undefined {
    return this.db.prepare(`SELECT state FROM processing_tasks WHERE id = ?`).pluck().get(id) as string | undefined;
  }

  resetFailedTask(id: string, at: string): number {
    return this.db
      .prepare(`UPDATE processing_tasks SET state = 'pending', attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE state = 'failed' AND id = ?`)
      .run(at, id).changes;
  }

  resetFailedKind(kind: TaskKind, at: string): number {
    return this.db
      .prepare(`UPDATE processing_tasks SET state = 'pending', attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE state = 'failed' AND kind = ?`)
      .run(at, kind).changes;
  }

  /** Latest revision per photo and kind, so counts are photos rather than attempts over time. */
  summary(at: string): { kind: TaskKind; state: string; waiting: number; n: number }[] {
    return this.db
      .prepare(
        `SELECT kind, state, (state = 'pending' AND next_attempt_at > ?) AS waiting, count(*) AS n
           FROM processing_tasks t WHERE ${LATEST} GROUP BY kind, state, waiting`,
      )
      .all(at) as { kind: TaskKind; state: string; waiting: number; n: number }[];
  }

  /** Pending tasks of the given kinds that a worker could pick up. */
  claimableCount(kinds: readonly TaskKind[]): number {
    return this.db
      .prepare(`SELECT count(*) FROM processing_tasks WHERE state = 'pending' AND kind IN (SELECT value FROM json_each(?)) AND ${IN_USE}`)
      .pluck()
      .get(JSON.stringify(kinds)) as number;
  }

  albumProgress(albumId: string): { kind: 'caption' | 'embedding'; total: number; done: number }[] {
    return this.db
      .prepare(
        `SELECT t.kind, count(*) AS total, sum(t.state IN ('succeeded', 'failed')) AS done
           FROM processing_tasks t JOIN album_assets aa ON aa.asset_id = t.asset_id AND aa.album_id = ?
          WHERE t.kind IN ('caption', 'embedding') AND ${LATEST}
          GROUP BY t.kind`,
      )
      .all(albumId) as { kind: 'caption' | 'embedding'; total: number; done: number }[];
  }

  private static readonly JOB_PHOTOS = `t.asset_id IN (SELECT asset_id FROM import_items WHERE job_id = ? AND state = 'imported' AND asset_id IS NOT NULL)`;

  importStats(jobId: string): TaskStats[] {
    return this.db
      .prepare(`SELECT t.kind, t.state, count(*) AS n FROM processing_tasks t WHERE ${TaskRepository.JOB_PHOTOS} AND ${LATEST} GROUP BY t.kind, t.state`)
      .all(jobId) as TaskStats[];
  }

  importClocks(jobId: string): TaskClock[] {
    return this.db
      .prepare(
        `SELECT t.kind, min(t.started_at) AS first, max(t.finished_at) AS last, avg(t.duration_ms) AS avgMs,
                sum(t.state IN ('succeeded', 'failed')) AS done
           FROM processing_tasks t WHERE ${TaskRepository.JOB_PHOTOS} AND ${LATEST} GROUP BY t.kind`,
      )
      .all(jobId) as TaskClock[];
  }

  deleteForAsset(assetId: string): void {
    this.db.prepare('DELETE FROM processing_tasks WHERE asset_id = ?').run(assetId);
  }
}
