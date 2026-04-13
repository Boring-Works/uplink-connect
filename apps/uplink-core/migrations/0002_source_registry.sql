PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_configs (
	source_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled', 'deleted')) DEFAULT 'active',
	adapter_type TEXT NOT NULL,
	endpoint_url TEXT,
	request_method TEXT NOT NULL DEFAULT 'GET',
	request_headers_json TEXT NOT NULL DEFAULT '{}',
	request_body TEXT,
	metadata_json TEXT NOT NULL DEFAULT '{}',
	webhook_security_json TEXT,
	deleted_at INTEGER,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS source_policies (
	source_id TEXT PRIMARY KEY,
	min_interval_seconds INTEGER NOT NULL DEFAULT 60,
	lease_ttl_seconds INTEGER NOT NULL DEFAULT 300,
	max_records_per_run INTEGER NOT NULL DEFAULT 1000,
	retry_limit INTEGER NOT NULL DEFAULT 3,
	timeout_seconds INTEGER NOT NULL DEFAULT 60,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS source_capabilities (
	source_id TEXT PRIMARY KEY,
	allow_api INTEGER NOT NULL DEFAULT 1,
	allow_webhook INTEGER NOT NULL DEFAULT 0,
	allow_browser INTEGER NOT NULL DEFAULT 0,
	allow_manual_trigger INTEGER NOT NULL DEFAULT 1,
	supports_cursor INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS source_runtime_snapshots (
	source_id TEXT PRIMARY KEY,
	lease_owner TEXT,
	lease_token TEXT,
	lease_expires_at INTEGER,
	cursor TEXT,
	next_allowed_at INTEGER,
	consecutive_failures INTEGER NOT NULL DEFAULT 0,
	last_run_id TEXT,
	last_success_at TEXT,
	last_error_at TEXT,
	last_error_message TEXT,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_configs_status ON source_configs(status);
CREATE INDEX IF NOT EXISTS idx_source_configs_type ON source_configs(type);
CREATE INDEX IF NOT EXISTS idx_source_configs_deleted_at ON source_configs(deleted_at) WHERE deleted_at IS NOT NULL;
