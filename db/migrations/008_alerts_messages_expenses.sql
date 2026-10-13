-- Round 4: phone alerts, messaging customers, back-in-stock requests,
-- expenses and cost prices.
-- Run once in the Neon SQL Editor. Only adds things; safe to run more than once.

-- Phone alerts (web push). One row per phone or browser that turned alerts on.
-- A row only gets alerts while the login it was saved with is still live,
-- so logging out (or "log out everywhere") stops them.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id     BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  session_jti   TEXT,                      -- the login (user_sessions.jti) that turned it on
  endpoint      TEXT NOT NULL UNIQUE,      -- the push service address for this phone
  p256dh        TEXT NOT NULL,             -- the phone's public key (base64url)
  auth          TEXT NOT NULL,             -- the phone's auth secret (base64url)
  device        TEXT,                      -- "iPhone", "Android", "Computer"
  failures      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_vendor ON push_subscriptions (vendor_id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMPTZ;  -- sent to the seller's phones

-- Keys the server signs push messages with, made the first time they're
-- needed (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Netlify win if set).
CREATE TABLE IF NOT EXISTS app_keys (
  name        TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customers who asked not to get messages sent to many customers at once.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS no_broadcast BOOLEAN NOT NULL DEFAULT FALSE;

-- "Tell me when it's back": a customer's request on a sold-out product.
CREATE TABLE IF NOT EXISTS stock_alerts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id    BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,              -- normalised to 234XXXXXXXXXX
  choice_text  TEXT,                       -- the sold-out choice they want, like "Size: L"
  created_ip   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at  TIMESTAMPTZ,                -- the seller messaged them that it's back
  UNIQUE (product_id, phone)
);
CREATE INDEX IF NOT EXISTS stock_alerts_waiting ON stock_alerts (vendor_id, product_id) WHERE notified_at IS NULL;

-- One message sent to many customers, one WhatsApp chat at a time.
-- recipients: [{ customerId?, alertId?, name, phone, owingKobo?, choice?, sent }]
CREATE TABLE IF NOT EXISTS broadcasts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id       BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'restock')),
  product_id      BIGINT REFERENCES products(id) ON DELETE SET NULL,   -- for "it's back" messages
  audience        TEXT NOT NULL,           -- all | recent | quiet | owing | tag:<label> | restock
  audience_label  TEXT NOT NULL,
  message         TEXT NOT NULL,
  recipients      JSONB NOT NULL,
  total           INT NOT NULL CHECK (total >= 0),
  sent_count      INT NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS broadcasts_vendor ON broadcasts (vendor_id, created_at DESC);

-- What one of a product costs the seller, for profit. On an order line,
-- unit_cost_kobo (added in 007 for resold items) now holds the cost of
-- every item whose cost is known.
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_kobo BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_cost_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_cost_check CHECK (cost_kobo IS NULL OR cost_kobo >= 0);
  END IF;
END $$;

-- Money the seller spends running the business.
CREATE TABLE IF NOT EXISTS expenses (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id    BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount_kobo  BIGINT NOT NULL CHECK (amount_kobo > 0),
  category     TEXT NOT NULL,
  note         TEXT,
  spent_on     DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_vendor ON expenses (vendor_id, spent_on DESC, id DESC);
