// The customer-facing side of a store. No login: anyone with the link.
//   GET  /api/public?store=<slug>  -> { store, products }
//   POST /api/public { action: "order", store, items: [{ productId, quantity }],
//                      customer: { name, phone, address }, note }
//                    -> { order, store }   (store here includes bank details)
//
// Prices always come from the database, never from the browser. The order,
// its items, the customer record and the seller's notification are written
// in one SQL statement, so an order is either saved completely or not at all.
const { sql } = require('../lib/db');
const { HttpError, getClientIp } = require('../lib/auth');
const { cleanSlug, cleanText, normalizeNgPhone, formatNaira } = require('../lib/format');

const MAX_LINES = 50;
const MAX_QUANTITY = 99;
const ORDERS_PER_IP = 5;
const ORDER_WINDOW_MINUTES = 10;

async function findStore(rawSlug) {
  const slug = cleanSlug(rawSlug);
  if (!slug) return null;
  const rows = await sql`
    SELECT * FROM vendors
    WHERE slug = ${slug} AND email_verified = TRUE AND is_suspended = FALSE
    LIMIT 1
  `;
  return rows[0] || null;
}

function storeForCustomer(v, { withBank = false } = {}) {
  const store = {
    businessName: v.business_name,
    slug: v.slug,
    whatsappPhone: v.whatsapp_phone || null,
    deliveryFeeKobo: Number(v.default_delivery_fee_kobo || 0),
    deliveryNote: v.delivery_note || null,
    branded: v.plan !== 'pro'
  };
  if (withBank) {
    store.bank = v.bank_name && v.bank_account_number && v.bank_account_name
      ? { name: v.bank_name, accountNumber: v.bank_account_number, accountName: v.bank_account_name }
      : null;
  }
  return store;
}

async function getStore(req, res) {
  const slug = new URL(req.url || '/', 'http://x').searchParams.get('store');
  const vendor = await findStore(slug);
  if (!vendor) throw new HttpError(404, "This store doesn't exist. Check the link with the seller.");
  const products = await sql`
    SELECT id, name, description, price_kobo FROM products
    WHERE vendor_id = ${vendor.id} AND is_active = TRUE
    ORDER BY sort_order, created_at, id
  `;
  return res.status(200).json({
    store: storeForCustomer(vendor),
    products: products.map((p) => ({
      id: Number(p.id),
      name: p.name,
      description: p.description || '',
      priceKobo: Number(p.price_kobo)
    }))
  });
}

// Merges repeated product ids and checks quantities.
function readCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Your order is empty. Add something first.');
  const merged = new Map();
  for (const item of items) {
    const id = Number(item && item.productId);
    const qty = Number(item && item.quantity);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Something in your order is not a product from this store.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      throw new HttpError(400, `Quantities must be between 1 and ${MAX_QUANTITY}.`);
    }
    merged.set(id, Math.min(MAX_QUANTITY, (merged.get(id) || 0) + qty));
  }
  if (merged.size > MAX_LINES) throw new HttpError(400, `An order can have up to ${MAX_LINES} different products.`);
  return merged;
}

function readCustomer(body) {
  const c = body.customer && typeof body.customer === 'object' ? body.customer : {};
  const name = cleanText(c.name);
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Enter your name.', { field: 'name' });
  const phone = normalizeNgPhone(c.phone);
  if (!phone) throw new HttpError(400, 'Enter your phone number, like 0803 123 4567.', { field: 'phone' });
  const address = cleanText(c.address);
  if (address.length > 300) throw new HttpError(400, 'Keep the address under 300 characters.', { field: 'address' });
  const note = cleanText(body.note);
  if (note.length > 300) throw new HttpError(400, 'Keep the note under 300 characters.', { field: 'note' });
  return { name, phone, address: address || null, note: note || null };
}

