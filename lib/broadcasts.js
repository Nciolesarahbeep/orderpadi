// Messaging many customers, and "Tell me when it's back".
//
// A broadcast is one message for a group of customers (everyone, a label like
// VIP, people who owe you…). WhatsApp has no free way to send to many people
// from a normal account, so the seller's phone sends it one chat at a time:
// the app opens each customer's WhatsApp chat with the message filled in, and
// remembers who has had it, so the seller can stop and carry on later.
//
// Customers who see "Sold out" on a store can leave their name and number.
// The seller sees who's waiting, and when it's back, messages them all the
// same way (a "restock" broadcast).
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { cleanText, normalizeNgPhone } = require('./format');
const { isPro } = require('./plan');
const { flushPush } = require('./push');
const { optionsOf } = require('./catalog');

const MAX_RECIPIENTS = 300;
const FREE_BROADCASTS = 3;        // a month on the free plan ("it's back" messages don't count)
const MAX_MESSAGE = 700;
const WAITING_PER_PRODUCT = 300;
const REQUESTS_PER_IP_HOUR = 10;

const AUDIENCES = {
  all: 'All customers',
  recent: 'Bought in the last 30 days',
  quiet: "Haven't ordered in 2 months",
  owing: 'Owe you money'
};

function readId(value, what) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Which ${what}? The id is missing.`);
  return id;
}

// "all" | "recent" | "quiet" | "owing" | "tag:VIP"
function readAudience(raw) {
  const text = String(raw == null ? '' : raw);
  if (AUDIENCES[text]) return { key: text, tag: '', label: AUDIENCES[text] };
  if (text.startsWith('tag:')) {
    const tag = cleanText(text.slice(4));
    if (tag && tag.length <= 20) return { key: 'tag:' + tag, tag, label: 'Label: ' + tag };
  }
  throw new HttpError(400, 'Choose who gets the message.', { field: 'audience' });
}

function readMessage(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
  if (text.length < 2) throw new HttpError(400, 'Write your message first.', { field: 'message' });
  if (text.length > MAX_MESSAGE) throw new HttpError(400, `Keep the message under ${MAX_MESSAGE} characters.`, { field: 'message' });
  return text;
}

// Customers in a group, newest buyers first. Customers who asked not to get
// these messages are always left out.
async function audienceRows(vendorId, a) {
  return sql`
    SELECT b.customer_id, b.name, b.phone, b.owing_kobo
    FROM customer_balances b JOIN customers c ON c.id = b.customer_id
    WHERE b.vendor_id = ${vendorId} AND NOT c.no_broadcast
      AND (
        ${a.key} = 'all'
        OR (${a.key} = 'recent' AND b.last_order_at > now() - interval '30 days')
        OR (${a.key} = 'quiet' AND (b.last_order_at IS NULL OR b.last_order_at < now() - interval '60 days'))
        OR (${a.key} = 'owing' AND b.owing_kobo > 0)
        OR (${a.tag} <> '' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.tags) AS t(tag) WHERE lower(t.tag) = lower(${a.tag})))
      )
    ORDER BY b.last_order_at DESC NULLS LAST, b.customer_id DESC
    LIMIT ${MAX_RECIPIENTS}
  `;
}

async function usageOf(vendor) {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM broadcasts
    WHERE vendor_id = ${vendor.id} AND kind = 'message'
      AND created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'
  `;
  const pro = isPro(vendor);
  return { used: Number(row.n), limit: pro ? null : FREE_BROADCASTS, pro };
}

// Who could get a message, with how many people are in each group.
async function audiences(vendor) {
  const [[counts], tags, usage] = await Promise.all([
    sql`
      SELECT
        count(*) FILTER (WHERE NOT c.no_broadcast)::int AS all_n,
        count(*) FILTER (WHERE NOT c.no_broadcast AND b.last_order_at > now() - interval '30 days')::int AS recent_n,
        count(*) FILTER (WHERE NOT c.no_broadcast AND (b.last_order_at IS NULL OR b.last_order_at < now() - interval '60 days'))::int AS quiet_n,
        count(*) FILTER (WHERE NOT c.no_broadcast AND b.owing_kobo > 0)::int AS owing_n,
        count(*) FILTER (WHERE c.no_broadcast)::int AS opted_out
      FROM customer_balances b JOIN customers c ON c.id = b.customer_id
      WHERE b.vendor_id = ${vendor.id}
    `,
    sql`
      SELECT t.tag, count(*)::int AS n
      FROM customers c, jsonb_array_elements_text(c.tags) AS t(tag)
      WHERE c.vendor_id = ${vendor.id} AND NOT c.no_broadcast
      GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 30
    `,
    usageOf(vendor)
  ]);
  const cap = (n) => Math.min(Number(n), MAX_RECIPIENTS);
  return {
    audiences: [
      { key: 'all', label: AUDIENCES.all, count: cap(counts.all_n) },
      { key: 'recent', label: AUDIENCES.recent, count: cap(counts.recent_n) },
      { key: 'quiet', label: AUDIENCES.quiet, count: cap(counts.quiet_n) },
      { key: 'owing', label: AUDIENCES.owing, count: cap(counts.owing_n) }
    ],
    tags: tags.map((t) => ({ key: 'tag:' + t.tag, tag: t.tag, label: t.tag, count: cap(t.n) })),
    optedOut: Number(counts.opted_out),
    maxRecipients: MAX_RECIPIENTS,
    usage
  };
}

