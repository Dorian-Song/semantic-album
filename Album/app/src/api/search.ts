import { api, ApiError } from './client';
import type { AlbumRef, PhotoSummary } from './types';

export type SearchMode = 'words' | 'meaning' | 'both';

export interface SearchParams {
  query: string;
  mode?: SearchMode;
  albumIds?: string[];
  takenFrom?: string;
  takenTo?: string;
  camera?: string;
  kind?: string;
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
  kinds: { kind: string; count: number }[];
}

export const searchPhotos = (p: SearchParams) => api<SearchResponse>('/api/search', { method: 'POST', body: p });
export const getFacets = () => api<Facets>('/api/search/facets');

/** Scope of a search by image: the same album, date, camera and type filters as a text search. */
export interface ImageSearchScope {
  albumIds?: string[];
  takenFrom?: string;
  takenTo?: string;
  camera?: string;
  kind?: string;
}

export interface ImageSearchResponse {
  items: SearchResultItem[];
  total: number;
  reusedLibraryVector: boolean;
  notYetIndexed: number;
  excludedForMissingMetadata: number;
  timingsMs: { total: number; embedQuery: number; vectorScan: number; hydrate: number };
}

/** Uploads the image (multipart) with the scope in the query string; the server keeps nothing. */
export async function searchByImage(file: File, scope: ImageSearchScope): Promise<ImageSearchResponse> {
  const qs = new URLSearchParams();
  if (scope.albumIds?.length) qs.set('albums', scope.albumIds.join(','));
  if (scope.takenFrom) qs.set('from', scope.takenFrom);
  if (scope.takenTo) qs.set('to', scope.takenTo);
  if (scope.camera) qs.set('camera', scope.camera);
  if (scope.kind) qs.set('kind', scope.kind);
  const form = new FormData();
  form.append('image', file, file.name || 'pasted-image');
  let res: Response;
  try {
    res = await fetch(`/api/search/image?${qs.toString()}`, { method: 'POST', body: form });
  } catch {
    throw new ApiError(0, 'network_error', 'Album is not responding. Is the backend running?');
  }
  const data = (await res.json().catch(() => null)) as (ImageSearchResponse & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? `Request failed (${res.status})`);
  return data as ImageSearchResponse;
}
