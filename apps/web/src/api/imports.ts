import { api } from './client';
import type { ImportJob } from './types';

export interface ManifestEntry {
  key: string;
  name: string;
  size: number;
}

export const listJobs = () => api<{ items: ImportJob[] }>('/api/jobs').then((r) => r.items);
export const startFolderImport = (path: string, albumId?: string) =>
  api<ImportJob>('/api/imports/folder', { method: 'POST', body: albumId ? { path, albumId } : { path } });
export const createFileImport = (target: { albumId: string } | { newAlbumName: string }, files: ManifestEntry[]) =>
  api<ImportJob>('/api/imports', { method: 'POST', body: { ...target, files } });
export const finishImport = (id: string) => api<ImportJob>(`/api/imports/${id}/finish`, { method: 'POST' });
export const cancelImport = (id: string) => api<ImportJob>(`/api/imports/${id}/cancel`, { method: 'POST' });

export async function uploadImportFile(jobId: string, key: string, file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`/api/imports/${jobId}/files?itemKey=${encodeURIComponent(key)}`, { method: 'POST', body: form });
  if (!res.ok && res.status !== 409) throw new Error(`Upload failed (${res.status})`);
}
