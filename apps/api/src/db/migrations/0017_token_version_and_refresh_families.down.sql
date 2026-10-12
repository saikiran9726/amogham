DROP INDEX IF EXISTS idx_refresh_tokens_expires_at;
DROP INDEX IF EXISTS idx_refresh_tokens_family_id;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS last_used_at;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS replaced_by;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS family_id;
ALTER TABLE users DROP COLUMN IF EXISTS token_version;