function broadcastForClient(b, full) {
  const out = {
    id: Number(b.id),
    kind: b.kind,
    audience: b.audience,
    audienceLabel: b.audience_label,
    message: b.message,
    productId: b.product_id == null ? null : Number(b.product_id),
    productName: b.product_name || null,
    total: Number(b.total),
    sentCount: Number(b.sent_count),
    createdAt: b.created_at,
    updatedAt: b.updated_at
  };
  if (full) {
    out.recipients = (Array.isArray(b.recipients) ? b.recipients : []).map((r) => ({
      customerId: r.customerId || null,
      alertId: r.alertId || null,
      name: r.name,
      phone: r.phone,
      owingKobo: Number(r.owingKobo || 0),
      choice: r.choice || '',
      sent: !!r.sent
    }));
  }
  return out;
}

async function broadcastList(vendor) {
  const [rows, usage] = await Promise.all([
    sql`
      SELECT b.id, b.kind, b.audience, b.audience_label, b.message, b.product_id, b.total, b.sent_count, b.created_at, b.updated_at,
             p.name AS product_name
      FROM broadcasts b LEFT JOIN products p ON p.id = b.product_id
      WHERE b.vendor_id = ${vendor.id}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT 50
    `,
    usageOf(vendor)
  ]);
  return { broadcasts: rows.map((b) => broadcastForClient(b, false)), usage };
}

async function broadcastOne(vendor, id) {
  const [b] = await sql`
    SELECT b.*, p.name AS product_name FROM broadcasts b LEFT JOIN products p ON p.id = b.product_id
    WHERE b.id = ${id} AND b.vendor_id = ${vendor.id}
  `;
  if (!b) throw new HttpError(404, "That message doesn't exist any more.");
  return { broadcast: broadcastForClient(b, true) };
}

async function createBroadcast(vendor, body) {
  const a = readAudience(body.audience);
  const message = readMessage(body.message);
  const people = await audienceRows(vendor.id, a);
  if (!people.length) throw new HttpError(400, 'Nobody is in that group yet.', { field: 'audience' });
  const recipients = people.map((p) => ({
    customerId: Number(p.customer_id), name: p.name, phone: p.phone, owingKobo: Number(p.owing_kobo || 0), sent: false
  }));
  const limit = isPro(vendor) ? 1000000 : FREE_BROADCASTS;
  const [row] = await sql`
    INSERT INTO broadcasts (vendor_id, kind, audience, audience_label, message, recipients, total)
    SELECT ${vendor.id}, 'message', ${a.key}, ${a.label}, ${message}, ${JSON.stringify(recipients)}::jsonb, ${recipients.length}
    WHERE (
      SELECT count(*) FROM broadcasts
      WHERE vendor_id = ${vendor.id} AND kind = 'message'
        AND created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'
    ) < ${limit}
    RETURNING id
  `;
  if (!row) {
    throw new HttpError(402, `The free plan has ${FREE_BROADCASTS} group messages a month. Go Pro to send as many as you like.`, { upgrade: true });
  }
  return broadcastOne(vendor, Number(row.id));
}

