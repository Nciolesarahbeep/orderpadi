// The logged-in vendor's products.
//   GET    /api/products                                 -> { products, photoLimit }
//   POST   /api/products { name, price, description?, category?, options?, stock? }   -> { product }
//   PATCH  /api/products { id, name?, price?, description?, isActive?, category?, options?, stock? } -> { product }
// options: up to 2, like [{ name: "Size", choices: [{ id?, label, extra?, soldOut?, stock? }] }]
// where extra is what that choice adds to the price, in naira (lib/catalog.js).
// stock: how many are left ("" or null = not counted). Orders take from it;
// cancelling an order puts it back.
//   POST   /api/products { action: "stock", id, choiceId?, add?: n | stock?: n|null } -> { product }
//          add changes the count by n (never below 0); stock sets it (null stops counting)
//   DELETE /api/products { id }                          -> { ok }
// Photos (shrunk on the phone first; see lib/photos.js):
//   POST   /api/products { action: "add-photo", id, image: "data:image/jpeg;base64,..." } -> { product }
//   POST   /api/products { action: "remove-photo", photo }  -> { product }
//   POST   /api/products { action: "cover-photo", photo }   -> { product }   makes it the first photo
// Prices come in as naira ("4500", "₦4,500.50") and are stored as kobo.
// Deleting is safe for old orders: they keep their own copy of name and price.
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { cleanText, nairaToKobo } = require('../lib/format');
const { photoLimit, photosByProduct, addPhoto, removePhoto, makeCover } = require('../lib/photos');
const { readOptions, optionsOf, splitStock, readStock, readCategory, stockRowsFor, saveChoiceStock } = require('../lib/catalog');

const MAX_PRODUCTS = 200;

function productForClient(p, photos = [], stockRows = []) {
  return {
    id: Number(p.id),
    name: p.name,
    description: p.description || '',
    priceKobo: Number(p.price_kobo),
    isActive: !!p.is_active,
    category: p.category || '',
    options: optionsOf(p, stockRows),
    stock: p.stock == null ? null : Number(p.stock),
    photos,
    createdAt: p.created_at
  };
}

