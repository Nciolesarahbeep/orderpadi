// The logged-in seller's orders, payments and notifications.
//   GET  /api/orders?filter=all|new|unpaid|delivered&before=<number> -> { orders, counts, unread, hasMore }
//   GET  /api/orders?id=<id>                    -> { order }   (items + payments)
//   GET  /api/orders?view=notifications         -> { notifications, unread }
//   GET  /api/orders?view=unread                -> { unread, latest }   (polled by the bell)
//   POST /api/orders { action: "create", customer, items, deliveryFee, discount, note } -> { order }
//   POST /api/orders { action: "status", id, status }                    -> { order }
//   POST /api/orders { action: "payment", id, amount, method, note }     -> { order }
//   POST /api/orders { action: "undo-payment", id, paymentId }           -> { order }
//   POST /api/orders { action: "notifications-read" }                    -> { unread: 0 }
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { cleanText, nairaToKobo, normalizeNgPhone, formatNaira } = require('../lib/format');
const { createOrder, orderSummary, orderDetail } = require('../lib/orders');

const PAGE_SIZE = 50;
const FILTERS = ['all', 'new', 'unpaid', 'delivered'];
const STATUSES = ['new', 'processing', 'delivered', 'cancelled'];
const METHODS = ['transfer', 'cash', 'pos', 'other'];

