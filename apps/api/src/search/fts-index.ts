import type { Db } from '../db/connection.js';

interface SourceRow {
  rid: number;
  caption: string;
  tags: string;
  objects: string;
  text: string | null;
  enrichment: string | null;
  filenames: string | null;
}

/**
 * Rewrites one photo's lexical-search rows from authoritative tables: effective caption; tags, visible objects,
 * and n8n categories; text transcribed from the image; and every membership filename. photo_fts (Porter-stemmed)
 * serves matching (objects in their own, lightly weighted column); photo_words (unstemmed) only feeds typo correction. Call inside the changing transaction.
 */
/** Objects are listed most prominent first; this many are indexed with the tags. */
export const MAIN_OBJECTS = 5;

export function refreshPhotoText(db: Db, assetId: string): void {
  const row = db
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
  removeRows(db, assetId, row?.rid);
  if (!row || row.filenames === null) return; // no memberships: hidden from search

  const categories = row.enrichment ? ((JSON.parse(row.enrichment) as { categories?: string[] }).categories ?? []) : [];
  const allObjects = JSON.parse(row.objects) as string[];
  // The first objects are the most prominent: they weigh like tags; the long tail goes in a low-weight column.
  const tags = [...(JSON.parse(row.tags) as string[]), ...allObjects.slice(0, MAIN_OBJECTS), ...categories].join(' ');
  const objects = allObjects.slice(MAIN_OBJECTS).join(' ');
  const filenames = row.filenames.replace(/,/g, ' ');
  const text = row.text ?? '';
  db.prepare('INSERT INTO photo_fts (asset_id, caption, tags, objects, text, filenames) VALUES (?, ?, ?, ?, ?, ?)').run(
    assetId,
    row.caption,
    tags,
    objects,
    text,
    filenames,
  );
  db.prepare('INSERT INTO photo_words (rowid, words) VALUES (?, ?)').run(row.rid, `${row.caption} ${tags} ${objects} ${text} ${filenames}`);
}

/** Removes a photo's lexical rows; call before deleting the asset row. */
export function removePhotoText(db: Db, assetId: string): void {
  const rid = db.prepare('SELECT rowid FROM assets WHERE id = ?').pluck().get(assetId) as number | undefined;
  removeRows(db, assetId, rid);
}

function removeRows(db: Db, assetId: string, rid: number | undefined): void {
  db.prepare('DELETE FROM photo_fts WHERE asset_id = ?').run(assetId);
  if (rid !== undefined) db.prepare('DELETE FROM photo_words WHERE rowid = ?').run(rid);
}
