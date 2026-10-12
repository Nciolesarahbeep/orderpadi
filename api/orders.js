// The logged-in seller's orders, customers, payments and notifications.
//   GET  /api/orders?filter=all|new|unpaid|delivered&before=<number>&q=<search> -> { orders, counts, unread, hasMore }
//        q finds a name, phone number, order number (#12) or item name
//   GET  /api/orders?id=<id>                    -> { order }   (items, payments, timeline)
//   GET  /api/orders?view=notifications         -> { notifications, unread }
//   GET  /api/orders?view=unread                -> { unread, latest }   (polled by the bell)
//   GET  /api/orders?view=stats                 -> today / week / month sales, owed, plan usage
//   GET  /api/orders?view=customers&q=&tag=&sort=owing|recent|top|name -> { customers, tags, total }
//   GET  /api/orders?view=customer&id=<id>      -> { customer, stats, favourites, orders }
//   GET  /api/orders?view=report                -> last 30 days by day + top products   (Pro)
//   GET  /api/orders?view=export                -> all orders as a CSV file              (Pro)
//   GET  /api/orders?customer=<id>              -> the list, for one customer
//   POST /api/orders { action: "create", customer, items, zone?, deliveryFee, discount, note } -> { order }
//   POST /api/orders { action: "status", id, status }                    -> { order }
//        cancelling puts counted stock back; restoring a cancelled order takes it again
//   POST /api/orders { action: "payment", id, amount, method, note }     -> { order }
//   POST /api/orders { action: "undo-payment", id, paymentId }           -> { order }
//   POST /api/orders { action: "note", id, message }                     -> { order }   a note in the order's history
//   POST /api/orders { action: "log", id, kind, title? }                 -> { order }
//        kind: invoice_sent | invoice_copied | quick_reply (title = the reply's title) | review_asked
//   POST /api/orders { action: "customer", id, name?, address?, notes?, tags? } -> customer page
//   POST /api/orders { action: "notifications-read" }                    -> { unread: 0 }
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { cleanText, nairaToKobo, normalizeNgPhone, formatNaira } = require('../lib/format');
const { createOrder, orderSummary, orderDetail, isStockError } = require('../lib/orders');
const { priceFor, lineKey, stockRowsFor, stockShortfalls } = require('../lib/catalog');
const { zonesOf } = require('../lib/storeSettings');
const { isPro, usage, noteUsage, FREE_MONTHLY_ORDERS } = require('../lib/plan');

const PAGE_SIZE = 50;
const FILTERS = ['all', 'new', 'unpaid', 'delivered'];
const STATUSES = ['new', 'processing', 'delivered', 'cancelled'];
const METHODS = ['transfer', 'cash', 'pos', 'other'];
const METHOD_TEXT = { transfer: 'bank transfer', cash: 'cash', pos: 'POS', other: 'other' };
const STATUS_TEXT = { new: 'Marked as new', processing: 'Marked as processing', delivered: 'Marked as delivered', cancelled: 'Order cancelled' };
const CUSTOMER_SORTS = ['owing', 'recent', 'top', 'name'];
const MAX_TAGS = 8;