// Ticks a customer off (or back on) after their WhatsApp chat was opened.
async function markSent(vendor, body) {
  const id = readId(body.id, 'message');
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_RECIPIENTS) throw new HttpError(400, 'Which customer?');
  const sent = body.sent !== false;
  const [row] = await sql`
    UPDATE broadcasts SET
      recipients = jsonb_set(recipients, ARRAY[${String(index)}::text, 'sent'], to_jsonb(${sent}::boolean)),
      sent_count = sent_count + CASE
        WHEN coalesce((recipients -> ${index}::int ->> 'sent')::boolean, FALSE) = ${sent}::boolean THEN 0
        WHEN ${sent}::boolean THEN 1 ELSE -1 END,
      updated_at = now()
    WHERE id = ${id} AND vendor_id = ${vendor.id} AND ${index}::int < jsonb_array_length(recipients)
    RETURNING recipients -> ${index}::int ->> 'alertId' AS alert_id
  `;
  if (!row) throw new HttpError(404, "That message doesn't exist any more.");
  // Someone told "it's back" leaves the waiting list.
  if (row.alert_id) {
    await sql`
      UPDATE stock_alerts SET notified_at = ${sent ? new Date() : null}
      WHERE id = ${Number(row.alert_id)} AND vendor_id = ${vendor.id}
    `;
  }
  return broadcastOne(vendor, id);
}

async function deleteBroadcast(vendor, body) {
  const id = readId(body.id, 'message');
  const rows = await sql`DELETE FROM broadcasts WHERE id = ${id} AND vendor_id = ${vendor.id} RETURNING id`;
  if (!rows.length) throw new HttpError(404, "That message doesn't exist any more.");
  return broadcastList(vendor);
}

// ---------- "Tell me when it's back" ----------

// From the store page. Anyone can ask, so it's limited per device and per product.
async function requestStock(body, ip) {
  const slug = String(body.store || '').toLowerCase();
  const productId = readId(body.productId, 'product');
  const name = cleanText(body.name);
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Enter your name.', { field: 'name' });
  const phone = normalizeNgPhone(cleanText(body.phone));
  if (!phone) throw new HttpError(400, 'Enter your WhatsApp number, like 0803 123 4567.', { field: 'phone' });

  const [p] = await sql`
    SELECT p.id, p.vendor_id, p.name, p.options, p.is_active FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE p.id = ${productId} AND v.slug = ${slug} AND v.email_verified AND NOT v.is_suspended
    LIMIT 1
  `;
  if (!p || !p.is_active) throw new HttpError(404, "This product isn't in the store any more.");
  let choiceText = null;
  if (body.choiceId != null && body.choiceId !== '') {
    const id = String(body.choiceId);
    optionsOf(p).forEach((g) => g.choices.forEach((c) => { if (c.id === id) choiceText = g.name + ': ' + c.label; }));
  }

  const [busy] = await sql`
    SELECT
      (SELECT count(*) FROM stock_alerts WHERE created_ip = ${ip} AND created_at > now() - interval '1 hour')::int AS by_ip,
      (SELECT count(*) FROM stock_alerts WHERE product_id = ${productId} AND notified_at IS NULL)::int AS waiting
  `;
  if (Number(busy.by_ip) >= REQUESTS_PER_IP_HOUR) throw new HttpError(429, 'Too many requests from this phone. Try again later.');
  if (Number(busy.waiting) >= WAITING_PER_PRODUCT) {
    throw new HttpError(409, 'Lots of people are already waiting for this. Message the seller on WhatsApp instead.');
  }

  const [saved] = await sql`
    INSERT INTO stock_alerts (vendor_id, product_id, name, phone, choice_text, created_ip)
    VALUES (${p.vendor_id}, ${p.id}, ${name}, ${phone}, ${choiceText}, ${ip})
    ON CONFLICT (product_id, phone) DO UPDATE SET
      name = EXCLUDED.name, choice_text = EXCLUDED.choice_text, created_ip = EXCLUDED.created_ip,
      created_at = now(), notified_at = NULL
    RETURNING (xmax = 0) AS inserted
  `;
  const waiting = Number(busy.waiting) + (saved.inserted ? 1 : 0);
  if (saved.inserted) {
    const what = p.name + (choiceText ? ' (' + choiceText + ')' : '');
    const others = waiting > 1 ? ` ${waiting} people are waiting.` : '';
    await sql`
      INSERT INTO notifications (vendor_id, type, message)
      VALUES (${p.vendor_id}, 'stock_request', ${name + ' wants ' + what + " when it's back." + others})
    `;
    await flushPush([p.vendor_id]);
  }
  return { ok: true };
}

