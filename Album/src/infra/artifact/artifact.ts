import type { Readable } from 'node:stream';
import { FileStore, FileTooLargeError } from '../../data-access/file-store/file-store.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import { KeyedMutex } from '../../shared/keyed-mutex.js';
import { newId, nowIso } from '../../shared/ids.js';
import { MIME, sniffImage } from '../imaging/format.js';
import { UndecodableImageError, type Imaging } from '../imaging/imaging.js';

/** Why a file was not stored. */
export type RejectReason = 'unsupported_format' | 'too_large';

export type StoreResult<T> = { stored: true; assetId: string; isNew: boolean; attached: T } | { stored: false; reason: RejectReason };

/** Keys of a stored file, as kept in its record. */
export interface StoredFiles {
  sha256: string;
  objectKey: string;
  derivativeKey: string | null;
  thumbnailKey: string | null;
}

/**
 * Stores a file in the library exactly once and removes it again. Knows nothing about albums: the caller's
 * `attach` step runs in the same write as the file record and under the same per-file lock, so a file can never
 * be removed between being stored and being placed in an album.
 */
export class Artifact {
  private readonly locks = new KeyedMutex();

  constructor(
    private readonly files: FileStore,
    private readonly imaging: Imaging,
    private readonly repos: Repositories,
    private readonly maxBytes: number,
  ) {}

  /**
   * Receives a byte stream. Same bytes already stored → the existing file is reused; a new file is decoded
   * first, so an unreadable file never becomes part of the library. `attach` runs inside the write.
   */
  async store<T>(source: Readable, attach: (assetId: string, isNew: boolean) => T): Promise<StoreResult<T>> {
    let temp;
    try {
      temp = await this.files.writeTemp(source, this.maxBytes);
    } catch (err) {
      if (err instanceof FileTooLargeError) return { stored: false, reason: 'too_large' };
      throw err;
    }
    const format = sniffImage(temp.head);
    if (!format) {
      await this.files.removePath(temp.path);
      return { stored: false, reason: 'unsupported_format' };
    }

    return this.locks.run(temp.sha256, async () => {
      const existing = this.repos.assets.idBySha(temp.sha256);
      if (existing) {
        await this.files.removePath(temp.path);
        return { stored: true, assetId: existing, isNew: false, attached: this.repos.tx(() => attach(existing, false)) };
      }

      let derived;
      try {
        derived = await this.imaging.derive(temp.path, format, this.files.tempDir);
      } catch (err) {
        await this.files.removePath(temp.path);
        if (err instanceof UndecodableImageError) return { stored: false, reason: 'unsupported_format' };
        throw err;
      }
      const meta = await this.imaging.readMetadata(temp.path);
      const objectKey = FileStore.objectKey(temp.sha256);
      const derivativeKey = FileStore.derivativeKey(temp.sha256);
      const thumbnailKey = FileStore.thumbnailKey(temp.sha256);
      await this.files.write(derivativeKey, derived.display);
      await this.files.write(thumbnailKey, derived.thumbnail);
      await this.files.keep(temp.path, objectKey);

      const id = newId();
      const attached = this.repos.tx(() => {
        this.repos.assets.insert({
          id,
          sha256: temp.sha256,
          objectKey,
          format,
          mime: MIME[format],
          byteSize: temp.size,
          width: derived.width,
          height: derived.height,
          derivativeKey,
          thumbnailKey,
          ...meta,
          createdAt: nowIso(),
        });
        return attach(id, true);
      });
      return { stored: true, assetId: id, isNew: true, attached };
    });
  }

  /**
   * Removes a stored file under its lock. `deleteRecords` runs first, in one write, and decides: when it returns
   * false nothing is removed. Files go after the records, so a crash can leave an unused file but never a record
   * without its file.
   */
  async remove(f: StoredFiles, deleteRecords: () => boolean): Promise<boolean> {
    return this.locks.run(f.sha256, async () => {
      if (!this.repos.tx(deleteRecords)) return false;
      await Promise.all([this.files.remove(f.objectKey), this.files.remove(f.derivativeKey), this.files.remove(f.thumbnailKey)]);
      return true;
    });
  }

  /** Runs `fn` while no file with this SHA-256 can be stored or removed. */
  whileLocked<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(sha256, fn);
  }
}
