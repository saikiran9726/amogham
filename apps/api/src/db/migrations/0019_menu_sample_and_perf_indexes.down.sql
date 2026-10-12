-- Migration 0019 Down: Drop is_sample columns and performance composite indexes

-- Drop composite indexes
DROP INDEX IF EXISTS idx_payments_bill_status;
DROP INDEX IF EXISTS idx_payments_restaurant_created;
DROP INDEX IF EXISTS idx_orders_table_status;
DROP INDEX IF EXISTS idx_orders_restaurant_status_created;
DROP INDEX IF EXISTS idx_order_items_order_line;
DROP INDEX IF EXISTS idx_order_items_item_id;
DROP INDEX IF EXISTS idx_bill_lines_bill_item;
DROP INDEX IF EXISTS idx_bill_lines_item_id;
DROP INDEX IF EXISTS idx_bill_lines_bill_id;
DROP INDEX IF EXISTS idx_bills_created_by;
DROP INDEX IF EXISTS idx_bills_restaurant_bdate_status;
DROP INDEX IF EXISTS idx_bills_keyset;
DROP INDEX IF EXISTS idx_bills_bill_number_trgm;

-- Drop is_sample columns
ALTER TABLE menu_items DROP COLUMN IF EXISTS is_sample;
ALTER TABLE menu_categories DROP COLUMN IF EXISTS is_sample;
