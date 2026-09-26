import fs from 'node:fs';
import path from 'node:path';

/** Subdirectories of DATA_DIR; see "Persistence and ownership" in docs/backend-design.md. */
export const DATA_SUBDIRS = ['objects', 'derivatives', 'thumbnails', 'staging', 'exports'] as const;

export function ensureDataDir(dataDir: string): void {
  for (const sub of DATA_SUBDIRS) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
}
