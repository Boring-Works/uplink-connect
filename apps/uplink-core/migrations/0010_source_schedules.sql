-- Source schedules for dynamic cron-based triggering
CREATE TABLE IF NOT EXISTS source_schedules (
	schedule_id TEXT PRIMARY KEY,
	source_id TEXT NOT NULL,
	cron_expression TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	label TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (source_id) REFERENCES source_configs(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_source_schedules_source ON source_schedules(source_id);
CREATE INDEX IF NOT EXISTS idx_source_schedules_enabled ON source_schedules(enabled);
