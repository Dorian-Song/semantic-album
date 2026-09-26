import type { Db } from '../db/connection.js';
import { refreshPhotoText } from '../search/fts-index.js';
import { badRequest, conflict, notFound } from '../shared/errors.js';
import { newId, nowIso } from '../shared/ids.js';

export interface AlbumSummary {
  id: string;
  name: string;
  photoCount: number;
  coverPhotoId: string | null;
  createdAt: string;
  updatedAt: string;
}

const MAX_NAME = 120;

export function normalizeAlbumName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('invalid_name', 'Album name cannot be empty');
  if (name.length > MAX_NAME) throw badRequest('invalid_name', `Album name is longer than ${MAX_NAME} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw badRequest('invalid_name', 'Album name contains control characters');
  return name;
}

/**
 * Albums and memberships. Every method that removes a membership marks assets left with none as orphaned
 * (hidden immediately, deleted after the grace period); adding a membership clears that mark.
 */
export class AlbumService {
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

  get(id: string): AlbumSummary {
    const album = this.list().find((a) => a.id === id);
    if (!album) throw notFound('Album');
    return album;
  }

  private requireAlbum(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM albums WHERE id = ?').get(id)) throw notFound('Album');
  }

  private requireAsset(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM assets WHERE id = ?').get(id)) throw notFound('Photo');
  }

  private nameTaken(name: string, exceptId?: string): boolean {
    const row = this.db.prepare('SELECT id FROM albums WHERE name = ?').get(name) as { id: string } | undefined;
    return row !== undefined && row.id !== exceptId;
  }

  create(rawName: string): AlbumSummary {
    const name = normalizeAlbumName(rawName);
    const id = newId();
    this.db.transaction(() => {
      if (this.nameTaken(name)) throw conflict('name_taken', `An album named "${name}" already exists`);
      const now = nowIso();
      this.db.prepare('INSERT INTO albums (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
    })();
    return this.get(id);
  }

  /** "Holiday" → "Holiday (2)" → "Holiday (3)" ... Call inside a write transaction. */
  allocateUniqueName(rawName: string): string {
    const base = normalizeAlbumName(rawName);
    if (!this.nameTaken(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!this.nameTaken(candidate)) return candidate;
    }
  }

  /** Creates an album with the next free suffixed name. Used by folder imports. */
  createUnique(rawName: string): AlbumSummary {
    const id = newId();
    this.db.transaction(() => {
      const name = this.allocateUniqueName(rawName);
      const now = nowIso();
      this.db.prepare('INSERT INTO albums (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
    })();
    return this.get(id);
  }

  /** Name the backend would assign right now; the final name is decided when the album is created. */
  suggestName(rawName: string): string {
    return this.allocateUniqueName(rawName);
  }

  rename(id: string, rawName: string): AlbumSummary {
    const name = normalizeAlbumName(rawName);
    this.db.transaction(() => {
      this.requireAlbum(id);
      if (this.nameTaken(name, id)) throw conflict('name_taken', `An album named "${name}" already exists`);
      this.db.prepare('UPDATE albums SET name = ?, updated_at = ? WHERE id = ?').run(name, nowIso(), id);
    })();
    return this.get(id);
  }

  /** Deletes the album and its memberships. Photos also in other albums stay there. */
  delete(id: string): { orphaned: number } {
    return this.db.transaction(() => {
      this.requireAlbum(id);
      const assetIds = this.db.prepare('SELECT asset_id FROM album_assets WHERE album_id = ?').pluck().all(id) as string[];
      this.db.prepare('DELETE FROM albums WHERE id = ?').run(id);
      const orphaned = this.markOrphans(assetIds);
      for (const assetId of assetIds) refreshPhotoText(this.db, assetId);
      return { orphaned };
    })();
  }

  /** Adds a membership. Returns false if the photo was already in the album. */
  addPhoto(albumId: string, assetId: string, displayFilename?: string): boolean {
    return this.db.transaction(() => {
      this.requireAlbum(albumId);
      this.requireAsset(assetId);
      const added = this.insertMembership(albumId, assetId, displayFilename ?? this.displayNameOf(assetId));
      if (added) refreshPhotoText(this.db, assetId);
      return added;
    })();
  }

  /** Removes one membership. Returns false if it did not exist. */
  removePhoto(albumId: string, assetId: string): boolean {
    return this.db.transaction(() => {
      this.requireAlbum(albumId);
      this.requireAsset(assetId);
      const removed = this.db.prepare('DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?').run(albumId, assetId).changes > 0;
      if (removed) {
        this.touch(albumId);
        this.markOrphans([assetId]);
        refreshPhotoText(this.db, assetId);
      }
      return removed;
    })();
  }

  /**
   * Moves one membership: adds the destination (unless already there) and removes the source, atomically.
   * Other memberships are untouched.
   */
  movePhoto(assetId: string, fromAlbumId: string, toAlbumId: string): void {
    this.db.transaction(() => {
      this.requireAlbum(fromAlbumId);
      this.requireAlbum(toAlbumId);
      this.requireAsset(assetId);
      const source = this.db
        .prepare('SELECT display_filename AS name FROM album_assets WHERE album_id = ? AND asset_id = ?')
        .get(fromAlbumId, assetId) as { name: string } | undefined;
      if (!source) throw conflict('not_in_album', 'The photo is not in the source album');
      if (fromAlbumId === toAlbumId) return;
      this.insertMembership(toAlbumId, assetId, source.name);
      this.db.prepare('DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?').run(fromAlbumId, assetId);
      this.touch(fromAlbumId);
      refreshPhotoText(this.db, assetId);
    })();
  }

  /** Removes every membership; the files are cleaned up after the grace period. */
  deleteFromLibrary(assetId: string): void {
    this.db.transaction(() => {
      this.requireAsset(assetId);
      const albumIds = this.db.prepare('SELECT album_id FROM album_assets WHERE asset_id = ?').pluck().all(assetId) as string[];
      this.db.prepare('DELETE FROM album_assets WHERE asset_id = ?').run(assetId);
      for (const albumId of albumIds) this.touch(albumId);
      this.markOrphans([assetId]);
      refreshPhotoText(this.db, assetId);
    })();
  }

  /** Inserts a membership if missing and clears any orphan mark. Call inside a transaction. */
  insertMembership(albumId: string, assetId: string, displayFilename: string): boolean {
    const now = nowIso();
    const added =
      this.db
        .prepare('INSERT OR IGNORE INTO album_assets (album_id, asset_id, display_filename, added_at) VALUES (?, ?, ?, ?)')
        .run(albumId, assetId, displayFilename, now).changes > 0;
    if (added) {
      this.db.prepare('UPDATE assets SET orphaned_at = NULL WHERE id = ?').run(assetId);
      this.touch(albumId, now);
    }
    return added;
  }

  private displayNameOf(assetId: string): string {
    const name = this.db
      .prepare('SELECT display_filename FROM album_assets WHERE asset_id = ? ORDER BY added_at LIMIT 1')
      .pluck()
      .get(assetId) as string | undefined;
    return name ?? 'photo';
  }

  private touch(albumId: string, at = nowIso()): void {
    this.db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(at, albumId);
  }

  private markOrphans(assetIds: string[]): number {
    const mark = this.db.prepare(
      `UPDATE assets SET orphaned_at = ?
        WHERE id = ? AND orphaned_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM album_assets WHERE asset_id = assets.id)`,
    );
    const now = nowIso();
    let n = 0;
    for (const id of assetIds) n += mark.run(now, id).changes;
    return n;
  }
}
