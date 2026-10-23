import type { Repositories } from '../../data-access/repositories/index.js';
import { TASK_KINDS, type TaskKind, type TaskStatus } from '../../data-access/repositories/tasks.js';
import { notFound } from '../../shared/errors.js';
import { PROMPT_REVISION } from './prompt.js';
import { DescribeStep, DescriptionEmbeddingStep, ImageEmbeddingStep, NormalizeStep, type StepDeps } from './steps.js';
import type { KindSummary, TaskQueue } from './queue.js';

export type { TaskKind };

/** Task counts of one import's photos per kind (latest revision). */
export type ImportProcessing = Record<TaskKind, { total: number; done: number; failed: number }>;

/**
 * Turns a stored photo into complete, searchable data: description, n8n normalisation, image and description
 * vectors, search content. Other modules register work here; the order of steps lives here too.
 */
export class Processing {
  constructor(
    private readonly repos: Repositories,
    readonly queue: TaskQueue,
    deps: Omit<StepDeps, 'queue' | 'repos'>,
  ) {
    const d: StepDeps = { ...deps, repos, queue };
    queue.register('caption', new DescribeStep(d));
    queue.register('enrichment', new NormalizeStep(d));
    queue.register('embedding', new ImageEmbeddingStep(d));
    queue.register('text_embedding', new DescriptionEmbeddingStep(d));
  }

  /** A new file entered the library: describe it and compute its image vector. Call inside the caller's write. */
  photoAdded(assetId: string): void {
    this.queue.add(assetId, ['caption', 'embedding']);
  }

  /** Starts newly registered work now instead of at the next poll. Call after the registering write. */
  wake(): void {
    this.queue.kick();
  }

  /** The user's description changed: recompute the description vector. */
  descriptionChanged(assetId: string): void {
    this.queue.nextRevision(assetId, 'text_embedding');
  }

  /** Queues a fresh AI description. Returns its revision. */
  regenerateDescription(assetId: string): number {
    if (!this.repos.assets.isInUse(assetId)) throw notFound('Photo');
    return this.queue.nextRevision(assetId, 'caption');
  }

  /** Photos whose AI description predates the current prompt (or that have none). */
  outdatedCount(): number {
    return this.repos.descriptions.outdated(PROMPT_REVISION).length;
  }

  /** Re-describes outdated photos with the current prompt; user descriptions are kept. */
  refreshOutdated(): number {
    const ids = this.repos.descriptions.outdated(PROMPT_REVISION);
    for (const id of ids) this.queue.nextRevision(id, 'caption');
    return ids.length;
  }

  summary(): KindSummary[] {
    return this.queue.summary();
  }

  statusOf(assetId: string): Partial<Record<TaskKind, TaskStatus>> {
    return this.queue.statusOf(assetId);
  }

  /** How far descriptions and image vectors have got for an album's photos. */
  albumProgress(albumId: string): Record<'caption' | 'embedding', { done: number; total: number }> {
    if (!this.repos.albums.exists(albumId)) throw notFound('Album');
    const out = { caption: { done: 0, total: 0 }, embedding: { done: 0, total: 0 } };
    for (const r of this.repos.tasks.albumProgress(albumId)) out[r.kind] = { done: r.done, total: r.total };
    return out;
  }

  /** Task counts and stage clocks of the photos one import brought in. */
  importProgress(jobId: string) {
    const counts = Object.fromEntries(TASK_KINDS.map((k) => [k, { total: 0, done: 0, failed: 0 }])) as ImportProcessing;
    for (const r of this.repos.tasks.importStats(jobId)) {
      const c = counts[r.kind];
      if (!c) continue; // a kind this build does not know
      c.total += r.n;
      if (r.state === 'succeeded') c.done += r.n;
      if (r.state === 'failed') c.failed += r.n;
    }
    return { counts, clocks: this.repos.tasks.importClocks(jobId) };
  }

  retry(taskId: string): void {
    this.queue.retry(taskId);
  }

  retryFailed(kind: TaskKind): number {
    return this.queue.retryFailed(kind);
  }

  /** Settings changed: a new key or re-enabled feature should not wait out an old pause. */
  settingsChanged(): void {
    this.queue.resume();
  }

  /** Deletes the photo's tasks and description. Call inside the write that deletes the photo. */
  forget(assetId: string): void {
    this.repos.tasks.deleteForAsset(assetId);
    this.repos.descriptions.delete(assetId);
  }
}
