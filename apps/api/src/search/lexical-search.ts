import type { Db } from '../db/connection.js';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on',
  'or', 'the', 'their', 'this', 'that', 'to', 'with', 'photo', 'photos', 'picture', 'pictures', 'image', 'images', 'show', 'me',
  'my', 'some', 'find', 'where', 'there', 'was', 'were',
]);

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

/** Query words worth matching: lower-case letters/digits, no stop words, at most 12. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))].slice(0, 12);
}

/** Levenshtein distance, giving up once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
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
 * FTS5 column weights: asset_id (unindexed), caption 1.0, tags with the main objects and n8n categories 2.0,
 * the remaining objects 0.5, text in the image 1.0, filenames 0.5. Long object lists add noise to
 * sentence-like queries, so only the most prominent objects weigh like tags; see docs/decision-log.md.
 */
const BM25 = 'bm25(photo_fts, 0.0, 1.0, 2.0, 0.5, 1.0, 0.5)';

/**
 * Words search: any query term, Porter-stemmed by the index (so "skateboarding" finds "skateboard" while "car"
 * does not find "carrot"), ranked by bm25 so photos matching more (and rarer) terms come first. A term with
 * no match falls back to a prefix match, then to the closest indexed word within a small edit distance.
 * This is search assistance, not web-search ranking.
 */
export class LexicalSearch {
  constructor(private readonly db: Db) {}

  search(query: string, eligible: readonly string[] | null, limit: number): LexicalResult {
    const terms = queryTerms(query);
    if (terms.length === 0) return { hits: [], corrections: [] };
    const corrections: { from: string; to: string }[] = [];
    const matches = this.db.prepare(`SELECT 1 FROM photo_fts WHERE photo_fts MATCH ? LIMIT 1`);
    const groups = terms.map((t) => {
      if (matches.get(quote(t))) return quote(t);
      // Prefix fallback only for longer words: a short one ("car") would match unrelated words ("carrot").
      if (t.length >= 4 && matches.get(`${quote(t)}*`)) return `${quote(t)}*`;
      const fix = this.correct(t);
      if (!fix) return quote(t);
      corrections.push({ from: t, to: fix });
      return quote(fix);
    });
    return { hits: this.run(groups.map((g) => `(${g})`).join(' OR '), eligible, limit), corrections };
  }

  private run(match: string, eligible: readonly string[] | null, limit: number): LexicalHit[] {
    const scope = eligible ? 'AND asset_id IN (SELECT value FROM json_each(?))' : '';
    const params: unknown[] = eligible ? [match, JSON.stringify(eligible), limit] : [match, limit];
    return this.db
      .prepare(`SELECT asset_id AS assetId, ${BM25} AS rank FROM photo_fts WHERE photo_fts MATCH ? ${scope} ORDER BY rank LIMIT ?`)
      .all(...params) as LexicalHit[];
  }

  /** Closest indexed (unstemmed) word for a term that matches nothing, if one is close enough. */
  private correct(term: string): string | null {
    if (term.length < 4) return null;
    const max = term.length >= 7 ? 2 : 1;
    const rows = this.db
      .prepare(`SELECT term, doc FROM photo_words_vocab WHERE length(term) BETWEEN ? AND ?`)
      .all(term.length - max, term.length + max) as { term: string; doc: number }[];
    // Closest first; on a tie prefer a word that contains the typed letters in order (a dropped letter is the
    // commonest typo, so "grden" means "garden" rather than "green"), then the more common word.
    const candidates = rows
      .map((r) => ({ term: r.term, doc: r.doc, dist: editDistance(term, r.term, max), keeps: isSubsequence(term, r.term) }))
      .filter((c) => c.dist <= max)
      .sort((a, b) => a.dist - b.dist || Number(b.keeps) - Number(a.keeps) || b.doc - a.doc);
    return candidates[0]?.term ?? null;
  }
}
