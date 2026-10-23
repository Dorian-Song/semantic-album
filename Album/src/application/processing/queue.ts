import { RejectedError, ServiceUnavailableError } from '../../data-access/egress/errors.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import { TASK_KINDS, type ClaimedTask, type TaskKind, type TaskStatus } from '../../data-access/repositories/tasks.js';
import type { Logger } from '../../infra/observability/log.js';
import { RateMeter, type Throughput } from '../../infra/observability/rates.js';
import { conflict, notFound } from '../../shared/errors.js';
import { newId, nowIso } from '../../shared/ids.js';

export interface StepHandler {
  /** Parallelism limit, read on every scheduling pass so settings changes apply without a restart. */
  concurrency(): number;
  run(task: ClaimedTask): Promise<{ provider?: string } | void>;
}

/** The task cannot run now for a reason of its own photo (for example it left the library); it waits without using an attempt. */
export class DeferredError extends Error {}

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
  throughput: Throughput;
}

export interface QueueOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  pollMs: number;
}

const DEFAULTS: QueueOptions = { maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 3_600_000, pollMs: 2_000 };

/**
 * Durable per-photo work. Each kind has its own handler and concurrency bound, so a slow local GPU never holds
 * back cloud descriptions and vice versa. State lives in the database; nothing important is in memory.
 */
export class TaskQueue {
  private readonly handlers = new Map<TaskKind, StepHandler>();
  private readonly active = new Map<TaskKind, number>();
  private readonly paused = new Map<TaskKind, { until: number; reason: string }>();
  private readonly rates = new Map<TaskKind, RateMeter>(TASK_KINDS.map((k) => [k, new RateMeter()]));
  readonly opts: QueueOptions;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;

  constructor(
    private readonly repos: Repositories,
    private readonly log: Logger,
    opts: Partial<QueueOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  register(kind: TaskKind, handler: StepHandler): void {
    this.handlers.set(kind, handler);
    this.paused.delete(kind); // a pause belonged to the previous handler's service
    this.kick();
  }

  /** Queues work for a photo. Safe to repeat; call inside the caller's write. */
  add(assetId: string, kinds: readonly TaskKind[], revision = 1): void {
    const at = nowIso();
    for (const kind of kinds) this.repos.tasks.add(newId(), assetId, kind, revision, at);
  }

  /** Queues the next revision of one kind (e.g. "regenerate description") unless one is already queued. Returns the revision. */
  nextRevision(assetId: string, kind: TaskKind): number {
    const revision = this.repos.tx(() => {
      const open = this.repos.tasks.openRevision(assetId, kind);
      if (open !== undefined) return open;
      const next = (this.repos.tasks.latestRevision(assetId, kind) ?? 0) + 1;
      this.add(assetId, [kind], next);
      return next;
    });
    this.kick();
    return revision;
  }

  /** Begins claiming work. Call after recover(), so recovery never resets tasks this process is running. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.kick(), this.opts.pollMs);
    this.timer.unref();
    this.kick();
  }

  /** Stops claiming work and waits (up to `timeoutMs`) for running tasks. */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + timeoutMs;
    while ([...this.active.values()].some((n) => n > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }

  /** Work that was running when the process stopped is queued again. */
  recover(): number {
    const n = this.repos.tasks.requeueRunning(nowIso());
    if (n) this.log.info({ tasks: n }, 'requeued interrupted processing tasks');
    return n;
  }

  /** Starts due tasks up to each kind's concurrency limit. */
  kick(): void {
    if (!this.started || this.stopping) return;
    for (const [kind, handler] of this.handlers) {
      const pause = this.paused.get(kind);
      if (pause && pause.until > Date.now()) continue;
      if (pause) this.paused.delete(kind);
      while ((this.active.get(kind) ?? 0) < Math.max(1, handler.concurrency())) {
        const task = this.repos.tasks.claim(kind, nowIso());
        if (!task) break;
        this.active.set(kind, (this.active.get(kind) ?? 0) + 1);
        void this.execute(handler, task).finally(() => {
          this.active.set(kind, (this.active.get(kind) ?? 1) - 1);
          this.kick();
        });
      }
    }
  }

  private async execute(handler: StepHandler, task: ClaimedTask): Promise<void> {
    const tasks = this.repos.tasks;
    const started = Date.now();
    try {
      const result = await handler.run(task);
      this.rates.get(task.kind)?.record(Date.now() - started);
      tasks.succeeded(task.id, result?.provider ?? null, nowIso(), Date.now() - started);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now = new Date();
      if (err instanceof ServiceUnavailableError) {
        this.paused.set(task.kind, { until: now.getTime() + err.retryAfterMs, reason: message });
        tasks.putBack(task.id, message, now.toISOString());
        this.log.warn({ kind: task.kind, reason: message, retryInMs: err.retryAfterMs }, 'processing paused');
        return;
      }
      if (err instanceof DeferredError) {
        tasks.putBack(task.id, message, now.toISOString());
        return;
      }
      if (err instanceof RejectedError || task.attempts >= this.opts.maxAttempts) {
        tasks.failed(task.id, message, now.toISOString(), Date.now() - started);
        this.rates.get(task.kind)?.record(Date.now() - started);
        this.log.warn({ kind: task.kind, assetId: task.assetId, attempts: task.attempts, err: message }, 'processing task failed');
      } else {
        const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (task.attempts - 1));
        tasks.retryLater(task.id, message, new Date(now.getTime() + delay).toISOString(), now.toISOString());
      }
    }
  }

  /** Lifts pauses early, e.g. after the user saves a new API key. */
  resume(kind?: TaskKind): void {
    if (kind) this.paused.delete(kind);
    else this.paused.clear();
    this.kick();
  }

  retry(taskId: string): void {
    const state = this.repos.tasks.state(taskId);
    if (state === undefined) throw notFound('Task');
    if (state !== 'failed') throw conflict('not_failed', 'Only failed tasks can be retried');
    this.repos.tasks.resetFailedTask(taskId, nowIso());
    this.kick();
  }

  retryFailed(kind: TaskKind): number {
    const n = this.repos.tasks.resetFailedKind(kind, nowIso());
    this.paused.delete(kind);
    this.kick();
    return n;
  }

  /** Latest-revision task state per kind for one photo. */
  statusOf(assetId: string): Partial<Record<TaskKind, TaskStatus>> {
    return Object.fromEntries(this.repos.tasks.statusOf(assetId).map(({ kind, ...rest }) => [kind, rest]));
  }

  summary(): KindSummary[] {
    const rows = this.repos.tasks.summary(nowIso());
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
        throughput: this.rates.get(kind)!.read(),
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

  /** Resolves once no unpaused registered kind has running or claimable work, including retries in backoff. */
  async idle(): Promise<void> {
    const due = () => {
      const kinds = [...this.handlers.keys()].filter((k) => (this.paused.get(k)?.until ?? 0) <= Date.now());
      return kinds.length === 0 ? 0 : this.repos.tasks.claimableCount(kinds);
    };
    const busy = () => [...this.active.values()].some((n) => n > 0);
    while (busy() || due() > 0) await new Promise((r) => setTimeout(r, 10));
  }
}
