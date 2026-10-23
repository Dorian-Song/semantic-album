import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FileStore } from '../../data-access/file-store/file-store.js';
import type { ItemState, JobState } from '../../data-access/repositories/imports.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import type { TaskKind } from '../../data-access/repositories/tasks.js';
import { TASK_KINDS } from '../../data-access/repositories/tasks.js';
import type { Artifact } from '../../infra/artifact/artifact.js';
import type { Logger } from '../../infra/observability/log.js';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { newId, nowIso } from '../../shared/ids.js';
import type { Library } from '../library/library.js';
import type { ImportProcessing, Processing } from '../processing/processing.js';

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
  /** Processing of this import's photos, counted separately from the import. */
  processing: ImportProcessing;
  /** Wall-clock time and rate of each stage, from stored timestamps (survives restarts). */
  stages: Record<'import' | TaskKind, StageClock | null>;
  /** Stage timings, written when the job completes (null before, or if it finished before a restart). */
  timings: JobTimings | null;
  /** Keys of items not yet received from the browser. Once no upload is running, the UI asks the user to reselect them. */
  missingKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StageClock {
  startedAt: string;
  /** Null while the stage still has work left. */
  finishedAt: string | null;
  elapsedMs: number;
  done: number;
  perSecond: number;
  /** Mean run time of one item (tasks only). */
  avgMs: number | null;
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
  /** Read + SHA-256 into the temporary area. */
  stage: StageTiming;
  /** Format check, decode, display copies, EXIF, storing, and the database write. */
  ingest: StageTiming;
}

export interface ManifestEntry {
  key: string;
  name: string;
  size: number;
}

type Outcome = { state: ItemState; reason: string | null; assetId?: string | null };

/** Extensions considered when scanning a host folder. Content is still checked; other files are ignored. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.gif', '.bmp', '.dib', '.webp', '.tif', '.tiff', '.heic', '.heif', '.hif', '.avif']);
const MAX_MANIFEST = 50_000;
const ABORT_CODES = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR']);

function clock(startedAt: string | null, lastAt: string | null, done: number, finished: boolean, avgMs: number | null): StageClock | null {
  if (!startedAt || done === 0) return null;
  const end = finished && lastAt ? Date.parse(lastAt) : Date.now();
  const elapsedMs = Math.max(1, end - Date.parse(startedAt));
  return {
    startedAt,
    finishedAt: finished ? lastAt : null,
    elapsedMs,
    done,
    perSecond: Math.round((done / elapsedMs) * 1000 * 10) / 10,
    avgMs: avgMs === null ? null : Math.round(avgMs),
  };
}

function timing(values: number[]): StageTiming {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  return { count: sorted.length, meanMs: Math.round(mean), p50Ms: Math.round(at(0.5)), p95Ms: Math.round(at(0.95)) };
}

function isTransferAbort(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && ABORT_CODES.has(code);
}

/**
 * Import batches: browser-selected files or a host folder. Records each item's state and outcome, has artifact
 * store each file and library place it in the album, and resumes after a restart.
 */
export class Import {
  private active = 0;
  private stopping = false;
  /** In-memory stage measurements per job, saved with the job when it completes. */
  private readonly measurements = new Map<string, { firstStart: number; lastEnd: number; stage: number[]; ingest: number[] }>();

  constructor(
    private readonly repos: Repositories,
    private readonly files: FileStore,
    private readonly artifact: Artifact,
    private readonly library: Library,
    private readonly processing: Processing,
    private readonly log: Logger,
    private readonly limits: { concurrency: number; maxBytes: number },
  ) {}

  // ---------- host folder ----------

  async startFolderImport(folderPath: string, albumId?: string): Promise<ImportProgress> {
    if (!path.isAbsolute(folderPath)) throw badRequest('invalid_path', 'Enter an absolute folder path on the machine running Album');
    const root = path.resolve(folderPath);
    if (!(await this.files.isHostFolder(root))) throw badRequest('folder_not_found', 'That folder does not exist on the machine running Album');
    const { files, ignored } = await this.files.scanHostFolder(root, IMAGE_EXTENSIONS);
    if (files.length === 0) throw badRequest('no_images', `No image files found in that folder${ignored ? ` (${ignored} other files ignored)` : ''}`);

    const jobId = newId();
    this.repos.tx(() => {
      if (albumId) this.library.get(albumId);
      const target = albumId ?? this.library.createUnique(path.basename(root) || 'Imported').id;
      const at = nowIso();
      this.repos.imports.createJob({ id: jobId, kind: 'folder', albumId: target, label: path.basename(root) || root, sourcePath: root, state: 'queued', intakeClosed: true, at });
      this.repos.imports.addItems(jobId, files.map((rel) => ({ key: rel, name: path.basename(rel), size: null, state: 'pending', reason: null })), newId, at);
    });
    this.kick();
    return this.progress(jobId);
  }

  // ---------- browser-selected files ----------

