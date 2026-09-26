-- Per-task timing for throughput reports, and per-import stage timings (JSON) written when a job finishes.
ALTER TABLE processing_tasks ADD COLUMN started_at TEXT;
ALTER TABLE processing_tasks ADD COLUMN finished_at TEXT;
ALTER TABLE processing_tasks ADD COLUMN duration_ms INTEGER;
ALTER TABLE import_jobs ADD COLUMN stats TEXT;
CREATE INDEX processing_tasks_asset ON processing_tasks (asset_id, kind);
