export interface Album {
  id: string;
  name: string;
  photoCount: number;
  coverPhotoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlbumRef {
  id: string;
  name: string;
}

export interface PhotoSummary {
  id: string;
  filename: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
}

export interface PhotoDetail extends PhotoSummary {
  format: string;
  mime: string;
  byteSize: number;
  camera: { make: string | null; model: string | null } | null;
  location: { lat: number; lon: number } | null;
  description: {
    effective: string | null;
    ai: string | null;
    manual: string | null;
    tags: string[];
    provider: string | null;
    model: string | null;
    enrichment: { categories: string[]; keywords: string[]; rowId: number; storedAt: string } | null;
    objects: string[];
    text: string | null;
    kind: string | null;
  } | null;
  albums: AlbumRef[];
  processing: Partial<Record<TaskKind, { state: 'pending' | 'running' | 'succeeded' | 'failed'; error: string | null; provider: string | null }>>;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PhotoContext {
  index: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
  window: PhotoSummary[];
}

export interface Throughput {
  perSecond: number;
  perSecond5m: number;
  avgMs: number | null;
  p95Ms: number | null;
  finishedSinceStart: number;
}

export interface StageClock {
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  done: number;
  perSecond: number;
  avgMs: number | null;
}

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';

export interface ImportJob {
  id: string;
  kind: 'folder' | 'files';
  state: JobState;
  albumId: string | null;
  albumName: string | null;
  sourceLabel: string;
  intakeClosed: boolean;
  counts: { total: number; imported: number; skipped: number; failed: number; pending: number };
  problems: { filename: string; state: string; reason: string | null }[];
  missingKeys: string[];
  processing: Record<TaskKind, { total: number; done: number; failed: number }>;
  stages: Record<'import' | TaskKind, StageClock | null>;
  createdAt: string;
  updatedAt: string;
}

export type TaskKind = 'caption' | 'embedding' | 'enrichment' | 'text_embedding';

export interface KindSummary {
  kind: TaskKind;
  registered: boolean;
  pausedReason: string | null;
  pausedUntil: string | null;
  pending: number;
  retrying: number;
  running: number;
  succeeded: number;
  failed: number;
  throughput: Throughput;
}
