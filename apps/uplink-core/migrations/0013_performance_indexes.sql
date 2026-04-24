-- Performance indexes for hot dashboard and monitoring queries

-- ingest_runs: heavily queried by created_at + status for dashboards
CREATE INDEX IF NOT EXISTS idx_ingest_runs_created_status ON ingest_runs(created_at, status);

-- ingest_errors: pending error lookups
CREATE INDEX IF NOT EXISTS idx_ingest_errors_status_created ON ingest_errors(status, created_at);

-- entities_current: source entity counts
CREATE INDEX IF NOT EXISTS idx_entities_source_observed ON entities_current(source_id, last_observed_at);

-- raw_artifacts: run lookups
CREATE INDEX IF NOT EXISTS idx_raw_artifacts_run ON raw_artifacts(run_id);
