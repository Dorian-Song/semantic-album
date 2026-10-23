-- Visible objects get their own lexical column with a low weight. Kept in the heavily weighted tags column,
-- the 10-25 objects per photo from prompt revision 2 added noise that lowered Words recall on COCO.
DROP TABLE photo_fts;
CREATE VIRTUAL TABLE photo_fts USING fts5 (
  asset_id UNINDEXED,
  caption,
  tags,
  objects,
  text,
  filenames,
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);
INSERT INTO photo_fts (asset_id, caption, tags, objects, text, filenames)
SELECT a.id,
       COALESCE(d.manual_caption, d.ai_caption, ''),
       trim(COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(d.ai_tags, '[]'))), '') || ' ' ||
            COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(json_extract(d.enrichment, '$.categories'), '[]'))), '')),
       COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(d.ai_objects, '[]'))), ''),
       COALESCE(d.ai_text, ''),
       replace((SELECT group_concat(DISTINCT display_filename) FROM album_assets WHERE asset_id = a.id), ',', ' ')
  FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
 WHERE EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id);
