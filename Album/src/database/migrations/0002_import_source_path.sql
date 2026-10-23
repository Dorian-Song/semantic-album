-- Host folder being imported, needed to resume after a restart. Never returned by the API.
ALTER TABLE import_jobs ADD COLUMN source_path TEXT;
