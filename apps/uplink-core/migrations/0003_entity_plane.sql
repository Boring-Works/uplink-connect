PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entities_current (
	entity_id TEXT PRIMARY KEY,
	source_id TEXT NOT NULL,
	source_type TEXT NOT NULL,
	external_id TEXT,
	content_hash TEXT NOT NULL,
	canonical_json TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_observed_at TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_entities_source ON entities_current(source_id);
CREATE INDEX IF NOT EXISTS idx_entities_external ON entities_current(source_id, external_id);
CREATE INDEX IF NOT EXISTS idx_entities_last_observed ON entities_current(last_observed_at);

CREATE TABLE IF NOT EXISTS entity_observations (
	observation_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id) ON DELETE CASCADE,
	FOREIGN KEY (entity_id) REFERENCES entities_current(entity_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_observations_run ON entity_observations(run_id);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON entity_observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_observations_source ON entity_observations(source_id);

CREATE TABLE IF NOT EXISTS entity_links (
	link_id TEXT PRIMARY KEY,
	from_entity_id TEXT NOT NULL,
	to_entity_id TEXT NOT NULL,
	relationship_type TEXT NOT NULL,
	confidence REAL,
	source_run_id TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (from_entity_id) REFERENCES entities_current(entity_id) ON DELETE CASCADE,
	FOREIGN KEY (to_entity_id) REFERENCES entities_current(entity_id) ON DELETE CASCADE,
	FOREIGN KEY (source_run_id) REFERENCES ingest_runs(run_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_links_from ON entity_links(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_to ON entity_links(to_entity_id);