function readId(value, what = 'order') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Which ${what}? The id is missing.`);
  return id;
}

async function unreadCount(vendorId) {
  const [row] = await sql`SELECT count(*)::int AS n FROM notifications WHERE vendor_id = ${vendorId} AND read_at IS NULL`;
  return Number(row.n);
}

async function loadOrder(vendorId, id) {
  const [order] = await sql`SELECT * FROM orders WHERE id = ${id} AND vendor_id = ${vendorId} LIMIT 1`;
  if (!order) throw new HttpError(404, "That order doesn't exist.");
  const [items, payments] = await Promise.all([
    sql`SELECT * FROM order_items WHERE order_id = ${id} ORDER BY id`,
    sql`SELECT * FROM payments WHERE order_id = ${id} ORDER BY paid_at, id`
  ]);
  return orderDetail(order, items, payments);
}

async function list(vendor, params) {
  const filter = FILTERS.includes(params.get('filter')) ? params.get('filter') : 'all';
  const before = Math.max(0, Number(params.get('before')) || 0);
  const rows = await sql`
    SELECT o.*,
      (SELECT string_agg(i.quantity || ' × ' || i.name, ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items_summary
    FROM orders o
    WHERE o.vendor_id = ${vendor.id}
      AND (
        ${filter} = 'all'
        OR (${filter} = 'new' AND o.status = 'new')
        OR (${filter} = 'unpaid' AND o.payment_status <> 'paid' AND o.status <> 'cancelled')
        OR (${filter} = 'delivered' AND o.status = 'delivered')
      )
      AND (${before} = 0 OR o.order_number < ${before})
    ORDER BY o.order_number DESC
    LIMIT ${PAGE_SIZE + 1}
  `;
  const [counts] = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'new')::int AS new,
      count(*) FILTER (WHERE payment_status <> 'paid' AND status <> 'cancelled')::int AS unpaid,
      coalesce(sum(total_kobo - amount_paid_kobo) FILTER (WHERE payment_status <> 'paid' AND status <> 'cancelled'), 0)::bigint AS owing,
      count(*) FILTER (WHERE customer_marked_paid_at IS NOT NULL AND payment_status <> 'paid' AND status <> 'cancelled')::int AS says_paid
    FROM orders WHERE vendor_id = ${vendor.id}
  `;
  return {
    orders: rows.slice(0, PAGE_SIZE).map(orderSummary),
    hasMore: rows.length > PAGE_SIZE,
    counts: {
      total: Number(counts.total),
      new: Number(counts.new),
      unpaid: Number(counts.unpaid),
      owingKobo: Number(counts.owing),
      saysPaid: Number(counts.says_paid)
    },
    unread: await unreadCount(vendor.id)
  };
}

async function notifications(vendor) {
  const rows = await sql`
    SELECT id, type, message, order_id, read_at, created_at FROM notifications
    WHERE vendor_id = ${vendor.id}
    ORDER BY created_at DESC, id DESC
    LIMIT 30
  `;
  return {
    notifications: rows.map((n) => ({
      id: Number(n.id),
      type: n.type,
      message: n.message,
      orderId: n.order_id ? Number(n.order_id) : null,
      read: !!n.read_at,
      createdAt: n.created_at
    })),
    unread: await unreadCount(vendor.id)
  };
}

async function unread(vendor) {
  const [latest] = await sql`
    SELECT message, created_at FROM notifications
    WHERE vendor_id = ${vendor.id} AND read_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  return {
    unread: await unreadCount(vendor.id),
    latest: latest ? { message: latest.message, createdAt: latest.created_at } : null
  };
}

// A seller typing in an order for someone who ordered in their DMs.
async function create(vendor, body) {
  const c = body.customer && typeof body.customer === 'object' ? body.customer : {};
  const name = cleanText(c.name);
  if (name.length < 2 || name.length > 80) throw new HttpError(400, "Enter the customer's name.", { field: 'name' });
  const phone = normalizeNgPhone(c.phone);
  if (!phone) throw new HttpError(400, "Enter the customer's phone number, like 0803 123 4567.", { field: 'phone' });
  const address = cleanText(c.address);
  if (address.length > 300) throw new HttpError(400, 'Keep the address under 300 characters.', { field: 'address' });
  const note = cleanText(body.note);
  if (note.length > 300) throw new HttpError(400, 'Keep the note under 300 characters.', { field: 'note' });

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'Add at least one item.', { field: 'items' });
  if (items.length > 50) throw new HttpError(400, 'An order can have up to 50 lines.', { field: 'items' });

  const productIds = items.filter((i) => i && i.productId != null).map((i) => Number(i.productId));
  const products = productIds.length
    ? await sql`
        SELECT id, name, price_kobo FROM products
        WHERE vendor_id = ${vendor.id}
          AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(productIds)}::jsonb)::bigint)
      `
    : [];
  const byId = new Map(products.map((p) => [Number(p.id), p]));

  const lines = items.map((i) => {
    const quantity = Number(i && i.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new HttpError(400, 'Quantities must be between 1 and 99.', { field: 'items' });
    }
    if (i.productId != null) {
      const p = byId.get(Number(i.productId));
      if (!p) throw new HttpError(400, 'One of the products no longer exists. Remove it and try again.', { field: 'items' });
      return { product_id: Number(p.id), name: p.name, unit_price_kobo: Number(p.price_kobo), quantity };
    }
    const itemName = cleanText(i.name);
    if (itemName.length < 2 || itemName.length > 80) throw new HttpError(400, 'Give each custom item a name.', { field: 'items' });
    const price = nairaToKobo(i.price);
    if (price === null || price <= 0) throw new HttpError(400, `Enter a price for "${itemName}".`, { field: 'items' });
    return { product_id: null, name: itemName, unit_price_kobo: price, quantity };
  });

  const deliveryFee = body.deliveryFee === '' || body.deliveryFee == null ? 0 : nairaToKobo(body.deliveryFee);
  if (deliveryFee === null) throw new HttpError(400, 'Enter the delivery fee in naira, like 1500.', { field: 'deliveryFee' });
  const discount = body.discount === '' || body.discount == null ? 0 : nairaToKobo(body.discount);
  if (discount === null) throw new HttpError(400, 'Enter the discount in naira, like 500.', { field: 'discount' });
  const subtotal = lines.reduce((sum, l) => sum + l.unit_price_kobo * l.quantity, 0);
  if (discount >= subtotal + deliveryFee) {
    throw new HttpError(400, 'The discount must be less than the order total.', { field: 'discount' });
  }

  const created = await createOrder({
    vendorId: vendor.id,
    customer: { name, phone, address: address || null },
    lines,
    deliveryFeeKobo: deliveryFee,
    discountKobo: discount,
    note: note || null,
    source: 'manual',
    notify: false
  });
  return { order: await loadOrder(vendor.id, created.id) };
}

async function setStatus(vendor, body) {
  const id = readId(body.id);
  if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
  const rows = await sql`
    UPDATE orders SET status = ${body.status}, updated_at = now()
    WHERE id = ${id} AND vendor_id = ${vendor.id}
    RETURNING id
  `;
  if (!rows.length) throw new HttpError(404, "That order doesn't exist.");
  return { order: await loadOrder(vendor.id, id) };
}

async function recordPayment(vendor, body) {
  const id = readId(body.id);
  const amount = nairaToKobo(body.amount);
  if (amount === null || amount <= 0) throw new HttpError(400, 'Enter the amount paid in naira, like 45000.', { field: 'amount' });
  const method = METHODS.includes(body.method) ? body.method : 'transfer';
  const note = cleanText(body.note);
  if (note.length > 140) throw new HttpError(400, 'Keep the note under 140 characters.', { field: 'note' });

  const order = await loadOrder(vendor.id, id);
  if (order.status === 'cancelled') throw new HttpError(409, 'This order is cancelled. Change its status first to record a payment.');
  if (order.balanceKobo <= 0) throw new HttpError(409, 'This order is already fully paid.');
  if (amount > order.balanceKobo) {
    throw new HttpError(400, `That's more than the ${formatNaira(order.balanceKobo)} still owed.`, { field: 'amount' });
  }

  // Lock the order row, add the payment and update the paid amount together,
  // so two payments recorded at once can't push it past the total.
  const rows = await sql`
    WITH o AS (
      SELECT id FROM orders
      WHERE id = ${id} AND vendor_id = ${vendor.id} AND status <> 'cancelled'
        AND amount_paid_kobo + ${amount} <= total_kobo
      FOR UPDATE
    ),
    p AS (
      INSERT INTO payments (order_id, vendor_id, amount_kobo, method, note)
      SELECT o.id, ${vendor.id}, ${amount}, ${method}, ${note || null} FROM o
      RETURNING order_id, amount_kobo
    )
    UPDATE orders SET
      amount_paid_kobo = orders.amount_paid_kobo + p.amount_kobo,
      payment_status = CASE WHEN orders.amount_paid_kobo + p.amount_kobo >= orders.total_kobo THEN 'paid' ELSE 'part_paid' END,
      updated_at = now()
    FROM p
    WHERE orders.id = p.order_id
    RETURNING orders.id
  `;
  if (!rows.length) throw new HttpError(409, 'This order changed while you were recording the payment. Check it and try again.');
  return { order: await loadOrder(vendor.id, id) };
}

