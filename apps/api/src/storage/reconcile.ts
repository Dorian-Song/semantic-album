import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';

/** Object subdirectories and how each file name maps back to a SHA-256. */
const OWNED = [
  { dir: 'objects', sha: (name: string) => name },
  { dir: 'derivatives', sha: (name: string) => name.replace(/\.jpg$/, '') },
  { dir: 'thumbnails', sha: (name: string) => name.replace(/\.webp$/, '') },
] as const;

const SHA = /^[0-9a-f]{64}$/;

async function listFiles(dir: string): Promise<{ file: string; name: string; mtimeMs: number }[]> {
  const out: { file: string; name: string; mtimeMs: number }[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
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

/**
 * Startup recovery for files. Moving a file and writing its row cannot share a transaction, so a crash can
 * leave a staged upload or an object without a row. Anything older than `minAgeMs` with no asset row is
 * removed; files of a known asset are never touched. Orphaned-asset rows are the garbage collector's job.
 */
export async function reconcileStorage(ctx: AppContext, log: FastifyBaseLogger, minAgeMs = 3_600_000): Promise<{ staging: number; unowned: number }> {
  const cutoff = Date.now() - minAgeMs;
  let staging = 0;
  for (const f of await listFiles(ctx.store.stagingDir)) {
    if (f.mtimeMs < cutoff) {
      await fs.rm(f.file, { force: true });
      staging++;
    }
  }

  const known = new Set(ctx.db.prepare('SELECT sha256 FROM assets').pluck().all() as string[]);
  let unowned = 0;
  for (const { dir, sha } of OWNED) {
    for (const f of await listFiles(path.join(ctx.env.dataDir, dir))) {
      const hash = sha(f.name);
      if (!SHA.test(hash) || known.has(hash) || f.mtimeMs >= cutoff) continue;
      await ctx.shaLocks.run(hash, async () => {
        const stillUnknown = !ctx.db.prepare('SELECT 1 FROM assets WHERE sha256 = ?').get(hash);
        if (stillUnknown) {
          await fs.rm(f.file, { force: true });
          unowned++;
        }
      });
    }
  }
  if (staging || unowned) log.info({ staging, unowned }, 'removed leftover files from interrupted work');
  return { staging, unowned };
}
