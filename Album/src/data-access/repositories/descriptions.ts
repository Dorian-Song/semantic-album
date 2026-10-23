import type { Db } from '../../database/connection.js';

export interface AiDescription {
  caption: string;
  tags: string[];
  objects: string[];
  text: string | null;
  kind: string | null;
  provider: string;
  model: string;
  promptRevision: number;
}

export interface Enrichment {
  caption: string;
  tags: string[];
  categories: string[];
  keywords: string[];
  wordCount: number;
  rowId: number;
  storedAt: string;
}

/** What a photo's description vector is computed from. */
export interface DescriptionSource {
  manual: string | null;
  ai: string | null;
  tags: string;
  objects: string;
  text: string | null;
}

/** Photo descriptions: the user's text and the AI draft (descriptions). */
export class DescriptionRepository {
  constructor(private readonly db: Db) {}

  setManual(assetId: string, caption: string | null, at: string): void {
    this.db
      .prepare(
        `INSERT INTO descriptions (asset_id, manual_caption, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET manual_caption = excluded.manual_caption, updated_at = excluded.updated_at`,
      )
      .run(assetId, caption, at);
  }

  /** Stores the AI draft; never touches the user's text. */
  saveAi(assetId: string, d: AiDescription, at: string): void {
    this.db
      .prepare(
        `INSERT INTO descriptions (asset_id, ai_caption, ai_tags, ai_objects, ai_text, ai_kind, provider, model, prompt_revision, enrichment_state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (asset_id) DO UPDATE SET
           ai_caption = excluded.ai_caption, ai_tags = excluded.ai_tags, ai_objects = excluded.ai_objects, ai_text = excluded.ai_text,
           ai_kind = excluded.ai_kind, provider = excluded.provider, model = excluded.model,
           prompt_revision = excluded.prompt_revision, enrichment_state = 'pending', updated_at = excluded.updated_at`,
      )
      .run(assetId, d.caption, JSON.stringify(d.tags), JSON.stringify(d.objects), d.text, d.kind, d.provider, d.model, d.promptRevision, at);
  }

  aiCaption(assetId: string): { caption: string | null; tags: string[] } | undefined {
    const row = this.db.prepare(`SELECT ai_caption AS caption, ai_tags AS tags FROM descriptions WHERE asset_id = ?`).get(assetId) as
      | { caption: string | null; tags: string }
      | undefined;
    return row && { caption: row.caption, tags: JSON.parse(row.tags) as string[] };
  }

  applyEnrichment(assetId: string, e: Enrichment, at: string): void {
    this.db
      .prepare(`UPDATE descriptions SET ai_caption = ?, ai_tags = ?, enrichment = ?, enrichment_state = 'done', updated_at = ? WHERE asset_id = ?`)
      .run(
        e.caption,
        JSON.stringify(e.tags),
        JSON.stringify({ categories: e.categories, keywords: e.keywords, wordCount: e.wordCount, rowId: e.rowId, storedAt: e.storedAt }),
        at,
        assetId,
      );
  }

  source(assetId: string): DescriptionSource | undefined {
    return this.db
      .prepare(
        `SELECT manual_caption AS manual, ai_caption AS ai, ai_tags AS tags, ai_objects AS objects, ai_text AS text
           FROM descriptions WHERE asset_id = ?`,
      )
      .get(assetId) as DescriptionSource | undefined;
  }

  /** Photos in the library whose AI description is missing or older than `promptRevision`. */
  outdated(promptRevision: number): string[] {
    return this.db
      .prepare(
        `SELECT a.id FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
          WHERE a.orphaned_at IS NULL AND EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id)
            AND (d.asset_id IS NULL OR d.ai_caption IS NULL OR COALESCE(d.prompt_revision, 0) < ?)`,
      )
      .pluck()
      .all(promptRevision) as string[];
  }

  delete(assetId: string): void {
    this.db.prepare('DELETE FROM descriptions WHERE asset_id = ?').run(assetId);
  }
}
