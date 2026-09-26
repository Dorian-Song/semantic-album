-- The first objects of a description are its most prominent ones; they are indexed with the tags (weight 2.0),
-- the rest in the lightly weighted objects column. Measured on COCO: Words Recall@10 54.2 -> 56.6 and object
-- precision@10 92.9 -> 95.9 compared with all objects in the objects column (docs/decision-log.md).
DELETE FROM photo_fts;
INSERT INTO photo_fts (asset_id, caption, tags, objects, text, filenames)
SELECT a.id,
       COALESCE(d.manual_caption, d.ai_caption, ''),
       trim(COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(d.ai_tags, '[]'))), '') || ' ' ||
            COALESCE((SELECT group_concat(value, ' ') FROM (SELECT value FROM json_each(COALESCE(d.ai_objects, '[]')) ORDER BY key LIMIT 5)), '') || ' ' ||
            COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(json_extract(d.enrichment, '$.categories'), '[]'))), '')),
       COALESCE((SELECT group_concat(value, ' ') FROM (SELECT value FROM json_each(COALESCE(d.ai_objects, '[]')) ORDER BY key LIMIT -1 OFFSET 5)), ''),
       COALESCE(d.ai_text, ''),
       replace((SELECT group_concat(DISTINCT display_filename) FROM album_assets WHERE asset_id = a.id), ',', ' ')
  FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
 WHERE EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id);
