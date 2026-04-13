-- Add missing columns for soft delete and webhook security
-- (These were added to 0002_source_registry.sql but already-applied databases need them)
ALTER TABLE source_configs ADD COLUMN deleted_at INTEGER;
ALTER TABLE source_configs ADD COLUMN webhook_security_json TEXT;

-- Update status check constraint to include 'deleted'
-- SQLite doesn't support ALTER TABLE on constraints, so we use a workaround
-- The application will enforce the constraint

CREATE INDEX IF NOT EXISTS idx_source_configs_deleted_at ON source_configs(deleted_at) WHERE deleted_at IS NOT NULL;
