-- =====================================================================
-- Vendor Order & Invoice Tool — v1 database schema (Neon Postgres)
--
-- HOW TO USE: create a NEW Neon project for this app (don't reuse the
-- Apex Horizon Bank database), open the SQL Editor, paste this whole
-- file, and press Run once.
--
-- RULES BAKED IN:
--   * All money is stored in KOBO as BIGINT (₦1 = 100 kobo). Never floats.
--   * Order items copy the product name + price at order time, so editing
--     a product never changes an old invoice.
--   * Prices on public orders must be recomputed on the server from the
--     products table — never trust prices sent by the browser.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_bytes() for invoice links


-- ---------------------------------------------------------------------
-- 1. VENDORS — the sellers who sign up (and pay)
-- ---------------------------------------------------------------------
CREATE TABLE vendors (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                       TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash               TEXT NOT NULL,
  email_verified              BOOLEAN NOT NULL DEFAULT FALSE,

  -- store profile
  business_name               TEXT NOT NULL,
  slug                        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),  -- store link: /s/<slug>
  whatsapp_phone              TEXT,          -- 234XXXXXXXXXX (no +), used for wa.me links
  logo_url                    TEXT,          -- Pro only
  bank_name                   TEXT,          -- shown on invoices so buyers can transfer
  bank_account_name           TEXT,
  bank_account_number         TEXT,
  delivery_note               TEXT,          -- e.g. "Delivery within Ondo: ₦1,500"
  default_delivery_fee_kobo   BIGINT NOT NULL DEFAULT 0 CHECK (default_delivery_fee_kobo >= 0),

  -- plan & billing
  plan                        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  plan_renews_at              TIMESTAMPTZ,   -- next Paystack charge date; revert to free after this if cancelled
  paystack_customer_code      TEXT,
  paystack_subscription_code  TEXT,

  -- per-vendor order counter: bump with
  --   UPDATE vendors SET order_seq = order_seq + 1 WHERE id = $1 RETURNING order_seq
  order_seq                   INTEGER NOT NULL DEFAULT 0,

  is_admin                    BOOLEAN NOT NULL DEFAULT FALSE,
  is_suspended                BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 2. AUTH SUPPORT — same patterns as Apex Horizon Bank
-- ---------------------------------------------------------------------
CREATE TABLE email_otps (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('signup', 'reset')),
  code_hash   TEXT NOT NULL,                 -- HMAC-SHA256 of the 6-digit code
  attempts    INTEGER NOT NULL DEFAULT 0,    -- lock out after 5 wrong tries
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  ip          TEXT,                          -- limits codes per device (added in step 2)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_otps_lookup ON email_otps (email, purpose, created_at DESC);
CREATE INDEX email_otps_ip ON email_otps (ip, created_at DESC);

CREATE TABLE user_sessions (
  jti         TEXT PRIMARY KEY,              -- JWT id, so sessions can be revoked
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX user_sessions_vendor ON user_sessions (vendor_id);

CREATE TABLE login_attempts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       TEXT,
  ip          TEXT,
  success     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email ON login_attempts (email, created_at DESC);
CREATE INDEX login_attempts_ip    ON login_attempts (ip, created_at DESC);


-- ---------------------------------------------------------------------
-- 3. PRODUCTS
-- ---------------------------------------------------------------------
CREATE TABLE products (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id    BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  price_kobo   BIGINT NOT NULL CHECK (price_kobo >= 0),
  image_url    TEXT,                          -- v1: optional pasted link; real uploads in v1.1
  is_active    BOOLEAN NOT NULL DEFAULT TRUE, -- archive instead of delete
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_vendor ON products (vendor_id, is_active, sort_order);


-- ---------------------------------------------------------------------
-- 4. CUSTOMERS — buyers never log in; one row per phone per vendor
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,                  -- normalised to 234XXXXXXXXXX
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, phone)
);


