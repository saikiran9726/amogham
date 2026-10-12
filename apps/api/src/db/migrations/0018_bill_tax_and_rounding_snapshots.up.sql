ALTER TABLE bills ADD COLUMN IF NOT EXISTS tax_mode TEXT NOT NULL DEFAULT 'exclusive';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS service_charge_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS default_gst_rate_bp INT NOT NULL DEFAULT 500;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS round_off_enabled BOOLEAN NOT NULL DEFAULT true;

-- Backfill from restaurant_settings where available
UPDATE bills b
SET
  tax_mode = COALESCE(rs.tax_mode, 'exclusive'),
  service_charge_percent = COALESCE(rs.service_charge_percent, 0.00),
  default_gst_rate_bp = COALESCE(rs.default_gst_rate_bp, 500)
FROM restaurant_settings rs
WHERE b.restaurant_id = rs.restaurant_id;

-- Allow multiple loyalty transactions per bill for re-redemption and reversals while enforcing earn uniqueness
ALTER TABLE loyalty_transactions DROP CONSTRAINT IF EXISTS uq_loyalty_tx_bill_type;
CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_tx_bill_earn ON loyalty_transactions(bill_id) WHERE type = 'earn';
