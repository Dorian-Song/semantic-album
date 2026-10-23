import type { PhotoSummary } from '../api/types';

/**
 * The result list the user last opened a photo from, so the detail view can step through results in the same
 * order and return to the same search. Kept per tab in memory and sessionStorage.
 */
export interface SearchContext {
  /** The /search?... URL to return to. */
  href: string;
  items: PhotoSummary[];
}

const KEY = 'album.searchContext';
let current: SearchContext | null = null;

export function setSearchContext(ctx: SearchContext): void {
  current = ctx;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(ctx));
  } catch {
    // storage unavailable: memory only
  }
}

export function getSearchContext(): SearchContext | null {
  if (current) return current;
  try {
    const raw = sessionStorage.getItem(KEY);
    current = raw ? (JSON.parse(raw) as SearchContext) : null;
  } catch {
    current = null;
  }
  return current;
}
