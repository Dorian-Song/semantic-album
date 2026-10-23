import type { ReadStream } from 'node:fs';
import { ServiceUnavailableError } from '../../data-access/egress/errors.js';
import type { FileStore } from '../../data-access/file-store/file-store.js';
import type { AlbumRef } from '../../data-access/repositories/albums.js';
import type { Repositories } from '../../data-access/repositories/index.js';
import type { PhotoSummary } from '../../data-access/repositories/photo-reads.js';
import type { SearchMode } from '../../data-access/repositories/settings.js';
import { queryTerms } from '../../data-access/search-store/text-index.js';
import type { SearchStore } from '../../data-access/search-store/search-store.js';
import type { Embedder } from '../../infra/embedding/embedding.js';
import { BROWSER_NATIVE, type ImageFormat } from '../../infra/imaging/format.js';
import type { SettingsService } from '../../infra/settings/settings.js';
import { notFound } from '../../shared/errors.js';

export type { PhotoSummary };

export interface PhotoDetail extends PhotoSummary {
  format: string;
  mime: string;
  byteSize: number;
  camera: { make: string | null; model: string | null } | null;
  location: { lat: number; lon: number } | null;
  description: {
    /** What is shown and searched: the user's text when there is one, else the AI draft. */
    effective: string | null;
    ai: string | null;
    manual: string | null;
    tags: string[];
    /** Who wrote the AI draft. */
    provider: string | null;
    model: string | null;
    /** Returned by the n8n workflow, if it has run. */
    enrichment: { categories: string[]; keywords: string[]; rowId: number; storedAt: string } | null;
    objects: string[];
    text: string | null;
    kind: string | null;
  } | null;
  albums: AlbumRef[];
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PhotoContext {
  index: number;
  total: number;
  prevId: string | null;
  nextId: string | null;
  /** Neighbouring photos for the filmstrip, in list order. */
  window: PhotoSummary[];
}

export interface SearchRequest {
  query: string;
  mode?: SearchMode | undefined;
  /** Albums the result must be in; null/empty means all albums. */
  albumIds?: string[] | null | undefined;
  /** Capture-date filter, inclusive, YYYY-MM-DD. Photos without a capture date never match it. */
  takenFrom?: string | undefined;
  takenTo?: string | undefined;
  camera?: string | undefined;
  /** Image kind from the AI description: photo, screenshot, document, illustration, other. */
  kind?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface SearchResultItem extends PhotoSummary {
  /** Every album the photo is in, including albums outside the search scope. */
  albums: AlbumRef[];
  matchedBy: ('words' | 'meaning')[];
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  items: SearchResultItem[];
  /** Number of ranked results, at most the most relevant CANDIDATES from each ranking. */
  total: number;
  offset: number;
  limit: number;
  /** "unavailable": Meaning was requested but the embedding service is not running. */
  meaning: 'ok' | 'unavailable' | 'not_requested';
  meaningReason: string | null;
  /** Meaning was requested but unavailable, so these are Words results. */
  fallbackToWords: boolean;
  corrections: { from: string; to: string }[];
  /** In-scope photos left out because they lack the metadata a filter needs. */
  excludedForMissingMetadata: number;
  timingsMs: { total: number; scope: number; words: number; embedQuery: number; vectorScan: number; hydrate: number };
}

export type FileVariant = 'original' | 'display' | 'thumbnail';

/** Candidates taken from each ranking before fusion and paging: results are the most relevant N. */
const CANDIDATES = 300;
const RRF_K = 60;
const QUERY_CACHE = 200;
const WORDS_WEIGHT = { short: 1, medium: 0.5, long: 0.25 };

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * How much Words counts in Both. Keyword matching is precise for a few words ("banana", "stop sign") but weak for
 * sentence-like queries, where it rewards common words; Meaning handles those better.
 */
function wordsWeight(query: string): number {
  const n = queryTerms(query).length;
  return n <= 2 ? WORDS_WEIGHT.short : n <= 4 ? WORDS_WEIGHT.medium : WORDS_WEIGHT.long;
}

/** Weighted reciprocal-rank fusion: score = Σ w / (k + rank). Each photo appears once. */
function fuse(lists: string[][], weights: number[]): string[] {
  const score = new Map<string, number>();
  lists.forEach((list, l) => list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + (weights[l] ?? 1) / (RRF_K + i + 1))));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Reads the library for the user: browsing and search. Changes nothing. */
export class Query {
  private readonly queryCache = new Map<string, Float32Array>();