function readId(value, what = 'order') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Which ${what}? The id is missing.`);
  return id;
}

// Text for ILIKE: "%" and "_" typed by the seller are matched as themselves.
const likeOf = (text) => (text ? '%' + text.replace(/[\\%_]/g, (m) => '\\' + m) + '%' : '');

// Phone digits typed in any form (0803…, 234803…, 803…) -> what to look for
// inside the saved 234XXXXXXXXXX. Needs at least 4 digits.
function phoneLikeOf(text) {
  let digits = String(text || '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits ? '%' + digits + '%' : '';
}

async function unreadCount(vendorId) {
  const [row] = await sql`SELECT count(*)::int AS n FROM notifications WHERE vendor_id = ${vendorId} AND read_at IS NULL`;
  return Number(row.n);
}

async function loadOrder(vendorId, id) {
  const [order] = await sql`SELECT * FROM orders WHERE id = ${id} AND vendor_id = ${vendorId} LIMIT 1`;
  if (!order) throw new HttpError(404, "That order doesn't exist.");
  const [items, payments, events, reviews] = await Promise.all([
    sql`SELECT * FROM order_items WHERE order_id = ${id} ORDER BY id`,
    sql`SELECT * FROM payments WHERE order_id = ${id} ORDER BY paid_at, id`,
    sql`SELECT kind, message, created_at FROM order_events WHERE order_id = ${id} ORDER BY created_at, id LIMIT 200`,
    sql`SELECT rating, body, reply, created_at FROM reviews WHERE order_id = ${id} LIMIT 1`
  ]);
  return orderDetail(order, items, payments, events, reviews[0] || null);
}

async function list(vendor, params) {
  const filter = FILTERS.includes(params.get('filter')) ? params.get('filter') : 'all';
  const before = Math.max(0, Number(params.get('before')) || 0);
  const customerId = Math.max(0, Number(params.get('customer')) || 0);
  const q = cleanText(params.get('q') || '').slice(0, 60);
  const like = likeOf(q);
  const phoneLike = phoneLikeOf(q);
  const number = /^#?\d{1,7}$/.test(q) ? Number(q.replace('#', '')) : 0;
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
      AND (
        ${q} = ''
        OR o.customer_name ILIKE ${like}
        OR (${phoneLike} <> '' AND o.customer_phone LIKE ${phoneLike})
        OR (${number} > 0 AND o.order_number = ${number})
        OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND (i.name ILIKE ${like} OR i.option_text ILIKE ${like}))
      )
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
      (SELECT coalesce(sum(total_kobo - amount_paid_kobo), 0) FROM orders o WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND o.payment_status <> 'paid')::bigint AS owing,
      (SELECT count(*) FROM products p WHERE p.vendor_id = ${vendor.id} AND p.is_active = TRUE AND p.stock IS NOT NULL AND p.stock <= 3)::int
        + (SELECT count(*) FROM choice_stock c JOIN products p ON p.id = c.product_id WHERE p.vendor_id = ${vendor.id} AND p.is_active = TRUE AND c.qty <= 3)::int AS low_stock
    FROM b
  `;
  return {
    today: { orders: Number(s.today_orders), salesKobo: Number(s.today_sales) },
    week: { orders: Number(s.week_orders), salesKobo: Number(s.week_sales) },
    month: { orders: Number(s.month_orders), salesKobo: Number(s.month_sales), receivedKobo: Number(s.month_received) },
    owingKobo: Number(s.owing),
    lowStock: Number(s.low_stock),
    usage: await usage(vendor)
  };
}

// ---------- customers ----------
const tagsOf = (raw) => (Array.isArray(raw) ? raw.map(String) : []);

async function customers(vendor, params) {
  const q = cleanText(params.get('q') || '').slice(0, 60);
  const like = likeOf(q);
  const phoneLike = phoneLikeOf(q);
  const tag = cleanText(params.get('tag') || '').slice(0, 20);
  const sort = CUSTOMER_SORTS.includes(params.get('sort')) ? params.get('sort') : 'owing';
  const [rows, tagRows, [count]] = await Promise.all([
    sql`
      SELECT b.customer_id, b.name, b.phone, b.order_count, b.total_paid_kobo, b.owing_kobo, b.last_order_at,
             c.tags, (c.notes IS NOT NULL AND c.notes <> '') AS has_notes
      FROM customer_balances b
      JOIN customers c ON c.id = b.customer_id
      WHERE b.vendor_id = ${vendor.id}
        AND (${q} = '' OR b.name ILIKE ${like} OR (${phoneLike} <> '' AND b.phone LIKE ${phoneLike}))
        AND (${tag} = '' OR c.tags @> jsonb_build_array(${tag}::text))
      ORDER BY
        CASE WHEN ${sort} = 'owing' THEN b.owing_kobo END DESC NULLS LAST,
        CASE WHEN ${sort} = 'top' THEN b.total_paid_kobo END DESC NULLS LAST,
        CASE WHEN ${sort} = 'name' THEN lower(b.name) END ASC,
        b.last_order_at DESC NULLS LAST, b.customer_id DESC
      LIMIT 200
    `,
    sql`
      SELECT t.tag, count(*)::int AS n
      FROM customers c, jsonb_array_elements_text(c.tags) AS t(tag)
      WHERE c.vendor_id = ${vendor.id}
      GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 30
    `,
    sql`SELECT count(*)::int AS n FROM customers WHERE vendor_id = ${vendor.id}`
  ]);
  return {
    customers: rows.map((c) => ({
      id: Number(c.customer_id),
      name: c.name,
      phone: c.phone,
      orderCount: Number(c.order_count),
      totalPaidKobo: Number(c.total_paid_kobo),
      owingKobo: Number(c.owing_kobo),
      lastOrderAt: c.last_order_at,
      tags: tagsOf(c.tags),
      hasNotes: !!c.has_notes
    })),
    tags: tagRows.map((t) => ({ tag: t.tag, count: Number(t.n) })),
    total: Number(count.n)
  };
}

