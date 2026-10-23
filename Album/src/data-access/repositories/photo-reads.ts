import type { Db } from '../../database/connection.js';
import type { AlbumRef } from './albums.js';

export interface PhotoSummary {
  id: string;
  filename: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
}

export interface PhotoDetailRow {
  id: string;
  format: string;
  mime: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  filename: string | null;
  hasDescription: string | null;
  ai: string | null;
  manual: string | null;
  tags: string | null;
  provider: string | null;
  model: string | null;
  enrichment: string | null;
  objects: string | null;
  aiText: string | null;
  kind: string | null;
}

export interface PhotoFiles {
  format: string;
  mime: string;
  objectKey: string;
  derivativeKey: string | null;
  thumbnailKey: string | null;
  filename: string | null;
}

export interface SearchFilter {
  albumIds: string[] | null;
  takenFrom: string | null;
  /** Exclusive upper bound, YYYY-MM-DD. */
  takenBefore: string | null;
  camera: string | null;
  kind: string | null;
}

// Photos without any membership are unused and hidden, so every listing goes through album_assets.
// Galleries show the newest capture first; photos without a capture time sort by when they were added.
const ALL_FROM = `SELECT a.id, m.filename, a.width, a.height, a.taken_at AS takenAt
                    FROM assets a
                    JOIN (SELECT asset_id, max(added_at) AS added_at, min(display_filename) AS filename
                            FROM album_assets GROUP BY asset_id) m ON m.asset_id = a.id`;
const ALL_ORDER = `${ALL_FROM} ORDER BY COALESCE(a.taken_at, m.added_at) DESC, m.filename DESC, a.id`;
const RECENT_ORDER = `${ALL_FROM} ORDER BY m.added_at DESC, a.id`;
const ALBUM_ORDER = `SELECT a.id, aa.display_filename AS filename, a.width, a.height, a.taken_at AS takenAt
                       FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
                      WHERE aa.album_id = ?
                      ORDER BY COALESCE(a.taken_at, aa.added_at) DESC, aa.display_filename DESC, a.id`;
const VISIBLE = `FROM assets a WHERE a.orphaned_at IS NULL AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id)`;

/** Reads for browsing and search. Writes nothing. */
export class PhotoReadRepository {
  constructor(private readonly db: Db) {}

  albumPage(albumId: string, offset: number, limit: number): PhotoSummary[] {
    return this.db.prepare(`${ALBUM_ORDER} LIMIT ? OFFSET ?`).all(albumId, limit, offset) as PhotoSummary[];
  }

  albumCount(albumId: string): number {
    return this.db.prepare('SELECT count(*) FROM album_assets WHERE album_id = ?').pluck().get(albumId) as number;
  }

