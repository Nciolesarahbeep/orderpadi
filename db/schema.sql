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
  logo_url                    TEXT,          -- profile picture: "/p/<profile_pictures.public_id>", or NULL
  bank_name                   TEXT,          -- shown on invoices so buyers can transfer
  bank_account_name           TEXT,
  bank_account_number         TEXT,
  delivery_note               TEXT,          -- e.g. "Delivery within Ondo: ₦1,500"
  default_delivery_fee_kobo   BIGINT NOT NULL DEFAULT 0 CHECK (default_delivery_fee_kobo >= 0),
  store_theme                 TEXT NOT NULL DEFAULT 'green'   -- colour of the store and invoices (added in the redesign)
                              CHECK (store_theme IN ('green', 'coral', 'sun', 'sky', 'grape', 'night')),
  delivery_zones              JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{id, name, feeKobo}] delivery areas
  quick_replies               JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{id, title, body}] saved WhatsApp messages
  away_message                TEXT,                               -- shown on the store while away

  -- directory listing at /stores
  bio                         TEXT,          -- a line about the store, up to 160 characters
  store_category              TEXT,          -- one of the directory categories (lib/directory.js)
  state                       TEXT,          -- Nigerian state, or FCT
  city                        TEXT,
  in_directory                BOOLEAN NOT NULL DEFAULT FALSE,

  -- referrals: both sellers get a free Pro month after the new one's first store order
  referral_code               TEXT,          -- like ADA4K7, made the first time it's needed
  referred_by                 BIGINT REFERENCES vendors(id) ON DELETE SET NULL,
  referral_rewarded_at        TIMESTAMPTZ,

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
CREATE INDEX vendors_directory ON vendors (store_category, state) WHERE in_directory;
CREATE UNIQUE INDEX vendors_referral_code ON vendors (referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX vendors_referred_by ON vendors (referred_by) WHERE referred_by IS NOT NULL;


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
  image_url    TEXT,                          -- unused; photos live in product_photos
  category     TEXT,                          -- e.g. "Wigs"; groups products on the store page
  options      JSONB NOT NULL DEFAULT '[]'::jsonb  -- up to 2 options like Size/Colour, see lib/catalog.js
               CONSTRAINT products_options_is_array CHECK (jsonb_typeof(options) = 'array'),
  stock        INTEGER CONSTRAINT products_stock_check CHECK (stock IS NULL OR stock >= 0),  -- NULL: not counted
  -- reselling: what other sellers pay to resell it (NULL: not for resale), and
  -- for a reseller's copy, the supplier's product it comes from
  resell_price_kobo  BIGINT CONSTRAINT products_resell_price_check CHECK (resell_price_kobo IS NULL OR resell_price_kobo > 0),
  is_resale    BOOLEAN NOT NULL DEFAULT FALSE,
  source_product_id  BIGINT REFERENCES products(id) ON DELETE SET NULL,
  cost_kobo    BIGINT CONSTRAINT products_cost_check CHECK (cost_kobo IS NULL OR cost_kobo >= 0),  -- what one costs the seller (for profit)
  is_active    BOOLEAN NOT NULL DEFAULT TRUE, -- archive instead of delete
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_vendor ON products (vendor_id, is_active, sort_order);
CREATE INDEX products_vendor_category ON products (vendor_id, category);
CREATE INDEX products_source ON products (source_product_id) WHERE source_product_id IS NOT NULL;
CREATE INDEX products_resellable ON products (created_at DESC) WHERE resell_price_kobo IS NOT NULL AND is_active;

-- How many are left of one choice (like size 42); only counted choices have a row.
CREATE TABLE choice_stock (
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  choice_id   TEXT NOT NULL,
  qty         INTEGER NOT NULL CONSTRAINT choice_stock_qty_check CHECK (qty >= 0),
  PRIMARY KEY (product_id, choice_id)
);

-- Product photos (added in the redesign), shrunk on the seller's phone before
-- upload. Served at /p/<public_id>; a replaced photo gets a new public_id.
CREATE TABLE product_photos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(8), 'hex'),
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  position    SMALLINT NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 9),  -- 0 is the cover
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 400000),
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_photos_product ON product_photos (product_id, position, id);
CREATE INDEX product_photos_vendor ON product_photos (vendor_id);