  createFileImport(input: { albumId?: string | undefined; newAlbumName?: string | undefined; files: ManifestEntry[] }): ImportProgress {
    if (input.files.length === 0) throw badRequest('empty_manifest', 'Select at least one file');
    if (input.files.length > MAX_MANIFEST) throw badRequest('manifest_too_large', `Import at most ${MAX_MANIFEST} files at once`);
    if (new Set(input.files.map((f) => f.key)).size !== input.files.length) throw badRequest('duplicate_keys', 'File keys must be unique');
    if (!input.albumId === !input.newAlbumName) throw badRequest('invalid_target', 'Choose either an existing album or a new album name');

    const jobId = newId();
    this.repos.tx(() => {
      const albumId = input.albumId ?? this.library.createUnique(input.newAlbumName!).id;
      this.library.get(albumId);
      const at = nowIso();
      const label = input.files.length === 1 ? input.files[0]!.name : `${input.files.length} selected files`;
      this.repos.imports.createJob({ id: jobId, kind: 'files', albumId, label, sourcePath: null, state: 'running', intakeClosed: false, at });
      this.repos.imports.addItems(
        jobId,
        input.files.map((f) => {
          const tooLarge = f.size > this.limits.maxBytes;
          return { key: f.key, name: path.basename(f.name), size: f.size, state: tooLarge ? 'skipped' : 'pending', reason: tooLarge ? 'too_large' : null };
        }),
        newId,
        at,
      );
    });
    this.maybeFinishJob(jobId);
    return this.progress(jobId);
  }

  /** Receives one browser file. Re-sending an already accepted item is harmless and returns its outcome. */
  async receiveFile(jobId: string, itemKey: string, stream: Readable): Promise<{ state: ItemState; reason: string | null }> {
    const imports = this.repos.imports;
    const job = imports.job(jobId);
    if (!job || job.kind !== 'files') throw notFound('Import');
    if (job.state === 'canceled') throw conflict('import_canceled', 'This import was canceled');
    const item = imports.item(jobId, itemKey);
    if (!item) throw notFound('Import item');
    if (item.state === 'imported' || item.state === 'skipped') {
      stream.resume();
      return { state: item.state, reason: item.reason };
    }
    if (!imports.claimItem(item.id, nowIso())) {
      stream.resume();
      throw conflict('upload_in_progress', 'This file is already being received');
    }
    if (job.state === 'paused') imports.setJobState(jobId, 'running', nowIso());
    if (!job.albumId) {
      stream.resume();
      return this.recordOutcome(item.id, jobId, { state: 'failed', reason: 'album_deleted' });
    }
    try {
      return this.recordOutcome(item.id, jobId, await this.ingest(jobId, item.id, job.albumId, item.name, stream));
    } catch (err) {
      if (isTransferAbort(err)) {
        // The browser went away mid-file: the item was never received, so it waits for reselection.
        imports.setItemPending(item.id, nowIso());
        this.maybeFinishJob(jobId);
        throw err;
      }
      return this.recordOutcome(item.id, jobId, this.failure(err, item.name));
    }
  }

  /** The browser has sent everything it will send. Unreceived items keep the job paused until reselected. */
  finish(jobId: string): ImportProgress {
    if (!this.repos.imports.closeIntake(jobId, nowIso())) throw notFound('Import');
    this.maybeFinishJob(jobId);
    return this.progress(jobId);
  }

  cancel(jobId: string): ImportProgress {
    this.repos.imports.setJobState(jobId, 'canceled', nowIso(), ['queued', 'running', 'paused']);
    return this.progress(jobId);
  }

  // ---------- progress ----------

  progress(jobId: string): ImportProgress {
    const imports = this.repos.imports;
    const job = imports.job(jobId);
    if (!job) throw notFound('Import');
    const counts = { total: 0, imported: 0, skipped: 0, failed: 0, pending: 0 };
    for (const r of imports.itemCounts(jobId)) {
      counts.total += r.n;
      if (r.state === 'pending' || r.state === 'running') counts.pending += r.n;
      else counts[r.state] += r.n;
    }
    const finished = job.state === 'completed' || job.state === 'canceled';
    const { counts: processing, clocks } = this.processing.importProgress(jobId);
    const stages = { import: clock(job.createdAt, imports.lastItemAt(jobId), counts.total - counts.pending, finished, null) } as ImportProgress['stages'];
    for (const kind of TASK_KINDS) {
      const r = clocks.find((x) => x.kind === kind);
      const p = processing[kind];
      stages[kind] = r ? clock(r.first, r.last, r.done, p.total > 0 && p.done + p.failed >= p.total, r.avgMs) : null;
    }
    const { stats, intakeClosed, ...rest } = job;
    return {
      ...rest,
      intakeClosed: intakeClosed === 1,
      counts,
      problems: imports.problems(jobId),
      missingKeys: job.kind === 'files' && job.state !== 'canceled' ? imports.missingKeys(jobId) : [],
      processing,
      timings: stats ? (JSON.parse(stats) as JobTimings) : null,
      stages,
    };
  }

