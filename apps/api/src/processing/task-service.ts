import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../shared/errors.js';
import { newId, nowIso } from '../shared/ids.js';

export type TaskKind = 'caption' | 'embedding' | 'enrichment';
export const TASK_KINDS: readonly TaskKind[] = ['caption', 'embedding', 'enrichment'];

export interface ClaimedTask {
  id: string;
  assetId: string;
  kind: TaskKind;
  revision: number;
  /** Including the current run. */
  attempts: number;
}

export interface TaskHandler {
  /** Parallelism limit, read on every scheduling pass so settings changes apply without a restart. */
  concurrency(): number;
  run(task: ClaimedTask): Promise<{ provider?: string } | void>;
}

/** Retrying cannot help (for example the provider rejected the image): the task fails at once. */
export class PermanentTaskError extends Error {}

/**
 * The service behind a kind is down or not configured. The task goes back to the queue without using an
 * attempt, and the whole kind pauses, so a 10,000-item backlog does not hammer a dead endpoint.
 */
export class ServiceUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 60_000,
  ) {
    super(message);
  }
}

export interface KindSummary {
  kind: TaskKind;
  /** A handler is registered (the feature exists in this build). */
  registered: boolean;
  /** Set while the kind is paused because its service is unavailable. */
  pausedReason: string | null;
  pausedUntil: string | null;
  pending: number;
  /** Pending but waiting for a retry backoff to expire. */
  retrying: number;
  running: number;
  succeeded: number;
  failed: number;
}

export interface TaskOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  pollMs: number;
}

const DEFAULTS: TaskOptions = { maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 3_600_000, pollMs: 2_000 };

/**
 * Durable per-asset AI work. Each kind has its own queue, handler, and concurrency bound, so a slow local GPU
 * never holds back cloud captions and vice versa. State lives in processing_tasks; nothing important is in memory.
 */
export class TaskService {
  private readonly handlers = new Map<TaskKind, TaskHandler>();
  private readonly active = new Map<TaskKind, number>();
  private readonly paused = new Map<TaskKind, { until: number; reason: string }>();
  private readonly opts: TaskOptions;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly log: FastifyBaseLogger,
    opts: Partial<TaskOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  register(kind: TaskKind, handler: TaskHandler): void {
    this.handlers.set(kind, handler);
    this.paused.delete(kind); // a pause belonged to the previous handler's service
    this.kick();
  }

