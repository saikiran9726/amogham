-- Migration 0021 Up: Dedicated Login Throttle Table
CREATE TABLE IF NOT EXISTS login_throttle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  blocked_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT login_throttle_user_id_ip_unique UNIQUE (user_id, ip)
);

CREATE INDEX IF NOT EXISTS login_throttle_user_id_ip_idx ON login_throttle (user_id, ip);
CREATE INDEX IF NOT EXISTS login_throttle_blocked_until_idx ON login_throttle (blocked_until);
