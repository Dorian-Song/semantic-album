import type { Db } from '../../database/connection.js';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on',
  'or', 'the', 'their', 'this', 'that', 'to', 'with', 'photo', 'photos', 'picture', 'pictures', 'image', 'images', 'show', 'me',
  'my', 'some', 'find', 'where', 'there', 'was', 'were',
]);

/** Objects are listed most prominent first; this many are indexed with the tags. */
const MAIN_OBJECTS = 5;

/**
 * FTS5 column weights: asset_id (unindexed), caption 1.0, tags with the main objects and n8n categories 2.0,
 * the remaining objects 0.5, text in the image 1.0, filenames 0.5.
 */
const BM25 = 'bm25(photo_fts, 0.0, 1.0, 2.0, 0.5, 1.0, 0.5)';

export interface LexicalHit {
  assetId: string;
  /** bm25: lower is better. */
  rank: number;
}

export interface LexicalResult {
  hits: LexicalHit[];
  /** Terms replaced by a close vocabulary word because they matched nothing. */
  corrections: { from: string; to: string }[];
}

interface SourceRow {
  rid: number;
  caption: string;
  tags: string;
  objects: string;
  text: string | null;
  enrichment: string | null;
  filenames: string | null;
}

/** Query words worth matching: lower-case letters/digits, no stop words, at most 12. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))].slice(0, 12);
}

/** Levenshtein distance, giving up once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

const quote = (t: string) => `"${t.replace(/"/g, '')}"`;

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

/**
 * Full-text index of photo descriptions: photo_fts (Porter-stemmed) for matching, photo_words (unstemmed)
 * only for typo correction.
 */
export class TextIndex {
  constructor(private readonly db: Db) {}

  /**
   * Rewrites one photo's rows from the authoritative tables: effective caption; tags, main objects, and n8n
   * categories; remaining objects; text in the image; every membership filename. A photo in no album is
   * removed from the index. Call inside the changing write.
   */
  refresh(assetId: string): void {
    const row = this.db
      .prepare(
        `SELECT a.rowid AS rid,
                COALESCE(d.manual_caption, d.ai_caption, '') AS caption,
                COALESCE(d.ai_tags, '[]') AS tags,
                COALESCE(d.ai_objects, '[]') AS objects,
                d.ai_text AS text,
                d.enrichment AS enrichment,
                (SELECT group_concat(DISTINCT display_filename) FROM album_assets WHERE asset_id = a.id) AS filenames
           FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
          WHERE a.id = ?`,
      )
      .get(assetId) as SourceRow | undefined;
    this.removeRows(assetId, row?.rid);
    if (!row || row.filenames === null) return;

    const categories = row.enrichment ? ((JSON.parse(row.enrichment) as { categories?: string[] }).categories ?? []) : [];
    const allObjects = JSON.parse(row.objects) as string[];
    const tags = [...(JSON.parse(row.tags) as string[]), ...allObjects.slice(0, MAIN_OBJECTS), ...categories].join(' ');
    const objects = allObjects.slice(MAIN_OBJECTS).join(' ');
    const filenames = row.filenames.replace(/,/g, ' ');
    const text = row.text ?? '';
    this.db.prepare('INSERT INTO photo_fts (asset_id, caption, tags, objects, text, filenames) VALUES (?, ?, ?, ?, ?, ?)').run(assetId, row.caption, tags, objects, text, filenames);
    this.db.prepare('INSERT INTO photo_words (rowid, words) VALUES (?, ?)').run(row.rid, `${row.caption} ${tags} ${objects} ${text} ${filenames}`);
  }

  /** Call before deleting the file record. */
  remove(assetId: string): void {
    const rid = this.db.prepare('SELECT rowid FROM assets WHERE id = ?').pluck().get(assetId) as number | undefined;
    this.removeRows(assetId, rid);
  }

  private removeRows(assetId: string, rid: number | undefined): void {
    this.db.prepare('DELETE FROM photo_fts WHERE asset_id = ?').run(assetId);
    if (rid !== undefined) this.db.prepare('DELETE FROM photo_words WHERE rowid = ?').run(rid);
  }

  /**
   * Any query term, ranked by bm25. A term with no match falls back to a prefix match (4+ letters, so "car"
   * does not find "carrot"), then to the closest indexed word within a small edit distance.
   */
  search(query: string, eligible: readonly string[] | null, limit: number): LexicalResult {
    const terms = queryTerms(query);
    if (terms.length === 0) return { hits: [], corrections: [] };
    const corrections: { from: string; to: string }[] = [];
    const matches = this.db.prepare(`SELECT 1 FROM photo_fts WHERE photo_fts MATCH ? LIMIT 1`);
    const groups = terms.map((t) => {
      if (matches.get(quote(t))) return quote(t);
      if (t.length >= 4 && matches.get(`${quote(t)}*`)) return `${quote(t)}*`;
      const fix = this.correct(t);
      if (!fix) return quote(t);
      corrections.push({ from: t, to: fix });
      return quote(fix);
    });
    const match = groups.map((g) => `(${g})`).join(' OR ');
    const scope = eligible ? 'AND asset_id IN (SELECT value FROM json_each(?))' : '';
    const params: unknown[] = eligible ? [match, JSON.stringify(eligible), limit] : [match, limit];
    const hits = this.db
      .prepare(`SELECT asset_id AS assetId, ${BM25} AS rank FROM photo_fts WHERE photo_fts MATCH ? ${scope} ORDER BY rank LIMIT ?`)
      .all(...params) as LexicalHit[];
    return { hits, corrections };
  }

  /** Closest indexed (unstemmed) word for a term that matches nothing, if one is close enough. */
  private correct(term: string): string | null {
    if (term.length < 4) return null;
    const max = term.length >= 7 ? 2 : 1;
    const rows = this.db
      .prepare(`SELECT term, doc FROM photo_words_vocab WHERE length(term) BETWEEN ? AND ?`)
      .all(term.length - max, term.length + max) as { term: string; doc: number }[];
    // Closest first; on a tie prefer a word containing the typed letters in order, then the more common word.
    const candidates = rows
      .map((r) => ({ term: r.term, doc: r.doc, dist: editDistance(term, r.term, max), keeps: isSubsequence(term, r.term) }))
      .filter((c) => c.dist <= max)
      .sort((a, b) => a.dist - b.dist || Number(b.keeps) - Number(a.keeps) || b.doc - a.doc);
    return candidates[0]?.term ?? null;
  }
}
