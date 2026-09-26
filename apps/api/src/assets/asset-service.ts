import fs from 'node:fs/promises';
import type { AppContext } from '../context.js';
import type { AlbumService } from '../albums/album-service.js';
import { refreshPhotoText } from '../search/fts-index.js';
import { badRequest, notFound } from '../shared/errors.js';
import { newId, nowIso } from '../shared/ids.js';
import { ObjectStore } from '../storage/object-store.js';
import { ItemRejected, type Staged } from '../storage/staging.js';
import { makeDerivatives } from './derivatives.js';
import { MIME, sniffImage } from './format-sniff.js';
import { readCaptureMetadata } from './image-metadata.js';

export type IngestResult =
  | { outcome: 'imported'; assetId: string }
  | { outcome: 'skipped'; reason: string; assetId: string | null };

const MAX_CAPTION = 4000;

export class AssetService {
  constructor(
    private readonly ctx: AppContext,
    private readonly albums: AlbumService,
  ) {}

  /**
   * Turns a staged file into a library photo in `albumId`. Same bytes already in that album → skipped;
   * already in the library → new membership, object reused. Consumes (moves or deletes) the staged file.
   */
  async ingest(staged: Staged, albumId: string, displayFilename: string): Promise<IngestResult> {
    const { db, store, tools, shaLocks } = this.ctx;
    const format = sniffImage(staged.head);
    if (!format) {
      await fs.rm(staged.path, { force: true });
      return { outcome: 'skipped', reason: 'unsupported_format', assetId: null };
    }

    return shaLocks.run(staged.sha256, async () => {
      const existing = db.prepare('SELECT id FROM assets WHERE sha256 = ?').pluck().get(staged.sha256) as string | undefined;
      if (existing) {
        await fs.rm(staged.path, { force: true });
        const added = db.transaction(() => {
          const ok = this.albums.insertMembership(albumId, existing, displayFilename);
          if (ok) refreshPhotoText(db, existing);
          return ok;
        })();
        return added
          ? { outcome: 'imported', assetId: existing }
          : { outcome: 'skipped', reason: 'duplicate_in_album', assetId: existing };
      }

      // Decode before storing, so an undecodable file never becomes an object.
      let derived;
      try {
        derived = await makeDerivatives(staged.path, format, tools, store.stagingDir);
      } catch (err) {
        await fs.rm(staged.path, { force: true });
        if (err instanceof ItemRejected) return { outcome: 'skipped', reason: err.reason, assetId: null };
        throw err;
      }
      const meta = await readCaptureMetadata(staged.path);

      const objectKey = ObjectStore.objectKey(staged.sha256);
      const derivativeKey = ObjectStore.derivativeKey(staged.sha256);
      const thumbnailKey = ObjectStore.thumbnailKey(staged.sha256);
      await store.writeBuffer(derivativeKey, derived.display);
      await store.writeBuffer(thumbnailKey, derived.thumbnail);
      await store.placeFile(staged.path, objectKey);

      const id = newId();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO assets (id, sha256, object_key, format, mime, byte_size, width, height, derivative_key,
                               thumbnail_key, taken_at, camera_make, camera_model, gps_lat, gps_lon, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, staged.sha256, objectKey, format, MIME[format], staged.size, derived.width, derived.height,
          derivativeKey, thumbnailKey, meta.takenAt, meta.cameraMake, meta.cameraModel, meta.gpsLat, meta.gpsLon, nowIso(),
        );
        this.albums.insertMembership(albumId, id, displayFilename);
        refreshPhotoText(db, id);
      })();
      return { outcome: 'imported', assetId: id };
    });
  }

  /** Sets or clears (null / blank) the manual caption. The AI draft is kept separately. */
  setManualCaption(assetId: string, caption: string | null): void {
    const { db } = this.ctx;
    const value = caption?.trim() ? caption.trim() : null;
    if (value && value.length > MAX_CAPTION) throw badRequest('caption_too_long', `Description is longer than ${MAX_CAPTION} characters`);
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM assets WHERE id = ? AND orphaned_at IS NULL').get(assetId)) throw notFound('Photo');
      db.prepare(
        `INSERT INTO descriptions (asset_id, manual_caption, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET manual_caption = excluded.manual_caption, updated_at = excluded.updated_at`,
      ).run(assetId, value, nowIso());
      refreshPhotoText(db, assetId);
    })();
  }
}