  /** Queues work for an asset. Safe to repeat; call inside the transaction that created the asset. */
  enqueue(assetId: string, kinds: readonly TaskKind[], revision = 1): void {
    const now = nowIso();
    const insert = this.ctx.db.prepare(
      `INSERT OR IGNORE INTO processing_tasks (id, asset_id, kind, revision, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    );
    for (const kind of kinds) insert.run(newId(), assetId, kind, revision, now, now);
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), this.opts.pollMs);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Startup recovery: work that was running when the process stopped is queued again. */
  recover(): number {
    const n = this.ctx.db
      .prepare(`UPDATE processing_tasks SET state = 'pending', started_at = NULL, updated_at = ? WHERE state = 'running'`)
      .run(nowIso()).changes;
    if (n) this.log.info({ tasks: n }, 'requeued interrupted processing tasks');
    return n;
  }

  /** Starts due tasks up to each kind's concurrency limit. */
  kick(): void {
    for (const [kind, handler] of this.handlers) {
      const pause = this.paused.get(kind);
      if (pause && pause.until > Date.now()) continue;
      if (pause) this.paused.delete(kind);
      while ((this.active.get(kind) ?? 0) < Math.max(1, handler.concurrency())) {
        const task = this.claim(kind);
        if (!task) break;
        this.active.set(kind, (this.active.get(kind) ?? 0) + 1);
        void this.execute(handler, task).finally(() => {
          this.active.set(kind, (this.active.get(kind) ?? 1) - 1);
          this.kick();
        });
      }
    }
  }

  private claim(kind: TaskKind): ClaimedTask | null {
    const { db } = this.ctx;
    return db.transaction(() => {
      const now = nowIso();
      const row = db
        .prepare(
          `SELECT id, asset_id AS assetId, kind, revision, attempts FROM processing_tasks
            WHERE kind = ? AND state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(kind, now) as ClaimedTask | undefined;
      if (!row) return null;
      db.prepare(
        `UPDATE processing_tasks SET state = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, now, row.id);
      return { ...row, attempts: row.attempts + 1 };
    })();
  }

  private async execute(handler: TaskHandler, task: ClaimedTask): Promise<void> {
    const { db } = this.ctx;
    const started = Date.now();
    try {
      const result = await handler.run(task);
      const now = nowIso();
      db.prepare(
        `UPDATE processing_tasks SET state = 'succeeded', error = NULL, next_attempt_at = NULL, provider = COALESCE(?, provider),
                finished_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
      ).run(result?.provider ?? null, now, Date.now() - started, now, task.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now = new Date();
      if (err instanceof ServiceUnavailableError) {
        this.paused.set(task.kind, { until: now.getTime() + err.retryAfterMs, reason: message });
        db.prepare(
          `UPDATE processing_tasks SET state = 'pending', attempts = attempts - 1, started_at = NULL, error = ?, updated_at = ? WHERE id = ?`,
        ).run(message, now.toISOString(), task.id);
        this.log.warn({ kind: task.kind, reason: message, retryInMs: err.retryAfterMs }, 'processing paused');
        return;
      }
      const permanent = err instanceof PermanentTaskError || task.attempts >= this.opts.maxAttempts;
      if (permanent) {
        db.prepare(
          `UPDATE processing_tasks SET state = 'failed', error = ?, finished_at = ?, duration_ms = ?, updated_at = ? WHERE id = ?`,
        ).run(message, now.toISOString(), Date.now() - started, now.toISOString(), task.id);
        this.log.warn({ kind: task.kind, assetId: task.assetId, attempts: task.attempts, err: message }, 'processing task failed');
      } else {
        const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (task.attempts - 1));
        db.prepare(
          `UPDATE processing_tasks SET state = 'pending', error = ?, started_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
        ).run(message, new Date(now.getTime() + delay).toISOString(), now.toISOString(), task.id);
      }
    }
  }

  /** Lifts a pause early, e.g. after the user saves a new API key. */
  resume(kind?: TaskKind): void {
    if (kind) this.paused.delete(kind);
    else this.paused.clear();
    this.kick();
  }

  /** Queues the next revision of one kind for an asset (e.g. "regenerate description"). Returns the revision. */
  enqueueNextRevision(assetId: string, kind: TaskKind): number {
    const { db } = this.ctx;
    const revision = db.transaction(() => {
      const current = db.prepare(`SELECT max(revision) FROM processing_tasks WHERE asset_id = ? AND kind = ?`).pluck().get(assetId, kind) as number | null;
      const pendingSame = db
        .prepare(`SELECT revision FROM processing_tasks WHERE asset_id = ? AND kind = ? AND state IN ('pending', 'running') ORDER BY revision DESC LIMIT 1`)
        .pluck()
        .get(assetId, kind) as number | undefined;
      if (pendingSame !== undefined) return pendingSame; // already queued; do not stack reruns
      const next = (current ?? 0) + 1;
      this.enqueue(assetId, [kind], next);
      return next;
    })();
    this.kick();
    return revision;
  }

  /** Latest-revision task state per kind for one asset. */
  statusOf(assetId: string): Partial<Record<TaskKind, { state: string; error: string | null; provider: string | null }>> {
    const rows = this.ctx.db
      .prepare(
        `SELECT kind, state, error, provider FROM processing_tasks t
          WHERE asset_id = ? AND revision = (SELECT max(revision) FROM processing_tasks WHERE asset_id = t.asset_id AND kind = t.kind)`,
      )
      .all(assetId) as { kind: TaskKind; state: string; error: string | null; provider: string | null }[];
    return Object.fromEntries(rows.map(({ kind, ...rest }) => [kind, rest]));
  }

  get maxAttempts(): number {
    return this.opts.maxAttempts;
  }

  retry(taskId: string): void {
    const row = this.ctx.db.prepare(`SELECT state FROM processing_tasks WHERE id = ?`).get(taskId) as { state: string } | undefined;
    if (!row) throw notFound('Task');
    if (row.state !== 'failed') throw conflict('not_failed', 'Only failed tasks can be retried');
    this.resetFailed(`id = ?`, taskId);
    this.kick();
  }

  retryFailed(kind: TaskKind): number {
    const n = this.resetFailed(`kind = ?`, kind);
    this.paused.delete(kind);
    this.kick();
    return n;
  }

  private resetFailed(where: string, value: string): number {
    return this.ctx.db
      .prepare(
        `UPDATE processing_tasks SET state = 'pending', attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = ?
          WHERE state = 'failed' AND ${where}`,
      )
      .run(nowIso(), value).changes;
  }

  summary(): KindSummary[] {
    const now = nowIso();
    const rows = this.ctx.db
      .prepare(
        `SELECT kind, state, (state = 'pending' AND next_attempt_at > ?) AS waiting, count(*) AS n
           FROM processing_tasks GROUP BY kind, state, waiting`,
      )
      .all(now) as { kind: TaskKind; state: string; waiting: number; n: number }[];
    return TASK_KINDS.map((kind) => {
      const pause = this.paused.get(kind);
      const live = pause && pause.until > Date.now() ? pause : null;
      const s: KindSummary = {
        kind,
        registered: this.handlers.has(kind),
        pausedReason: live?.reason ?? null,
        pausedUntil: live ? new Date(live.until).toISOString() : null,
        pending: 0,
        retrying: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
      };
      for (const r of rows.filter((x) => x.kind === kind)) {
        if (r.state === 'pending') {
          s.pending += r.n;
          if (r.waiting) s.retrying += r.n;
        } else if (r.state === 'running') s.running += r.n;
        else if (r.state === 'succeeded') s.succeeded += r.n;
        else if (r.state === 'failed') s.failed += r.n;
      }
      return s;
    });
  }

  /** Resolves once no unpaused registered kind has running or pending work, including retries in backoff. For tests. */
  async idle(): Promise<void> {
    const due = () => {
      const kinds = [...this.handlers.keys()].filter((k) => (this.paused.get(k)?.until ?? 0) <= Date.now());
      if (kinds.length === 0) return 0;
      return this.ctx.db
        .prepare(
          `SELECT count(*) FROM processing_tasks WHERE state = 'pending' AND kind IN (SELECT value FROM json_each(?))`,
        )
        .pluck()
        .get(JSON.stringify(kinds)) as number;
    };
    const busy = () => [...this.active.values()].some((n) => n > 0);
    while (busy() || due() > 0) await new Promise((r) => setTimeout(r, 10));
  }
}
