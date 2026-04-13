PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
	source_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	owner TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS source_auth_refs (
	auth_ref_id TEXT PRIMARY KEY,
	source_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	secret_ref TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingest_runs (
	run_id TEXT PRIMARY KEY,
	source_id TEXT NOT NULL,
	source_name TEXT NOT NULL,
	source_type TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('received', 'collecting', 'enqueued', 'persisted', 'normalized', 'replayed', 'failed')),
	collected_at TEXT NOT NULL,
	received_at TEXT NOT NULL,
	record_count INTEGER NOT NULL DEFAULT 0,
	normalized_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	workflow_instance_id TEXT,
	triggered_by TEXT,
	replay_of_run_id TEXT,
	envelope_json TEXT NOT NULL,
	artifact_key TEXT,
	ended_at TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_source ON ingest_runs(source_id);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_status ON ingest_runs(status);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_created_at ON ingest_runs(created_at);

CREATE TABLE IF NOT EXISTS raw_artifacts (
	artifact_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	artifact_type TEXT NOT NULL,
	r2_key TEXT NOT NULL,
	size_bytes INTEGER,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_raw_artifacts_run ON raw_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_raw_artifacts_source ON raw_artifacts(source_id);

CREATE TABLE IF NOT EXISTS ingest_errors (
	error_id TEXT PRIMARY KEY,
	run_id TEXT,
	source_id TEXT,
	phase TEXT NOT NULL,
	error_code TEXT NOT NULL,
	error_message TEXT NOT NULL,
	payload TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'retrying', 'resolved', 'dead_letter')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_errors_run ON ingest_errors(run_id);
CREATE INDEX IF NOT EXISTS idx_ingest_errors_status ON ingest_errors(status);