-- ---------------------------------------------------------------------
-- 5. ORDERS
-- ---------------------------------------------------------------------
CREATE TABLE orders (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id                BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  customer_id              BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  order_number             INTEGER NOT NULL,  -- per vendor: #1, #2, #3 …
  public_id                TEXT NOT NULL UNIQUE
                             DEFAULT encode(gen_random_bytes(8), 'hex'),  -- invoice link: /i/<public_id>
  source                   TEXT NOT NULL CHECK (source IN ('link', 'manual')),

  -- buyer details copied in at order time
  customer_name            TEXT NOT NULL,
  customer_phone           TEXT NOT NULL,
  delivery_address         TEXT,
  note                     TEXT,

  -- money (kobo). total = subtotal + delivery_fee - discount, computed on the server
  subtotal_kobo            BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_kobo >= 0),
  delivery_fee_kobo        BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_kobo >= 0),
  discount_kobo            BIGINT NOT NULL DEFAULT 0 CHECK (discount_kobo >= 0),
  total_kobo               BIGINT NOT NULL DEFAULT 0 CHECK (total_kobo >= 0),
  amount_paid_kobo         BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_kobo >= 0),

  payment_status           TEXT NOT NULL DEFAULT 'unpaid'
                             CHECK (payment_status IN ('unpaid', 'part_paid', 'paid')),
  status                   TEXT NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new', 'processing', 'delivered', 'cancelled')),
  customer_marked_paid_at  TIMESTAMPTZ,       -- buyer tapped "I've paid" on the invoice; vendor still confirms

  created_ip               TEXT,              -- rate-limits the public order form
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, order_number)
);
CREATE INDEX orders_vendor_recent ON orders (vendor_id, created_at DESC);
CREATE INDEX orders_vendor_owing  ON orders (vendor_id)
  WHERE payment_status <> 'paid' AND status <> 'cancelled';
CREATE INDEX orders_customer      ON orders (customer_id);
CREATE INDEX orders_ip_recent     ON orders (created_ip, created_at DESC);


-- ---------------------------------------------------------------------
-- 6. ORDER ITEMS — snapshot of name + price
-- ---------------------------------------------------------------------
CREATE TABLE order_items (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id         BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       BIGINT REFERENCES products(id) ON DELETE SET NULL,  -- NULL for custom manual lines
  name             TEXT NOT NULL,
  unit_price_kobo  BIGINT NOT NULL CHECK (unit_price_kobo >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  line_total_kobo  BIGINT NOT NULL CHECK (line_total_kobo >= 0)
);
CREATE INDEX order_items_order ON order_items (order_id);


-- ---------------------------------------------------------------------
-- 7. PAYMENTS — an order can be paid in parts (transfer, cash, POS)
--    After inserting, update orders.amount_paid_kobo and payment_status
--    in the same statement/transaction.
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id    BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount_kobo  BIGINT NOT NULL CHECK (amount_kobo > 0),
  method       TEXT NOT NULL DEFAULT 'transfer'
                 CHECK (method IN ('transfer', 'cash', 'pos', 'other')),
  note         TEXT,
  paid_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_order          ON payments (order_id);
CREATE INDEX payments_vendor_recent  ON payments (vendor_id, paid_at DESC);


-- ---------------------------------------------------------------------
-- 8. NOTIFICATIONS — bell icon with polling, like Apex Horizon Bank
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,     -- 'new_order', 'payment_claimed', 'plan_renewed', 'plan_ending', 'cap_reached'
  message     TEXT NOT NULL,
  order_id    BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread ON notifications (vendor_id, created_at DESC)
  WHERE read_at IS NULL;


-- ---------------------------------------------------------------------
-- 9. BILLING EVENTS — every Paystack webhook, stored once
--    dedupe_key: data.reference for charge events,
--                data.subscription_code for subscription events.
--    INSERT ... ON CONFLICT DO NOTHING, and only act if a row was inserted,
--    so Paystack's retries never double-upgrade anyone.
-- ---------------------------------------------------------------------
CREATE TABLE billing_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id    BIGINT REFERENCES vendors(id) ON DELETE SET NULL,
  event        TEXT NOT NULL,    -- 'charge.success', 'subscription.create', 'subscription.disable', …
  dedupe_key   TEXT NOT NULL,
  amount_kobo  BIGINT,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event, dedupe_key)
);


-- ---------------------------------------------------------------------
-- 10. HELPER VIEWS — fewer queries to write in the API
-- ---------------------------------------------------------------------

-- Orders created this calendar month (Lagos time) — enforces the free plan's 20-order cap.
CREATE VIEW vendor_month_usage AS
SELECT vendor_id,
       count(*) AS orders_this_month
FROM orders
WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')
GROUP BY vendor_id;

-- Who owes what: one row per customer with spend and outstanding balance.
CREATE VIEW customer_balances AS
SELECT c.id                                   AS customer_id,
       c.vendor_id,
       c.name,
       c.phone,
       count(o.id)                            AS order_count,
       coalesce(sum(o.amount_paid_kobo), 0)   AS total_paid_kobo,
       coalesce(sum(o.total_kobo - o.amount_paid_kobo)
                FILTER (WHERE o.payment_status <> 'paid'), 0) AS owing_kobo,
       max(o.created_at)                      AS last_order_at
FROM customers c
LEFT JOIN orders o
       ON o.customer_id = c.id
      AND o.status <> 'cancelled'
GROUP BY c.id;


-- ---------------------------------------------------------------------
-- AFTER YOU SIGN UP in your own app, make yourself admin (edit the email):
-- UPDATE vendors SET is_admin = TRUE WHERE email = 'you@example.com';
-- ---------------------------------------------------------------------
