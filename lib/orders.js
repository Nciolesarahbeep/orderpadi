// Shared order logic: creating an order (from the store page or by the
// seller for a DM customer) and shaping orders for the dashboard and the
// public invoice. All money is kobo.
const { sql } = require('./db');
const { formatNaira } = require('./format');

// lines: [{ product_id (or null for a custom line), name, option_text?, unit_price_kobo, quantity }]
// One statement: bump the seller's order number, save/update the customer,
// insert the order and its items, and (for store orders) notify the seller.
async function createOrder({ vendorId, customer, lines, deliveryFeeKobo = 0, discountKobo = 0, note = null, source, ip = null, notify }) {
  const items = lines.map((l) => ({ ...l, option_text: l.option_text || null, line_total_kobo: l.unit_price_kobo * l.quantity }));
  const subtotal = items.reduce((sum, l) => sum + l.line_total_kobo, 0);
  const total = subtotal + deliveryFeeKobo - discountKobo;

  const [order] = await sql`
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
        delivery_address, note, subtotal_kobo, delivery_fee_kobo, discount_kobo, total_kobo, created_ip
      )
      SELECT seq.id, cust.id, seq.order_seq, ${source}, ${customer.name}, ${customer.phone},
             ${customer.address}, ${note}, ${subtotal}, ${deliveryFeeKobo}, ${discountKobo}, ${total}, ${ip}
      FROM seq, cust
      RETURNING id, order_number, public_id, created_at
    ),
    saved_items AS (
      INSERT INTO order_items (order_id, product_id, name, option_text, unit_price_kobo, quantity, line_total_kobo)
      SELECT ord.id, i.product_id, i.name, i.option_text, i.unit_price_kobo, i.quantity, i.line_total_kobo
      FROM ord, jsonb_to_recordset(${JSON.stringify(items)}::jsonb)
        AS i(product_id bigint, name text, option_text text, unit_price_kobo bigint, quantity int, line_total_kobo bigint)
      RETURNING id
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
  if (!order) throw new Error('Order insert returned no row');

  return {
    id: Number(order.id),
    number: Number(order.order_number),
    publicId: order.public_id,
    createdAt: order.created_at,
    items: items.map(itemForClient),
    subtotalKobo: subtotal,
    deliveryFeeKobo,
    discountKobo,
    totalKobo: total
  };
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

// The full order for the seller.
function orderDetail(o, items, payments) {
  return {
    ...orderSummary(o),
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

module.exports = { createOrder, orderSummary, orderDetail, invoiceForCustomer, itemName };
