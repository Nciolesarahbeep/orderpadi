// Shared order logic: creating an order (from the store page or by the
// seller for a DM customer) and shaping orders for the dashboard and the
// public invoice. All money is kobo.
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { formatNaira } = require('./format');
const { isPromoUsedUp } = require('./promos');
const { canReview } = require('./reviews');
const { rewardReferral } = require('./referrals');

// True when an order couldn't go through because it would take more stock
// than is left (the checks on products.stock and choice_stock).
function isStockError(err) {
  return !!err && err.code === '23514' && /products_stock_check|choice_stock_qty_check/.test(String(err.constraint || '') + ' ' + String(err.message || ''));
}

// lines: [{ product_id (or null for a custom line), name, option_text?, option_ids?, unit_price_kobo, quantity,
//           stock_product_id?, supplier_id?, unit_cost_kobo? }]   (the last three for resold items)
// One statement: bump the seller's order number, save/update the customer,
// insert the order and its items, take the stock, note it in the order's
// history and (for store orders) notify the seller. If any stock would go
// below zero the whole statement fails and nothing is saved.
// promo: { id, code } when a promo code gave the discount; its use is counted
// in the same statement, and the order fails if the code just ran out.
async function createOrder({ vendorId, customer, lines, deliveryFeeKobo = 0, deliveryZone = null, discountKobo = 0, promo = null, note = null, source, ip = null, notify }) {
  const items = lines.map((l) => ({
    ...l, option_text: l.option_text || null, option_ids: l.option_ids || null, line_total_kobo: l.unit_price_kobo * l.quantity,
    stock_product_id: l.stock_product_id || null, supplier_id: l.supplier_id || null, unit_cost_kobo: l.unit_cost_kobo == null ? null : l.unit_cost_kobo
  }));
  const subtotal = items.reduce((sum, l) => sum + l.line_total_kobo, 0);
  const total = subtotal + deliveryFeeKobo - discountKobo;
  const placed = source === 'manual' ? 'Order added by you' : 'Order placed from your store link';
  const json = JSON.stringify(items);

  let order;
  try {
    [order] = await sql`
    WITH seq AS (
      UPDATE vendors SET order_seq = order_seq + 1,
        -- an invited seller's first store order earns the referral reward, once
        referral_rewarded_at = CASE WHEN ${source} = 'link' AND referred_by IS NOT NULL AND referral_rewarded_at IS NULL
                                    THEN now() ELSE referral_rewarded_at END
      WHERE id = ${vendorId}
      RETURNING id, order_seq, business_name, referred_by, (referral_rewarded_at = now()) AS rewarded_now
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
        delivery_address, note, subtotal_kobo, delivery_fee_kobo, delivery_zone, discount_kobo, promo_code, total_kobo, created_ip, stock_state
      )
      SELECT seq.id, cust.id, seq.order_seq, ${source}, ${customer.name}, ${customer.phone},
             ${customer.address}, ${note}, ${subtotal}, ${deliveryFeeKobo}, ${deliveryZone}, ${discountKobo}, ${promo ? promo.code : null}, ${total}, ${ip}, 'taken'
      FROM seq, cust
      RETURNING id, order_number, public_id, created_at
    ),
    saved_items AS (
      INSERT INTO order_items (order_id, product_id, name, option_text, option_ids, unit_price_kobo, quantity, line_total_kobo,
                               stock_product_id, supplier_vendor_id, unit_cost_kobo)
      SELECT ord.id, i.product_id, i.name, i.option_text, i.option_ids, i.unit_price_kobo, i.quantity, i.line_total_kobo,
             i.stock_product_id, i.supplier_id, i.unit_cost_kobo
      FROM ord, jsonb_to_recordset(${json}::jsonb)
        AS i(product_id bigint, name text, option_text text, option_ids jsonb, unit_price_kobo bigint, quantity int, line_total_kobo bigint,
             stock_product_id bigint, supplier_id bigint, unit_cost_kobo bigint)
      RETURNING id
    ),
    take_products AS (
      UPDATE products p SET stock = p.stock - x.qty, updated_at = now()
      FROM (
        SELECT coalesce(i.stock_product_id, i.product_id) AS pid, sum(i.quantity)::int AS qty
        FROM jsonb_to_recordset(${json}::jsonb) AS i(product_id bigint, stock_product_id bigint, quantity int)
        WHERE i.product_id IS NOT NULL GROUP BY 1
      ) x
      WHERE p.id = x.pid AND p.stock IS NOT NULL
      RETURNING p.id
    ),
    take_choices AS (
      UPDATE choice_stock c SET qty = c.qty - x.qty
      FROM (
        SELECT coalesce(i.stock_product_id, i.product_id) AS pid, ch.value AS choice_id, sum(i.quantity)::int AS qty
        FROM jsonb_to_recordset(${json}::jsonb) AS i(product_id bigint, stock_product_id bigint, quantity int, option_ids jsonb),
             jsonb_array_elements_text(coalesce(i.option_ids, '[]'::jsonb)) AS ch
        WHERE i.product_id IS NOT NULL GROUP BY 1, 2
      ) x
      WHERE c.product_id = x.pid AND c.choice_id = x.choice_id
      RETURNING 1
    ),
    -- resold items: one supply order per supplier, who sends them to the customer
    supply_lines AS (
      SELECT i.supplier_id,
             jsonb_agg(jsonb_build_object('name', i.name, 'optionText', i.option_text, 'quantity', i.quantity, 'unitCostKobo', i.unit_cost_kobo)) AS items,
             sum(i.unit_cost_kobo * i.quantity)::bigint AS total,
             sum(i.quantity)::int AS qty
      FROM jsonb_to_recordset(${json}::jsonb) AS i(supplier_id bigint, name text, option_text text, quantity int, unit_cost_kobo bigint)
      WHERE i.supplier_id IS NOT NULL
      GROUP BY i.supplier_id
    ),
    supply AS (
      INSERT INTO supply_orders (order_id, reseller_vendor_id, supplier_vendor_id, items, total_kobo)
      SELECT ord.id, ${vendorId}, sl.supplier_id, sl.items, sl.total FROM ord, supply_lines sl
      RETURNING id
    ),
    supply_alert AS (
      INSERT INTO notifications (vendor_id, type, message)
      SELECT sl.supplier_id, 'supply_order',
             'Resale order from ' || seq.business_name || ': ' || sl.qty || CASE WHEN sl.qty = 1 THEN ' item' ELSE ' items' END
             || ' to send to their customer. Open More › Resale orders.'
      FROM supply_lines sl, seq, ord
      RETURNING 1
    ),
    use_promo AS (
      UPDATE promo_codes SET uses = uses + 1
      WHERE id = ${promo ? promo.id : 0} AND vendor_id = ${vendorId}
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
           (SELECT count(*) FROM saved_items)::int AS item_count,
           (SELECT CASE WHEN rewarded_now THEN referred_by END FROM seq) AS reward_referrer
    FROM ord
  `;
  } catch (err) {
    if (isStockError(err)) throw new HttpError(409, 'Some items just sold out. Check the order and try again.', { stock: true });
    if (isPromoUsedUp(err)) throw new HttpError(409, 'That promo code has just been used up. Remove it to place your order.', { field: 'promo' });
    throw err;
  }
  if (!order) throw new Error('Order insert returned no row');
  if (order.reward_referrer) {
    try { await rewardReferral(vendorId, Number(order.reward_referrer)); }
    catch (err) { console.error('Referral reward failed:', err); }
  }

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
    promoCode: promo ? promo.code : null,
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
    promoCode: o.promo_code || null,
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
function orderDetail(o, items, payments, events = [], review = null) {
  const timeline = events.map((e) => ({ kind: e.kind, message: e.message, at: e.created_at }));
  if (!timeline.some((e) => e.kind === 'placed')) {
    timeline.unshift({ kind: 'placed', message: o.source === 'manual' ? 'Order added by you' : 'Order placed from your store link', at: o.created_at });
  }
  return {
    ...orderSummary(o),
    customerId: o.customer_id ? Number(o.customer_id) : null,
    timeline,
    canReview: canReview(o),
    review: review ? { rating: Number(review.rating), body: review.body || '', reply: review.reply || '', createdAt: review.created_at } : null,
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