  /** The most recent jobs, finished or not. */
  history(limit = 10): ImportProgress[] {
    return this.repos.imports.latestJobIds(limit).map((id) => this.progress(id));
  }

  /** Unfinished jobs plus those finished in the last 10 minutes, newest first. */
  recent(): ImportProgress[] {
    return this.repos.imports.recentJobIds(new Date(Date.now() - 10 * 60_000).toISOString()).map((id) => this.progress(id));
  }

  // ---------- folder worker ----------

  /** Work interrupted mid-item goes back to pending, then folder jobs continue. */
  recover(): void {
    const reset = this.repos.imports.requeueRunningItems(nowIso());
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
    while (!this.stopping && this.active < this.limits.concurrency) {
      const item = this.repos.imports.claimNextFolderItem(nowIso());
      if (!item) return;
      this.active++;
      void (async () => {
        if (!item.albumId) return this.recordOutcome(item.id, item.jobId, { state: 'failed', reason: 'album_deleted' });
        const albumId = item.albumId;
        try {
          const file = this.files.readHostFile(path.join(item.sourcePath, item.itemKey));
          this.recordOutcome(item.id, item.jobId, await this.ingest(item.jobId, item.id, albumId, item.displayFilename, file));
        } catch (err) {
          this.recordOutcome(item.id, item.jobId, this.failure(err, item.displayFilename));
        }
      })().finally(() => {
        this.active--;
        this.kick();
      });
    }
  }

  /** Resolves when no folder item is being processed and none is waiting. */
  async idle(): Promise<void> {
    while (this.active > 0 || this.repos.imports.claimableFolderItems() > 0) await new Promise((r) => setTimeout(r, 20));
  }

  // ---------- one item ----------

  private async ingest(jobId: string, itemId: string, albumId: string, filename: string, source: Readable): Promise<Outcome> {
    const t0 = Date.now();
    let received = t0;
    const counted = source.once('end', () => (received = Date.now()));
    const result = await this.artifact.store(counted, (assetId, isNew) => this.library.attach(albumId, assetId, filename, isNew));
    this.processing.wake();
    this.measure(jobId, t0, received, Date.now());
    if (!result.stored) return { state: 'skipped', reason: result.reason };
    if (result.attached) return { state: 'imported', reason: null, assetId: result.assetId };
    // "Already in this album" can also mean this very item was stored just before a crash and is now received again.
    if (this.repos.imports.importedByThisItem(jobId, albumId, result.assetId, itemId)) return { state: 'imported', reason: null, assetId: result.assetId };
    return { state: 'skipped', reason: 'duplicate_in_album', assetId: result.assetId };
  }

  private measure(jobId: string, start: number, received: number, end: number): void {
    let m = this.measurements.get(jobId);
    if (!m) this.measurements.set(jobId, (m = { firstStart: start, lastEnd: end, stage: [], ingest: [] }));
    m.firstStart = Math.min(m.firstStart, start);
    m.lastEnd = Math.max(m.lastEnd, end);
    m.stage.push(received - start);
    m.ingest.push(end - received);
  }

  private saveTimings(jobId: string): void {
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
    this.repos.imports.saveStats(jobId, JSON.stringify(timings));
    this.log.info({ jobId, ...timings }, 'import finished');
  }

  private failure(err: unknown, filename: string): Outcome {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') return { state: 'skipped', reason: 'too_large' };
    if (code === 'ENOENT') return { state: 'failed', reason: 'source_missing' };
    if (code === 'EACCES' || code === 'EPERM') return { state: 'failed', reason: 'permission_denied' };
    if (err instanceof AppError) return { state: 'failed', reason: err.code };
    this.log.error({ err, filename }, 'import item failed');
    return { state: 'failed', reason: 'internal_error' };
  }

  private recordOutcome(itemId: string, jobId: string, o: Outcome): { state: ItemState; reason: string | null } {
    this.repos.imports.setItemOutcome(itemId, o.state, o.reason, o.assetId ?? null, nowIso());
    this.maybeFinishJob(jobId);
    return { state: o.state, reason: o.reason };
  }

  /** A job completes once intake is closed and every item has an outcome; a files job with unreceived items pauses. */
  private maybeFinishJob(jobId: string): void {
    const imports = this.repos.imports;
    const job = imports.job(jobId);
    if (!job || !job.intakeClosed || job.state === 'canceled' || job.state === 'completed') return;
    const counts = imports.itemCounts(jobId);
    const running = counts.find((r) => r.state === 'running')?.n ?? 0;
    const pending = counts.find((r) => r.state === 'pending')?.n ?? 0;
    let next: JobState | null = null;
    if (running + pending === 0) next = 'completed';
    else if (running === 0 && pending > 0 && job.kind === 'files') next = 'paused';
    if (next && next !== job.state) {
      imports.setJobState(jobId, next, nowIso());
      if (next === 'completed') this.saveTimings(jobId);
    }
  }
}
