import { useSyncExternalStore } from 'react';
import { createFileImport, finishImport, uploadImportFile, type ManifestEntry } from '../api/imports';
import type { ImportJob } from '../api/types';

/**
 * Browser uploads outlive the dialog that started them, so they live here rather than in a component.
 * The File objects exist only in this tab: after a reload the backend still knows which items are missing,
 * and the user reselects them (see resumeWithFiles).
 */

const IMAGE_EXTENSIONS = /\.(jpe?g|jpe|png|gif|bmp|dib|webp|tiff?|heic|heif|hif|avif)$/i;
const CONCURRENCY = 3;

const activeJobs = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function changed() {
  snapshot = new Set(activeJobs);
  for (const l of listeners) l();
}

/** Stable across reselection: the same file on disk gives the same key. */
export function fileKey(f: File): string {
  return `${f.webkitRelativePath || f.name}|${f.size}|${f.lastModified}`;
}

/** Folder pickers include every file; keep what looks like an image (the backend still checks content). */
export function imageFiles(files: Iterable<File>): File[] {
  return [...files].filter((f) => f.type.startsWith('image/') || IMAGE_EXTENSIONS.test(f.name));
}

/** Root folder name of a folder-picker selection, if any. */
export function rootFolderName(files: File[]): string | null {
  const rel = files.find((f) => f.webkitRelativePath)?.webkitRelativePath;
  return rel ? (rel.split('/')[0] ?? null) : null;
}

async function uploadAll(jobId: string, files: Map<string, File>, onDone: () => void) {
  activeJobs.add(jobId);
  changed();
  const queue = [...files.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await uploadImportFile(jobId, next[0], next[1]);
      } catch {
        // Left unreceived on the backend; the progress panel offers reselection.
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    await finishImport(jobId).catch(() => undefined);
  } finally {
    activeJobs.delete(jobId);
    changed();
    onDone();
  }
}

export async function startBrowserImport(
  target: { albumId: string } | { newAlbumName: string },
  files: File[],
  onProgress: () => void,
): Promise<ImportJob> {
  const byKey = new Map(files.map((f) => [fileKey(f), f]));
  const manifest: ManifestEntry[] = [...byKey].map(([key, f]) => ({ key, name: f.name, size: f.size }));
  const job = await createFileImport(target, manifest);
  void uploadAll(job.id, byKey, onProgress);
  return job;
}

/** Uploads the reselected files that the backend is still missing. Returns how many matched. */
export function resumeWithFiles(job: ImportJob, files: File[], onProgress: () => void): number {
  const missing = new Set(job.missingKeys);
  const matched = new Map(files.map((f) => [fileKey(f), f] as const).filter(([key]) => missing.has(key)));
  if (matched.size > 0) void uploadAll(job.id, matched, onProgress);
  return matched.size;
}

export function useActiveUploads(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
