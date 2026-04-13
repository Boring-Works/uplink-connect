PRAGMA foreign_keys = ON;

-- Alert configuration stored in source_policies table (JSON column)
-- Adding alert_config_json column to source_policies
ALTER TABLE source_policies ADD COLUMN alert_config_json TEXT;

-- Active alerts table with deduplication support
CREATE TABLE IF NOT EXISTS alerts_active (
	alert_id TEXT PRIMARY KEY,
	dedup_key TEXT NOT NULL UNIQUE,
	alert_type TEXT NOT NULL CHECK (alert_type IN ('source_failure_rate', 'queue_lag', 'run_stuck', 'lease_expired')),
	severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
	source_id TEXT,
	run_id TEXT,
	message TEXT NOT NULL,
	recommended_action TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE,
	FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alerts_active_type ON alerts_active(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_active_severity ON alerts_active(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_active_source ON alerts_active(source_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active_created ON alerts_active(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_active_acknowledged ON alerts_active(acknowledged);

-- Alert history for resolved/acknowledged alerts
CREATE TABLE IF NOT EXISTS alerts_history (
	alert_id TEXT PRIMARY KEY,
	alert_type TEXT NOT NULL,
	severity TEXT NOT NULL,
	source_id TEXT,
	run_id TEXT,
	message TEXT NOT NULL,
	recommended_action TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	resolved_at INTEGER NOT NULL DEFAULT (unixepoch()),
	resolution_note TEXT,
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE,
	FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alerts_history_type ON alerts_history(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_history_source ON alerts_history(source_id);
CREATE INDEX IF NOT EXISTS idx_alerts_history_resolved ON alerts_history(resolved_at);

-- Metrics aggregation table for per-source statistics
CREATE TABLE IF NOT EXISTS source_metrics_5min (
	metric_id TEXT PRIMARY KEY,
	source_id TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	window_end INTEGER NOT NULL,
	total_runs INTEGER NOT NULL DEFAULT 0,
	success_count INTEGER NOT NULL DEFAULT 0,
	failure_count INTEGER NOT NULL DEFAULT 0,
	normalized_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	avg_processing_ms INTEGER,
	p50_latency_ms INTEGER,
	p95_latency_ms INTEGER,
	p99_latency_ms INTEGER,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metrics_source_window ON source_metrics_5min(source_id, window_start);
CREATE INDEX IF NOT EXISTS idx_metrics_window ON source_metrics_5min(window_start);

-- Daily metrics rollup
CREATE TABLE IF NOT EXISTS source_metrics_daily (
	metric_id TEXT PRIMARY KEY,
	source_id TEXT NOT NULL,
	date TEXT NOT NULL, -- YYYY-MM-DD
	total_runs INTEGER NOT NULL DEFAULT 0,
	success_count INTEGER NOT NULL DEFAULT 0,
	failure_count INTEGER NOT NULL DEFAULT 0,
	normalized_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	avg_processing_ms INTEGER,
	p50_latency_ms INTEGER,
	p95_latency_ms INTEGER,
	p99_latency_ms INTEGER,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE,
	UNIQUE(source_id, date)
);

CREATE INDEX IF NOT EXISTS idx_metrics_daily_source_date ON source_metrics_daily(source_id, date);
