import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { newId } from '../../shared/ids.js';

/** A received file waiting in the temporary area. */
export interface TempFile {
  path: string;
  sha256: string;
  size: number;
  /** First bytes of the file, for format detection. */
  head: Buffer;
}

/** The byte stream was longer than allowed. */
export class FileTooLargeError extends Error {
  constructor() {
    super('too_large');
  }
}

const SUBDIRS = ['objects', 'derivatives', 'thumbnails', 'staging', 'exports'] as const;
const HEAD_BYTES = 64;

/**
 * The only code that touches disk paths. Lays out DATA_DIR; app files are addressed by keys (paths relative to
 * DATA_DIR, stored in SQLite), and originals are content-addressed by SHA-256.
 */
export class FileStore {
  constructor(readonly root: string) {}

  /** Creates the data directory layout. */
  prepare(): void {
    for (const sub of SUBDIRS) fsSync.mkdirSync(path.join(this.root, sub), { recursive: true });
  }

  static objectKey(sha: string): string {
    return `objects/${sha.slice(0, 2)}/${sha}`;
  }
  static derivativeKey(sha: string): string {
    return `derivatives/${sha.slice(0, 2)}/${sha}.jpg`;
  }
  static thumbnailKey(sha: string): string {
    return `thumbnails/${sha.slice(0, 2)}/${sha}.webp`;
  }
  static exportKey(id: string): string {
    return `exports/${id}.zip`;
  }

  /** Content-addressed folders and how each file name maps back to a SHA-256. */
  static readonly CONTENT_DIRS = [
    { dir: 'objects', sha: (name: string) => name },
    { dir: 'derivatives', sha: (name: string) => name.replace(/\.jpg$/, '') },
    { dir: 'thumbnails', sha: (name: string) => name.replace(/\.webp$/, '') },
  ] as const;

  abs(key: string): string {
    return path.join(this.root, key);
  }

  get tempDir(): string {
    return path.join(this.root, 'staging');
  }

  /** A fresh path in the temporary area. */
  tempPath(suffix: string): string {
    return path.join(this.tempDir, `${newId()}${suffix}`);
  }

  /** Copies a stream into the temporary area while computing SHA-256, size, and the first bytes. */
  async writeTemp(source: Readable, maxBytes: number): Promise<TempFile> {
    const target = this.tempPath('.part');
    const hash = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new FileTooLargeError());
        hash.update(chunk);
        if (headLength < HEAD_BYTES) {
          const part = chunk.subarray(0, HEAD_BYTES - headLength);
          headChunks.push(part);
          headLength += part.length;
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(target));
    } catch (err) {
      await fs.rm(target, { force: true });
      throw err;
    }
    return { path: target, sha256: hash.digest('hex'), size, head: Buffer.concat(headChunks) };
  }

  /** Moves a temporary file into place. If the key already exists (same bytes), the temporary copy is dropped. */
  async keep(tempPath: string, key: string): Promise<void> {
    const target = this.abs(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (await this.exists(key)) {
      await fs.rm(tempPath, { force: true });
      return;
    }
    await fs.rename(tempPath, target);
  }

  /** Writes via a temporary file and rename, so a crash never leaves a half-written file under its final name. */
  async write(key: string, data: Buffer): Promise<void> {
    const target = this.abs(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = this.tempPath('.tmp');
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.abs(key));
      return true;
    } catch {
      return false;
    }
  }

  read(key: string): Promise<Buffer> {
    return fs.readFile(this.abs(key));
  }

  /** Size and a stream of the file, or null when it is missing. */
  async open(key: string): Promise<{ size: number; stream: ReadStream } | null> {
    const stat = await fs.stat(this.abs(key)).catch(() => null);
    return stat ? { size: stat.size, stream: createReadStream(this.abs(key)) } : null;
  }

  async remove(key: string | null): Promise<void> {
    if (key) await fs.rm(this.abs(key), { force: true });
  }

  async removePath(file: string): Promise<void> {
    await fs.rm(file, { force: true });
  }

  /** Moves a finished temporary file to a key. */
  async promote(tempPath: string, key: string): Promise<void> {
    await fs.mkdir(path.dirname(this.abs(key)), { recursive: true });
    await fs.rename(tempPath, this.abs(key));
  }

  createTempWriteStream(tempPath: string) {
    return createWriteStream(tempPath);
  }

  /** Every file under a folder of DATA_DIR (or the temporary area), with its modification time. */
  async list(dir: string): Promise<{ file: string; name: string; mtimeMs: number }[]> {
    const out: { file: string; name: string; mtimeMs: number }[] = [];
    let entries;
    try {
      entries = await fs.readdir(path.join(this.root, dir), { recursive: true, withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const file = path.join(e.parentPath, e.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) out.push({ file, name: e.name, mtimeMs: stat.mtimeMs });
    }
    return out;
  }

  // ---------- host folders (read-only) ----------

  async isHostFolder(folder: string): Promise<boolean> {
    const stat = await fs.stat(folder).catch(() => null);
    return !!stat?.isDirectory();
  }

  /**
   * Lists files of a host folder recursively (relative paths) whose extension is in `extensions`, skipping
   * hidden files and folders and not following symlinks. Files come before subfolders, name order within each.
   */
  async scanHostFolder(root: string, extensions: ReadonlySet<string>): Promise<{ files: string[]; ignored: number }> {
    const files: string[] = [];
    let ignored = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const e of entries) {
        if (e.name.startsWith('.') || !e.isFile()) continue;
        if (extensions.has(path.extname(e.name).toLowerCase())) files.push(path.relative(root, path.join(dir, e.name)));
        else ignored++;
      }
      for (const e of entries) {
        if (!e.name.startsWith('.') && e.isDirectory()) await walk(path.join(dir, e.name));
      }
    };
    await walk(root);
    return { files, ignored };
  }

  readHostFile(file: string): Readable {
    return createReadStream(file);
  }
}
