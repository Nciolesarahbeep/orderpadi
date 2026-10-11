// The logged-in seller's orders, payments and notifications.
//   GET  /api/orders?filter=all|new|unpaid|delivered&before=<number> -> { orders, counts, unread, hasMore }
//   GET  /api/orders?id=<id>                    -> { order }   (items + payments)
//   GET  /api/orders?view=notifications         -> { notifications, unread }
//   GET  /api/orders?view=unread                -> { unread, latest }   (polled by the bell)
//   GET  /api/orders?view=stats                 -> today / week / month sales, owed, plan usage
//   GET  /api/orders?view=customers             -> customers with what they've paid and owe
//   GET  /api/orders?view=report                -> last 30 days by day + top products   (Pro)
//   GET  /api/orders?view=export                -> all orders as a CSV file              (Pro)
//   GET  /api/orders?customer=<id>              -> the list, for one customer
//   POST /api/orders { action: "create", customer, items, deliveryFee, discount, note } -> { order }
//   POST /api/orders { action: "status", id, status }                    -> { order }
//   POST /api/orders { action: "payment", id, amount, method, note }     -> { order }
//   POST /api/orders { action: "undo-payment", id, paymentId }           -> { order }
//   POST /api/orders { action: "notifications-read" }                    -> { unread: 0 }
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { cleanText, nairaToKobo, normalizeNgPhone, formatNaira } = require('../lib/format');
const { createOrder, orderSummary, orderDetail } = require('../lib/orders');
const { priceFor } = require('../lib/catalog');
const { isPro, usage, noteUsage, FREE_MONTHLY_ORDERS } = require('../lib/plan');

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
  const customerId = Math.max(0, Number(params.get('customer')) || 0);
  const rows = await sql`
    SELECT o.*,
      (SELECT string_agg(i.quantity || ' × ' || i.name || coalesce(' (' || i.option_text || ')', ''), ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items_summary
    FROM orders o
    WHERE o.vendor_id = ${vendor.id}
      AND (
        ${filter} = 'all'
        OR (${filter} = 'new' AND o.status = 'new')
        OR (${filter} = 'unpaid' AND o.payment_status <> 'paid' AND o.status <> 'cancelled')
        OR (${filter} = 'delivered' AND o.status = 'delivered')
      )
      AND (${before} = 0 OR o.order_number < ${before})
      AND (${customerId} = 0 OR o.customer_id = ${customerId})
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

// ---------- numbers ----------
// Day, week (from Monday) and month boundaries are in Lagos time. "Sales"
// is the value of orders placed (not cancelled); "received" is money recorded.
async function stats(vendor) {
  const [s] = await sql`
    WITH b AS (
      SELECT
        date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS today,
        date_trunc('week', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS week,
        date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS month
    )
    SELECT
      (SELECT count(*) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.created_at >= b.today)::int AS today_orders,
      (SELECT coalesce(sum(total_kobo), 0) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.created_at >= b.today)::bigint AS today_sales,
      (SELECT count(*) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.created_at >= b.week)::int AS week_orders,
      (SELECT coalesce(sum(total_kobo), 0) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.created_at >= b.week)::bigint AS week_sales,
      (SELECT count(*) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.created_at >= b.month)::int AS month_orders,
      (SELECT coalesce(sum(total_kobo), 0) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.created_at >= b.month)::bigint AS month_sales,
      (SELECT coalesce(sum(amount_kobo), 0) FROM payments p WHERE p.vendor_id = ${vendor.id} AND p.paid_at >= b.month)::bigint AS month_received,
      (SELECT coalesce(sum(total_kobo - amount_paid_kobo), 0) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.payment_status <> 'paid')::bigint AS owing
    FROM b
  `;
  return {
    today: { orders: Number(s.today_orders), salesKobo: Number(s.today_sales) },
    week: { orders: Number(s.week_orders), salesKobo: Number(s.week_sales) },
    month: { orders: Number(s.month_orders), salesKobo: Number(s.month_sales), receivedKobo: Number(s.month_received) },
    owingKobo: Number(s.owing),
    usage: await usage(vendor)
  };
}

async function customers(vendor) {
  const rows = await sql`
    SELECT customer_id, name, phone, order_count, total_paid_kobo, owing_kobo, last_order_at
    FROM customer_balances
    WHERE vendor_id = ${vendor.id}
    ORDER BY owing_kobo DESC, last_order_at DESC NULLS LAST
    LIMIT 200
  `;
  return {
    customers: rows.map((c) => ({
      id: Number(c.customer_id),
      name: c.name,
      phone: c.phone,
      orderCount: Number(c.order_count),
      totalPaidKobo: Number(c.total_paid_kobo),
      owingKobo: Number(c.owing_kobo),
      lastOrderAt: c.last_order_at
    }))
  };
}

function requirePro(vendor, what) {
  if (!isPro(vendor)) throw new HttpError(402, `${what} are part of Pro.`, { upgrade: true });
}

async function report(vendor) {
  requirePro(vendor, 'Sales reports');
  const days = await sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
           count(o.id)::int AS orders,
           coalesce(sum(o.total_kobo), 0)::bigint AS sales
    FROM generate_series(
      date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') - interval '29 days',
      date_trunc('day', now() AT TIME ZONE 'Africa/Lagos'),
      interval '1 day'
    ) AS d
    LEFT JOIN orders o
      ON o.vendor_id = ${vendor.id} AND o.status <> 'cancelled'
     AND date_trunc('day', o.created_at AT TIME ZONE 'Africa/Lagos') = d
    GROUP BY d
    ORDER BY d
  `;
  const top = await sql`
    SELECT i.name, sum(i.quantity)::int AS quantity, sum(i.line_total_kobo)::bigint AS sales
    FROM order_items i
    JOIN orders o ON o.id = i.order_id
    WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled'
      AND o.created_at >= now() - interval '30 days'
    GROUP BY i.name
    ORDER BY sales DESC, quantity DESC
    LIMIT 5
  `;
  const list = days.map((d) => ({ day: d.day, orders: Number(d.orders), salesKobo: Number(d.sales) }));
  return {
    days: list,
    totals: {
      orders: list.reduce((s, d) => s + d.orders, 0),
      salesKobo: list.reduce((s, d) => s + d.salesKobo, 0)
    },
    topProducts: top.map((t) => ({ name: t.name, quantity: Number(t.quantity), salesKobo: Number(t.sales) }))
  };
}

