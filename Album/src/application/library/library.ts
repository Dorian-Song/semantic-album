import type { AlbumRef, AlbumSummary } from '../../data-access/repositories/albums.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import type { SearchStore } from '../../data-access/search-store/search-store.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { newId, nowIso } from '../../shared/ids.js';
import type { Processing } from '../processing/processing.js';

export type { AlbumRef, AlbumSummary };

const MAX_NAME = 120;
const MAX_CAPTION = 4000;

function normalizeAlbumName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw badRequest('invalid_name', 'Album name cannot be empty');
  if (name.length > MAX_NAME) throw badRequest('invalid_name', `Album name is longer than ${MAX_NAME} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw badRequest('invalid_name', 'Album name contains control characters');
  return name;
}

/**
 * The rules of the user's library: albums, which photos are in them, and the user's descriptions. A photo
 * appears once per album; one stored file may belong to many albums. A photo that leaves its last album is
 * marked unused (hidden at once, removed after the grace period); joining an album clears the mark.
 */
export class Library {
  constructor(
    private readonly repos: Repositories,
    private readonly search: SearchStore,
    private readonly processing: Processing,
  ) {}

  list(): AlbumSummary[] {
    return this.repos.albums.list();
  }

  get(id: string): AlbumSummary {
    const album = this.list().find((a) => a.id === id);
    if (!album) throw notFound('Album');
    return album;
  }

  create(rawName: string): AlbumSummary {
    const name = normalizeAlbumName(rawName);
    const id = newId();
    this.repos.tx(() => {
      if (this.repos.albums.idByName(name) !== undefined) throw conflict('name_taken', `An album named "${name}" already exists`);
      this.repos.albums.insert(id, name, nowIso());
    });
    return this.get(id);
  }

  /** Creates an album with the next free name: "Holiday", "Holiday (2)", ... Used for folder imports and new-album imports. */
  createUnique(rawName: string): AlbumSummary {
    const id = newId();
    this.repos.tx(() => this.repos.albums.insert(id, this.uniqueName(rawName), nowIso()));
    return this.get(id);
  }

  /** Name the album would get right now; the final name is decided when it is created. */
  suggestName(rawName: string): string {
    return this.uniqueName(rawName);
  }

  rename(id: string, rawName: string): AlbumSummary {
    const name = normalizeAlbumName(rawName);
    this.repos.tx(() => {
      this.requireAlbum(id);
      const holder = this.repos.albums.idByName(name);
      if (holder !== undefined && holder !== id) throw conflict('name_taken', `An album named "${name}" already exists`);
      this.repos.albums.rename(id, name, nowIso());
    });
    return this.get(id);
  }

  /** Deletes the album and its memberships. Photos also in other albums stay there. */
  delete(id: string): { orphaned: number } {
    return this.repos.tx(() => {
      this.requireAlbum(id);
      const assetIds = this.repos.albums.photoIds(id);
      this.repos.albums.delete(id);
      const orphaned = this.repos.assets.markUnused(assetIds, nowIso());
      for (const assetId of assetIds) this.search.refreshText(assetId);
      return { orphaned };
    });
  }

  /**
   * Places a stored file in an album during an import; runs inside the import's write. A new file also gets its
   * processing registered. Returns false when the photo was already in the album.
   */
  attach(albumId: string, assetId: string, displayFilename: string, isNew: boolean): boolean {
    const added = this.addMember(albumId, assetId, displayFilename);
    if (added) this.search.refreshText(assetId);
    if (isNew) this.processing.photoAdded(assetId);
    return added;
  }

  /** Adds a photo to another album. Returns false if it was already there. */
  addPhoto(albumId: string, assetId: string): boolean {
    return this.repos.tx(() => {
      this.requireAlbum(albumId);
      this.requirePhoto(assetId);
      const added = this.addMember(albumId, assetId, this.repos.albums.firstFilename(assetId) ?? 'photo');
      if (added) this.search.refreshText(assetId);
      return added;
    });
  }

  /** Removes one membership. Returns false if it did not exist. */
  removePhoto(albumId: string, assetId: string): boolean {
    return this.repos.tx(() => {
      this.requireAlbum(albumId);
      this.requirePhoto(assetId);
      const removed = this.repos.albums.removeMember(albumId, assetId);
      if (removed) {
        const at = nowIso();
        this.repos.albums.touch(albumId, at);
        this.repos.assets.markUnused([assetId], at);
        this.search.refreshText(assetId);
      }
      return removed;
    });
  }

  /** Moves one membership: adds the destination (unless already there) and removes the source, atomically. */
  movePhoto(assetId: string, fromAlbumId: string, toAlbumId: string): AlbumRef[] {
    this.repos.tx(() => {
      this.requireAlbum(fromAlbumId);
      this.requireAlbum(toAlbumId);
      this.requirePhoto(assetId);
      const name = this.repos.albums.memberFilename(fromAlbumId, assetId);
      if (name === undefined) throw conflict('not_in_album', 'The photo is not in the source album');
      if (fromAlbumId === toAlbumId) return;
      this.addMember(toAlbumId, assetId, name);
      this.repos.albums.removeMember(fromAlbumId, assetId);
      this.repos.albums.touch(fromAlbumId, nowIso());
      this.search.refreshText(assetId);
    });
    return this.repos.albums.albumsOf(assetId);
  }

  /** Removes the photo from every album; its files are removed after the grace period. */
  deleteFromLibrary(assetId: string): void {
    this.repos.tx(() => {
      this.requirePhoto(assetId);
      const at = nowIso();
      for (const albumId of this.repos.albums.removeFromAll(assetId)) this.repos.albums.touch(albumId, at);
      this.repos.assets.markUnused([assetId], at);
      this.search.refreshText(assetId);
    });
  }

  /** Sets or clears (null / blank) the user's description. The AI draft is kept separately and never replaces it. */
  setDescription(assetId: string, caption: string | null): void {
    const value = caption?.trim() ? caption.trim() : null;
    if (value && value.length > MAX_CAPTION) throw badRequest('caption_too_long', `Description is longer than ${MAX_CAPTION} characters`);
    this.repos.tx(() => {
      if (!this.repos.assets.isInUse(assetId)) throw notFound('Photo');
      this.repos.descriptions.setManual(assetId, value, nowIso());
      this.search.refreshText(assetId);
    });
    this.processing.descriptionChanged(assetId);
  }

  private addMember(albumId: string, assetId: string, displayFilename: string): boolean {
    const at = nowIso();
    const added = this.repos.albums.addMember(albumId, assetId, displayFilename, at);
    if (added) {
      this.repos.assets.clearUnused(assetId);
      this.repos.albums.touch(albumId, at);
    }
    return added;
  }

  private uniqueName(rawName: string): string {
    const base = normalizeAlbumName(rawName);
    if (this.repos.albums.idByName(base) === undefined) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (this.repos.albums.idByName(candidate) === undefined) return candidate;
    }
  }

  private requireAlbum(id: string): void {
    if (!this.repos.albums.exists(id)) throw notFound('Album');
  }

  private requirePhoto(id: string): void {
    if (!this.repos.assets.exists(id)) throw notFound('Photo');
  }
}
