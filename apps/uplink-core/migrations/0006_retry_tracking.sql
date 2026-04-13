PRAGMA foreign_keys = ON;

-- Enhanced ingest_errors table with retry tracking
ALTER TABLE ingest_errors ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_errors ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE ingest_errors ADD COLUMN last_retry_at INTEGER;
ALTER TABLE ingest_errors ADD COLUMN error_category TEXT;
ALTER TABLE ingest_errors ADD COLUMN retry_attempts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ingest_errors ADD COLUMN resolved_at INTEGER;
ALTER TABLE ingest_errors ADD COLUMN resolved_by TEXT;
ALTER TABLE ingest_errors ADD COLUMN resolution_notes TEXT;

-- Index for retry queries
CREATE INDEX IF NOT EXISTS idx_ingest_errors_retry ON ingest_errors(status, retry_count, last_retry_at);
CREATE INDEX IF NOT EXISTS idx_ingest_errors_category ON ingest_errors(error_category);
CREATE INDEX IF NOT EXISTS idx_ingest_errors_source_status ON ingest_errors(source_id, status);

-- Table for idempotency tracking of retry operations
CREATE TABLE IF NOT EXISTS retry_idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    error_id TEXT NOT NULL,
    attempted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    result TEXT NOT NULL CHECK (result IN ('success', 'failed', 'in_progress')),
    FOREIGN KEY (error_id) REFERENCES ingest_errors(error_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retry_idempotency_error ON retry_idempotency_keys(error_id);
CREATE INDEX IF NOT EXISTS idx_retry_idempotency_time ON retry_idempotency_keys(attempted_at);

-- Table for tracking retry batches (for bulk operations)
CREATE TABLE IF NOT EXISTS retry_batches (
    batch_id TEXT PRIMARY KEY,
    triggered_by TEXT NOT NULL,
    filter_criteria_json TEXT NOT NULL,
    total_errors INTEGER NOT NULL DEFAULT 0,
    successful_retries INTEGER NOT NULL DEFAULT 0,
    failed_retries INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')) DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_retry_batches_status ON retry_batches(status);
