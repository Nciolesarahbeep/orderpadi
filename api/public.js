// The customer-facing side of a store. No login: anyone with the link.
//   GET  /api/public?store=<slug>  -> { store, products }
//   POST /api/public { action: "order", store, items: [{ productId, quantity }],
//                      customer: { name, phone, address }, note }
//                    -> { order, store }   (store here includes bank details)
//   GET  /api/public?invoice=<publicId>        -> { invoice, store }
//   POST /api/public { action: "paid", invoice } -> customer says they've paid
//   GET  /api/public?site=contact              -> { contact: { email, whatsapp } }
//   GET  /api/public?render=home|store|invoice -> the page itself, with link-preview tags
//
// Prices always come from the database, never from the browser. The order,
// its items, the customer record and the seller's notification are written
// in one SQL statement, so an order is either saved completely or not at all.
const { sql } = require('../lib/db');
const { HttpError, getClientIp } = require('../lib/auth');
const { cleanSlug, cleanText, normalizeNgPhone, formatNaira } = require('../lib/format');
const { createOrder, invoiceForCustomer } = require('../lib/orders');
const { isPro, usage, noteUsage } = require('../lib/plan');
const { renderPage } = require('../lib/pages');

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
    branded: !isPro(v)
  };
  if (withBank) {
    store.bank = v.bank_name && v.bank_account_number && v.bank_account_name
      ? { name: v.bank_name, accountNumber: v.bank_account_number, accountName: v.bank_account_name }
      : null;
  }
  return store;
}

async function getStore(req, res) {
  const slug = param(req, 'store');
  const vendor = await findStore(slug);
  if (!vendor) throw new HttpError(404, "This store doesn't exist. Check the link with the seller.");
  const products = await sql`
    SELECT id, name, description, price_kobo FROM products
    WHERE vendor_id = ${vendor.id} AND is_active = TRUE
    ORDER BY sort_order, created_at, id
  `;
  // On the free plan, after 20 orders this month the store takes orders on
  // WhatsApp only (the page builds the message; nothing is saved).
  const { capReached } = await usage(vendor);
  return res.status(200).json({
    store: { ...storeForCustomer(vendor), acceptingOrders: !capReached },
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

  if ((await usage(vendor)).capReached) {
    throw new HttpError(403, 'This store is taking orders on WhatsApp right now. Tap the button to send your order to the seller.', { capReached: true });
  }

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
    return { product_id: id, name: p.name, unit_price_kobo: Number(p.price_kobo), quantity };
  });

  const order = await createOrder({
    vendorId: vendor.id,
    customer,
    lines,
    deliveryFeeKobo: Number(vendor.default_delivery_fee_kobo || 0),
    note: customer.note,
    source: 'link',
    ip,
    notify: true
  });
  await noteUsage(vendor);

  const { id: internalId, ...publicOrder } = order; // customers don't need our row id
  return res.status(201).json({
    order: { ...publicOrder, customer: { name: customer.name, address: customer.address }, note: customer.note },
    store: storeForCustomer(vendor, { withBank: true })
  });
}