async function undoPayment(vendor, body) {
  const id = readId(body.id);
  const paymentId = readId(body.paymentId, 'payment');
  const rows = await sql`
    WITH d AS (
      DELETE FROM payments
      WHERE id = ${paymentId} AND order_id = ${id} AND vendor_id = ${vendor.id}
      RETURNING order_id, amount_kobo
    )
    UPDATE orders SET
      amount_paid_kobo = orders.amount_paid_kobo - d.amount_kobo,
      payment_status = CASE
        WHEN orders.amount_paid_kobo - d.amount_kobo <= 0 THEN 'unpaid'
        WHEN orders.amount_paid_kobo - d.amount_kobo >= orders.total_kobo THEN 'paid'
        ELSE 'part_paid' END,
      updated_at = now()
    FROM d
    WHERE orders.id = d.order_id
    RETURNING orders.id
  `;
  if (!rows.length) throw new HttpError(404, "That payment doesn't exist or was already removed.");
  return { order: await loadOrder(vendor.id, id) };
}

async function markNotificationsRead(vendor) {
  await sql`UPDATE notifications SET read_at = now() WHERE vendor_id = ${vendor.id} AND read_at IS NULL`;
  return { unread: 0 };
}

const ACTIONS = {
  create,
  status: setStatus,
  payment: recordPayment,
  'undo-payment': undoPayment,
  'notifications-read': markNotificationsRead
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!sql) return res.status(500).json({ error: 'The database is not connected (DATABASE_URL is missing).' });
    const vendor = await getSessionVendor(req);
    if (!vendor) return res.status(401).json({ error: 'Not logged in.' });

    if (req.method === 'GET') {
      const params = new URL(req.url || '/', 'http://x').searchParams;
      if (params.get('id')) return res.status(200).json({ order: await loadOrder(vendor.id, readId(params.get('id'))) });
      if (params.get('view') === 'notifications') return res.status(200).json(await notifications(vendor));
      if (params.get('view') === 'unread') return res.status(200).json(await unread(vendor));
      return res.status(200).json(await list(vendor, params));
    }

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const run = ACTIONS[body.action];
    if (!run) return res.status(400).json({ error: 'Unknown action.' });
    const result = await run(vendor, body);
    return res.status(body.action === 'create' ? 201 : 200).json(result);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Orders error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