-- The seller's profile picture, cropped to a square on their phone (640 x 640).
-- Also served at /p/<public_id>; vendors.logo_url holds that address.
CREATE TABLE profile_pictures (
  vendor_id   BIGINT PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  public_id   TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(8), 'hex'),
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 400000),
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 4. CUSTOMERS — buyers never log in; one row per phone per vendor
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,                  -- normalised to 234XXXXXXXXXX
  address     TEXT,
  notes       TEXT,                           -- the seller's own notes
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- labels like "VIP" or "Wholesale"
  no_broadcast BOOLEAN NOT NULL DEFAULT FALSE,    -- asked not to get messages sent to many customers
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
  delivery_zone            TEXT,              -- the delivery area picked, if the seller has areas
  promo_code               TEXT,              -- the promo code used, if any (discount_kobo has the amount)
  stock_state              TEXT NOT NULL DEFAULT 'none',  -- 'taken' once stock came off, 'returned' after a cancel

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
  option_text      TEXT,              -- the picked options, e.g. "22 inches, Black"
  option_ids       JSONB,             -- the picked choice ids, to put stock back on cancel
  unit_price_kobo  BIGINT NOT NULL CHECK (unit_price_kobo >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  line_total_kobo  BIGINT NOT NULL CHECK (line_total_kobo >= 0),
  stock_product_id    BIGINT,         -- whose stock it took: the supplier's product for resold items
  supplier_vendor_id  BIGINT REFERENCES vendors(id) ON DELETE SET NULL,
  unit_cost_kobo      BIGINT          -- what one item cost the seller (for resold items, what they owe the supplier)
);
CREATE INDEX order_items_order ON order_items (order_id);

-- What a supplier sends for one of a reseller's orders. The supplier sees the
-- customer's delivery details through the order.
CREATE TABLE supply_orders (
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
CREATE INDEX supply_orders_supplier ON supply_orders (supplier_vendor_id, created_at DESC);
CREATE INDEX supply_orders_reseller ON supply_orders (reseller_vendor_id, created_at DESC);

-- Everything that happened to an order: placed, status, payments, notes...
CREATE TABLE order_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order ON order_events (order_id, created_at, id);


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


-- One review per order, left by the customer from their invoice link once
-- the order is paid or delivered. The seller can reply; only an admin can hide one.
CREATE TABLE reviews (
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
CREATE INDEX reviews_vendor ON reviews (vendor_id, created_at DESC);

-- Promo codes: a percentage or a naira amount off the items (not delivery).
-- The check on uses stops a code going past its limit even when two
-- customers use the last one at the same moment.
CREATE TABLE promo_codes (
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
  pushed_at   TIMESTAMPTZ,       -- sent to the seller's phones as an alert
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
-- 9b. ALERTS, MESSAGES AND EXPENSES (Round 4)
-- ---------------------------------------------------------------------
-- Phone alerts (web push). A row only gets alerts while the login it was
-- saved with is still live, so logging out stops them.
CREATE TABLE push_subscriptions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id     BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  session_jti   TEXT,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  device        TEXT,
  failures      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at  TIMESTAMPTZ
);
CREATE INDEX push_subscriptions_vendor ON push_subscriptions (vendor_id);

-- Keys the server signs push messages with, made the first time they're needed.
CREATE TABLE app_keys (
  name        TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Tell me when it's back" requests on sold-out products.
CREATE TABLE stock_alerts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id    BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  product_id   BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  choice_text  TEXT,
  created_ip   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at  TIMESTAMPTZ,
  UNIQUE (product_id, phone)
);
CREATE INDEX stock_alerts_waiting ON stock_alerts (vendor_id, product_id) WHERE notified_at IS NULL;

-- One message sent to many customers, one WhatsApp chat at a time.
CREATE TABLE broadcasts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id       BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'restock')),
  product_id      BIGINT REFERENCES products(id) ON DELETE SET NULL,
  audience        TEXT NOT NULL,
  audience_label  TEXT NOT NULL,
  message         TEXT NOT NULL,
  recipients      JSONB NOT NULL,   -- [{ customerId?, alertId?, name, phone, owingKobo?, choice?, sent }]
  total           INT NOT NULL CHECK (total >= 0),
  sent_count      INT NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX broadcasts_vendor ON broadcasts (vendor_id, created_at DESC);

-- Money the seller spends running the business.
CREATE TABLE expenses (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id    BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  amount_kobo  BIGINT NOT NULL CHECK (amount_kobo > 0),
  category     TEXT NOT NULL,
  note         TEXT,
  spent_on     DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_vendor ON expenses (vendor_id, spent_on DESC, id DESC);


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
