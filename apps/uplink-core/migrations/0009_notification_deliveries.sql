-- Notification delivery tracking and alert history improvements
CREATE TABLE IF NOT EXISTS notification_deliveries (
	delivery_id TEXT PRIMARY KEY,
	alert_id TEXT NOT NULL,
	provider_type TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	provider_name TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'throttled')),
	sent_at INTEGER,
	error_message TEXT,
	retry_count INTEGER DEFAULT 0,
	response_body TEXT,
	created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_alert_id ON notification_deliveries(alert_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created_at ON notification_deliveries(created_at);

-- Alert history table (if not already created by alerting.ts)
CREATE TABLE IF NOT EXISTS alerts_history (
	alert_id TEXT PRIMARY KEY,
	alert_type TEXT NOT NULL,
	severity TEXT NOT NULL,
	source_id TEXT,
	run_id TEXT,
	message TEXT NOT NULL,
	recommended_action TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	resolved_at INTEGER,
	resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_history_source_id ON alerts_history(source_id);
CREATE INDEX IF NOT EXISTS idx_alerts_history_resolved_at ON alerts_history(resolved_at);
