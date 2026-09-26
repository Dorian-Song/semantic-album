-- Photos imported before processing tasks existed get their caption and embedding work queued.
INSERT OR IGNORE INTO processing_tasks (id, asset_id, kind, revision, state, created_at, updated_at)
SELECT lower(hex(randomblob(16))), a.id, k.kind, 1, 'pending',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM assets a CROSS JOIN (SELECT 'caption' AS kind UNION ALL SELECT 'embedding') k
 WHERE NOT EXISTS (SELECT 1 FROM processing_tasks t WHERE t.asset_id = a.id AND t.kind = k.kind);
