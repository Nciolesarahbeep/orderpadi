// Product photos and store colours.
// Photos are shrunk on the seller's phone (about 900px, JPEG) before upload,
// stored in Postgres, and served at /p/<publicId> with a year-long cache.
// Free plan: 1 photo per product. Pro: up to 3.
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { isPro } = require('./plan');

const PHOTO_LIMIT = { free: 1, pro: 3 };
const MAX_PHOTO_BYTES = 350000; // the phone aims for well under this

const STORE_THEMES = {
  green: { hex: '#12B76A', ink: '#1B1530' },
  coral: { hex: '#FF8A7A', ink: '#1B1530' },
  sun: { hex: '#FFD23F', ink: '#1B1530' },
  sky: { hex: '#6CCFF6', ink: '#1B1530' },
  grape: { hex: '#6A4CE0', ink: '#FFFFFF' },
  night: { hex: '#1B1530', ink: '#FFFFFF' }
};

function themeOf(vendor) {
  const id = vendor && vendor.store_theme;
  return Object.prototype.hasOwnProperty.call(STORE_THEMES, id) ? id : 'green';
}

function photoLimit(vendor) {
  return isPro(vendor) ? PHOTO_LIMIT.pro : PHOTO_LIMIT.free;
}

function photoUrl(publicId) {
  return `/p/${publicId}`;
}

function isPhotoId(value) {
  return /^[0-9a-f]{16}$/.test(String(value || ''));
}

// Accepts "data:image/jpeg;base64,..." or bare base64. Checks the file really
// is a JPEG or WebP picture and not too big.
function readImage(input) {
  const text = String(input || '').trim();
  const match = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(text);
  const b64 = (match ? match[2] : text).replace(/\s+/g, '');
  if (!b64 || b64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new HttpError(400, "That photo didn't upload properly. Try again.");
  }
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new HttpError(413, 'That photo is too big. Try another one, or a screenshot of it.');
  }
  let mime = null;
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
  else if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  if (!mime) throw new HttpError(415, 'Photos must be JPEG or WebP pictures.');
  return { mime, size: bytes.length, b64: bytes.toString('base64') };
}

// { productId: [{ id, url }] } for one seller, cover first.
async function photosByProduct(vendorId) {
  const rows = await sql`
    SELECT public_id, product_id FROM product_photos
    WHERE vendor_id = ${vendorId}
    ORDER BY product_id, position, id
  `;
  const map = new Map();
  for (const r of rows) {
    const key = Number(r.product_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: r.public_id, url: photoUrl(r.public_id) });
  }
  return map;
}

// Puts positions back to 0, 1, 2... with an optional photo moved to the front.
async function renumber(productId, coverPublicId = '') {
  await sql`
    UPDATE product_photos ph SET position = r.rn - 1
    FROM (
      SELECT id, row_number() OVER (ORDER BY (public_id = ${coverPublicId}) DESC, position, id) AS rn
      FROM product_photos WHERE product_id = ${productId}
    ) r
    WHERE ph.id = r.id AND ph.position <> r.rn - 1
  `;
}

async function addPhoto(vendor, productId, image) {
  const { mime, size, b64 } = readImage(image);
  const limit = photoLimit(vendor);
  const rows = await sql`
    WITH p AS (
      SELECT id FROM products WHERE id = ${productId} AND vendor_id = ${vendor.id}
    ), n AS (
      SELECT count(*) AS c, coalesce(max(position) + 1, 0) AS next
      FROM product_photos WHERE product_id = ${productId}
    )
    INSERT INTO product_photos (product_id, vendor_id, position, mime, size_bytes, data)
    SELECT p.id, ${vendor.id}, least(n.next, 9), ${mime}, ${size}, decode(${b64}, 'base64')
    FROM p, n
    WHERE n.c < ${limit}
    RETURNING public_id
  `;
  if (rows.length) return rows[0].public_id;
  const [product] = await sql`SELECT id FROM products WHERE id = ${productId} AND vendor_id = ${vendor.id}`;
  if (!product) throw new HttpError(404, "That product doesn't exist or was deleted.");
  throw new HttpError(400, limit === PHOTO_LIMIT.free
    ? 'The free plan has 1 photo per product. Go Pro to add up to 3.'
    : `A product can have up to ${limit} photos. Remove one first.`, { photoLimit: limit });
}

async function removePhoto(vendor, publicId) {
  if (!isPhotoId(publicId)) throw new HttpError(400, 'Which photo? The id is missing.');
  const rows = await sql`
    DELETE FROM product_photos WHERE public_id = ${publicId} AND vendor_id = ${vendor.id}
    RETURNING product_id
  `;
  if (!rows.length) throw new HttpError(404, 'That photo was already removed.');
  const productId = Number(rows[0].product_id);
  await renumber(productId);
  return productId;
}

async function makeCover(vendor, publicId) {
  if (!isPhotoId(publicId)) throw new HttpError(400, 'Which photo? The id is missing.');
  const rows = await sql`
    SELECT product_id FROM product_photos WHERE public_id = ${publicId} AND vendor_id = ${vendor.id}
  `;
  if (!rows.length) throw new HttpError(404, 'That photo was removed.');
  const productId = Number(rows[0].product_id);
  await renumber(productId, publicId);
  return productId;
}

// The picture itself, for /p/<publicId>. Nothing for suspended stores.
async function loadPhoto(publicId) {
  if (!isPhotoId(publicId)) return null;
  const rows = await sql`
    SELECT ph.mime, encode(ph.data, 'base64') AS b64
    FROM product_photos ph JOIN vendors v ON v.id = ph.vendor_id
    WHERE ph.public_id = ${publicId} AND v.is_suspended = FALSE
    LIMIT 1
  `;
  if (!rows.length) return null;
  return { mime: rows[0].mime, bytes: Buffer.from(rows[0].b64, 'base64') };
}

module.exports = {
  PHOTO_LIMIT,
  MAX_PHOTO_BYTES,
  STORE_THEMES,
  themeOf,
  photoLimit,
  photoUrl,
  isPhotoId,
  readImage,
  photosByProduct,
  addPhoto,
  removePhoto,
  makeCover,
  loadPhoto
};
