-- Redesign database update. Run once in the Neon SQL Editor.
-- Adds product photos and a colour theme for each seller's store.
-- Only adds things; nothing existing is changed or removed. Safe to run more than once.

-- The colour customers see on the store and invoices.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS store_theme TEXT NOT NULL DEFAULT 'green';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendors_store_theme_check') THEN
    ALTER TABLE vendors ADD CONSTRAINT vendors_store_theme_check
      CHECK (store_theme IN ('green', 'coral', 'sun', 'sky', 'grape', 'night'));
  END IF;
END $$;

-- Product photos, shrunk on the seller's phone before upload (usually 50 to 150 KB).
-- Served at /p/<public_id>. A replaced photo gets a new public_id, so browsers
-- and Netlify can cache each one forever.
CREATE TABLE IF NOT EXISTS product_photos (
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
CREATE INDEX IF NOT EXISTS product_photos_product ON product_photos (product_id, position, id);
CREATE INDEX IF NOT EXISTS product_photos_vendor ON product_photos (vendor_id);
