import type { AppContext } from '../context.js';
import type { Embedder } from '../inference/embedder.js';
import type { VectorIndex } from '../search/vector-index.js';
import type { ClaimedTask, TaskHandler } from './task-service.js';

interface DescriptionRow {
  manual: string | null;
  ai: string | null;
  tags: string;
  objects: string;
  text: string | null;
}

/** Text of a photo's description as embedded: what it shows, its keywords, and the start of any text in it. */
export function descriptionDocument(d: DescriptionRow): string | null {
  const caption = d.manual ?? d.ai;
  if (!caption) return null;
  const parts = [caption.trim()];
  const tags = JSON.parse(d.tags) as string[];
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}.`);
  if (d.text?.trim()) parts.push(`Text: ${d.text.trim().slice(0, 400)}`);
  return parts.join(' ');
}

/**
 * Embeds the description text of a photo into the same space as its image. Meaning search blends the two:
 * on 5,000 COCO photos, an even blend lifted caption-query Recall@1 from 26% (image only) to 34% and object
 * precision@10 from 93% to 95%, where a single vector of image + text together was worse on objects (87%).
 */
export class TextEmbeddingWorker implements TaskHandler {
  constructor(
    private readonly ctx: AppContext,
    private readonly embedder: Embedder,
    private readonly textVectors: VectorIndex,
    private readonly limit: number,
  ) {}

  concurrency(): number {
    return this.limit;
  }

  async run(task: ClaimedTask): Promise<{ provider: string } | void> {
    const { db } = this.ctx;
    const newer = db
      .prepare(`SELECT 1 FROM processing_tasks WHERE asset_id = ? AND kind = 'text_embedding' AND revision > ? LIMIT 1`)
      .get(task.assetId, task.revision);
    if (newer) return; // a later description change will be embedded instead
    const d = db
      .prepare(
        `SELECT manual_caption AS manual, ai_caption AS ai, ai_tags AS tags, ai_objects AS objects, ai_text AS text
           FROM descriptions WHERE asset_id = ?`,
      )
      .get(task.assetId) as DescriptionRow | undefined;
    const doc = d ? descriptionDocument(d) : null;
    if (!doc) {
      this.textVectors.delete(task.assetId);
      return;
    }
    const vector = await this.embedder.embedQuery(doc);
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM assets WHERE id = ?').get(task.assetId)) this.textVectors.put(task.assetId, vector);
    })();
    return { provider: this.embedder.modelId };
  }
}
