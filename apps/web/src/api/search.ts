import { api } from './client';
import type { AlbumRef, PhotoSummary } from './types';

export type SearchMode = 'words' | 'meaning' | 'both';

export interface SearchParams {
  query: string;
  mode?: SearchMode;
  albumIds?: string[];
  takenFrom?: string;
  takenTo?: string;
  camera?: string;
  offset?: number;
  limit?: number;
}

export interface SearchResultItem extends PhotoSummary {
  albums: AlbumRef[];
  matchedBy: ('words' | 'meaning')[];
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  items: SearchResultItem[];
  total: number;
  offset: number;
  limit: number;
  meaning: 'ok' | 'unavailable' | 'not_requested';
  meaningReason: string | null;
  fallbackToWords: boolean;
  corrections: { from: string; to: string }[];
  excludedForMissingMetadata: number;
  timingsMs: { total: number; scope: number; words: number; embedQuery: number; vectorScan: number; hydrate: number };
}

export interface Facets {
  cameras: { model: string; count: number }[];
  taken: { earliest: string | null; latest: string | null; withDate: number; withoutDate: number };
}

export const searchPhotos = (p: SearchParams) => api<SearchResponse>('/api/search', { method: 'POST', body: p });
export const getFacets = () => api<Facets>('/api/search/facets');
