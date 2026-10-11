-- Product options and categories. Run once in the Neon SQL Editor.
-- Only adds things; nothing existing is changed or removed. Safe to run more than once.

-- A product's category, like "Wigs" or "Hair care". Empty means no category.
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;

-- Up to 2 options per product, like Size or Colour, each with its choices:
-- [{ "name": "Size", "choices": [{ "id": "k3j9a2xq", "label": "22 inches",
--    "extraKobo": 500000, "soldOut": false }] }]
-- A choice's price is the product price plus its extraKobo.
ALTER TABLE products ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_options_is_array') THEN
    ALTER TABLE products ADD CONSTRAINT products_options_is_array CHECK (jsonb_typeof(options) = 'array');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS products_vendor_category ON products (vendor_id, category);

-- What the customer picked, kept with the order like the name and price:
-- "22 inches, Black". Shown after the product name on invoices.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS option_text TEXT;
