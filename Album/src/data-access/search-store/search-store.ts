import type { Db } from '../../database/connection.js';
import { nowIso } from '../../shared/ids.js';
import { ServiceUnavailableError } from '../egress/errors.js';
import { TextIndex, type LexicalResult } from './text-index.js';
import { VectorIndex } from './vector-index.js';

/** Which embedding model produced a vector. */
export interface ModelIdentity {
  modelId: string;
  revision: string;
  dimension: number;
}

/**
 * What search needs: the full-text index and two vector sets per photo (image, description text). Refuses
 * vectors from a different embedding model than the one the index was built with.
 */
export class SearchStore {
  private readonly text: TextIndex;
  private readonly images: VectorIndex;
  private readonly descriptions: VectorIndex;

  constructor(
    private readonly db: Db,
    dimension: number,
  ) {
    this.text = new TextIndex(db);
    this.images = new VectorIndex(db, dimension, 'photo_vectors');
    this.descriptions = new VectorIndex(db, dimension, 'photo_text_vectors');
  }

  warm(): void {
    this.images.warm();
    this.descriptions.warm();
  }

  /** Rebuilds a photo's full-text rows from its current description and albums. */
  refreshText(assetId: string): void {
    this.text.refresh(assetId);
  }

  searchWords(query: string, eligible: readonly string[] | null, limit: number): LexicalResult {
    return this.text.search(query, eligible, limit);
  }

  /** Throws when the image vectors were built by a different model. */
  assertModel(m: ModelIdentity): void {
    const meta = this.db.prepare(`SELECT model_id AS modelId, revision, dimension FROM embedding_meta WHERE id = 1`).get() as ModelIdentity | undefined;
    if (!meta || (meta.modelId === m.modelId && meta.revision === m.revision && meta.dimension === m.dimension)) return;
    if (this.images.isEmpty()) return;
    throw new ServiceUnavailableError(
      `The search index was built with ${meta.modelId}@${meta.revision.slice(0, 7)} (${meta.dimension}d); it must be rebuilt for the configured model`,
      60 * 60_000,
    );
  }

  /** Stores a photo's image vector. Call inside the write that confirms the photo still exists. */
  putImageVector(assetId: string, vector: Float32Array, m: ModelIdentity): void {
    this.assertModel(m);
    // The index records its model with its first vector; an empty index adopts the current model.
    this.db
      .prepare(
        `INSERT INTO embedding_meta (id, model_id, revision, dimension, created_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET model_id = excluded.model_id, revision = excluded.revision,
           dimension = excluded.dimension, created_at = excluded.created_at
         WHERE NOT EXISTS (SELECT 1 FROM photo_vectors)`,
      )
      .run(m.modelId, m.revision, m.dimension, nowIso());
    this.images.put(assetId, vector, nowIso());
  }

  putDescriptionVector(assetId: string, vector: Float32Array): void {
    this.descriptions.put(assetId, vector, nowIso());
  }

  deleteDescriptionVector(assetId: string): void {
    this.descriptions.deleteRow(assetId);
    this.descriptions.forget(assetId);
  }

  scoreImages(query: Float32Array, among: ReadonlySet<string>): Map<string, number> {
    return this.images.score(query, among);
  }

  scoreDescriptions(query: Float32Array, among: ReadonlySet<string>): Map<string, number> {
    return this.descriptions.score(query, among);
  }

  /** Deletes a photo's stored search data. Call inside the write that deletes the photo, then `forget` after it. */
  removePhoto(assetId: string): void {
    this.text.remove(assetId);
    this.images.deleteRow(assetId);
    this.descriptions.deleteRow(assetId);
  }

  /** Drops a removed photo from the in-memory vectors. */
  forget(assetId: string): void {
    this.images.forget(assetId);
    this.descriptions.forget(assetId);
  }
}
