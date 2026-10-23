-- Image embeddings (float32, L2-normalised) for Meaning search. Exact scan in memory; see search/vector-index.ts.
CREATE TABLE photo_vectors (
  asset_id    TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  embedding   BLOB NOT NULL,
  created_at  TEXT NOT NULL
);

-- Vocabulary of the lexical index, for the typo-tolerant fallback.
CREATE VIRTUAL TABLE photo_fts_vocab USING fts5vocab (photo_fts, 'row');