// CSV cells: quote everything, and stop spreadsheet apps treating a value
// that starts with = + - @ as a formula.
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

const CSV_LABELS = {
  unpaid: 'Unpaid', part_paid: 'Part paid', paid: 'Paid',
  new: 'New', processing: 'Processing', delivered: 'Delivered', cancelled: 'Cancelled',
  link: 'Store link', manual: 'Added by you'
};

async function exportCsv(vendor, res) {
  requirePro(vendor, 'Exports');
  const rows = await sql`
    SELECT o.*,
      to_char(o.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') AS placed,
      (SELECT string_agg(i.quantity || ' x ' || i.name || coalesce(' (' || i.option_text || ')', ''), '; ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items
    FROM orders o
    WHERE o.vendor_id = ${vendor.id}
    ORDER BY o.order_number DESC
    LIMIT 5000
  `;
  const naira = (k) => (Number(k) / 100).toFixed(2);
  // 2348031234567 -> 0803 123 4567 (spaces stop spreadsheets turning it into a number)
  const phone = (p) => (/^234\d{10}$/.test(p || '') ? `0${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : p || '');
  const header = ['Order', 'Date', 'Customer', 'Phone', 'Items', 'Total (NGN)', 'Paid (NGN)', 'Balance (NGN)', 'Payment', 'Status', 'Source', 'Address', 'Note'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((o) => {
    lines.push([
      o.order_number, o.placed, o.customer_name, phone(o.customer_phone), o.items || '',
      naira(o.total_kobo), naira(o.amount_paid_kobo), naira(Math.max(0, Number(o.total_kobo) - Number(o.amount_paid_kobo))),
      CSV_LABELS[o.payment_status] || o.payment_status, CSV_LABELS[o.status] || o.status,
      CSV_LABELS[o.source] || o.source, o.delivery_address || '', o.note || ''
    ].map(csvCell).join(','));
  });
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orderpadi-orders-${date}.csv"`);
  return res.status(200).send('﻿' + lines.join('\r\n'));
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
        SELECT id, name, price_kobo, options FROM products
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
      // The seller can sell a choice marked sold out (they know their stock).
      const priced = priceFor(p, i.options, { allowSoldOut: true });
      if (priced.problem) throw new HttpError(400, `Choose the ${priced.option.toLowerCase()} for ${p.name}.`, { field: 'items' });
      return { product_id: Number(p.id), name: p.name, option_text: priced.optionText, unit_price_kobo: priced.unitPriceKobo, quantity };
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

  if ((await usage(vendor)).capReached) {
    throw new HttpError(403, `You've used your ${FREE_MONTHLY_ORDERS} free orders this month. Upgrade to Pro for unlimited orders.`, { upgrade: true });
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
  await noteUsage(vendor);
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
      if (params.get('view') === 'stats') return res.status(200).json(await stats(vendor));
      if (params.get('view') === 'customers') return res.status(200).json(await customers(vendor));
      if (params.get('view') === 'report') return res.status(200).json(await report(vendor));
      if (params.get('view') === 'export') return await exportCsv(vendor, res);
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