// One customer: details, what they've spent, what they buy, their orders.
async function customerPage(vendor, id) {
  const [c] = await sql`
    SELECT c.id, c.name, c.phone, c.address, c.notes, c.tags, c.created_at,
           count(o.id)::int AS order_count,
           coalesce(sum(o.total_kobo), 0)::bigint AS spent,
           coalesce(sum(o.amount_paid_kobo), 0)::bigint AS paid,
           coalesce(sum(o.total_kobo - o.amount_paid_kobo) FILTER (WHERE o.payment_status <> 'paid'), 0)::bigint AS owing,
           min(o.created_at) AS first_at, max(o.created_at) AS last_at
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
    WHERE c.id = ${id} AND c.vendor_id = ${vendor.id}
    GROUP BY c.id
  `;
  if (!c) throw new HttpError(404, "That customer doesn't exist.");
  const [favourites, orders] = await Promise.all([
    sql`
      SELECT i.name, sum(i.quantity)::int AS quantity
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.customer_id = ${id} AND o.vendor_id = ${vendor.id} AND o.status <> 'cancelled'
      GROUP BY i.name ORDER BY quantity DESC, i.name LIMIT 3
    `,
    sql`
      SELECT o.*,
        (SELECT string_agg(i.quantity || ' × ' || i.name || coalesce(' (' || i.option_text || ')', ''), ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items_summary
      FROM orders o
      WHERE o.vendor_id = ${vendor.id} AND o.customer_id = ${id}
      ORDER BY o.order_number DESC
      LIMIT 50
    `
  ]);
  const count = Number(c.order_count);
  return {
    customer: {
      id: Number(c.id),
      name: c.name,
      phone: c.phone,
      address: c.address || '',
      notes: c.notes || '',
      tags: tagsOf(c.tags),
      createdAt: c.created_at
    },
    stats: {
      orderCount: count,
      spentKobo: Number(c.spent),
      paidKobo: Number(c.paid),
      owingKobo: Number(c.owing),
      averageKobo: count ? Math.round(Number(c.spent) / count) : 0,
      firstOrderAt: c.first_at,
      lastOrderAt: c.last_at
    },
    favourites: favourites.map((f) => ({ name: f.name, quantity: Number(f.quantity) })),
    orders: orders.map(orderSummary)
  };
}

function readTags(raw) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'The labels look wrong. Reload and try again.', { field: 'tags' });
  const seen = new Set();
  const tags = [];
  for (const t of raw) {
    const tag = cleanText(t);
    if (!tag) continue;
    if (tag.length > 20) throw new HttpError(400, 'Keep each label under 20 characters.', { field: 'tags' });
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) throw new HttpError(400, `A customer can have up to ${MAX_TAGS} labels.`, { field: 'tags' });
  return tags;
}

// "vip" becomes "VIP" when another customer already has the label "VIP".
async function matchTags(vendor, tags) {
  if (!tags.length) return tags;
  const rows = await sql`
    SELECT DISTINCT t.tag FROM customers c, jsonb_array_elements_text(c.tags) AS t(tag)
    WHERE c.vendor_id = ${vendor.id}
  `;
  const known = new Map(rows.map((r) => [String(r.tag).toLowerCase(), String(r.tag)]));
  return tags.map((t) => known.get(t.toLowerCase()) || t);
}

