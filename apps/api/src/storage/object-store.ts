import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../shared/ids.js';

/** App-owned files under DATA_DIR. Keys are relative paths stored in SQLite; originals are content-addressed. */
export class ObjectStore {
  constructor(readonly root: string) {}

  static objectKey(sha: string): string {
    return `objects/${sha.slice(0, 2)}/${sha}`;
  }
  static derivativeKey(sha: string): string {
    return `derivatives/${sha.slice(0, 2)}/${sha}.jpg`;
  }
  static thumbnailKey(sha: string): string {
    return `thumbnails/${sha.slice(0, 2)}/${sha}.webp`;
  }

  abs(key: string): string {
    return path.join(this.root, key);
  }

  get stagingDir(): string {
    return path.join(this.root, 'staging');
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.abs(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Moves a staged file into place. If the object already exists (same bytes), the staged copy is dropped. */
  async placeFile(stagedPath: string, key: string): Promise<void> {
    const target = this.abs(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (await this.exists(key)) {
      await fs.rm(stagedPath, { force: true });
      return;
    }
    await fs.rename(stagedPath, target);
  }

  /** Writes via a temp file and rename so a crash never leaves a half-written file under its final name. */
  async writeBuffer(key: string, data: Buffer): Promise<void> {
    const target = this.abs(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = path.join(this.stagingDir, `${newId()}.tmp`);
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  }

  async remove(key: string | null): Promise<void> {
    if (key) await fs.rm(this.abs(key), { force: true });
  }
}