// Everyone waiting, by product.
async function waitingList(vendor) {
  const rows = await sql`
    SELECT a.id, a.product_id, a.name, a.phone, a.choice_text, a.created_at, p.name AS product_name
    FROM stock_alerts a JOIN products p ON p.id = a.product_id
    WHERE a.vendor_id = ${vendor.id} AND a.notified_at IS NULL
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 2000
  `;
  const byProduct = new Map();
  rows.forEach((r) => {
    const id = Number(r.product_id);
    if (!byProduct.has(id)) byProduct.set(id, { productId: id, name: r.product_name, people: [] });
    byProduct.get(id).people.push({ id: Number(r.id), name: r.name, phone: r.phone, choice: r.choice_text || '', createdAt: r.created_at });
  });
  const products = [...byProduct.values()].map((p) => ({ ...p, waiting: p.people.length }));
  return { products, total: rows.length };
}

async function waitingCounts(productIds) {
  const ids = JSON.stringify([...new Set(productIds.map(Number).filter((n) => n > 0))]);
  const rows = await sql`
    SELECT product_id, count(*)::int AS n FROM stock_alerts
    WHERE notified_at IS NULL AND product_id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::bigint)
    GROUP BY product_id
  `;
  return new Map(rows.map((r) => [Number(r.product_id), Number(r.n)]));
}

async function waitingRemove(vendor, body) {
  const id = readId(body.id, 'request');
  await sql`DELETE FROM stock_alerts WHERE id = ${id} AND vendor_id = ${vendor.id}`;
  return waitingList(vendor);
}

// "Tell them it's back": a message for everyone waiting on one product.
// An unfinished one from the last week is picked up again instead of starting over.
async function restockMessage(vendor, body) {
  const productId = readId(body.productId, 'product');
  const [p] = await sql`SELECT id, name FROM products WHERE id = ${productId} AND vendor_id = ${vendor.id}`;
  if (!p) throw new HttpError(404, "That product doesn't exist or was deleted.");
  const [open] = await sql`
    SELECT id FROM broadcasts
    WHERE vendor_id = ${vendor.id} AND kind = 'restock' AND product_id = ${productId}
      AND sent_count < total AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC LIMIT 1
  `;
  const people = await sql`
    SELECT id, name, phone, choice_text FROM stock_alerts
    WHERE vendor_id = ${vendor.id} AND product_id = ${productId} AND notified_at IS NULL
    ORDER BY created_at, id
    LIMIT ${MAX_RECIPIENTS}
  `;
  if (open) {
    // Add anyone who asked since it was made.
    const [b] = await sql`SELECT recipients FROM broadcasts WHERE id = ${open.id}`;
    const have = new Set((b.recipients || []).map((r) => Number(r.alertId)));
    const extra = people.filter((x) => !have.has(Number(x.id))).map((x) => ({ alertId: Number(x.id), name: x.name, phone: x.phone, choice: x.choice_text || '', sent: false }));
    if (extra.length) {
      await sql`
        UPDATE broadcasts SET recipients = recipients || ${JSON.stringify(extra)}::jsonb, total = total + ${extra.length}, updated_at = now()
        WHERE id = ${open.id} AND jsonb_array_length(recipients) + ${extra.length} <= ${MAX_RECIPIENTS}
      `;
    }
    return broadcastOne(vendor, Number(open.id));
  }
  if (!people.length) throw new HttpError(400, 'Nobody is waiting for this product.');
  const recipients = people.map((x) => ({ alertId: Number(x.id), name: x.name, phone: x.phone, choice: x.choice_text || '', sent: false }));
  const message = readMessage(body.message || "Hi {name}, good news! {product} is back in stock at {store}. Order here before it sells out again: {link}");
  const [row] = await sql`
    INSERT INTO broadcasts (vendor_id, kind, product_id, audience, audience_label, message, recipients, total)
    VALUES (${vendor.id}, 'restock', ${productId}, 'restock', ${'Waiting for ' + p.name}, ${message}, ${JSON.stringify(recipients)}::jsonb, ${recipients.length})
    RETURNING id
  `;
  return broadcastOne(vendor, Number(row.id));
}

// The message itself can be changed before (or while) sending.
async function editBroadcast(vendor, body) {
  const id = readId(body.id, 'message');
  const message = readMessage(body.message);
  const rows = await sql`UPDATE broadcasts SET message = ${message}, updated_at = now() WHERE id = ${id} AND vendor_id = ${vendor.id} RETURNING id`;
  if (!rows.length) throw new HttpError(404, "That message doesn't exist any more.");
  return broadcastOne(vendor, id);
}

module.exports = {
  MAX_RECIPIENTS, FREE_BROADCASTS, AUDIENCES,
  readAudience, audiences, broadcastList, broadcastOne, createBroadcast, markSent, deleteBroadcast, editBroadcast,
  requestStock, waitingList, waitingCounts, waitingRemove, restockMessage
};
