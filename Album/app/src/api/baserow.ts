import { api } from './client';

export interface BaserowState {
  configured: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  last: { created: number; updated: number; deleted: number } | null;
  /** Read back from Baserow; null when it is not configured or not reachable. */
  overview: { albums: number; photos: number; tags: number; topTags: { name: string; photoCount: number }[] } | null;
}

export const getBaserow = () => api<BaserowState>('/api/baserow');
export const syncBaserow = () => api<BaserowState>('/api/baserow/sync', { method: 'POST' });
