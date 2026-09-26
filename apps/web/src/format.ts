export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** EXIF times without an offset are local wall-clock times; Date parses them as local, which is what we want. */
export function formatTakenAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en', { dateStyle: 'long', timeStyle: 'short' });
}

/** 850 ms, 7.1 s, 2 m 14 s, 1 h 3 m */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

export function formatRate(perSecond: number): string {
  return perSecond >= 10 ? `${Math.round(perSecond)}/s` : `${perSecond.toFixed(1)}/s`;
}
