import type { Db } from '../db/connection.js';
import { nowIso } from '../shared/ids.js';

export interface VectorHit {
  assetId: string;
  score: number;
}

/**
 * Image vectors kept in SQLite (authoritative) and mirrored in memory for search. Vectors are
 * L2-normalised, so a dot product is the cosine similarity. At the 10,000-photo scale an exact scan over the
 * eligible photos takes milliseconds, so no approximate index is used; rows of deleted assets disappear by
 * cascade and are filtered out by the eligibility check.
 */
export class VectorIndex {
  private readonly vectors = new Map<string, Float32Array>();
  private loaded = false;

  constructor(
    private readonly db: Db,
    readonly dimension: number,
  ) {}

  private load(): void {
    if (this.loaded) return;
    for (const row of this.db.prepare('SELECT asset_id AS id, embedding FROM photo_vectors').iterate() as Iterable<{ id: string; embedding: Buffer }>) {
      this.vectors.set(row.id, toFloat32(row.embedding));
    }
    this.loaded = true;
  }

  /** Stores a vector. Call inside the transaction that decides the asset still exists. */
  put(assetId: string, vector: Float32Array): void {
    if (vector.length !== this.dimension) throw new Error(`Expected a ${this.dimension}-dimensional vector, got ${vector.length}`);
    const normalised = normalise(vector);
    this.db
      .prepare(
        `INSERT INTO photo_vectors (asset_id, embedding, created_at) VALUES (?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET embedding = excluded.embedding, created_at = excluded.created_at`,
      )
      .run(assetId, Buffer.from(normalised.buffer, normalised.byteOffset, normalised.byteLength), nowIso());
    if (this.loaded) this.vectors.set(assetId, normalised);
  }

  get size(): number {
    this.load();
    return this.vectors.size;
  }

  /** Top-k photos by cosine similarity, optionally restricted to `eligible`. */
  search(query: Float32Array, eligible: ReadonlySet<string> | null, k: number): VectorHit[] {
    this.load();
    const q = normalise(query);
    const hits: VectorHit[] = [];
    for (const [assetId, v] of this.vectors) {
      if (eligible && !eligible.has(assetId)) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i]! * q[i]!;
      hits.push({ assetId, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}

function toFloat32(buf: Buffer): Float32Array {
  // Copy: the Buffer may share memory and need not be 4-byte aligned.
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

export function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}
