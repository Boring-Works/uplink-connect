-- Generated columns for faster JSON metadata queries
-- NOTE: D1 does not support ALTER TABLE ADD COLUMN with GENERATED STORED.
-- We use expression indexes on json_extract() instead.

-- source_type extracted from metadata_json for fast filtering
CREATE INDEX IF NOT EXISTS idx_source_type_extracted ON source_configs(json_extract(metadata_json, '$.sourceType')) WHERE deleted_at IS NULL;