async function placeOrder(req, res, body) {
  const vendor = await findStore(body.store);
  if (!vendor) throw new HttpError(404, "This store doesn't exist. Check the link with the seller.");
  const cart = readCart(body.items);
  const customer = readCustomer(body);
  const ip = getClientIp(req);

  const [recent] = await sql`
    SELECT count(*)::int AS n FROM orders
    WHERE created_ip = ${ip} AND created_at > now() - make_interval(mins => ${ORDER_WINDOW_MINUTES})
  `;
  if (Number(recent.n) >= ORDERS_PER_IP) {
    throw new HttpError(429, 'Too many orders from this phone in the last few minutes. Wait a little, or message the seller on WhatsApp.');
  }

  // Current prices from the database, only for this seller's live products.
  const ids = JSON.stringify([...cart.keys()]);
  const rows = await sql`
    SELECT id, name, price_kobo FROM products
    WHERE vendor_id = ${vendor.id} AND is_active = TRUE
      AND id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::bigint)
  `;
  const found = new Map(rows.map((r) => [Number(r.id), r]));
  const unavailable = [...cart.keys()].filter((id) => !found.has(id));
  if (unavailable.length) {
    throw new HttpError(409, 'Some items are no longer available, so we removed them. Check your order and try again.', { unavailable });
  }

  const lines = [...cart.entries()].map(([id, quantity]) => {
    const p = found.get(id);
    const unit = Number(p.price_kobo);
    return { product_id: id, name: p.name, unit_price_kobo: unit, quantity, line_total_kobo: unit * quantity };
  });
  const subtotal = lines.reduce((sum, l) => sum + l.line_total_kobo, 0);
  const deliveryFee = Number(vendor.default_delivery_fee_kobo || 0);
  const total = subtotal + deliveryFee;

  const [order] = await sql`
    WITH seq AS (
      UPDATE vendors SET order_seq = order_seq + 1
      WHERE id = ${vendor.id}
      RETURNING id, order_seq
    ),
    cust AS (
      INSERT INTO customers (vendor_id, name, phone, address)
      VALUES (${vendor.id}, ${customer.name}, ${customer.phone}, ${customer.address})
      ON CONFLICT (vendor_id, phone) DO UPDATE
        SET name = EXCLUDED.name, address = COALESCE(EXCLUDED.address, customers.address)
      RETURNING id
    ),
    ord AS (
      INSERT INTO orders (
        vendor_id, customer_id, order_number, source, customer_name, customer_phone,
        delivery_address, note, subtotal_kobo, delivery_fee_kobo, total_kobo, created_ip
      )
      SELECT seq.id, cust.id, seq.order_seq, 'link', ${customer.name}, ${customer.phone},
             ${customer.address}, ${customer.note}, ${subtotal}, ${deliveryFee}, ${total}, ${ip}
      FROM seq, cust
      RETURNING id, order_number, public_id, created_at
    ),
    items AS (
      INSERT INTO order_items (order_id, product_id, name, unit_price_kobo, quantity, line_total_kobo)
      SELECT ord.id, i.product_id, i.name, i.unit_price_kobo, i.quantity, i.line_total_kobo
      FROM ord, jsonb_to_recordset(${JSON.stringify(lines)}::jsonb)
        AS i(product_id bigint, name text, unit_price_kobo bigint, quantity int, line_total_kobo bigint)
      RETURNING id
    ),
    alert AS (
      INSERT INTO notifications (vendor_id, type, message, order_id)
      SELECT ${vendor.id}, 'new_order',
             'New order #' || ord.order_number || ' from ' || ${customer.name} || ' · ' || ${formatNaira(total)},
             ord.id
      FROM ord
      RETURNING id
    )
    SELECT ord.order_number, ord.public_id, ord.created_at,
           (SELECT count(*) FROM items)::int AS item_count
    FROM ord
  `;
  if (!order) throw new Error('Order insert returned no row');

  return res.status(201).json({
    order: {
      number: Number(order.order_number),
      publicId: order.public_id,
      createdAt: order.created_at,
      items: lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPriceKobo: l.unit_price_kobo, lineTotalKobo: l.line_total_kobo })),
      subtotalKobo: subtotal,
      deliveryFeeKobo: deliveryFee,
      totalKobo: total,
      customer: { name: customer.name, address: customer.address },
      note: customer.note
    },
    store: storeForCustomer(vendor, { withBank: true })
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!sql) throw new HttpError(500, 'The store is not connected to its database yet.');
    if (req.method === 'GET') return await getStore(req, res);

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'order') return await placeOrder(req, res, body);
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Public store error:', err);
    return res.status(500).json({ error: "Something went wrong placing your order. Please try again, or message the seller on WhatsApp." });
  }
};
