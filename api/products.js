// The logged-in vendor's products.
//   GET    /api/products                                 -> { products }
//   POST   /api/products { name, price, description? }   -> { product }
//   PATCH  /api/products { id, name?, price?, description?, isActive? } -> { product }
//   DELETE /api/products { id }                          -> { ok }
// Prices come in as naira ("4500", "₦4,500.50") and are stored as kobo.
// Deleting is safe for old orders: they keep their own copy of name and price.
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { cleanText, nairaToKobo } = require('../lib/format');

const MAX_PRODUCTS = 200;

function productForClient(p) {
  return {
    id: Number(p.id),
    name: p.name,
    description: p.description || '',
    priceKobo: Number(p.price_kobo),
    isActive: !!p.is_active,
    createdAt: p.created_at
  };
}

function readName(body) {
  const name = cleanText(body.name);
  if (name.length < 2 || name.length > 80) {
    throw new HttpError(400, 'Give the product a name (2 to 80 characters).', { field: 'name' });
  }
  return name;
}

function readPrice(body) {
  const kobo = nairaToKobo(body.price);
  if (kobo === null || kobo <= 0) {
    throw new HttpError(400, 'Enter the price in naira, like 4500.', { field: 'price' });
  }
  return kobo;
}

function readDescription(body) {
  const text = String(body.description == null ? '' : body.description).trim();
  if (text.length > 300) {
    throw new HttpError(400, 'Keep the description under 300 characters.', { field: 'description' });
  }
  return text || null;
}

function readId(req, body) {
  const fromQuery = new URL(req.url || '/', 'http://x').searchParams.get('id');
  const id = Number(body.id != null ? body.id : fromQuery);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which product? The id is missing.');
  return id;
}

async function list(vendor) {
  const rows = await sql`
    SELECT * FROM products
    WHERE vendor_id = ${vendor.id}
    ORDER BY is_active DESC, sort_order, created_at, id
  `;
  return { products: rows.map(productForClient) };
}

async function create(vendor, body) {
  const name = readName(body);
  const priceKobo = readPrice(body);
  const description = readDescription(body);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM products WHERE vendor_id = ${vendor.id}`;
  if (Number(n) >= MAX_PRODUCTS) {
    throw new HttpError(400, `You can have up to ${MAX_PRODUCTS} products. Delete some you no longer sell.`);
  }
  const [row] = await sql`
    INSERT INTO products (vendor_id, name, description, price_kobo)
    VALUES (${vendor.id}, ${name}, ${description}, ${priceKobo})
    RETURNING *
  `;
  return { product: productForClient(row) };
}

async function update(req, vendor, body) {
  const id = readId(req, body);
  const [current] = await sql`SELECT * FROM products WHERE id = ${id} AND vendor_id = ${vendor.id} LIMIT 1`;
  if (!current) throw new HttpError(404, "That product doesn't exist or was deleted.");

  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const name = has('name') ? readName(body) : current.name;
  const priceKobo = has('price') ? readPrice(body) : Number(current.price_kobo);
  const description = has('description') ? readDescription(body) : current.description;
  const isActive = has('isActive') ? body.isActive === true : !!current.is_active;

  const [row] = await sql`
    UPDATE products SET
      name = ${name}, price_kobo = ${priceKobo}, description = ${description},
      is_active = ${isActive}, updated_at = now()
    WHERE id = ${id} AND vendor_id = ${vendor.id}
    RETURNING *
  `;
  return { product: productForClient(row) };
}

async function remove(req, vendor, body) {
  const id = readId(req, body);
  const rows = await sql`DELETE FROM products WHERE id = ${id} AND vendor_id = ${vendor.id} RETURNING id`;
  if (!rows.length) throw new HttpError(404, "That product doesn't exist or was already deleted.");
  return { ok: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!sql) return res.status(500).json({ error: 'The database is not connected (DATABASE_URL is missing).' });
    const vendor = await getSessionVendor(req);
    if (!vendor) return res.status(401).json({ error: 'Not logged in.' });

    if (req.method === 'GET') return res.status(200).json(await list(vendor));

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (req.method === 'POST') return res.status(201).json(await create(vendor, body));
    if (req.method === 'PATCH') return res.status(200).json(await update(req, vendor, body));
    return res.status(200).json(await remove(req, vendor, body));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Products error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
