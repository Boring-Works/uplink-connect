-- Generated columns for faster JSON metadata queries
-- These replace runtime json_extract() calls with indexed, stored columns

-- source_type extracted from metadata_json for fast filtering
ALTER TABLE source_configs ADD COLUMN source_type_generated TEXT
  GENERATED ALWAYS AS (json_extract(metadata_json, '$.sourceType')) STORED;

CREATE INDEX IF NOT EXISTS idx_source_type_generated ON source_configs(source_type_generated)
  WHERE deleted_at IS NULL;
