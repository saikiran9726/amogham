-- Migration 0019 Up: Explicit is_sample flags and performance composite indexes

-- 1. Explicit is_sample boolean on categories and items
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT false;

-- Backfill is_sample from "(sample)" naming pattern
UPDATE menu_categories SET is_sample = true WHERE name ILIKE '%(sample)%';
UPDATE menu_items SET is_sample = true WHERE category_id IN (SELECT id FROM menu_categories WHERE is_sample = true) OR name ILIKE '%(sample)%';

-- 2. Trigram extension and search index on bill_number
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_bills_bill_number_trgm ON bills USING gin (bill_number gin_trgm_ops);

-- 3. Keyset pagination and composite list indexes on bills
CREATE INDEX IF NOT EXISTS idx_bills_keyset ON bills (restaurant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_bills_restaurant_bdate_status ON bills (restaurant_id, business_date, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_bills_created_by ON bills (restaurant_id, created_by, created_at DESC, id DESC);

-- 4. Composite indexes for high-frequency report and item queries
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill_id ON bill_lines (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_item_id ON bill_lines (item_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill_item ON bill_lines (bill_id, item_id);
CREATE INDEX IF NOT EXISTS idx_order_items_item_id ON order_items (item_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_line ON order_items (order_id, line_no);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status_created ON orders (restaurant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_table_status ON orders (table_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_restaurant_created ON payments (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_bill_status ON payments (bill_id, status);
