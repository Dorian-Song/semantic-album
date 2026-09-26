import type { Db } from '../db/connection.js';
import { notFound } from '../shared/errors.js';

export interface PhotoSummary {
  id: string;
  filename: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
}

export interface AlbumRef {
  id: string;
  name: string;
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
    /** Who wrote the AI draft. */
    provider: string | null;
    model: string | null;
    /** Returned by the n8n workflow, if it has run. */
    enrichment: { categories: string[]; keywords: string[]; rowId: number; storedAt: string } | null;
    /** Distinct visible things listed by the AI. */
    objects: string[];
    /** Text transcribed from the image by the AI. */
    text: string | null;
    kind: string | null;
  } | null;
  albums: AlbumRef[];
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

/** Where the viewer came from; decides previous/next order in the detail view. */
export type PhotoListContext = { kind: 'album'; albumId: string } | { kind: 'all' };

export interface PhotoContext {
  index: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
  /** Neighbouring photos for the filmstrip, in list order. */
  window: PhotoSummary[];
}

// Photos without any membership are orphaned and hidden, so every listing goes through album_assets.
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

export class PhotoQueries {
  constructor(private readonly db: Db) {}

  listAlbum(albumId: string, offset: number, limit: number): Page<PhotoSummary> {
    if (!this.db.prepare('SELECT 1 FROM albums WHERE id = ?').get(albumId)) throw notFound('Album');
    const items = this.db.prepare(`${ALBUM_ORDER} LIMIT ? OFFSET ?`).all(albumId, limit, offset) as PhotoSummary[];
    const total = this.db.prepare('SELECT count(*) FROM album_assets WHERE album_id = ?').pluck().get(albumId) as number;
    return { items, total, offset, limit };
  }

  /** `recent` = most recently added first (Home); `date` = gallery order (All Photos). */
  listAll(offset: number, limit: number, order: 'date' | 'recent' = 'date'): Page<PhotoSummary> {
    const items = this.db.prepare(`${order === 'recent' ? RECENT_ORDER : ALL_ORDER} LIMIT ? OFFSET ?`).all(limit, offset) as PhotoSummary[];
    const total = this.db.prepare('SELECT count(DISTINCT asset_id) FROM album_assets').pluck().get() as number;
    return { items, total, offset, limit };
  }

  /** All current album memberships, regardless of how the photo was reached. */
  albumsOf(assetId: string): AlbumRef[] {
    return this.db
      .prepare(
        `SELECT al.id, al.name FROM album_assets aa JOIN albums al ON al.id = aa.album_id
          WHERE aa.asset_id = ? ORDER BY al.name`,
      )
      .all(assetId) as AlbumRef[];
  }

  /** `albumId` picks the filename the photo has in that album; otherwise its first imported name. */
  detail(assetId: string, albumId?: string): PhotoDetail {
    const row = this.db
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
      .get(albumId ?? '', assetId) as Record<string, unknown> | undefined;
    if (!row || row.filename === null) throw notFound('Photo');

    const make = row.cameraMake as string | null;
    const model = row.cameraModel as string | null;
    const lat = row.gpsLat as number | null;
    const lon = row.gpsLon as number | null;
    const ai = row.ai as string | null;
    const manual = row.manual as string | null;
    return {
      id: row.id as string,
      filename: row.filename as string,
      format: row.format as string,
      mime: row.mime as string,
      byteSize: row.byteSize as number,
      width: row.width as number | null,
      height: row.height as number | null,
      takenAt: row.takenAt as string | null,
      camera: make || model ? { make, model } : null,
      location: lat !== null && lon !== null ? { lat, lon } : null,
      description: row.hasDescription
        ? {
            effective: manual ?? ai,
            ai,
            manual,
            tags: JSON.parse((row.tags as string) ?? '[]') as string[],
            provider: row.provider as string | null,
            model: row.model as string | null,
            enrichment: row.enrichment ? JSON.parse(row.enrichment as string) : null,
            objects: JSON.parse((row.objects as string) ?? '[]') as string[],
            text: row.aiText as string | null,
            kind: row.kind as string | null,
          }
        : null,
      albums: this.albumsOf(assetId),
    };
  }

  context(assetId: string, list: PhotoListContext, radius = 12): PhotoContext {
    const ids =
      list.kind === 'album'
        ? (this.db.prepare(`SELECT id FROM (${ALBUM_ORDER})`).pluck().all(list.albumId) as string[])
        : (this.db.prepare(`SELECT id FROM (${ALL_ORDER})`).pluck().all() as string[]);
    const index = ids.indexOf(assetId);
    if (index < 0) throw notFound('Photo in this list');
    const from = Math.max(0, index - radius);
    const windowIds = ids.slice(from, index + radius + 1);
    const byId = new Map(
      (
        this.db
          .prepare(
            `SELECT a.id, a.width, a.height, a.taken_at AS takenAt,
                    (SELECT display_filename FROM album_assets WHERE asset_id = a.id ORDER BY added_at LIMIT 1) AS filename
               FROM assets a WHERE a.id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(windowIds)) as PhotoSummary[]
      ).map((p) => [p.id, p]),
    );
    return {
      index,
      total: ids.length,
      prevId: ids[index - 1] ?? null,
      nextId: ids[index + 1] ?? null,
      window: windowIds.map((id) => byId.get(id)).filter((p): p is PhotoSummary => p !== undefined),
    };
  }

  /** File keys for serving images. */
  files(assetId: string): { format: string; mime: string; objectKey: string; derivativeKey: string | null; thumbnailKey: string | null; filename: string } {
    const row = this.db
      .prepare(
        `SELECT a.format, a.mime, a.object_key AS objectKey, a.derivative_key AS derivativeKey, a.thumbnail_key AS thumbnailKey,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id ORDER BY added_at LIMIT 1) AS filename
           FROM assets a WHERE a.id = ? AND a.orphaned_at IS NULL`,
      )
      .get(assetId) as ReturnType<PhotoQueries['files']> | undefined;
    if (!row || row.filename === null) throw notFound('Photo');
    return row;
  }
}
