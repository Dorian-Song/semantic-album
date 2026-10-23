import type { Db } from '../../database/connection.js';

/** A stored file and the facts read from its bytes. */
export interface AssetRecord {
  id: string;
  sha256: string;
  objectKey: string;
  format: string;
  mime: string;
  byteSize: number;
  width: number;
  height: number;
  derivativeKey: string;
  thumbnailKey: string;
  takenAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  createdAt: string;
}

export interface UnusedAsset {
  id: string;
  sha256: string;
  orphanedAt: string;
  objectKey: string;
  derivativeKey: string | null;
  thumbnailKey: string | null;
}

/** File records (the assets table). */
export class AssetRepository {
  constructor(private readonly db: Db) {}

  idBySha(sha256: string): string | undefined {
    return this.db.prepare('SELECT id FROM assets WHERE sha256 = ?').pluck().get(sha256) as string | undefined;
  }

  insert(r: AssetRecord): void {
    this.db
      .prepare(
        `INSERT INTO assets (id, sha256, object_key, format, mime, byte_size, width, height, derivative_key,
                             thumbnail_key, taken_at, camera_make, camera_model, gps_lat, gps_lon, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.sha256, r.objectKey, r.format, r.mime, r.byteSize, r.width, r.height, r.derivativeKey, r.thumbnailKey,
        r.takenAt, r.cameraMake, r.cameraModel, r.gpsLat, r.gpsLon, r.createdAt);
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM assets WHERE id = ?').get(id);
  }

  /** Not marked unused, so shown in the library. */
  isInUse(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM assets WHERE id = ? AND orphaned_at IS NULL').get(id);
  }

  files(id: string): { format: string; byteSize: number; objectKey: string; derivativeKey: string | null } | undefined {
    return this.db
      .prepare('SELECT format, byte_size AS byteSize, object_key AS objectKey, derivative_key AS derivativeKey FROM assets WHERE id = ?')
      .get(id) as { format: string; byteSize: number; objectKey: string; derivativeKey: string | null } | undefined;
  }

  /** Marks photos left without any album as unused, from now. Returns how many were marked. */
  markUnused(ids: readonly string[], at: string): number {
    const mark = this.db.prepare(
      `UPDATE assets SET orphaned_at = ?
        WHERE id = ? AND orphaned_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM album_assets WHERE asset_id = assets.id)`,
    );
    let n = 0;
    for (const id of ids) n += mark.run(at, id).changes;
    return n;
  }

  clearUnused(id: string): void {
    this.db.prepare('UPDATE assets SET orphaned_at = NULL WHERE id = ?').run(id);
  }

  unusedSince(cutoff: string): UnusedAsset[] {
    return this.db
      .prepare(
        `SELECT id, sha256, orphaned_at AS orphanedAt, object_key AS objectKey,
                derivative_key AS derivativeKey, thumbnail_key AS thumbnailKey
           FROM assets WHERE orphaned_at IS NOT NULL AND orphaned_at <= ?`,
      )
      .all(cutoff) as UnusedAsset[];
  }

  /** Still unused since the same moment and still without any album. */
  stillUnused(id: string, orphanedAt: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM assets WHERE id = ? AND orphaned_at = ?
           AND NOT EXISTS (SELECT 1 FROM album_assets WHERE asset_id = assets.id)`,
      )
      .get(id, orphanedAt);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  }

  knownShas(): Set<string> {
    return new Set(this.db.prepare('SELECT sha256 FROM assets').pluck().all() as string[]);
  }

  shaKnown(sha256: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM assets WHERE sha256 = ?').get(sha256);
  }
}
