// Profile pictures: one per seller (product photos are in lib/photos.js).
// The seller's phone crops the picture to a square and shrinks it to a
// 640 x 640 JPEG before sending it (the editor in app.html), so the server
// only checks it really is a small JPEG or WebP picture.
// Stored in profile_pictures and served at /p/<publicId> with a year-long
// cache, like product photos. vendors.logo_url keeps that address, so every
// page that already loads the seller has it without another query.
// Free for every seller.
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { readImage, isPhotoId } = require('./photos');

const PICTURE_PATH = /^\/p\/[0-9a-f]{16}$/;
const MISSING_TABLE = '42P01'; // Postgres: the table doesn't exist (migration 009 not run yet)

// The picture's address for the browser ("/p/<id>"), or null.
// Only addresses written by setPicture() are passed on.
function pictureUrlOf(vendor) {
  const url = vendor && vendor.logo_url;
  return typeof url === 'string' && PICTURE_PATH.test(url) ? url : null;
}

function needsUpdate(err) {
  if (err && err.code === MISSING_TABLE) {
    return new HttpError(503, 'Profile pictures need a quick database update first. Run db/migrations/009_profile_picture.sql in the Neon SQL Editor.');
  }
  return err;
}

// Saves (or replaces) the seller's picture. Every new picture gets a new
// public id, so phones and the CDN never show the old one from their cache.
// Returns the updated vendor row.
async function setPicture(vendor, image) {
  const { mime, size, b64 } = readImage(image);
  try {
    const [row] = await sql`
      WITH saved AS (
        INSERT INTO profile_pictures (vendor_id, mime, size_bytes, data)
        VALUES (${vendor.id}, ${mime}, ${size}, decode(${b64}, 'base64'))
        ON CONFLICT (vendor_id) DO UPDATE SET
          public_id = encode(gen_random_bytes(8), 'hex'),
          mime = EXCLUDED.mime,
          size_bytes = EXCLUDED.size_bytes,
          data = EXCLUDED.data,
          created_at = now()
        RETURNING public_id
      )
      UPDATE vendors SET logo_url = '/p/' || (SELECT public_id FROM saved), updated_at = now()
      WHERE id = ${vendor.id}
      RETURNING *
    `;
    if (!row) throw new HttpError(404, 'Your account was not found. Log in again.');
    return row;
  } catch (err) {
    throw needsUpdate(err);
  }
}

// Takes the picture off; the store goes back to showing initials.
// Returns the updated vendor row.
async function removePicture(vendorId) {
  try {
    const [row] = await sql`
      WITH gone AS (DELETE FROM profile_pictures WHERE vendor_id = ${vendorId} RETURNING vendor_id)
      UPDATE vendors SET logo_url = NULL, updated_at = now()
      WHERE id = ${vendorId}
      RETURNING *
    `;
    return row || null;
  } catch (err) {
    if (err && err.code === MISSING_TABLE) {
      // Nothing can be stored before the update, so there is nothing to delete.
      const [row] = await sql`UPDATE vendors SET logo_url = NULL, updated_at = now() WHERE id = ${vendorId} RETURNING *`;
      return row || null;
    }
    throw err;
  }
}

// The picture itself, for /p/<publicId>. Nothing for suspended stores.
async function loadPicture(publicId) {
  if (!isPhotoId(publicId)) return null;
  try {
    const rows = await sql`
      SELECT pp.mime, encode(pp.data, 'base64') AS b64
      FROM profile_pictures pp JOIN vendors v ON v.id = pp.vendor_id
      WHERE pp.public_id = ${publicId} AND v.is_suspended = FALSE
      LIMIT 1
    `;
    if (!rows.length) return null;
    return { mime: rows[0].mime, bytes: Buffer.from(rows[0].b64, 'base64') };
  } catch (err) {
    if (err && err.code === MISSING_TABLE) return null;
    throw err;
  }
}

module.exports = { pictureUrlOf, setPicture, removePicture, loadPicture };
