-- Referrals (invite a seller, both get a free Pro month after their first
-- store order) and reselling (sell another seller's product for a commission).
-- Run once in the Neon SQL Editor. Only adds things; safe to run more than once.

-- Referrals
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS referral_code TEXT;                 -- like ADA4K7, made the first time it's needed
CREATE UNIQUE INDEX IF NOT EXISTS vendors_referral_code ON vendors (referral_code) WHERE referral_code IS NOT NULL;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS referral_rewarded_at TIMESTAMPTZ;  -- when both got their free month
CREATE INDEX IF NOT EXISTS vendors_referred_by ON vendors (referred_by) WHERE referred_by IS NOT NULL;

-- Reselling. A supplier sets the price resellers pay (resell_price_kobo).
-- A reseller's copy points at the supplier's product; its stock, photos
-- and availability come from there, and its name and options are kept in step.
ALTER TABLE products ADD COLUMN IF NOT EXISTS resell_price_kobo BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_resell_price_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_resell_price_check CHECK (resell_price_kobo IS NULL OR resell_price_kobo > 0);
  END IF;
END $$;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_resale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS source_product_id BIGINT REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS products_source ON products (source_product_id) WHERE source_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_resellable ON products (created_at DESC) WHERE resell_price_kobo IS NOT NULL AND is_active;

-- On an order line: whose stock it took (the supplier's product for resold
-- items), which supplier sends it, and what the reseller owes them per item.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS stock_product_id BIGINT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS supplier_vendor_id BIGINT REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cost_kobo BIGINT;

-- What a supplier sends for one of a reseller's orders. The supplier sees the
-- customer's delivery details through the order.
CREATE TABLE IF NOT EXISTS supply_orders (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id            BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reseller_vendor_id  BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  supplier_vendor_id  BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  items               JSONB NOT NULL,          -- [{ name, optionText, quantity, unitCostKobo }]
  total_kobo          BIGINT NOT NULL CHECK (total_kobo >= 0),
  status              TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new', 'accepted', 'shipped', 'delivered', 'cancelled')),
  cancel_reason       TEXT,                    -- 'order_cancelled' when the reseller cancelled their order
  paid_at             TIMESTAMPTZ,             -- the supplier confirmed the reseller paid them
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, supplier_vendor_id)
);
CREATE INDEX IF NOT EXISTS supply_orders_supplier ON supply_orders (supplier_vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supply_orders_reseller ON supply_orders (reseller_vendor_id, created_at DESC);
