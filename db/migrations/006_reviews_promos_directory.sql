-- Reviews and ratings, promo codes, and the store directory.
-- Run once in the Neon SQL Editor. Only adds things; safe to run more than once.

-- Store profile for the directory at /stores.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bio TEXT;             -- a line about the store, up to 160 characters
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS store_category TEXT;  -- one of the directory categories (lib/directory.js)
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS state TEXT;           -- Nigerian state, or FCT
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS in_directory BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS vendors_directory ON vendors (store_category, state) WHERE in_directory;

-- One review per order, left by the customer from their invoice link once
-- the order is paid or delivered. The seller can reply; only an admin can hide one.
CREATE TABLE IF NOT EXISTS reviews (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id      BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  order_id       BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  rating         SMALLINT NOT NULL CONSTRAINT reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  body           TEXT,
  customer_name  TEXT NOT NULL,   -- shown as "Tola A."
  reply          TEXT,
  replied_at     TIMESTAMPTZ,
  is_hidden      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_vendor ON reviews (vendor_id, created_at DESC);

-- Promo codes: a percentage or a naira amount off the items (not delivery).
-- The check on uses stops a code going past its limit even when two
-- customers use the last one at the same moment.
CREATE TABLE IF NOT EXISTS promo_codes (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id       BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  code            TEXT NOT NULL CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  kind            TEXT NOT NULL CHECK (kind IN ('percent', 'amount')),
  value           BIGINT NOT NULL CHECK (value > 0),       -- 1–90 for percent, kobo for amount
  min_order_kobo  BIGINT NOT NULL DEFAULT 0 CHECK (min_order_kobo >= 0),
  max_uses        INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses            INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, code),
  CONSTRAINT promo_codes_uses_check CHECK (uses >= 0 AND (max_uses IS NULL OR uses <= max_uses))
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT;   -- the code used, if any (discount_kobo has the amount)
