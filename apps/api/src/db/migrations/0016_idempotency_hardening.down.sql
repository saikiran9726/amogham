-- Migration 0016: Idempotency Hardening (Down)

-- 1. Drop index on created_at
DROP INDEX IF EXISTS idx_sync_commands_created_at;

-- 2. Drop composite unique constraint
ALTER TABLE sync_commands DROP CONSTRAINT IF EXISTS uq_sync_commands_tenant_type_key;

-- 3. Drop columns
ALTER TABLE sync_commands DROP COLUMN IF EXISTS status;
ALTER TABLE sync_commands DROP COLUMN IF EXISTS request_hash;

-- 4. Restore original global unique constraint and single-column index
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sync_commands_idempotency_key_key'
  ) THEN
    ALTER TABLE sync_commands
      ADD CONSTRAINT sync_commands_idempotency_key_key
      UNIQUE (idempotency_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sync_commands_key ON sync_commands (idempotency_key);
