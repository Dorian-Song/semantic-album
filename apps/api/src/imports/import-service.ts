import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import type { AlbumService } from '../albums/album-service.js';
import type { AssetService, IngestResult } from '../assets/asset-service.js';
import { TASK_KINDS, type TaskKind } from '../processing/task-service.js';
import { AppError, badRequest, conflict, notFound } from '../shared/errors.js';
import { newId, nowIso } from '../shared/ids.js';
import { ItemRejected, stageStream } from '../storage/staging.js';

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';
export type ItemState = 'pending' | 'running' | 'imported' | 'skipped' | 'failed';

export interface ImportProgress {
  id: string;
  kind: 'folder' | 'files';
  state: JobState;
  albumId: string | null;
  albumName: string | null;
  sourceLabel: string;
  intakeClosed: boolean;
  counts: { total: number; imported: number; skipped: number; failed: number; pending: number };
  /** Skipped and failed items with their reasons (first 200). */
  problems: { filename: string; state: ItemState; reason: string | null }[];
  /** Caption/embedding/enrichment progress of this import's photos, counted separately from the import. */
  processing: Record<TaskKind, { total: number; done: number; failed: number }>;
  /** Stage timings, written when the job completes (null before, or if it finished before a restart). */
  timings: JobTimings | null;
  /** Keys of items not yet received from the browser. Once no upload is running, the UI asks the user to reselect them. */
  missingKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StageTiming {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface JobTimings {
  /** First item started → last item finished, in this process. */
  wallMs: number;
  itemsPerSecond: number;
  /** Read + SHA-256 into staging. */
  stage: StageTiming;
  /** Format check, decode, derivatives, EXIF, object placement, and SQLite commit. */
  ingest: StageTiming;
}

function timing(values: number[]): StageTiming {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  return { count: sorted.length, meanMs: Math.round(mean), p50Ms: Math.round(at(0.5)), p95Ms: Math.round(at(0.95)) };
}

export interface ManifestEntry {
  key: string;
  name: string;
  size: number;
}

/** Extensions considered when scanning a host folder. Content is still sniffed; other files are ignored. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.gif', '.bmp', '.dib', '.webp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif']);
const MAX_MANIFEST = 50_000;

interface ClaimedItem {
  id: string;
  jobId: string;
  itemKey: string;
  displayFilename: string;
  sourcePath: string;
  albumId: string | null;
}

export class ImportService {
  private active = 0;
  private stopping = false;
  /** In-memory stage measurements per job, persisted to import_jobs.stats when the job completes. */
  private readonly measurements = new Map<string, { firstStart: number; lastEnd: number; stage: number[]; ingest: number[] }>();

  constructor(
    private readonly ctx: AppContext,
    private readonly albums: AlbumService,
    private readonly assets: AssetService,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ---------- host folder ----------

  async startFolderImport(folderPath: string, albumId?: string): Promise<ImportProgress> {
    if (!path.isAbsolute(folderPath)) throw badRequest('invalid_path', 'Enter an absolute folder path on the machine running Album');
    const root = path.resolve(folderPath);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw badRequest('folder_not_found', 'That folder does not exist on the machine running Album');
    const { files, ignored } = await scanFolder(root);
    if (files.length === 0) throw badRequest('no_images', `No image files found in that folder${ignored ? ` (${ignored} other files ignored)` : ''}`);

    const { db } = this.ctx;
    const jobId = newId();
    db.transaction(() => {
      const targetId = albumId ?? this.albums.createUnique(path.basename(root) || 'Imported').id;
      if (albumId) this.albums.get(albumId);
      const now = nowIso();
      db.prepare(
        `INSERT INTO import_jobs (id, kind, album_id, source_label, source_path, state, intake_closed, created_at, updated_at)
         VALUES (?, 'folder', ?, ?, ?, 'queued', 1, ?, ?)`,
      ).run(jobId, targetId, path.basename(root) || root, root, now, now);
      const insert = db.prepare(
        `INSERT INTO import_items (id, job_id, item_key, display_filename, state, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      );
      for (const rel of files) insert.run(newId(), jobId, rel, path.basename(rel), now);
    })();
    this.kick();
    return this.progress(jobId);
  }

  // ---------- browser-selected files ----------

  createFileImport(input: { albumId?: string | undefined; newAlbumName?: string | undefined; files: ManifestEntry[] }): ImportProgress {
    const { db, env } = this.ctx;
    if (input.files.length === 0) throw badRequest('empty_manifest', 'Select at least one file');
    if (input.files.length > MAX_MANIFEST) throw badRequest('manifest_too_large', `Import at most ${MAX_MANIFEST} files at once`);
    if (new Set(input.files.map((f) => f.key)).size !== input.files.length) throw badRequest('duplicate_keys', 'File keys must be unique');
    if (!input.albumId === !input.newAlbumName) throw badRequest('invalid_target', 'Choose either an existing album or a new album name');

    const jobId = newId();
    db.transaction(() => {
      const albumId = input.albumId ?? this.albums.createUnique(input.newAlbumName!).id;
      this.albums.get(albumId);
      const now = nowIso();
      const label = input.files.length === 1 ? input.files[0]!.name : `${input.files.length} selected files`;
      db.prepare(
        `INSERT INTO import_jobs (id, kind, album_id, source_label, state, intake_closed, created_at, updated_at)
         VALUES (?, 'files', ?, ?, 'running', 0, ?, ?)`,
      ).run(jobId, albumId, label, now, now);
      const insert = db.prepare(
        `INSERT INTO import_items (id, job_id, item_key, display_filename, byte_size, state, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of input.files) {
        const tooLarge = f.size > env.maxImportBytes;
        insert.run(newId(), jobId, f.key, path.basename(f.name), f.size, tooLarge ? 'skipped' : 'pending', tooLarge ? 'too_large' : null, now);
      }
    })();
    this.maybeFinishJob(jobId);
    return this.progress(jobId);
  }

  /** Receives one browser file. Re-sending an already accepted item is harmless and returns its outcome. */
  async receiveFile(jobId: string, itemKey: string, stream: Readable): Promise<{ state: ItemState; reason: string | null }> {
    const { db, env, store } = this.ctx;
    const job = db.prepare(`SELECT kind, state, album_id AS albumId FROM import_jobs WHERE id = ?`).get(jobId) as
      | { kind: string; state: JobState; albumId: string | null }
      | undefined;
    if (!job || job.kind !== 'files') throw notFound('Import');
    if (job.state === 'canceled') throw conflict('import_canceled', 'This import was canceled');
    const item = db.prepare(`SELECT id, state, reason, display_filename AS name FROM import_items WHERE job_id = ? AND item_key = ?`).get(jobId, itemKey) as
      | { id: string; state: ItemState; reason: string | null; name: string }
      | undefined;
    if (!item) throw notFound('Import item');
    if (item.state === 'imported' || item.state === 'skipped') {
      stream.resume();
      return { state: item.state, reason: item.reason };
    }
    const claimed = db
      .prepare(`UPDATE import_items SET state = 'running', updated_at = ? WHERE id = ? AND state IN ('pending', 'failed')`)
      .run(nowIso(), item.id).changes;
    if (!claimed) {
      stream.resume();
      throw conflict('upload_in_progress', 'This file is already being received');
    }
    if (job.state === 'paused') db.prepare(`UPDATE import_jobs SET state = 'running', updated_at = ? WHERE id = ?`).run(nowIso(), jobId);
    if (!job.albumId) {
      stream.resume();
      return this.recordOutcome(item.id, jobId, { state: 'failed', reason: 'album_deleted' });
    }

    try {
      const t0 = Date.now();
      const staged = await stageStream(store.stagingDir, stream, env.maxImportBytes);
      const t1 = Date.now();
      const result = await this.assets.ingest(staged, job.albumId, item.name);
      this.measure(jobId, t0, t1, Date.now());
      return this.recordOutcome(item.id, jobId, this.toOutcome(result, jobId, item.id, job.albumId));
    } catch (err) {
      if (isTransferAbort(err)) {
        // The browser went away mid-file: the item was never received, so it waits for reselection.
        db.prepare(`UPDATE import_items SET state = 'pending', updated_at = ? WHERE id = ?`).run(nowIso(), item.id);
        this.maybeFinishJob(jobId);
        throw err;
      }
      return this.recordOutcome(item.id, jobId, this.failure(err, item.name));
    }
  }

  /** The browser has sent everything it will send. Unreceived items keep the job paused until reselected. */
  finish(jobId: string): ImportProgress {
    const { db } = this.ctx;
    const changed = db.prepare(`UPDATE import_jobs SET intake_closed = 1, updated_at = ? WHERE id = ? AND kind = 'files'`).run(nowIso(), jobId).changes;
    if (!changed) throw notFound('Import');
    this.maybeFinishJob(jobId);
    return this.progress(jobId);
  }

  cancel(jobId: string): ImportProgress {
    const { db } = this.ctx;
    const changed = db
      .prepare(`UPDATE import_jobs SET state = 'canceled', updated_at = ? WHERE id = ? AND state IN ('queued', 'running', 'paused')`)
      .run(nowIso(), jobId).changes;
    if (!changed) this.progress(jobId); // 404 if missing; otherwise already finished
    return this.progress(jobId);
  }

  // ---------- progress ----------

  progress(jobId: string): ImportProgress {
    const { db } = this.ctx;
    const job = db
      .prepare(
        `SELECT j.id, j.kind, j.state, j.album_id AS albumId, al.name AS albumName, j.source_label AS sourceLabel,
                j.intake_closed AS intakeClosed, j.created_at AS createdAt, j.updated_at AS updatedAt, j.stats
           FROM import_jobs j LEFT JOIN albums al ON al.id = j.album_id WHERE j.id = ?`,
      )
      .get(jobId) as
      | (Omit<ImportProgress, 'counts' | 'problems' | 'missingKeys' | 'intakeClosed' | 'processing' | 'timings'> & { intakeClosed: number; stats: string | null })
      | undefined;
    if (!job) throw notFound('Import');
    const counts = { total: 0, imported: 0, skipped: 0, failed: 0, pending: 0 };
    for (const r of db.prepare(`SELECT state, count(*) AS n FROM import_items WHERE job_id = ? GROUP BY state`).all(jobId) as { state: ItemState; n: number }[]) {
      counts.total += r.n;
      if (r.state === 'pending' || r.state === 'running') counts.pending += r.n;
      else counts[r.state] += r.n;
    }
    const problems = db
      .prepare(
        `SELECT display_filename AS filename, state, reason FROM import_items
          WHERE job_id = ? AND state IN ('skipped', 'failed') AND COALESCE(reason, '') != 'duplicate_in_album'
          ORDER BY updated_at LIMIT 200`,
      )
      .all(jobId) as ImportProgress['problems'];
    const missingKeys =
      job.kind === 'files' && job.state !== 'canceled'
        ? (db.prepare(`SELECT item_key FROM import_items WHERE job_id = ? AND state = 'pending' LIMIT 5000`).pluck().all(jobId) as string[])
        : [];
    const { stats, ...rest } = job;
    return {
      ...rest,
      intakeClosed: job.intakeClosed === 1,
      counts,
      problems,
      missingKeys,
      processing: this.processingOf(jobId),
      timings: stats ? (JSON.parse(stats) as JobTimings) : null,
    };
  }

  /** Latest-revision task states for the photos this job imported. */
  private processingOf(jobId: string): ImportProgress['processing'] {
    const rows = this.ctx.db
      .prepare(
        `SELECT t.kind, t.state, count(*) AS n
           FROM processing_tasks t
          WHERE t.asset_id IN (SELECT asset_id FROM import_items WHERE job_id = ? AND state = 'imported' AND asset_id IS NOT NULL)
            AND t.revision = (SELECT max(revision) FROM processing_tasks t2 WHERE t2.asset_id = t.asset_id AND t2.kind = t.kind)
          GROUP BY t.kind, t.state`,
      )
      .all(jobId) as { kind: TaskKind; state: string; n: number }[];
    const out = Object.fromEntries(TASK_KINDS.map((k) => [k, { total: 0, done: 0, failed: 0 }])) as ImportProgress['processing'];
    for (const r of rows) {
      if (!out[r.kind]) continue; // a kind this build does not know
      out[r.kind].total += r.n;
      if (r.state === 'succeeded') out[r.kind].done += r.n;
      if (r.state === 'failed') out[r.kind].failed += r.n;
    }
    return out;
  }

  /** Unfinished jobs plus those finished in the last 10 minutes, newest first. */
  recent(): ImportProgress[] {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const ids = this.ctx.db
      .prepare(
        `SELECT id FROM import_jobs WHERE state IN ('queued', 'running', 'paused') OR updated_at >= ?
          ORDER BY created_at DESC LIMIT 20`,
      )
      .pluck()
      .all(since) as string[];
    return ids.map((id) => this.progress(id));
  }

  // ---------- worker ----------

  /** Startup recovery: work interrupted mid-item goes back to pending, then folder jobs continue. */
  recover(): void {
    const { db } = this.ctx;
    const reset = db.prepare(`UPDATE import_items SET state = 'pending', updated_at = ? WHERE state = 'running'`).run(nowIso()).changes;
    if (reset) this.log.info({ items: reset }, 'reset interrupted import items');
    this.kick();
  }

  /** Stops starting folder items and waits for those in progress; unfinished ones resume on the next start. */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + timeoutMs;
    while (this.active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }

  /** Starts folder items up to the concurrency limit. */
  kick(): void {
    while (!this.stopping && this.active < this.ctx.env.importConcurrency) {
      const item = this.claimNextFolderItem();
      if (!item) return;
      this.active++;
      void this.processFolderItem(item).finally(() => {
        this.active--;
        this.kick();
      });
    }
  }

  /** Resolves when no folder item is being processed and none is waiting. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.active > 0 || this.claimableCount() > 0) await new Promise((r) => setTimeout(r, 20));
  }

  private claimableCount(): number {
    return this.ctx.db
      .prepare(
        `SELECT count(*) FROM import_items i JOIN import_jobs j ON j.id = i.job_id
          WHERE j.kind = 'folder' AND j.state IN ('queued', 'running') AND i.state = 'pending'`,
      )
      .pluck()
      .get() as number;
  }

  private claimNextFolderItem(): ClaimedItem | null {
    const { db } = this.ctx;
    return db.transaction(() => {
      const item = db
        .prepare(
          `SELECT i.id, i.job_id AS jobId, i.item_key AS itemKey, i.display_filename AS displayFilename,
                  j.source_path AS sourcePath, j.album_id AS albumId
             FROM import_items i JOIN import_jobs j ON j.id = i.job_id
            WHERE j.kind = 'folder' AND j.state IN ('queued', 'running') AND i.state = 'pending'
            ORDER BY j.created_at, i.rowid LIMIT 1`,
        )
        .get() as ClaimedItem | undefined;
      if (!item) return null;
      const now = nowIso();
      db.prepare(`UPDATE import_items SET state = 'running', updated_at = ? WHERE id = ?`).run(now, item.id);
      db.prepare(`UPDATE import_jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'`).run(now, item.jobId);
      return item;
    })();
  }

  private async processFolderItem(item: ClaimedItem): Promise<void> {
    if (!item.albumId) {
      this.recordOutcome(item.id, item.jobId, { state: 'failed', reason: 'album_deleted' });
      return;
    }
    const file = path.join(item.sourcePath, item.itemKey);
    try {
      const t0 = Date.now();
      const staged = await stageStream(this.ctx.store.stagingDir, createReadStream(file), this.ctx.env.maxImportBytes);
      const t1 = Date.now();
      const result = await this.assets.ingest(staged, item.albumId, item.displayFilename);
      this.measure(item.jobId, t0, t1, Date.now());
      this.recordOutcome(item.id, item.jobId, this.toOutcome(result, item.jobId, item.id, item.albumId));
    } catch (err) {
      this.recordOutcome(item.id, item.jobId, this.failure(err, item.displayFilename));
    }
  }

  /**
   * "Already in this album" can also mean this very item was committed just before a crash and is now being
   * processed again. If the membership appeared during this job and no other item of the job owns the photo,
   * the item imported it.
   */
  private toOutcome(result: IngestResult, jobId: string, itemId: string, albumId: string): { state: ItemState; reason: string | null; assetId: string | null } {
    if (result.outcome === 'imported') return { state: 'imported', reason: null, assetId: result.assetId };
    if (result.reason === 'duplicate_in_album' && result.assetId) {
      const ownedHere = this.ctx.db
        .prepare(
          `SELECT 1 FROM album_assets aa JOIN import_jobs j ON j.id = ?
            WHERE aa.album_id = ? AND aa.asset_id = ? AND aa.added_at >= j.created_at
              AND NOT EXISTS (SELECT 1 FROM import_items WHERE job_id = j.id AND id != ? AND asset_id = aa.asset_id AND state = 'imported')`,
        )
        .get(jobId, albumId, result.assetId, itemId);
      if (ownedHere) return { state: 'imported', reason: null, assetId: result.assetId };
    }
    return { state: 'skipped', reason: result.reason, assetId: result.assetId };
  }

  private measure(jobId: string, start: number, staged: number, end: number): void {
    let m = this.measurements.get(jobId);
    if (!m) this.measurements.set(jobId, (m = { firstStart: start, lastEnd: end, stage: [], ingest: [] }));
    m.firstStart = Math.min(m.firstStart, start);
    m.lastEnd = Math.max(m.lastEnd, end);
    m.stage.push(staged - start);
    m.ingest.push(end - staged);
  }

  private persistTimings(jobId: string): void {
    const m = this.measurements.get(jobId);
    if (!m) return;
    this.measurements.delete(jobId);
    const wallMs = Math.max(1, m.lastEnd - m.firstStart);
    const timings: JobTimings = {
      wallMs,
      itemsPerSecond: Math.round((m.stage.length / wallMs) * 1000 * 100) / 100,
      stage: timing(m.stage),
      ingest: timing(m.ingest),
    };
    this.ctx.db.prepare(`UPDATE import_jobs SET stats = ? WHERE id = ?`).run(JSON.stringify(timings), jobId);
    this.log.info({ jobId, ...timings }, 'import finished');
  }

  private failure(err: unknown, filename: string): { state: ItemState; reason: string } {
    if (err instanceof ItemRejected) return { state: 'skipped', reason: err.reason };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') return { state: 'skipped', reason: 'too_large' };
    if (code === 'ENOENT') return { state: 'failed', reason: 'source_missing' };
    if (code === 'EACCES' || code === 'EPERM') return { state: 'failed', reason: 'permission_denied' };
    if (err instanceof AppError) return { state: 'failed', reason: err.code };
    this.log.error({ err, filename }, 'import item failed');
    return { state: 'failed', reason: 'internal_error' };
  }

  private recordOutcome(itemId: string, jobId: string, outcome: { state: ItemState; reason: string | null; assetId?: string | null }) {
    this.ctx.db
      .prepare(`UPDATE import_items SET state = ?, reason = ?, asset_id = ?, updated_at = ? WHERE id = ?`)
      .run(outcome.state, outcome.reason, outcome.assetId ?? null, nowIso(), itemId);
    this.maybeFinishJob(jobId);
    return { state: outcome.state, reason: outcome.reason };
  }

  /** A job completes once intake is closed and every item has an outcome; a files job with unreceived items pauses. */
  private maybeFinishJob(jobId: string): void {
    const { db } = this.ctx;
    const job = db.prepare(`SELECT state, intake_closed AS closed FROM import_jobs WHERE id = ?`).get(jobId) as
      | { state: JobState; closed: number }
      | undefined;
    if (!job || !job.closed || job.state === 'canceled' || job.state === 'completed') return;
    const open = db
      .prepare(`SELECT state, count(*) AS n FROM import_items WHERE job_id = ? AND state IN ('pending', 'running') GROUP BY state`)
      .all(jobId) as { state: ItemState; n: number }[];
    const running = open.find((r) => r.state === 'running')?.n ?? 0;
    const pending = open.find((r) => r.state === 'pending')?.n ?? 0;
    let next: JobState | null = null;
    if (running + pending === 0) next = 'completed';
    else if (running === 0 && pending > 0 && (db.prepare(`SELECT kind FROM import_jobs WHERE id = ?`).pluck().get(jobId) as string) === 'files') next = 'paused';
    if (next && next !== job.state) {
      db.prepare(`UPDATE import_jobs SET state = ?, updated_at = ? WHERE id = ?`).run(next, nowIso(), jobId);
      if (next === 'completed') this.persistTimings(jobId);
    }
  }
}

const ABORT_CODES = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR']);

function isTransferAbort(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && ABORT_CODES.has(code);
}


/** Recursively lists image files (relative paths), skipping hidden files and folders and not following symlinks. */
async function scanFolder(root: string): Promise<{ files: string[]; ignored: number }> {
  const files: string[] = [];
  let ignored = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // Files before subfolders, so an original is imported before a copy of it in a nested folder.
    for (const e of entries) {
      if (e.name.startsWith('.') || !e.isFile()) continue;
      if (IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) files.push(path.relative(root, path.join(dir, e.name)));
      else ignored++;
    }
    for (const e of entries) {
      if (!e.name.startsWith('.') && e.isDirectory()) await walk(path.join(dir, e.name));
    }
  };
  await walk(root);
  return { files, ignored };
}