  constructor(
    private readonly repos: Repositories,
    private readonly files: FileStore,
    private readonly search: SearchStore,
    private readonly embedder: Embedder,
    private readonly settings: SettingsService,
  ) {}

  // ---------- browsing ----------

  albumPhotos(albumId: string, offset: number, limit: number): Page<PhotoSummary> {
    if (!this.repos.albums.exists(albumId)) throw notFound('Album');
    const reads = this.repos.photoReads;
    return { items: reads.albumPage(albumId, offset, limit), total: reads.albumCount(albumId), offset, limit };
  }

  /** `recent` = most recently added first (Home); `date` = gallery order (All Photos). */
  allPhotos(offset: number, limit: number, order: 'date' | 'recent', kind?: string): Page<PhotoSummary> {
    const reads = this.repos.photoReads;
    return { items: reads.allPage(offset, limit, order, kind ?? null), total: reads.allCount(), offset, limit };
  }

  albumsOf(assetId: string): AlbumRef[] {
    return this.repos.albums.albumsOf(assetId);
  }

  /** `albumId` picks the filename the photo has in that album; otherwise its first imported name. */
  detail(assetId: string, albumId?: string): PhotoDetail {
    const row = this.repos.photoReads.detail(assetId, albumId ?? null);
    if (!row || row.filename === null) throw notFound('Photo');
    const { cameraMake: make, cameraModel: model, gpsLat: lat, gpsLon: lon, ai, manual } = row;
    return {
      id: row.id,
      filename: row.filename,
      format: row.format,
      mime: row.mime,
      byteSize: row.byteSize,
      width: row.width,
      height: row.height,
      takenAt: row.takenAt,
      camera: make || model ? { make, model } : null,
      location: lat !== null && lon !== null ? { lat, lon } : null,
      description: row.hasDescription
        ? {
            effective: manual ?? ai,
            ai,
            manual,
            tags: JSON.parse(row.tags ?? '[]') as string[],
            provider: row.provider,
            model: row.model,
            enrichment: row.enrichment ? JSON.parse(row.enrichment) : null,
            objects: JSON.parse(row.objects ?? '[]') as string[],
            text: row.aiText,
            kind: row.kind,
          }
        : null,
      albums: this.albumsOf(assetId),
    };
  }

  /** Previous/next and a filmstrip window in the list the user came from (an album, or all photos). */
  context(assetId: string, albumId: string | null, radius = 12): PhotoContext {
    const ids = this.repos.photoReads.orderedIds(albumId);
    const index = ids.indexOf(assetId);
    if (index < 0) throw notFound('Photo in this list');
    const windowIds = ids.slice(Math.max(0, index - radius), index + radius + 1);
    const byId = new Map(this.repos.photoReads.summaries(windowIds).map((p) => [p.id, p]));
    return {
      index,
      total: ids.length,
      prevId: ids[index - 1] ?? null,
      nextId: ids[index + 1] ?? null,
      window: windowIds.map((id) => byId.get(id)).filter((p) => p !== undefined),
    };
  }

  /** File contents for viewing. `display` is something every browser can render: the original for web formats, else the JPEG copy. */
  async openFile(assetId: string, variant: FileVariant): Promise<{ stream: ReadStream; size: number; mime: string; filename: string | null }> {
    const f = this.repos.photoReads.files(assetId);
    if (!f || f.filename === null) throw notFound('Photo');
    const native = BROWSER_NATIVE.has(f.format as ImageFormat);
    const [key, mime] =
      variant === 'original' ? [f.objectKey, f.mime] : variant === 'thumbnail' ? [f.thumbnailKey, 'image/webp'] : native ? [f.objectKey, f.mime] : [f.derivativeKey, 'image/jpeg'];
    const opened = key ? await this.files.open(key) : null;
    if (!opened) throw notFound('Image');
    return { ...opened, mime, filename: variant === 'original' ? f.filename : null };
  }

  facets() {
    const f = this.repos.photoReads.facets();
    return { ...f, taken: { ...f.taken, earliest: f.taken.earliest?.slice(0, 10) ?? null, latest: f.taken.latest?.slice(0, 10) ?? null } };
  }

  // ---------- search ----------

