-- Retrieval v2 (see docs/decision-log.md, "Retrieval improvements").
-- 1. Structured AI fields: visible objects, transcribed text, and image kind.
ALTER TABLE descriptions ADD COLUMN ai_objects TEXT NOT NULL DEFAULT '[]';
ALTER TABLE descriptions ADD COLUMN ai_text TEXT;
ALTER TABLE descriptions ADD COLUMN ai_kind TEXT;

-- 2. Lexical index with Porter stemming (skateboarding ~ skateboard, riding ~ ride) and a separate column
--    for text transcribed from the image. An unstemmed, contentless twin provides readable words for typo
--    correction. Both are rebuilt from authoritative rows below.
DROP TABLE photo_fts_vocab;
DROP TABLE photo_fts;
CREATE VIRTUAL TABLE photo_fts USING fts5 (
  asset_id UNINDEXED,
  caption,
  tags,
  text,
  filenames,
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);
CREATE VIRTUAL TABLE photo_words USING fts5 (words, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE photo_words_vocab USING fts5vocab (photo_words, 'row');

CREATE TEMP TABLE fts_source AS
SELECT a.rowid AS rid, a.id AS asset_id,
       COALESCE(d.manual_caption, d.ai_caption, '') AS caption,
       trim(COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(d.ai_tags, '[]'))), '') || ' ' ||
            COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(d.ai_objects, '[]'))), '') || ' ' ||
            COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(json_extract(d.enrichment, '$.categories'), '[]'))), '')) AS tags,
       COALESCE(d.ai_text, '') AS text,
       (SELECT group_concat(DISTINCT display_filename) FROM album_assets WHERE asset_id = a.id) AS filenames
  FROM assets a LEFT JOIN descriptions d ON d.asset_id = a.id
 WHERE EXISTS (SELECT 1 FROM album_assets WHERE asset_id = a.id);
INSERT INTO photo_fts (asset_id, caption, tags, text, filenames)
SELECT asset_id, caption, tags, text, replace(filenames, ',', ' ') FROM fts_source;
INSERT INTO photo_words (rowid, words)
SELECT rid, caption || ' ' || tags || ' ' || text || ' ' || replace(filenames, ',', ' ') FROM fts_source;
DROP TABLE fts_source;

-- 3. A second vector per photo, from its description text; Meaning search blends it with the image vector.
CREATE TABLE photo_text_vectors (
  asset_id    TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  embedding   BLOB NOT NULL,
  created_at  TEXT NOT NULL
);

-- 4. New task kind. SQLite cannot alter a CHECK constraint, so the table is rebuilt.
CREATE TABLE processing_tasks_v2 (
  id               TEXT PRIMARY KEY,
  asset_id         TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('caption', 'embedding', 'enrichment', 'text_embedding')),
  revision         INTEGER NOT NULL DEFAULT 1,
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT,
  error            TEXT,
  provider         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  duration_ms      INTEGER,
  UNIQUE (asset_id, kind, revision)
);
INSERT INTO processing_tasks_v2 (id, asset_id, kind, revision, state, attempts, next_attempt_at, error, provider,
                                 created_at, updated_at, started_at, finished_at, duration_ms)
SELECT id, asset_id, kind, revision, state, attempts, next_attempt_at, error, provider,
       created_at, updated_at, started_at, finished_at, duration_ms FROM processing_tasks;
DROP TABLE processing_tasks;
ALTER TABLE processing_tasks_v2 RENAME TO processing_tasks;
CREATE INDEX processing_tasks_queue ON processing_tasks (kind, state, next_attempt_at);
CREATE INDEX processing_tasks_asset ON processing_tasks (asset_id, kind);

-- Photos that already have a description get a text vector.
INSERT OR IGNORE INTO processing_tasks (id, asset_id, kind, revision, state, created_at, updated_at)
SELECT lower(hex(randomblob(16))), d.asset_id, 'text_embedding', 1, 'pending',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM descriptions d
 WHERE COALESCE(d.manual_caption, d.ai_caption) IS NOT NULL;
