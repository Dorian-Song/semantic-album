-- What the n8n workflow returned besides the normalised caption and tags (JSON: categories, keywords, rowId, ...).
ALTER TABLE descriptions ADD COLUMN enrichment TEXT;
