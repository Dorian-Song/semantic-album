import { api } from './client';

export interface ExportJob {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  total: number;
  done: number;
  filename: string;
  expiresAt: string | null;
  error: string | null;
}

export const createExport = (scope: { albumIds: string[] } | { assetIds: string[] }) => api<ExportJob>('/api/exports', { method: 'POST', body: scope });
export const getExport = (id: string) => api<ExportJob>(`/api/exports/${id}`);
export const exportDownloadUrl = (id: string) => `/api/exports/${id}/download`;
