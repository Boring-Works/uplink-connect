-- Error deduplication by hash with occurrence counting
ALTER TABLE ingest_errors ADD COLUMN error_hash TEXT;
ALTER TABLE ingest_errors ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_ingest_errors_hash ON ingest_errors(error_hash, status);
