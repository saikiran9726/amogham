-- Migration 0020 Down: Revert PIN Lockout Tracking
ALTER TABLE users DROP COLUMN IF EXISTS pin_locked_until;
ALTER TABLE users DROP COLUMN IF EXISTS pin_failed_attempts;
