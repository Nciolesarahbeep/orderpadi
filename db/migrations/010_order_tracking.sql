-- Order tracking: a "Sent out" step with the rider's or the waybill's
-- details, a tracker on the customer's invoice page, and an "I've got it"
-- button there that marks the order delivered.
-- Run once in the Neon SQL Editor. Only adds things; safe to run more than once.

-- 1. A new step between processing and delivered.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('new', 'processing', 'sent', 'delivered', 'cancelled'));

-- 2. When each step happened (the tracker shows the dates), and how the
--    order is travelling. courier_kind 'rider' uses courier_name and
--    courier_phone; 'waybill' uses courier_name (the company or park) and
--    tracking_code (the waybill number).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_at        TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sent_at              TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at         TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_received_at TIMESTAMPTZ;  -- the customer tapped "I've got it"
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_kind         TEXT CHECK (courier_kind IN ('rider', 'waybill'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_name         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_phone        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_code        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS expected_on          DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_message     TEXT;           -- the seller's note to the customer

-- Orders marked processing or delivered before this update get their dates
-- from the order's history.
UPDATE orders o SET processing_at = e.at
FROM (SELECT order_id, max(created_at) AS at FROM order_events
      WHERE kind = 'status' AND message LIKE '%processing%' GROUP BY order_id) e
WHERE e.order_id = o.id AND o.processing_at IS NULL AND o.status IN ('processing', 'delivered');

UPDATE orders o SET delivered_at = e.at
FROM (SELECT order_id, max(created_at) AS at FROM order_events
      WHERE kind = 'status' AND message LIKE '%delivered%' GROUP BY order_id) e
WHERE e.order_id = o.id AND o.delivered_at IS NULL AND o.status = 'delivered';

-- 3. A photo of the waybill slip, one per order. The seller's phone shrinks
--    it (about 1000px, under 240 KB) before sending. Served at /p/<public_id>
--    like other photos, but never cached by the CDN, since it shows the
--    customer's name and phone number. Photos of orders finished more than
--    30 days ago are removed when the seller adds a new one.
CREATE TABLE IF NOT EXISTS waybill_photos (
  order_id    BIGINT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id   BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  public_id   TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(8), 'hex'),
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 400000),
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waybill_photos_vendor ON waybill_photos (vendor_id);
