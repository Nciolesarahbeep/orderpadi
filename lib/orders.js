// Shared order logic: creating an order (from the store page or by the
// seller for a DM customer) and shaping orders for the dashboard and the
// public invoice. All money is kobo.
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { formatNaira } = require('./format');

// True when an order couldn't go through because it would take more stock
// than is left (the checks on products.stock and choice_stock).
function isStockError(err) {
  return !!err && err.code === '23514' && /products_stock_check|choice_stock_qty_check/.test(String(err.constraint || '') + ' ' + String(err.message || ''));
}

// lines: [{ product_id (or null for a custom line), name, option_text?, option_ids?, unit_price_kobo, quantity }]
// One statement: bump the seller's order number, save/update the customer,
// insert the order and its items, take the stock, note it in the order's
// history and (for store orders) notify the seller. If any stock would go
// below zero the whole statement fails and nothing is saved.
async function createOrder({ vendorId, customer, lines, deliveryFeeKobo = 0, deliveryZone = null, discountKobo = 0, note = null, source, ip = null, notify }) {
  const items = lines.map((l) => ({ ...l, option_text: l.option_text || null, option_ids: l.option_ids || null, line_total_kobo: l.unit_price_kobo * l.quantity }));
  const subtotal = items.reduce((sum, l) => sum + l.line_total_kobo, 0);
  const total = subtotal + deliveryFeeKobo - discountKobo;
  const placed = source === 'manual' ? 'Order added by you' : 'Order placed from your store link';
  const json = JSON.stringify(items);

  let order;
  try {
    [order] = await sql`
    WITH seq AS (
      UPDATE vendors SET order_seq = order_seq + 1
      WHERE id = ${vendorId}
      RETURNING id, order_seq
    ),
    cust AS (
      INSERT INTO customers (vendor_id, name, phone, address)
      VALUES (${vendorId}, ${customer.name}, ${customer.phone}, ${customer.address})
      ON CONFLICT (vendor_id, phone) DO UPDATE
        SET name = EXCLUDED.name, address = COALESCE(EXCLUDED.address, customers.address)
      RETURNING id
    ),
    ord AS (
      INSERT INTO orders (
        vendor_id, customer_id, order_number, source, customer_name, customer_phone,
        delivery_address, note, subtotal_kobo, delivery_fee_kobo, delivery_zone, discount_kobo, total_kobo, created_ip, stock_state
      )
      SELECT seq.id, cust.id, seq.order_seq, ${source}, ${customer.name}, ${customer.phone},
             ${customer.address}, ${note}, ${subtotal}, ${deliveryFeeKobo}, ${deliveryZone}, ${discountKobo}, ${total}, ${ip}, 'taken'
      FROM seq, cust
      RETURNING id, order_number, public_id, created_at
    ),
    saved_items AS (
      INSERT INTO order_items (order_id, product_id, name, option_text, option_ids, unit_price_kobo, quantity, line_total_kobo)
      SELECT ord.id, i.product_id, i.name, i.option_text, i.option_ids, i.unit_price_kobo, i.quantity, i.line_total_kobo
      FROM ord, jsonb_to_recordset(${json}::jsonb)
        AS i(product_id bigint, name text, option_text text, option_ids jsonb, unit_price_kobo bigint, quantity int, line_total_kobo bigint)
      RETURNING id
    ),
    take_products AS (
      UPDATE products p SET stock = p.stock - x.qty, updated_at = now()
      FROM (
        SELECT i.product_id, sum(i.quantity)::int AS qty
        FROM jsonb_to_recordset(${json}::jsonb) AS i(product_id bigint, quantity int)
        WHERE i.product_id IS NOT NULL GROUP BY i.product_id
      ) x
      WHERE p.id = x.product_id AND p.stock IS NOT NULL
      RETURNING p.id
    ),
    take_choices AS (
      UPDATE choice_stock c SET qty = c.qty - x.qty
      FROM (
        SELECT i.product_id, ch.value AS choice_id, sum(i.quantity)::int AS qty
        FROM jsonb_to_recordset(${json}::jsonb) AS i(product_id bigint, quantity int, option_ids jsonb),
             jsonb_array_elements_text(coalesce(i.option_ids, '[]'::jsonb)) AS ch
        WHERE i.product_id IS NOT NULL GROUP BY i.product_id, ch.value
      ) x
      WHERE c.product_id = x.product_id AND c.choice_id = x.choice_id
      RETURNING 1
    ),
    history AS (
      INSERT INTO order_events (order_id, vendor_id, kind, message)
      SELECT ord.id, ${vendorId}, 'placed', ${placed} FROM ord
      RETURNING 1
    ),
    alert AS (
      INSERT INTO notifications (vendor_id, type, message, order_id)
      SELECT ${vendorId}, 'new_order',
             'New order #' || ord.order_number || ' from ' || ${customer.name} || ' · ' || ${formatNaira(total)},
             ord.id
      FROM ord
      WHERE ${notify ? 1 : 0} = 1
      RETURNING id
    )
    SELECT ord.id, ord.order_number, ord.public_id, ord.created_at,
           (SELECT count(*) FROM saved_items)::int AS item_count
    FROM ord
  `;
  } catch (err) {
    if (isStockError(err)) throw new HttpError(409, 'Some items just sold out. Check the order and try again.', { stock: true });
    throw err;
  }
  if (!order) throw new Error('Order insert returned no row');

  return {
    id: Number(order.id),
    number: Number(order.order_number),
    publicId: order.public_id,
    createdAt: order.created_at,
    items: items.map(itemForClient),
    subtotalKobo: subtotal,
    deliveryFeeKobo,
    deliveryZone,
    discountKobo,
    totalKobo: total
  };
}

