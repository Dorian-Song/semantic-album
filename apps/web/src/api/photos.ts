import { api } from './client';
import type { AlbumRef, Page, PhotoContext, PhotoDetail, PhotoSummary } from './types';

export const listPhotos = (offset: number, limit = 60, order: 'date' | 'recent' = 'date') =>
  api<Page<PhotoSummary>>(`/api/photos?offset=${offset}&limit=${limit}&order=${order}`);
export const getPhoto = (id: string, albumId: string | null = null) =>
  api<PhotoDetail>(`/api/photos/${id}${albumId ? `?album=${encodeURIComponent(albumId)}` : ''}`);
export const getPhotoContext = (id: string, albumId: string | null) =>
  api<PhotoContext>(`/api/photos/${id}/context${albumId ? `?album=${encodeURIComponent(albumId)}` : ''}`);
export const addToAlbum = (id: string, albumId: string) => api<{ added: boolean }>(`/api/photos/${id}/albums`, { method: 'POST', body: { albumId } });
export const movePhoto = (id: string, fromAlbumId: string, toAlbumId: string) =>
  api<{ albums: AlbumRef[] }>(`/api/photos/${id}/move`, { method: 'POST', body: { fromAlbumId, toAlbumId } });
export const deletePhoto = (id: string) => api<void>(`/api/photos/${id}`, { method: 'DELETE' });
export const setManualCaption = (id: string, manualCaption: string | null) =>
  api<PhotoDetail>(`/api/photos/${id}/description`, { method: 'PATCH', body: { manualCaption } });

export const thumbnailUrl = (id: string) => `/api/photos/${id}/thumbnail`;
export const displayUrl = (id: string) => `/api/photos/${id}/display`;
export const originalUrl = (id: string) => `/api/photos/${id}/original`;
