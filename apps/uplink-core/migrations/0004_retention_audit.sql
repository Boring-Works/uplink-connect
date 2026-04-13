PRAGMA foreign_keys = ON;

-- Audit log for retention actions (idempotent, append-only)
CREATE TABLE IF NOT EXISTS retention_audit_log (
	log_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('archived', 'artifact_deleted', 'artifact_delete_failed', 'observations_deleted')),
	details_json TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_retention_audit_run ON retention_audit_log(run_id);
CREATE INDEX IF NOT EXISTS idx_retention_audit_action ON retention_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_retention_audit_created ON retention_audit_log(created_at);
