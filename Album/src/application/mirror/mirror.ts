import type { FastifyBaseLogger } from 'fastify';
import { createRows, deleteRows, listRows, rowPage, updateRows, type BaserowRow, type BaserowTarget } from '../../data-access/egress/baserow.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import type { MirrorPhoto } from '../../data-access/repositories/mirror-reads.js';

export interface BaserowConfig {
  target: BaserowTarget;
  tables: { albums: number; photos: number; tags: number };
}

export interface SyncCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface MirrorStatus {
  configured: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  last: SyncCounts | null;
}

export interface MirrorOverview {
  albums: number;
  photos: number;
  tags: number;
  topTags: { name: string; photoCount: number }[];
}

/** Field names in the Baserow tables (created with Kuma; see baserow/README.md). */
const F = {
  name: 'Name',
  albumCount: 'Photo count',
  albumCreated: 'Created date',
  sha: 'SHA-256 ID',
  fileName: 'File name',
  caption: 'Caption',
  takenAt: 'Captured at',
  camera: 'Camera',
  albums: 'Albums',
  tags: 'Tags',
  tagCount: 'Photo count',
} as const;

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const linkIds = (v: unknown) => (Array.isArray(v) ? (v as { id: number }[]).map((x) => x.id).sort((a, b) => a - b) : []);
const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** EXIF times carry no zone; send them as UTC so the value read back compares equal. */
const utc = (t: string | null) => (t === null ? null : /Z$|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
const sameTime = (a: unknown, b: string | null) => (a ? Date.parse(String(a)) : null) === (b ? Date.parse(b) : null);

/** Groups rows by a text key; the first row per key is kept, later duplicates are returned as extras. */
function byKey(rows: BaserowRow[], field: string): { map: Map<string, BaserowRow>; extras: number[] } {
  const map = new Map<string, BaserowRow>();
  const extras: number[] = [];
  for (const r of rows) {
    const k = text(r[field]);
    if (!k || map.has(k)) extras.push(r.id);
    else map.set(k, r);
  }
  return { map, extras };
}

/**
 * Keeps the Baserow tables an exact copy of the library's text: albums, photos (caption, EXIF, file name) and tags,
 * with the album and tag links. SQLite stays the source of truth; each run creates, updates and deletes rows until
 * Baserow matches it, so a run after an outage catches up. Never sends photos.
 */
export class Mirror {
  private running: Promise<SyncCounts> | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private last: SyncCounts | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly config: BaserowConfig | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  status(): MirrorStatus {
    return { configured: !!this.config, running: !!this.running, lastRunAt: this.lastRunAt, lastError: this.lastError, last: this.last };
  }

  /** Runs one sync, or joins the one already running. */
  async sync(): Promise<MirrorStatus> {
    if (!this.config) return this.status();
    this.running ??= this.run(this.config).finally(() => (this.running = null));
    try {
      this.last = await this.running;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      this.lastRunAt = new Date().toISOString();
    }
    return this.status();
  }

  /** Reads back from Baserow: row counts and the tags with the most photos (Baserow's own formula field). */
  async overview(limit = 12): Promise<MirrorOverview | null> {
    if (!this.config) return null;
    const { target, tables } = this.config;
    const [albums, photos, tags] = await Promise.all([
      rowPage(target, tables.albums, 1),
      rowPage(target, tables.photos, 1),
      rowPage(target, tables.tags, limit, `-${F.tagCount}`),
    ]);
    return {
      albums: albums.count,
      photos: photos.count,
      tags: tags.count,
      topTags: tags.rows.map((r) => ({ name: text(r[F.name]), photoCount: Number(r[F.tagCount]) || 0 })),
    };
  }

  private async run({ target, tables }: BaserowConfig): Promise<SyncCounts> {
    const counts: SyncCounts = { created: 0, updated: 0, deleted: 0 };
    const albums = this.repos.mirrorReads.albums();
    const photos = this.repos.mirrorReads.photos();
    const [albumRows, photoRows, tagRows] = await Promise.all([listRows(target, tables.albums), listRows(target, tables.photos), listRows(target, tables.tags)]);

    // Tags and albums first, so photo rows can link to their ids.
    const tagNames = new Set(photos.flatMap((p) => p.tags));
    const tagIds = await this.upsert(target, tables.tags, byKey(tagRows, F.name), [...tagNames].map((n) => ({ key: n, fields: { [F.name]: n } })), () => false, counts);
    const albumIds = await this.upsert(
      target,
      tables.albums,
      byKey(albumRows, F.name),
      albums.map((a) => ({ key: a.name, fields: { [F.name]: a.name, [F.albumCount]: a.photoCount, [F.albumCreated]: a.createdAt.slice(0, 10) } })),
      (row, f) => Number(row[F.albumCount]) !== f[F.albumCount] || text(row[F.albumCreated]) !== f[F.albumCreated],
      counts,
    );

    const photoFields = (p: MirrorPhoto) => ({
      [F.sha]: p.sha256,
      [F.fileName]: p.fileName,
      [F.caption]: p.caption ?? '',
      [F.takenAt]: utc(p.takenAt),
      [F.camera]: p.camera ?? '',
      [F.albums]: p.albums.map((n) => albumIds.get(n)!).filter(Boolean).sort((a, b) => a - b),
      [F.tags]: p.tags.map((n) => tagIds.get(n)!).filter(Boolean).sort((a, b) => a - b),
    });
    const photoIds = await this.upsert(
      target,
      tables.photos,
      byKey(photoRows, F.sha),
      photos.map((p) => ({ key: p.sha256, fields: photoFields(p) })),
      (row, f) =>
        text(row[F.fileName]) !== f[F.fileName] ||
        text(row[F.caption]) !== f[F.caption] ||
        text(row[F.camera]) !== f[F.camera] ||
        !sameTime(row[F.takenAt], f[F.takenAt] as string | null) ||
        !sameIds(linkIds(row[F.albums]), f[F.albums] as number[]) ||
        !sameIds(linkIds(row[F.tags]), f[F.tags] as number[]),
      counts,
    );

    // Then remove what the library no longer has: photos before the albums and tags they link to.
    const stale = (rows: BaserowRow[], keep: Map<string, number>) => {
      const kept = new Set(keep.values());
      return rows.filter((r) => !kept.has(r.id)).map((r) => r.id);
    };
    for (const [table, rows, keep] of [
      [tables.photos, photoRows, photoIds],
      [tables.tags, tagRows, tagIds],
      [tables.albums, albumRows, albumIds],
    ] as const) {
      const ids = stale(rows, keep);
      if (ids.length) await deleteRows(target, table, ids);
      counts.deleted += ids.length;
    }

    if (counts.created + counts.updated + counts.deleted > 0) this.log.info(counts, 'Baserow mirror updated');
    return counts;
  }

  /** Creates missing rows and updates changed ones; returns key → row id for every wanted row. */
  private async upsert(
    target: BaserowTarget,
    table: number,
    existing: { map: Map<string, BaserowRow> },
    wanted: { key: string; fields: Record<string, unknown> }[],
    changed: (row: BaserowRow, fields: Record<string, unknown>) => boolean,
    counts: SyncCounts,
  ): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    const toCreate: typeof wanted = [];
    const toUpdate: ({ id: number } & Record<string, unknown>)[] = [];
    for (const w of wanted) {
      const row = existing.map.get(w.key);
      if (!row) toCreate.push(w);
      else {
        ids.set(w.key, row.id);
        if (changed(row, w.fields)) toUpdate.push({ id: row.id, ...w.fields });
      }
    }
    const created = await createRows(target, table, toCreate.map((w) => w.fields));
    created.forEach((row, i) => ids.set(toCreate[i]!.key, row.id));
    await updateRows(target, table, toUpdate);
    counts.created += created.length;
    counts.updated += toUpdate.length;
    return ids;
  }
}