  /** `recent` = most recently added first; `date` = gallery order. */
  allPage(offset: number, limit: number, order: 'date' | 'recent', kind: string | null): PhotoSummary[] {
    const base = order === 'recent' ? RECENT_ORDER : ALL_ORDER;
    const sql = kind ? base.replace('ORDER BY', `WHERE EXISTS (SELECT 1 FROM descriptions d WHERE d.asset_id = a.id AND d.ai_kind = ?) ORDER BY`) : base;
    return this.db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...(kind ? [kind] : []), limit, offset) as PhotoSummary[];
  }

  allCount(): number {
    return this.db.prepare('SELECT count(DISTINCT asset_id) FROM album_assets').pluck().get() as number;
  }

  /** `albumId` picks the filename the photo has in that album; otherwise its first imported name. */
  detail(assetId: string, albumId: string | null): PhotoDetailRow | undefined {
    return this.db
      .prepare(
        `SELECT a.id, a.format, a.mime, a.byte_size AS byteSize, a.width, a.height, a.taken_at AS takenAt,
                a.camera_make AS cameraMake, a.camera_model AS cameraModel, a.gps_lat AS gpsLat, a.gps_lon AS gpsLon,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id
                  ORDER BY album_id = ? DESC, added_at LIMIT 1) AS filename,
                d.asset_id AS hasDescription, d.ai_caption AS ai, d.manual_caption AS manual, d.ai_tags AS tags,
                d.provider AS provider, d.model AS model, d.enrichment AS enrichment,
                d.ai_objects AS objects, d.ai_text AS aiText, d.ai_kind AS kind
           FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
          WHERE a.id = ? AND a.orphaned_at IS NULL`,
      )
      .get(albumId ?? '', assetId) as PhotoDetailRow | undefined;
  }

  orderedIds(albumId: string | null): string[] {
    return albumId
      ? (this.db.prepare(`SELECT id FROM (${ALBUM_ORDER})`).pluck().all(albumId) as string[])
      : (this.db.prepare(`SELECT id FROM (${ALL_ORDER})`).pluck().all() as string[]);
  }

  summaries(ids: readonly string[]): PhotoSummary[] {
    return this.db
      .prepare(
        `SELECT a.id, a.width, a.height, a.taken_at AS takenAt,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id ORDER BY added_at LIMIT 1) AS filename
           FROM assets a WHERE a.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as PhotoSummary[];
  }

  files(assetId: string): PhotoFiles | undefined {
    return this.db
      .prepare(
        `SELECT a.format, a.mime, a.object_key AS objectKey, a.derivative_key AS derivativeKey, a.thumbnail_key AS thumbnailKey,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id ORDER BY added_at LIMIT 1) AS filename
           FROM assets a WHERE a.id = ? AND a.orphaned_at IS NULL`,
      )
      .get(assetId) as PhotoFiles | undefined;
  }

  /** Every photo shown in the library. */
  visibleIds(): string[] {
    return this.db.prepare(`SELECT a.id ${VISIBLE}`).pluck().all() as string[];
  }

  /** Visible photos matching scope and filters, and how many in scope lack a field a filter needs. */
  matching(f: SearchFilter): { ids: string[]; excluded: number } {
    const scope = `FROM assets a WHERE a.orphaned_at IS NULL AND EXISTS (SELECT 1 FROM album_assets aa WHERE aa.asset_id = a.id
                   ${f.albumIds ? 'AND aa.album_id IN (SELECT value FROM json_each(@albums))' : ''})`;
    const conditions: string[] = [];
    if (f.takenFrom) conditions.push('a.taken_at >= @from');
    if (f.takenBefore) conditions.push('a.taken_at < @to');
    if (f.camera) conditions.push('a.camera_model = @camera');
    if (f.kind) conditions.push('EXISTS (SELECT 1 FROM descriptions d WHERE d.asset_id = a.id AND d.ai_kind = @kind)');
    const params = { albums: JSON.stringify(f.albumIds ?? []), from: f.takenFrom ?? '', to: f.takenBefore ?? '', camera: f.camera ?? '', kind: f.kind ?? '' };
    const ids = this.db.prepare(`SELECT a.id ${scope} ${conditions.map((c) => `AND ${c}`).join(' ')}`).pluck().all(params) as string[];
    const hasDate = !!(f.takenFrom || f.takenBefore);
    const missing = [hasDate ? 'a.taken_at IS NULL' : null, f.camera ? 'a.camera_model IS NULL' : null].filter(Boolean).join(' OR ');
    const excluded = missing ? (this.db.prepare(`SELECT count(*) ${scope} AND (${missing})`).pluck().get(params) as number) : 0;
    return { ids, excluded };
  }

  /** Result cards with every membership. The filename is the one used in a scoped album when there is one. */
  cards(ids: readonly string[], scopeAlbums: readonly string[] | null): (PhotoSummary & { albums: AlbumRef[] })[] {
    if (ids.length === 0) return [];
    const json = JSON.stringify(ids);
    const rows = this.db
      .prepare(
        `SELECT a.id, a.width, a.height, a.taken_at AS takenAt,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id
                  ORDER BY album_id IN (SELECT value FROM json_each(?)) DESC, added_at LIMIT 1) AS filename
           FROM assets a WHERE a.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(scopeAlbums ?? []), json) as PhotoSummary[];
    const albums = this.db
      .prepare(
        `SELECT aa.asset_id AS assetId, al.id, al.name FROM album_assets aa JOIN albums al ON al.id = aa.album_id
          WHERE aa.asset_id IN (SELECT value FROM json_each(?)) ORDER BY al.name`,
      )
      .all(json) as (AlbumRef & { assetId: string })[];
    const byId = new Map(rows.map((r) => [r.id, { ...r, albums: [] as AlbumRef[] }]));
    for (const a of albums) byId.get(a.assetId)?.albums.push({ id: a.id, name: a.name });
    return ids.map((id) => byId.get(id)).filter((x) => x !== undefined);
  }

  facets(): {
    cameras: { model: string; count: number }[];
    taken: { earliest: string | null; latest: string | null; withDate: number; withoutDate: number };
    kinds: { kind: string; count: number }[];
  } {
    const cameras = this.db
      .prepare(`SELECT a.camera_model AS model, count(*) AS count ${VISIBLE} AND a.camera_model IS NOT NULL GROUP BY a.camera_model ORDER BY count DESC`)
      .all() as { model: string; count: number }[];
    const taken = this.db
      .prepare(`SELECT min(a.taken_at) AS earliest, max(a.taken_at) AS latest, count(a.taken_at) AS withDate, count(*) - count(a.taken_at) AS withoutDate ${VISIBLE}`)
      .get() as { earliest: string | null; latest: string | null; withDate: number; withoutDate: number };
    const kinds = this.db
      .prepare(
        `SELECT d.ai_kind AS kind, count(*) AS count ${VISIBLE.replace('FROM assets a', 'FROM assets a JOIN descriptions d ON d.asset_id = a.id')} AND d.ai_kind IS NOT NULL GROUP BY d.ai_kind ORDER BY count DESC`,
      )
      .all() as { kind: string; count: number }[];
    return { cameras, taken, kinds };
  }
}
