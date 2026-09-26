import fs from 'node:fs/promises';
import sharp from 'sharp';
import type { AppContext } from '../context.js';
import type { Embedder } from '../inference/embedder.js';
import type { VectorIndex } from '../search/vector-index.js';
import { nowIso } from '../shared/ids.js';
import { PermanentTaskError, ServiceUnavailableError, type ClaimedTask, type TaskHandler } from './task-service.js';

/**
 * The model resizes images to about 1.3 megapixels anyway; sending a smaller JPEG than the 2560 px display
 * copy saves decoding and transfer without changing what the model sees much.
 */
const EMBED_LONG_EDGE = 1280;

export class EmbeddingWorker implements TaskHandler {
  constructor(
    private readonly ctx: AppContext,
    private readonly embedder: Embedder,
    private readonly vectors: VectorIndex,
    private readonly limit: number,
  ) {}

  concurrency(): number {
    return this.limit;
  }

  async run(task: ClaimedTask): Promise<{ provider: string }> {
    this.assertSameModel();
    const row = this.ctx.db.prepare(`SELECT derivative_key AS key FROM assets WHERE id = ?`).get(task.assetId) as { key: string | null } | undefined;
    if (!row) throw new PermanentTaskError('The photo no longer exists');
    if (!row.key) throw new PermanentTaskError('No decodable copy of this photo exists');
    const jpeg = await sharp(await fs.readFile(this.ctx.store.abs(row.key)))
      .resize(EMBED_LONG_EDGE, EMBED_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    const vector = await this.embedder.embedImage(jpeg);
    const { db } = this.ctx;
    db.transaction(() => {
      this.assertSameModel();
      if (!db.prepare('SELECT 1 FROM assets WHERE id = ?').get(task.assetId)) return;
      // The index records its model with its first vector; an empty index simply adopts the current model.
      const e = this.embedder;
      db.prepare(
        `INSERT INTO embedding_meta (id, model_id, revision, dimension, created_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET model_id = excluded.model_id, revision = excluded.revision,
           dimension = excluded.dimension, created_at = excluded.created_at
         WHERE NOT EXISTS (SELECT 1 FROM photo_vectors)`,
      ).run(e.modelId, e.revision, e.dimension, nowIso());
      this.vectors.put(task.assetId, vector);
    })();
    return { provider: this.embedder.modelId };
  }

  /** Refuses to mix vectors from a different model or dimension into a non-empty index. */
  private assertSameModel(): void {
    const { db } = this.ctx;
    const meta = db.prepare(`SELECT model_id AS modelId, revision, dimension FROM embedding_meta WHERE id = 1`).get() as
      | { modelId: string; revision: string; dimension: number }
      | undefined;
    const e = this.embedder;
    if (!meta || (meta.modelId === e.modelId && meta.revision === e.revision && meta.dimension === e.dimension)) return;
    if (!db.prepare('SELECT 1 FROM photo_vectors LIMIT 1').get()) return;
    throw new ServiceUnavailableError(
      `The search index was built with ${meta.modelId}@${meta.revision.slice(0, 7)} (${meta.dimension}d); it must be rebuilt for the configured model`,
      60 * 60_000,
    );
  }
}
