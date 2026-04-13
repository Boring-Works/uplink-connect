-- Platform settings and audit logging
CREATE TABLE IF NOT EXISTS platform_settings (
	settings_key TEXT PRIMARY KEY,
	settings_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
	audit_id TEXT PRIMARY KEY,
	action TEXT NOT NULL,
	actor TEXT,
	resource_type TEXT NOT NULL,
	resource_id TEXT,
	details_json TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
