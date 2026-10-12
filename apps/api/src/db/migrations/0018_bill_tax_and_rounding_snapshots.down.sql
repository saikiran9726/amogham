DROP INDEX IF EXISTS uq_loyalty_tx_bill_earn;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_loyalty_tx_bill_type'
  ) THEN
    ALTER TABLE loyalty_transactions ADD CONSTRAINT uq_loyalty_tx_bill_type UNIQUE (bill_id, type);
  END IF;
END $$;

ALTER TABLE bills DROP COLUMN IF EXISTS round_off_enabled;
ALTER TABLE bills DROP COLUMN IF EXISTS default_gst_rate_bp;
ALTER TABLE bills DROP COLUMN IF EXISTS service_charge_percent;
ALTER TABLE bills DROP COLUMN IF EXISTS tax_mode;
