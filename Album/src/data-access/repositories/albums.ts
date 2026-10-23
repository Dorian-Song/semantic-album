import type { Db } from '../../database/connection.js';

export interface AlbumSummary {
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

/** Albums and album memberships (albums, album_assets). */
export class AlbumRepository {
  constructor(private readonly db: Db) {}

  list(): AlbumSummary[] {
    return this.db
      .prepare(
        `SELECT al.id, al.name, al.created_at AS createdAt, al.updated_at AS updatedAt,
                (SELECT count(*) FROM album_assets WHERE album_id = al.id) AS photoCount,
                (SELECT asset_id FROM album_assets WHERE album_id = al.id
                  ORDER BY added_at DESC, asset_id LIMIT 1) AS coverPhotoId
           FROM albums al
          ORDER BY al.updated_at DESC, al.name`,
      )
      .all() as AlbumSummary[];
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM albums WHERE id = ?').get(id);
  }

  name(id: string): string | undefined {
    return this.db.prepare('SELECT name FROM albums WHERE id = ?').pluck().get(id) as string | undefined;
  }

  idByName(name: string): string | undefined {
    return this.db.prepare('SELECT id FROM albums WHERE name = ?').pluck().get(name) as string | undefined;
  }

  insert(id: string, name: string, at: string): void {
    this.db.prepare('INSERT INTO albums (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, at, at);
  }

  rename(id: string, name: string, at: string): void {
    this.db.prepare('UPDATE albums SET name = ?, updated_at = ? WHERE id = ?').run(name, at, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM albums WHERE id = ?').run(id);
  }

  touch(id: string, at: string): void {
    this.db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(at, id);
  }

  photoIds(albumId: string): string[] {
    return this.db.prepare('SELECT asset_id FROM album_assets WHERE album_id = ?').pluck().all(albumId) as string[];
  }

  /** Returns false when the photo is already in the album. */
  addMember(albumId: string, assetId: string, displayFilename: string, at: string): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO album_assets (album_id, asset_id, display_filename, added_at) VALUES (?, ?, ?, ?)')
        .run(albumId, assetId, displayFilename, at).changes > 0
    );
  }

  removeMember(albumId: string, assetId: string): boolean {
    return this.db.prepare('DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?').run(albumId, assetId).changes > 0;
  }

  /** Removes the photo from every album; returns those albums. */
  removeFromAll(assetId: string): string[] {
    const albumIds = this.db.prepare('SELECT album_id FROM album_assets WHERE asset_id = ?').pluck().all(assetId) as string[];
    this.db.prepare('DELETE FROM album_assets WHERE asset_id = ?').run(assetId);
    return albumIds;
  }

  memberFilename(albumId: string, assetId: string): string | undefined {
    return this.db
      .prepare('SELECT display_filename FROM album_assets WHERE album_id = ? AND asset_id = ?')
      .pluck()
      .get(albumId, assetId) as string | undefined;
  }

  /** The name the photo was first imported under. */
  firstFilename(assetId: string): string | undefined {
    return this.db
      .prepare('SELECT display_filename FROM album_assets WHERE asset_id = ? ORDER BY added_at LIMIT 1')
      .pluck()
      .get(assetId) as string | undefined;
  }

  albumsOf(assetId: string): AlbumRef[] {
    return this.db
      .prepare(
        `SELECT al.id, al.name FROM album_assets aa JOIN albums al ON al.id = aa.album_id
          WHERE aa.asset_id = ? ORDER BY al.name`,
      )
      .all(assetId) as AlbumRef[];
  }
}
