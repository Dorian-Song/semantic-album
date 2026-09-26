import type { Db } from '../db/connection.js';

/**
 * Rewrites one photo's lexical-search row from authoritative tables: effective caption, tags, and every
 * membership filename. Call inside the transaction that changed any of them.
 */
export function refreshPhotoText(db: Db, assetId: string): void {
  db.prepare('DELETE FROM photo_fts WHERE asset_id = ?').run(assetId);
  const row = db
    .prepare(
      `SELECT COALESCE(d.manual_caption, d.ai_caption, '') AS caption,
              COALESCE(d.ai_tags, '[]') AS tags,
              d.enrichment AS enrichment,
              (SELECT group_concat(DISTINCT display_filename) FROM album_assets WHERE asset_id = a.id) AS filenames
         FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
        WHERE a.id = ?`,
    )
    .get(assetId) as { caption: string; tags: string; enrichment: string | null; filenames: string | null } | undefined;
  if (!row || row.filenames === null) return; // no memberships: hidden from search
  // Broad n8n categories ("animals" for a photo tagged "dog") are searchable alongside the tags.
  const categories = row.enrichment ? ((JSON.parse(row.enrichment) as { categories?: string[] }).categories ?? []) : [];
  const tags = [...(JSON.parse(row.tags) as string[]), ...categories].join(' ');
  db.prepare('INSERT INTO photo_fts (asset_id, caption, tags, filenames) VALUES (?, ?, ?, ?)').run(
    assetId,
    row.caption,
    tags,
    row.filenames.replace(/,/g, ' '),
  );
}
