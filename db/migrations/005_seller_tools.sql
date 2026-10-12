-- Seller tools: stock counts, delivery areas, order history, customer notes,
-- quick replies and away mode. Run once in the Neon SQL Editor.
-- Only adds things; nothing existing is changed or removed. Safe to run more than once.

-- How many are left. NULL means the seller doesn't count this product.
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_stock_check CHECK (stock IS NULL OR stock >= 0);
  END IF;
END $$;

-- How many are left of one choice (like size 42). Only counted choices have a row.
-- The checks stop an order going through if it would take more than is left.
CREATE TABLE IF NOT EXISTS choice_stock (
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  choice_id   TEXT NOT NULL,
  qty         INTEGER NOT NULL CONSTRAINT choice_stock_qty_check CHECK (qty >= 0),
  PRIMARY KEY (product_id, choice_id)
);

-- The picked choice ids, so stock can be put back if the order is cancelled.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS option_ids JSONB;
-- 'none' for older orders, 'taken' once stock came off, 'returned' after a cancel put it back.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_state TEXT NOT NULL DEFAULT 'none';

-- Delivery areas with their own fees: [{ "id", "name", "feeKobo" }].
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS delivery_zones JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone TEXT;

-- Saved WhatsApp messages: [{ "id", "title", "body" }].
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS quick_replies JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Shown on the store while the seller is away (orders still come in).
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS away_message TEXT;

-- The seller's own notes and labels for a customer.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Everything that happened to an order, newest last: placed, status changes,
-- payments, "customer says paid", invoice sent, and the seller's own notes.
CREATE TABLE IF NOT EXISTS order_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events (order_id, created_at, id);
