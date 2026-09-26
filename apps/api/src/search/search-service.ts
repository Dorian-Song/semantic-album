import type { Db } from '../db/connection.js';
import type { Embedder } from '../inference/embedder.js';
import type { AlbumRef, PhotoSummary } from '../photos/photo-queries.js';
import { ServiceUnavailableError } from '../processing/task-service.js';
import type { SearchMode, SettingsService } from '../settings/settings-service.js';
import { LexicalSearch, queryTerms } from './lexical-search.js';
import type { VectorIndex } from './vector-index.js';

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

/** Candidates taken from each ranking before fusion and paging. */
const CANDIDATES = 300;
const RRF_K = 60;
const QUERY_CACHE = 200;

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export class SearchService {
  private readonly lexical: LexicalSearch;
  private readonly queryCache = new Map<string, Float32Array>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly vectors: VectorIndex,
    private readonly embedder: Embedder,
    private readonly textVectors: VectorIndex | null = null,
  ) {
    this.lexical = new LexicalSearch(db);
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();
    const mode = req.mode ?? this.settings.get().defaultSearchMode;
    const offset = req.offset ?? 0;
    const limit = req.limit ?? 60;
    const timings = { total: 0, scope: 0, words: 0, embedQuery: 0, vectorScan: 0, hydrate: 0 };

    // Scope and filters decide eligibility before any ranking or paging.
    let t = performance.now();
    const { eligible, excluded } = this.eligibility(req);
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
              meaningIds = this.meaningRanking(q, eligible ? new Set(eligible) : null);
              if (!eligible) meaningIds = this.onlyVisible(meaningIds);
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
    const words = this.lexical.search(req.query, eligible, CANDIDATES);
    timings.words = performance.now() - t;
    await meaningRun;

    const wordIds = words.hits.map((h) => h.assetId);
    let ranked: string[];
    const fallbackToWords = mode !== 'words' && m.status === 'unavailable';
    if (mode === 'words' || fallbackToWords) ranked = wordIds;
    else if (mode === 'meaning') ranked = meaningIds;
    else ranked = fuse([wordIds, meaningIds], [wordsWeight(req.query), 1]);

    t = performance.now();
    const pageIds = ranked.slice(offset, offset + limit);
    const wordSet = new Set(mode === 'meaning' && !fallbackToWords ? [] : wordIds);
    const meaningSet = new Set(meaningIds);
    const items = this.hydrate(pageIds, req.albumIds ?? null).map((p) => ({
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
      excludedForMissingMetadata: excluded,
      timingsMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10])) as SearchResponse['timingsMs'],
    };
  }

  /**
   * Blends image and description-text similarity evenly (measured best on COCO; see text-embedding-worker.ts).
   * Photos without a text vector yet (no description) use their image score shifted by the mean text-minus-image
   * difference, so they are neither favoured nor buried while descriptions are still being written.
   */
  private meaningRanking(q: Float32Array, eligible: ReadonlySet<string> | null): string[] {
    const image = this.vectors.scoreAll(q, eligible);
    const text = this.textVectors?.scoreAll(q, eligible) ?? new Map<string, number>();
    let diff = 0;
    let n = 0;
    for (const [id, t] of text) {
      const i = image.get(id);
      if (i !== undefined) (diff += t - i), n++;
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
    const v = await this.embedder.embedQuery(text.trim());
    this.queryCache.set(key, v);
    if (this.queryCache.size > QUERY_CACHE) this.queryCache.delete(this.queryCache.keys().next().value!);
    return v;
  }

  /** Visible photos matching scope and filters, or null for "every visible photo" (no restriction). */
  private eligibility(req: SearchRequest): { eligible: string[] | null; excluded: number } {
    const albums = req.albumIds?.length ? req.albumIds : null;
    const hasDate = !!(req.takenFrom || req.takenTo);
    const hasCamera = !!req.camera;
    const hasKind = !!req.kind;
    if (!albums && !hasDate && !hasCamera && !hasKind) return { eligible: null, excluded: 0 };

    const scope = `FROM assets a WHERE a.orphaned_at IS NULL AND EXISTS (SELECT 1 FROM album_assets aa WHERE aa.asset_id = a.id
                   ${albums ? 'AND aa.album_id IN (SELECT value FROM json_each(@albums))' : ''})`;
    const conditions: string[] = [];
    if (req.takenFrom) conditions.push('a.taken_at >= @from');
    if (req.takenTo) conditions.push('a.taken_at < @to');
    if (hasCamera) conditions.push('a.camera_model = @camera');
    if (hasKind) conditions.push('EXISTS (SELECT 1 FROM descriptions d WHERE d.asset_id = a.id AND d.ai_kind = @kind)');
    const params = {
      albums: JSON.stringify(albums ?? []),
      from: req.takenFrom ?? '',
      to: req.takenTo ? nextDay(req.takenTo) : '',
      camera: req.camera ?? '',
      kind: req.kind ?? '',
    };
    const eligible = this.db.prepare(`SELECT a.id ${scope} ${conditions.map((c) => `AND ${c}`).join(' ')}`).pluck().all(params) as string[];
    const missing = [hasDate ? 'a.taken_at IS NULL' : null, hasCamera ? 'a.camera_model IS NULL' : null].filter(Boolean).join(' OR ');
    const excluded = missing ? (this.db.prepare(`SELECT count(*) ${scope} AND (${missing})`).pluck().get(params) as number) : 0;
    return { eligible, excluded };
  }

  /** Drops vectors of photos that are hidden (no membership) or gone. */
  private onlyVisible(ids: string[]): string[] {
    if (ids.length === 0) return ids;
    const visible = new Set(
      this.db
        .prepare(
          `SELECT a.id FROM assets a WHERE a.id IN (SELECT value FROM json_each(?)) AND a.orphaned_at IS NULL
             AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id)`,
        )
        .pluck()
        .all(JSON.stringify(ids)) as string[],
    );
    return ids.filter((id) => visible.has(id));
  }

  /** Page items with every membership. The filename is the one used in a scoped album when there is one. */
  private hydrate(ids: string[], scopeAlbums: string[] | null): Omit<SearchResultItem, 'matchedBy'>[] {
    if (ids.length === 0) return [];
    const json = JSON.stringify(ids);
    const scope = JSON.stringify(scopeAlbums ?? []);
    const rows = this.db
      .prepare(
        `SELECT a.id, a.width, a.height, a.taken_at AS takenAt,
                (SELECT display_filename FROM album_assets WHERE asset_id = a.id
                  ORDER BY album_id IN (SELECT value FROM json_each(?)) DESC, added_at LIMIT 1) AS filename
           FROM assets a WHERE a.id IN (SELECT value FROM json_each(?))`,
      )
      .all(scope, json) as PhotoSummary[];
    const albums = this.db
      .prepare(
        `SELECT aa.asset_id AS assetId, al.id, al.name FROM album_assets aa JOIN albums al ON al.id = aa.album_id
          WHERE aa.asset_id IN (SELECT value FROM json_each(?)) ORDER BY al.name`,
      )
      .all(json) as (AlbumRef & { assetId: string })[];
    const byId = new Map(rows.map((r) => [r.id, { ...r, albums: [] as AlbumRef[] }]));
    for (const a of albums) byId.get(a.assetId)?.albums.push({ id: a.id, name: a.name });
    return ids.map((id) => byId.get(id)).filter((x): x is Omit<SearchResultItem, 'matchedBy'> => x !== undefined);
  }

  facets(): {
    cameras: { model: string; count: number }[];
    taken: { earliest: string | null; latest: string | null; withDate: number; withoutDate: number };
    kinds: { kind: string; count: number }[];
  } {
    const visible = `FROM assets a WHERE a.orphaned_at IS NULL AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id)`;
    const cameras = this.db
      .prepare(`SELECT a.camera_model AS model, count(*) AS count ${visible} AND a.camera_model IS NOT NULL GROUP BY a.camera_model ORDER BY count DESC`)
      .all() as { model: string; count: number }[];
    const t = this.db
      .prepare(`SELECT min(a.taken_at) AS earliest, max(a.taken_at) AS latest, count(a.taken_at) AS withDate, count(*) - count(a.taken_at) AS withoutDate ${visible}`)
      .get() as { earliest: string | null; latest: string | null; withDate: number; withoutDate: number };
    const kinds = this.db
      .prepare(`SELECT d.ai_kind AS kind, count(*) AS count ${visible.replace('FROM assets a', 'FROM assets a JOIN descriptions d ON d.asset_id = a.id')} AND d.ai_kind IS NOT NULL GROUP BY d.ai_kind ORDER BY count DESC`)
      .all() as { kind: string; count: number }[];
    return { cameras, taken: { ...t, earliest: t.earliest?.slice(0, 10) ?? null, latest: t.latest?.slice(0, 10) ?? null }, kinds };
  }
}

/**
 * How much Words counts in Both. Keyword matching is precise for a few words ("banana", "stop sign") but
 * weak for sentence-like queries, where it rewards common words; Meaning handles those better.
 */
export function wordsWeight(query: string): number {
  const n = queryTerms(query).length;
  return n <= 2 ? WORDS_WEIGHT.short : n <= 4 ? WORDS_WEIGHT.medium : WORDS_WEIGHT.long;
}
const WORDS_WEIGHT = { short: 1, medium: 0.5, long: 0.25 };

/** Weighted reciprocal-rank fusion: score = Σ w / (k + rank). Each photo appears once. */
export function fuse(lists: string[][], weights: number[] = [], k = RRF_K): string[] {
  const score = new Map<string, number>();
  lists.forEach((list, l) => list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + (weights[l] ?? 1) / (k + i + 1))));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