async function withPhotos(vendor, row) {
  const [photos, stock] = await Promise.all([photosByProduct(vendor.id), stockRowsFor(sql, [row.id])]);
  return productForClient(row, photos.get(Number(row.id)) || [], stock.get(Number(row.id)) || []);
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

// "wigs" becomes "Wigs" if the seller already has a "Wigs" category.
async function matchCategory(vendor, category) {
  if (!category) return null;
  const [same] = await sql`
    SELECT category FROM products
    WHERE vendor_id = ${vendor.id} AND lower(category) = lower(${category})
    LIMIT 1
  `;
  return same ? same.category : category;
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
  const [photos, stock] = await Promise.all([photosByProduct(vendor.id), stockRowsFor(sql, rows.map((p) => p.id))]);
  return {
    products: rows.map((p) => productForClient(p, photos.get(Number(p.id)) || [], stock.get(Number(p.id)) || [])),
    photoLimit: photoLimit(vendor)
  };
}

async function create(vendor, body) {
  const name = readName(body);
  const priceKobo = readPrice(body);
  const description = readDescription(body);
  const { saved: options, rows: choiceStock } = splitStock(readOptions(body.options));
  const stock = readStock(body.stock);
  const category = await matchCategory(vendor, readCategory(body.category));
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM products WHERE vendor_id = ${vendor.id}`;
  if (Number(n) >= MAX_PRODUCTS) {
    throw new HttpError(400, `You can have up to ${MAX_PRODUCTS} products. Delete some you no longer sell.`);
  }
  const [row] = await sql`
    INSERT INTO products (vendor_id, name, description, price_kobo, category, options, stock)
    VALUES (${vendor.id}, ${name}, ${description}, ${priceKobo}, ${category}, ${JSON.stringify(options)}::jsonb, ${stock})
    RETURNING *
  `;
  if (choiceStock.length) await saveChoiceStock(sql, row.id, choiceStock);
  return { product: await withPhotos(vendor, row) };
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
  const split = has('options') ? splitStock(readOptions(body.options)) : null;
  const options = split ? split.saved : splitStock(optionsOf(current)).saved;
  const stock = has('stock') ? readStock(body.stock) : current.stock;
  const category = has('category') ? await matchCategory(vendor, readCategory(body.category)) : current.category;

  const [row] = await sql`
    UPDATE products SET
      name = ${name}, price_kobo = ${priceKobo}, description = ${description},
      is_active = ${isActive}, category = ${category}, options = ${JSON.stringify(options)}::jsonb,
      stock = ${stock}, updated_at = now()
    WHERE id = ${id} AND vendor_id = ${vendor.id}
    RETURNING *
  `;
  if (split) await saveChoiceStock(sql, id, split.rows);
  return { product: await withPhotos(vendor, row) };
}

// Quick changes from the Stock screen: +1 / -1, or a new count.
async function stockAction(req, vendor, body) {
  const id = readId(req, body);
  const [current] = await sql`SELECT * FROM products WHERE id = ${id} AND vendor_id = ${vendor.id} LIMIT 1`;
  if (!current) throw new HttpError(404, "That product doesn't exist or was deleted.");
  const hasAdd = body.add != null && body.add !== '';
  const add = hasAdd ? Number(body.add) : 0;
  if (hasAdd && (!Number.isInteger(add) || Math.abs(add) > 100000)) throw new HttpError(400, 'Change the count by a whole number.', { field: 'stock' });
  const set = hasAdd ? null : readStock(body.stock);

  if (body.choiceId != null && body.choiceId !== '') {
    const choiceId = String(body.choiceId);
    const known = optionsOf(current).some((g) => g.choices.some((c) => c.id === choiceId));
    if (!known) throw new HttpError(404, 'That choice was removed. Reload and try again.');
    if (hasAdd) {
      await sql`
        INSERT INTO choice_stock (product_id, choice_id, qty) VALUES (${id}, ${choiceId}, ${Math.max(0, add)})
        ON CONFLICT (product_id, choice_id) DO UPDATE SET qty = GREATEST(0, choice_stock.qty + ${add})
      `;
    } else if (set === null) {
      await sql`DELETE FROM choice_stock WHERE product_id = ${id} AND choice_id = ${choiceId}`;
    } else {
      await sql`
        INSERT INTO choice_stock (product_id, choice_id, qty) VALUES (${id}, ${choiceId}, ${set})
        ON CONFLICT (product_id, choice_id) DO UPDATE SET qty = EXCLUDED.qty
      `;
    }
  } else if (hasAdd) {
    await sql`UPDATE products SET stock = GREATEST(0, coalesce(stock, 0) + ${add}), updated_at = now() WHERE id = ${id} AND vendor_id = ${vendor.id}`;
  } else {
    await sql`UPDATE products SET stock = ${set}, updated_at = now() WHERE id = ${id} AND vendor_id = ${vendor.id}`;
  }
  const [row] = await sql`SELECT * FROM products WHERE id = ${id} AND vendor_id = ${vendor.id}`;
  return { product: await withPhotos(vendor, row) };
}

async function photoAction(req, vendor, body) {
  let productId;
  if (body.action === 'add-photo') {
    productId = readId(req, body);
    await addPhoto(vendor, productId, body.image);
  } else if (body.action === 'remove-photo') {
    productId = await removePhoto(vendor, String(body.photo || ''));
  } else {
    productId = await makeCover(vendor, String(body.photo || ''));
  }
  const [row] = await sql`SELECT * FROM products WHERE id = ${productId} AND vendor_id = ${vendor.id}`;
  if (!row) throw new HttpError(404, "That product doesn't exist or was deleted.");
  return { product: await withPhotos(vendor, row), photoLimit: photoLimit(vendor) };
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
    if (req.method === 'POST' && body.action === 'stock') return res.status(200).json(await stockAction(req, vendor, body));
    if (req.method === 'POST' && ['add-photo', 'remove-photo', 'cover-photo'].includes(body.action)) {
      return res.status(200).json(await photoAction(req, vendor, body));
    }
    if (req.method === 'POST') return res.status(201).json(await create(vendor, body));
    if (req.method === 'PATCH') return res.status(200).json(await update(req, vendor, body));
    return res.status(200).json(await remove(req, vendor, body));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Products error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