  async searchPhotos(req: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();
    const mode = req.mode ?? this.settings.get().defaultSearchMode;
    const offset = req.offset ?? 0;
    const limit = req.limit ?? 60;
    const timings = { total: 0, scope: 0, words: 0, embedQuery: 0, vectorScan: 0, hydrate: 0 };

    // Scope and filters decide which photos may appear, before any ranking or cut-off.
    let t = performance.now();
    const albums = req.albumIds?.length ? req.albumIds : null;
    const filtered = !!(albums || req.takenFrom || req.takenTo || req.camera || req.kind);
    const scoped = filtered
      ? this.repos.photoReads.matching({
          albumIds: albums,
          takenFrom: req.takenFrom ?? null,
          takenBefore: req.takenTo ? nextDay(req.takenTo) : null,
          camera: req.camera ?? null,
          kind: req.kind ?? null,
        })
      : null;
    const eligible = scoped?.ids ?? null;
    timings.scope = performance.now() - t;

    const m: { status: SearchResponse['meaning']; reason: string | null } = { status: 'not_requested', reason: null };
    let meaningIds: string[] = [];
    const meaningRun =
      mode === 'words'
        ? Promise.resolve()
        : (async () => {
            try {
              t = performance.now();
              const q = await this.queryVector(req.query);
              timings.embedQuery = performance.now() - t;
              t = performance.now();
              meaningIds = this.meaningRanking(q, new Set(eligible ?? this.repos.photoReads.visibleIds()));
              timings.vectorScan = performance.now() - t;
              m.status = 'ok';
            } catch (err) {
              if (!(err instanceof ServiceUnavailableError)) throw err;
              m.status = 'unavailable';
              m.reason = err.message;
            }
          })();

    // Words also runs for Meaning, so an unavailable Meaning can fall back explicitly.
    t = performance.now();
    const words = this.search.searchWords(req.query, eligible, CANDIDATES);
    timings.words = performance.now() - t;
    await meaningRun;

    const wordIds = words.hits.map((h) => h.assetId);
    const fallbackToWords = mode !== 'words' && m.status === 'unavailable';
    const ranked = mode === 'words' || fallbackToWords ? wordIds : mode === 'meaning' ? meaningIds : fuse([wordIds, meaningIds], [wordsWeight(req.query), 1]);

    t = performance.now();
    const wordSet = new Set(mode === 'meaning' && !fallbackToWords ? [] : wordIds);
    const meaningSet = new Set(meaningIds);
    const items = this.repos.photoReads.cards(ranked.slice(offset, offset + limit), albums).map((p) => ({
      ...p,
      matchedBy: [...(wordSet.has(p.id) ? (['words'] as const) : []), ...(meaningSet.has(p.id) ? (['meaning'] as const) : [])],
    }));
    timings.hydrate = performance.now() - t;
    timings.total = performance.now() - started;

    return {
      query: req.query,
      mode,
      items,
      total: ranked.length,
      offset,
      limit,
      meaning: m.status,
      meaningReason: m.reason,
      fallbackToWords,
      corrections: mode === 'meaning' && !fallbackToWords ? [] : words.corrections,
      excludedForMissingMetadata: scoped?.excluded ?? 0,
      timingsMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10])) as SearchResponse['timingsMs'],
    };
  }

  /**
   * Blends image and description similarity evenly (measured best on COCO). Photos without a description vector
   * yet use their image score shifted by the mean text-minus-image difference, so they are neither favoured nor
   * buried while descriptions are still being written. Only `among` is ranked, so hidden photos never take a place.
   */
  private meaningRanking(q: Float32Array, among: ReadonlySet<string>): string[] {
    const image = this.search.scoreImages(q, among);
    const text = this.search.scoreDescriptions(q, among);
    let diff = 0;
    let n = 0;
    for (const [id, s] of text) {
      const i = image.get(id);
      if (i !== undefined) (diff += s - i), n++;
    }
    const shift = n ? diff / n : 0;
    const blended: [string, number][] = [];
    for (const [id, i] of image) blended.push([id, 0.5 * i + 0.5 * (text.get(id) ?? i + shift)]);
    blended.sort((a, b) => b[1] - a[1]);
    return blended.slice(0, CANDIDATES).map(([id]) => id);
  }

  private async queryVector(text: string): Promise<Float32Array> {
    const key = text.trim().toLowerCase();
    const cached = this.queryCache.get(key);
    if (cached) return cached;
    const v = await this.embedder.embedText(text.trim());
    this.queryCache.set(key, v);
    if (this.queryCache.size > QUERY_CACHE) this.queryCache.delete(this.queryCache.keys().next().value!);
    return v;
  }
}
