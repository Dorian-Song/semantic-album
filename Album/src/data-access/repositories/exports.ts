import type { Db } from '../../database/connection.js';

export type ExportState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface ExportRow {
  id: string;
  state: ExportState;
  total: number;
  done: number;
  scope: string;
  expiresAt: string | null;
  createdAt: string;
  zipKey: string | null;
}

export interface ExportPhoto {
  id: string;
  sha256: string;
  format: string;
  objectKey: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  ai: string | null;
  manual: string | null;
  tags: string | null;
  enrichment: string | null;
  objects: string | null;
  text: string | null;
  kind: string | null;
  /** Filename in the first preferred album that contains the photo, else its first imported name. */
  filename: string | null;
}

/** Export jobs (export_jobs) and the photo data an export reads. */
export class ExportRepository {
  constructor(private readonly db: Db) {}

  create(id: string, scope: string, total: number, at: string): void {
    this.db.prepare(`INSERT INTO export_jobs (id, scope, state, total, done, created_at, updated_at) VALUES (?, ?, 'queued', ?, 0, ?, ?)`).run(id, scope, total, at, at);
  }

  get(id: string): ExportRow | undefined {
    return this.db
      .prepare(`SELECT id, state, total, done, scope, expires_at AS expiresAt, created_at AS createdAt, zip_key AS zipKey FROM export_jobs WHERE id = ?`)
      .get(id) as ExportRow | undefined;
  }

  setState(id: string, state: ExportState, at: string): void {
    this.db.prepare(`UPDATE export_jobs SET state = ?, updated_at = ? WHERE id = ?`).run(state, at, id);
  }

  setDone(id: string, done: number, at: string): void {
    this.db.prepare(`UPDATE export_jobs SET done = ?, updated_at = ? WHERE id = ?`).run(done, at, id);
  }

  complete(id: string, done: number, zipKey: string, expiresAt: string, at: string): void {
    this.db
      .prepare(`UPDATE export_jobs SET state = 'completed', done = ?, total = ?, zip_key = ?, expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(done, done, zipKey, expiresAt, at, id);
  }

  failUnfinished(at: string): void {
    this.db.prepare(`UPDATE export_jobs SET state = 'failed', updated_at = ? WHERE state IN ('queued', 'running')`).run(at);
  }

  expired(at: string): { id: string; key: string | null }[] {
    return this.db.prepare(`SELECT id, zip_key AS key FROM export_jobs WHERE expires_at IS NOT NULL AND expires_at <= ?`).all(at) as { id: string; key: string | null }[];
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM export_jobs WHERE id = ?').run(id);
  }

  /** Photos in the library that belong to any of the albums, in a stable order. */
  photosInAlbums(albumIds: readonly string[]): string[] {
    return this.db
      .prepare(
        `SELECT DISTINCT a.id FROM assets a JOIN album_assets aa ON aa.asset_id = a.id
          WHERE aa.album_id IN (SELECT value FROM json_each(?)) AND a.orphaned_at IS NULL ORDER BY a.created_at, a.id`,
      )
      .pluck()
      .all(JSON.stringify(albumIds)) as string[];
  }

  /** The given photos that are in the library, in a stable order. */
  photosInLibrary(assetIds: readonly string[]): string[] {
    return this.db
      .prepare(
        `SELECT a.id FROM assets a WHERE a.id IN (SELECT value FROM json_each(?)) AND a.orphaned_at IS NULL
           AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id) ORDER BY a.created_at, a.id`,
      )
      .pluck()
      .all(JSON.stringify(assetIds)) as string[];
  }

  photo(assetId: string, preferredAlbums: readonly string[]): ExportPhoto | undefined {
    return this.db
      .prepare(
        `SELECT a.id, a.sha256, a.format, a.object_key AS objectKey, a.width, a.height, a.taken_at AS takenAt,
                a.camera_make AS cameraMake, a.camera_model AS cameraModel, a.gps_lat AS gpsLat, a.gps_lon AS gpsLon,
                d.ai_caption AS ai, d.manual_caption AS manual, d.ai_tags AS tags, d.enrichment,
                d.ai_objects AS objects, d.ai_text AS text, d.ai_kind AS kind,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id
                  ORDER BY album_id IN (SELECT value FROM json_each(?)) DESC, added_at LIMIT 1) AS filename
           FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id WHERE a.id = ?`,
      )
      .get(JSON.stringify(preferredAlbums), assetId) as ExportPhoto | undefined;
  }

  albumNames(assetId: string): string[] {
    return this.db
      .prepare(`SELECT al.name FROM album_assets aa JOIN albums al ON al.id = aa.album_id WHERE aa.asset_id = ? ORDER BY al.name`)
      .pluck()
      .all(assetId) as string[];
  }
}
