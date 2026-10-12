-- Migration 0016: Idempotency Hardening (Up)

-- 1. Drop global unique constraint on idempotency_key and the old single-column index
ALTER TABLE sync_commands DROP CONSTRAINT IF EXISTS sync_commands_idempotency_key_key;
DROP INDEX IF EXISTS idx_sync_commands_key;

-- 2. Add request_hash and status columns safely
ALTER TABLE sync_commands ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE sync_commands ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';

-- 3. Add composite unique constraint (restaurant_id, command_type, idempotency_key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_sync_commands_tenant_type_key'
  ) THEN
    ALTER TABLE sync_commands
      ADD CONSTRAINT uq_sync_commands_tenant_type_key
      UNIQUE (restaurant_id, command_type, idempotency_key);
  END IF;
END $$;

-- 4. Add index on created_at for fast retention pruning and chronological queries
CREATE INDEX IF NOT EXISTS idx_sync_commands_created_at ON sync_commands (created_at);