// The invoice (or receipt, once paid) a customer opens from /i/<publicId>.
async function loadInvoice(publicId) {
  const id = String(publicId || '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const rows = await sql`
    SELECT o.*, v.business_name, v.slug, v.whatsapp_phone, v.bank_name, v.bank_account_number,
           v.bank_account_name, v.default_delivery_fee_kobo, v.delivery_note, v.plan, v.plan_renews_at
    FROM orders o
    JOIN vendors v ON v.id = o.vendor_id
    WHERE o.public_id = ${id} AND v.is_suspended = FALSE
    LIMIT 1
  `;
  const order = rows[0];
  if (!order) return null;
  const [items, payments] = await Promise.all([
    sql`SELECT * FROM order_items WHERE order_id = ${order.id} ORDER BY id`,
    sql`SELECT amount_kobo, paid_at FROM payments WHERE order_id = ${order.id} ORDER BY paid_at, id`
  ]);
  const vendorShape = {
    business_name: order.business_name, slug: order.slug, whatsapp_phone: order.whatsapp_phone,
    bank_name: order.bank_name, bank_account_number: order.bank_account_number, bank_account_name: order.bank_account_name,
    default_delivery_fee_kobo: order.default_delivery_fee_kobo, delivery_note: order.delivery_note, plan: order.plan,
    plan_renews_at: order.plan_renews_at
  };
  return { order, items, payments, vendor: vendorShape };
}

async function getInvoice(publicId, res) {
  const found = await loadInvoice(publicId);
  if (!found) throw new HttpError(404, "This invoice doesn't exist. Check the link with the seller.");
  return res.status(200).json({
    invoice: invoiceForCustomer(found.order, found.items, found.payments),
    store: storeForCustomer(found.vendor, { withBank: true })
  });
}

// Customer taps "I've paid". Only the first tap notifies the seller.
async function markPaid(body, res) {
  const found = await loadInvoice(body.invoice);
  if (!found) throw new HttpError(404, "This invoice doesn't exist. Check the link with the seller.");
  const o = found.order;
  if (o.status === 'cancelled') throw new HttpError(409, 'This order was cancelled, so there is nothing to pay.');
  if (o.payment_status !== 'paid' && !o.customer_marked_paid_at) {
    const balance = Math.max(0, Number(o.total_kobo) - Number(o.amount_paid_kobo));
    await sql`
      WITH marked AS (
        UPDATE orders SET customer_marked_paid_at = now(), updated_at = now()
        WHERE id = ${o.id} AND customer_marked_paid_at IS NULL
        RETURNING id
      )
      INSERT INTO notifications (vendor_id, type, message, order_id)
      SELECT ${o.vendor_id}, 'payment_claimed',
             ${o.customer_name + ' says they paid ' + formatNaira(balance) + ' for order #' + o.order_number + '. Check your bank app, then mark it paid.'},
             id
      FROM marked
    `;
  }
  return getInvoice(body.invoice, res);
}

// Query values, whether the platform parsed them (req.query) or not.
function param(req, name) {
  if (req.query && typeof req.query[name] === 'string') return req.query[name];
  return new URL(req.url || '/', 'http://x').searchParams.get(name);
}

// How customers reach the business behind OrderPadi (SUPPORT_EMAIL and
// SUPPORT_WHATSAPP in Vercel). Shown on the home, terms and privacy pages.
function contact(res) {
  const email = String(process.env.SUPPORT_EMAIL || '').trim().toLowerCase();
  const whatsapp = normalizeNgPhone(process.env.SUPPORT_WHATSAPP || '');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  return res.status(200).json({
    contact: {
      email: /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email) ? email : null,
      whatsapp: whatsapp || null
    }
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method === 'GET') {
    // Pages with link previews: "/", "/s/<slug>", "/i/<id>" (see lib/pages.js).
    const render = param(req, 'render');
    if (render === 'home') return renderPage(req, res, 'home');
    if (render === 'store') return renderPage(req, res, 'store', param(req, 'slug'));
    if (render === 'invoice') return renderPage(req, res, 'invoice', param(req, 'id'));
    if (param(req, 'site') === 'contact') return contact(res);
  }

  try {
    if (!sql) throw new HttpError(500, 'The store is not connected to its database yet.');
    if (req.method === 'GET') {
      const invoice = param(req, 'invoice');
      return invoice !== null ? await getInvoice(invoice, res) : await getStore(req, res);
    }

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'order') return await placeOrder(req, res, body);
    if (body.action === 'paid') return await markPaid(body, res);
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Public store error:', err);
    return res.status(500).json({ error: "Something went wrong placing your order. Please try again, or message the seller on WhatsApp." });
  }
};
