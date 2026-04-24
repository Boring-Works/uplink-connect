-- Add occurrence_count to ingest_errors for error deduplication tracking
ALTER TABLE ingest_errors ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
