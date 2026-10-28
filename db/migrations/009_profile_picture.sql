-- Profile pictures: one picture per seller, shown on their store, invoices,
-- the directory, link previews and their status pictures.
-- Run once in the Neon SQL Editor. Only adds things; safe to run more than once.

-- The picture itself. The seller's phone crops it to a square (640 x 640 JPEG,
-- usually 40 to 120 KB) before it is sent. Served at /p/<public_id>, like
-- product photos; a new picture gets a new public_id, so each address can be
-- cached forever.
CREATE TABLE IF NOT EXISTS profile_pictures (
  vendor_id   BIGINT PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  public_id   TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(8), 'hex'),
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 400000),
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- vendors.logo_url (there since the first version, never used until now) holds
-- the picture's address, "/p/<public_id>", so every page that loads a seller
-- already has it. Free for every seller, so the old "Pro only" note goes.
COMMENT ON COLUMN vendors.logo_url IS 'Profile picture address, /p/<profile_pictures.public_id>, or NULL';
