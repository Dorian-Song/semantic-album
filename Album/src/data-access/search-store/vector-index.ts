import type { Db } from '../../database/connection.js';

/**
 * Vectors kept in SQLite (authoritative) and mirrored in memory for search. Vectors are L2-normalised, so a dot
 * product is the cosine similarity. At the 10,000-photo scale an exact scan takes milliseconds.
 */
export class VectorIndex {
  private readonly vectors = new Map<string, Float32Array>();
  private loaded = false;

  constructor(
    private readonly db: Db,
    readonly dimension: number,
    private readonly table: 'photo_vectors' | 'photo_text_vectors',
  ) {}

  private load(): void {
    if (this.loaded) return;
    for (const row of this.db.prepare(`SELECT asset_id AS id, embedding FROM ${this.table}`).iterate() as Iterable<{ id: string; embedding: Buffer }>) {
      this.vectors.set(row.id, toFloat32(row.embedding));
    }
    this.loaded = true;
  }

  /** Reads all vectors into memory, so the first search does not pay for it. */
  warm(): void {
    this.load();
  }

  put(assetId: string, vector: Float32Array, at: string): void {
    if (vector.length !== this.dimension) throw new Error(`Expected a ${this.dimension}-dimensional vector, got ${vector.length}`);
    const normalised = normalise(vector);
    this.db
      .prepare(
        `INSERT INTO ${this.table} (asset_id, embedding, created_at) VALUES (?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET embedding = excluded.embedding, created_at = excluded.created_at`,
      )
      .run(assetId, Buffer.from(normalised.buffer, normalised.byteOffset, normalised.byteLength), at);
    if (this.loaded) this.vectors.set(assetId, normalised);
  }

  /** Deletes the stored row; the in-memory copy goes when `forget` is called. */
  deleteRow(assetId: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE asset_id = ?`).run(assetId);
  }

  forget(assetId: string): void {
    this.vectors.delete(assetId);
  }

  isEmpty(): boolean {
    return !this.db.prepare(`SELECT 1 FROM ${this.table} LIMIT 1`).get();
  }

  /** Cosine similarity of each photo in `among` that has a vector. */
  score(query: Float32Array, among: ReadonlySet<string>): Map<string, number> {
    this.load();
    const q = normalise(query);
    const out = new Map<string, number>();
    for (const [assetId, v] of this.vectors) {
      if (!among.has(assetId)) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i]! * q[i]!;
      out.set(assetId, dot);
    }
    return out;
  }
}

function toFloat32(buf: Buffer): Float32Array {
  // Copy: the Buffer may share memory and need not be 4-byte aligned.
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}
