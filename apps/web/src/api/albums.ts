import { api } from './client';
import type { Album, Page, PhotoSummary } from './types';

export const listAlbums = () => api<{ items: Album[] }>('/api/albums').then((r) => r.items);
export const getAlbum = (id: string) => api<Album>(`/api/albums/${id}`);
export const createAlbum = (name: string) => api<Album>('/api/albums', { method: 'POST', body: { name } });
export const renameAlbum = (id: string, name: string) => api<Album>(`/api/albums/${id}`, { method: 'PATCH', body: { name } });
export const getAlbumProcessing = (id: string) => api<Record<'caption' | 'embedding', { done: number; total: number }>>(`/api/albums/${id}/processing`);
export const deleteAlbum = (id: string) => api<{ orphaned: number }>(`/api/albums/${id}`, { method: 'DELETE' });
export const suggestAlbumName = (name: string) =>
  api<{ name: string }>(`/api/albums/name-suggestion?name=${encodeURIComponent(name)}`).then((r) => r.name);
export const listAlbumPhotos = (id: string, offset: number, limit = 60) =>
  api<Page<PhotoSummary>>(`/api/albums/${id}/photos?offset=${offset}&limit=${limit}`);
export const removeFromAlbum = (albumId: string, photoId: string) =>
  api<{ removed: boolean }>(`/api/albums/${albumId}/photos/${photoId}`, { method: 'DELETE' });