async function updateCustomer(vendor, body) {
  const id = readId(body.id, 'customer');
  const [current] = await sql`SELECT * FROM customers WHERE id = ${id} AND vendor_id = ${vendor.id} LIMIT 1`;
  if (!current) throw new HttpError(404, "That customer doesn't exist.");
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  let name = current.name;
  if (has('name')) {
    name = cleanText(body.name);
    if (name.length < 2 || name.length > 80) throw new HttpError(400, "Enter the customer's name.", { field: 'name' });
  }
  let address = current.address;
  if (has('address')) {
    address = cleanText(body.address);
    if (address.length > 300) throw new HttpError(400, 'Keep the address under 300 characters.', { field: 'address' });
    address = address || null;
  }
  let notes = current.notes;
  if (has('notes')) {
    notes = String(body.notes == null ? '' : body.notes).trim().replace(/\r\n/g, '\n');
    if (notes.length > 1000) throw new HttpError(400, 'Keep the notes under 1000 characters.', { field: 'notes' });
    notes = notes || null;
  }
  const tags = has('tags') ? await matchTags(vendor, readTags(body.tags)) : tagsOf(current.tags);

  await sql`
    UPDATE customers SET name = ${name}, address = ${address}, notes = ${notes}, tags = ${JSON.stringify(tags)}::jsonb
    WHERE id = ${id} AND vendor_id = ${vendor.id}
  `;
  return customerPage(vendor, id);
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
  const header = ['Order', 'Date', 'Customer', 'Phone', 'Items', 'Total (NGN)', 'Paid (NGN)', 'Balance (NGN)', 'Payment', 'Status', 'Source', 'Delivery area', 'Address', 'Note'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((o) => {
    lines.push([
      o.order_number, o.placed, o.customer_name, phone(o.customer_phone), o.items || '',
      naira(o.total_kobo), naira(o.amount_paid_kobo), naira(Math.max(0, Number(o.total_kobo) - Number(o.amount_paid_kobo))),
      CSV_LABELS[o.payment_status] || o.payment_status, CSV_LABELS[o.status] || o.status,
      CSV_LABELS[o.source] || o.source, o.delivery_zone || '', o.delivery_address || '', o.note || ''
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
        SELECT id, name, price_kobo, options, stock FROM products
        WHERE vendor_id = ${vendor.id}
          AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(productIds)}::jsonb)::bigint)
      `
    : [];
  const stockRows = await stockRowsFor(sql, products.map((p) => p.id));
  const byId = new Map(products.map((p) => [Number(p.id), { ...p, stock_rows: stockRows.get(Number(p.id)) || [] }]));

  const lines = items.map((i) => {
    const quantity = Number(i && i.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new HttpError(400, 'Quantities must be between 1 and 99.', { field: 'items' });
    }
    if (i.productId != null) {
      const p = byId.get(Number(i.productId));
      if (!p) throw new HttpError(400, 'One of the products no longer exists. Remove it and try again.', { field: 'items' });
      // The seller can sell a choice marked sold out (they know their stock),
      // but not more than the count they keep.
      const priced = priceFor(p, i.options, { allowSoldOut: true });
      if (priced.problem === 'no_stock') {
        throw new HttpError(409, `${p.name} (${priced.choice}) is out of stock. Update your stock count first, or pick another ${priced.option.toLowerCase()}.`, { field: 'items', stock: true });
      }
      if (priced.problem) throw new HttpError(400, `Choose the ${priced.option.toLowerCase()} for ${p.name}.`, { field: 'items' });
      return { product_id: Number(p.id), name: p.name, option_text: priced.optionText, option_ids: priced.optionIds, unit_price_kobo: priced.unitPriceKobo, quantity };
    }
    const itemName = cleanText(i.name);
    if (itemName.length < 2 || itemName.length > 80) throw new HttpError(400, 'Give each custom item a name.', { field: 'items' });
    const price = nairaToKobo(i.price);
    if (price === null || price <= 0) throw new HttpError(400, `Enter a price for "${itemName}".`, { field: 'items' });
    return { product_id: null, name: itemName, unit_price_kobo: price, quantity };
  });

  const short = stockShortfalls(
    lines.filter((l) => l.product_id).map((l) => ({
      key: lineKey(l.product_id, l.option_ids), productId: l.product_id, quantity: l.quantity, optionIds: l.option_ids, optionText: l.option_text
    })),
    byId
  );
  if (short.length) {
    const s = short[0];
    const msg = s.left > 0
      ? `Only ${s.left} left of ${s.name}. Lower the quantity or update your stock count.`
      : `${s.name} is out of stock. Update your stock count first.`;
    throw new HttpError(409, msg, { field: 'items', stock: true });
  }

  // A delivery area sets the fee unless the seller typed one.
  let zone = null;
  if (body.zone != null && body.zone !== '') {
    zone = zonesOf(vendor).find((z) => z.id === String(body.zone));
    if (!zone) throw new HttpError(400, 'That delivery area was removed. Pick another.', { field: 'zone' });
  }
  const feeTyped = !(body.deliveryFee === '' || body.deliveryFee == null);
  const deliveryFee = feeTyped ? nairaToKobo(body.deliveryFee) : zone ? zone.feeKobo : 0;
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
    deliveryZone: zone ? zone.name : null,
    discountKobo: discount,
    note: note || null,
    source: 'manual',
    notify: false
  });
  await noteUsage(vendor);
  return { order: await loadOrder(vendor.id, created.id) };
}

// Changing the status. Cancelling puts back the stock the order took;
// restoring a cancelled order takes it again (and fails if it's gone).
async function setStatus(vendor, body) {
  const id = readId(body.id);
  const status = body.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
  const [before] = await sql`SELECT status FROM orders WHERE id = ${id} AND vendor_id = ${vendor.id} LIMIT 1`;
  if (!before) throw new HttpError(404, "That order doesn't exist.");
  if (before.status === status) return { order: await loadOrder(vendor.id, id) };

  try {
    await sql`
      WITH cur AS (
        SELECT id, status, stock_state FROM orders
        WHERE id = ${id} AND vendor_id = ${vendor.id}
        FOR UPDATE
      ),
      upd AS (
        UPDATE orders o SET
          status = ${status},
          stock_state = CASE
            WHEN ${status} = 'cancelled' AND cur.stock_state = 'taken' THEN 'returned'
            WHEN cur.status = 'cancelled' AND cur.stock_state = 'returned' THEN 'taken'
            ELSE cur.stock_state END,
          updated_at = now()
        FROM cur
        WHERE o.id = cur.id AND cur.status <> ${status}
        RETURNING o.id, cur.status AS old_status, cur.stock_state AS old_state, o.stock_state AS new_state
      ),
      delta AS (
        SELECT CASE
          WHEN upd.old_state = 'taken' AND upd.new_state = 'returned' THEN 1
          WHEN upd.old_state = 'returned' AND upd.new_state = 'taken' THEN -1
          ELSE 0 END AS sign
        FROM upd
      ),
      prod AS (
        UPDATE products p SET stock = p.stock + x.qty * d.sign, updated_at = now()
        FROM (
          SELECT i.product_id, sum(i.quantity)::int AS qty FROM order_items i
          WHERE i.order_id = ${id} AND i.product_id IS NOT NULL GROUP BY i.product_id
        ) x, delta d
        WHERE p.id = x.product_id AND p.vendor_id = ${vendor.id} AND p.stock IS NOT NULL AND d.sign <> 0
        RETURNING 1
      ),
      ch AS (
        UPDATE choice_stock c SET qty = c.qty + x.qty * d.sign
        FROM (
          SELECT i.product_id, e.value AS choice_id, sum(i.quantity)::int AS qty
          FROM order_items i, jsonb_array_elements_text(coalesce(i.option_ids, '[]'::jsonb)) AS e
          WHERE i.order_id = ${id} AND i.product_id IS NOT NULL
          GROUP BY i.product_id, e.value
        ) x, delta d
        WHERE c.product_id = x.product_id AND c.choice_id = x.choice_id AND d.sign <> 0
        RETURNING 1
      )
      INSERT INTO order_events (order_id, vendor_id, kind, message)
      SELECT upd.id, ${vendor.id}, 'status',
             CASE WHEN upd.old_status = 'cancelled' THEN ${'Order restored and marked as ' + status} ELSE ${STATUS_TEXT[status]} END
             || CASE
                  WHEN d.sign = 1 AND (SELECT count(*) FROM prod) + (SELECT count(*) FROM ch) > 0 THEN ' · stock put back'
                  WHEN d.sign = -1 AND (SELECT count(*) FROM prod) + (SELECT count(*) FROM ch) > 0 THEN ' · stock taken again'
                  ELSE '' END
      FROM upd, delta d
    `;
  } catch (err) {
    if (isStockError(err)) {
      throw new HttpError(409, 'There isn\'t enough stock left to bring this order back. Update your stock count, then try again.', { stock: true });
    }
    throw err;
  }
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
  const event = `${formatNaira(amount)} received by ${METHOD_TEXT[method]}` + (amount === order.balanceKobo ? ' · paid in full' : '');

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
    ),
    ev AS (
      INSERT INTO order_events (order_id, vendor_id, kind, message)
      SELECT p.order_id, ${vendor.id}, 'payment', ${event} FROM p
      RETURNING 1
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
  const [payment] = await sql`SELECT amount_kobo FROM payments WHERE id = ${paymentId} AND order_id = ${id} AND vendor_id = ${vendor.id}`;
  if (!payment) throw new HttpError(404, "That payment doesn't exist or was already removed.");
  const event = `Payment of ${formatNaira(payment.amount_kobo)} removed`;
  const rows = await sql`
    WITH d AS (
      DELETE FROM payments
      WHERE id = ${paymentId} AND order_id = ${id} AND vendor_id = ${vendor.id}
      RETURNING order_id, amount_kobo
    ),
    ev AS (
      INSERT INTO order_events (order_id, vendor_id, kind, message)
      SELECT d.order_id, ${vendor.id}, 'payment_removed', ${event} FROM d
      RETURNING 1
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

// The seller's own note in the order's history ("Rider picked up at 3pm").
async function addNote(vendor, body) {
  const id = readId(body.id);
  const message = String(body.message == null ? '' : body.message).trim().replace(/\s+/g, ' ');
  if (message.length < 1) throw new HttpError(400, 'Write the note first.', { field: 'message' });
  if (message.length > 300) throw new HttpError(400, 'Keep the note under 300 characters.', { field: 'message' });
  const rows = await sql`
    INSERT INTO order_events (order_id, vendor_id, kind, message)
    SELECT id, vendor_id, 'note', ${message} FROM orders WHERE id = ${id} AND vendor_id = ${vendor.id}
    RETURNING id
  `;
  if (!rows.length) throw new HttpError(404, "That order doesn't exist.");
  return { order: await loadOrder(vendor.id, id) };
}

// Things the seller did outside the app (sent the invoice on WhatsApp, sent
// a quick reply), so the history shows them. The same line twice within a
// minute is kept once.
const LOG_TEXT = {
  invoice_sent: () => 'Invoice sent on WhatsApp',
  invoice_copied: () => 'Invoice link copied',
  quick_reply: (title) => `Sent "${title}" on WhatsApp`,
  review_asked: () => 'Asked for a review on WhatsApp'
};

async function logAction(vendor, body) {
  const id = readId(body.id);
  const make = LOG_TEXT[body.kind];
  if (!make) throw new HttpError(400, 'Unknown kind.');
  const title = cleanText(body.title).slice(0, 30) || 'a message';
  const message = make(title);
  const kind = body.kind === 'invoice_copied' ? 'invoice_sent' : body.kind;
  await sql`
    INSERT INTO order_events (order_id, vendor_id, kind, message)
    SELECT o.id, o.vendor_id, ${kind}, ${message} FROM orders o
    WHERE o.id = ${id} AND o.vendor_id = ${vendor.id}
      AND NOT EXISTS (
        SELECT 1 FROM order_events e
        WHERE e.order_id = o.id AND e.message = ${message} AND e.created_at > now() - interval '1 minute'
      )
  `;
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
  note: addNote,
  log: logAction,
  customer: updateCustomer,
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
      const view = params.get('view');
      if (view === 'customer') return res.status(200).json(await customerPage(vendor, readId(params.get('id'), 'customer')));
      if (params.get('id')) return res.status(200).json({ order: await loadOrder(vendor.id, readId(params.get('id'))) });
      if (view === 'notifications') return res.status(200).json(await notifications(vendor));
      if (view === 'unread') return res.status(200).json(await unread(vendor));
      if (view === 'stats') return res.status(200).json(await stats(vendor));
      if (view === 'customers') return res.status(200).json(await customers(vendor, params));
      if (view === 'report') return res.status(200).json(await report(vendor));
      if (view === 'export') return await exportCsv(vendor, res);
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
