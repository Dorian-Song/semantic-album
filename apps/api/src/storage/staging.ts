import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { newId } from '../shared/ids.js';
import { SNIFF_BYTES } from '../assets/format-sniff.js';

export interface Staged {
  path: string;
  sha256: string;
  size: number;
  /** First bytes of the file, for format detection. */
  head: Buffer;
}

/** Thrown when an import item is rejected for a known reason; the item is recorded as skipped. */
export class ItemRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Copies a stream into DATA_DIR/staging while computing SHA-256, size, and the header bytes. */
export async function stageStream(stagingDir: string, source: Readable, maxBytes: number): Promise<Staged> {
  const target = path.join(stagingDir, `${newId()}.part`);
  const hash = createHash('sha256');
  const headChunks: Buffer[] = [];
  let headLength = 0;
  let size = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) return done(new ItemRejected('too_large'));
      hash.update(chunk);
      if (headLength < SNIFF_BYTES) {
        const part = chunk.subarray(0, SNIFF_BYTES - headLength);
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
