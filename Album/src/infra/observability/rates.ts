/** Live rates from the last minutes of work in this process (not persisted). */
export interface Throughput {
  /** Finished per second over the last 30 seconds. */
  perSecond: number;
  /** Finished per second over the last 5 minutes. */
  perSecond5m: number;
  /** Mean and 95th-percentile run time of the last 500 finished items. */
  avgMs: number | null;
  p95Ms: number | null;
  /** Finished since the process started. */
  finishedSinceStart: number;
}

const WINDOW_MS = 300_000;

/** Throughput of one kind of work, measured from finish times. Old samples are dropped on read too, so an idle rate falls to zero. */
export class RateMeter {
  private readonly samples: [number, number][] = [];
  private finished = 0;

  record(durationMs: number, now = Date.now()): void {
    this.samples.push([now, durationMs]);
    this.finished++;
    this.prune(now);
  }

  read(now = Date.now()): Throughput {
    this.prune(now);
    const list = this.samples;
    const last30 = list.filter(([at]) => at >= now - 30_000).length;
    const times = list.slice(-500).map(([, ms]) => ms).sort((a, b) => a - b);
    const round = (x: number) => Math.round(x * 10) / 10;
    return {
      perSecond: round(last30 / 30),
      perSecond5m: round(list.length / (WINDOW_MS / 1000)),
      avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      p95Ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]! : null,
      finishedSinceStart: this.finished,
    };
  }

  private prune(now: number): void {
    while (this.samples.length > 0 && (this.samples[0]![0] < now - WINDOW_MS || this.samples.length > 20_000)) this.samples.shift();
  }
}