// Adds a line to an order's history.
async function addEvent(orderId, vendorId, kind, message) {
  await sql`INSERT INTO order_events (order_id, vendor_id, kind, message) VALUES (${orderId}, ${vendorId}, ${kind}, ${message})`;
}

// "Bone straight wig (22 inches, Black)": the name customers and sellers see.
function itemName(i) {
  return i.option_text ? `${i.name} (${i.option_text})` : i.name;
}

function itemForClient(i) {
  return {
    name: itemName(i),
    product: i.name,
    options: i.option_text || '',
    quantity: Number(i.quantity),
    unitPriceKobo: Number(i.unit_price_kobo),
    lineTotalKobo: Number(i.line_total_kobo)
  };
}

function money(o) {
  const total = Number(o.total_kobo);
  const paid = Number(o.amount_paid_kobo);
  return {
    subtotalKobo: Number(o.subtotal_kobo),
    deliveryFeeKobo: Number(o.delivery_fee_kobo),
    deliveryZone: o.delivery_zone || null,
    discountKobo: Number(o.discount_kobo),
    totalKobo: total,
    amountPaidKobo: paid,
    balanceKobo: Math.max(0, total - paid)
  };
}

// A row in the Orders list.
function orderSummary(o) {
  return {
    id: Number(o.id),
    number: Number(o.order_number),
    publicId: o.public_id,
    source: o.source,
    customerName: o.customer_name,
    itemsSummary: o.items_summary || '',
    status: o.status,
    paymentStatus: o.payment_status,
    customerSaysPaid: !!o.customer_marked_paid_at && o.payment_status !== 'paid',
    createdAt: o.created_at,
    ...money(o)
  };
}

// The full order for the seller. Older orders have no history rows, so
// "placed" is filled in from when the order was made.
function orderDetail(o, items, payments, events = []) {
  const timeline = events.map((e) => ({ kind: e.kind, message: e.message, at: e.created_at }));
  if (!timeline.some((e) => e.kind === 'placed')) {
    timeline.unshift({ kind: 'placed', message: o.source === 'manual' ? 'Order added by you' : 'Order placed from your store link', at: o.created_at });
  }
  return {
    ...orderSummary(o),
    customerId: o.customer_id ? Number(o.customer_id) : null,
    timeline,
    customerPhone: o.customer_phone,
    deliveryAddress: o.delivery_address || '',
    note: o.note || '',
    customerMarkedPaidAt: o.customer_marked_paid_at || null,
    items: items.map(itemForClient),
    payments: payments.map((p) => ({
      id: Number(p.id),
      amountKobo: Number(p.amount_kobo),
      method: p.method,
      note: p.note || '',
      paidAt: p.paid_at
    }))
  };
}

// The public invoice: no phone number, no internal ids.
function invoiceForCustomer(o, items, payments) {
  return {
    number: Number(o.order_number),
    publicId: o.public_id,
    createdAt: o.created_at,
    status: o.status,
    paymentStatus: o.payment_status,
    customerName: o.customer_name,
    deliveryAddress: o.delivery_address || '',
    note: o.note || '',
    customerMarkedPaidAt: o.customer_marked_paid_at || null,
    items: items.map(itemForClient),
    payments: payments.map((p) => ({ amountKobo: Number(p.amount_kobo), paidAt: p.paid_at })),
    ...money(o)
  };
}

module.exports = { createOrder, addEvent, isStockError, orderSummary, orderDetail, invoiceForCustomer, itemName };
