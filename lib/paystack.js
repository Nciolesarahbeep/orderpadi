// Paystack: starting a Pro checkout, checking a payment, and applying
// billing events. Events are stored once in billing_events (unique per
// event + reference), so a webhook Paystack retries, or a payment seen by
// both the webhook and the "back from Paystack" check, is applied only once.
const crypto = require('crypto');
const { sql } = require('./db');
const { HttpError } = require('./auth');

const API = 'https://api.paystack.co';

function configured() {
  return !!(process.env.PAYSTACK_SECRET_KEY && process.env.PAYSTACK_PLAN_CODE);
}

async function paystack(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new HttpError(502, "Couldn't reach Paystack. Check your connection and try again.");
  }
  let data = {};
  try { data = await response.json(); } catch (err) { data = {}; }
  if (!response.ok || data.status === false) {
    throw new HttpError(502, data.message ? `Paystack: ${data.message}` : "Couldn't reach Paystack. Try again in a minute.");
  }
  return data.data;
}

// Paystack signs each webhook: HMAC-SHA512 of the body with your secret key.
function signatureValid(body, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !signature || !body) return false;
  const expected = Buffer.from(crypto.createHmac('sha512', secret).update(body).digest('hex'), 'hex');
  let given;
  try { given = Buffer.from(String(signature), 'hex'); } catch (err) { return false; }
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function metadata(data) {
  let meta = data && data.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (err) { meta = {}; }
  }
  return meta && typeof meta === 'object' ? meta : {};
}

function isProPayment(data) {
  const meta = metadata(data);
  const planCode = data && data.plan && typeof data.plan === 'object' ? data.plan.plan_code : data && data.plan;
  return meta.purpose === 'orderpadi_pro' || (!!planCode && planCode === process.env.PAYSTACK_PLAN_CODE);
}

async function findVendor(data) {
  const meta = metadata(data);
  const id = Number(meta.vendor_id);
  if (Number.isInteger(id) && id > 0) {
    const rows = await sql`SELECT * FROM vendors WHERE id = ${id} LIMIT 1`;
    if (rows[0]) return rows[0];
  }
  const customer = (data && data.customer) || {};
  if (customer.customer_code) {
    const rows = await sql`SELECT * FROM vendors WHERE paystack_customer_code = ${customer.customer_code} LIMIT 1`;
    if (rows[0]) return rows[0];
  }
  const email = String(customer.email || '').trim().toLowerCase();
  if (email) {
    const rows = await sql`SELECT * FROM vendors WHERE email = ${email} LIMIT 1`;
    if (rows[0]) return rows[0];
  }
  return null;
}

// Stores the event; returns true only the first time this event is seen.
async function remember(event, key, vendorId, amount, payload) {
  const rows = await sql`
    INSERT INTO billing_events (vendor_id, event, dedupe_key, amount_kobo, payload)
    VALUES (${vendorId}, ${event}, ${key}, ${amount}, ${JSON.stringify(payload || {})}::jsonb)
    ON CONFLICT (event, dedupe_key) DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

async function notify(vendorId, type, message) {
  await sql`INSERT INTO notifications (vendor_id, type, message) VALUES (${vendorId}, ${type}, ${message})`;
}

function niceDate(value) {
  return new Date(value).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long' });
}

async function applyEvent(event, data) {
  data = data || {};
  const vendor = await findVendor(data);
  const vendorId = vendor ? vendor.id : null;
  const amount = Number(data.amount) || null;

  if (event === 'charge.success') {
    const key = String(data.reference || data.id || crypto.randomUUID());
    const fresh = await remember(event, key, vendorId, amount, data);
    if (!fresh || !vendor || data.status !== 'success' || !isProPayment(data)) return { applied: false };
    const wasPro = vendor.plan === 'pro';
    const customerCode = (data.customer && data.customer.customer_code) || null;
    const [row] = await sql`
      UPDATE vendors SET
        plan = 'pro',
        -- a month on top of any time still left (e.g. Pro given by an admin)
        plan_renews_at = greatest(coalesce(plan_renews_at, now()), now()) + interval '1 month',
        paystack_customer_code = coalesce(${customerCode}, paystack_customer_code),
        updated_at = now()
      WHERE id = ${vendor.id}
      RETURNING plan_renews_at
    `;
    await notify(vendor.id, 'plan_renewed', wasPro
      ? `Payment received. You're on Pro until ${niceDate(row.plan_renews_at)}.`
      : "You're on Pro. Unlimited orders, no OrderPadi branding, and full sales reports are on.");
    return { applied: true };
  }

  if (event === 'subscription.create') {
    const code = String(data.subscription_code || '');
    const fresh = await remember(event, code || crypto.randomUUID(), vendorId, amount, data);
    if (!fresh || !vendor || !code) return { applied: false };
    const customerCode = (data.customer && data.customer.customer_code) || null;
    await sql`
      UPDATE vendors SET
        plan = 'pro',
        paystack_subscription_code = ${code},
        paystack_customer_code = coalesce(${customerCode}, paystack_customer_code),
        plan_renews_at = coalesce(${data.next_payment_date || null}::timestamptz, plan_renews_at, now() + interval '1 month'),
        updated_at = now()
      WHERE id = ${vendor.id}
    `;
    return { applied: true };
  }

  if (event === 'subscription.not_renew' || event === 'subscription.disable') {
    const code = String(data.subscription_code || '');
    const fresh = await remember(event, code || crypto.randomUUID(), vendorId, amount, data);
    if (!fresh || !vendor) return { applied: false };
    // Ignore an old subscription if the seller has since started a new one.
    if (vendor.paystack_subscription_code && code && vendor.paystack_subscription_code !== code) return { applied: false };
    if (event === 'subscription.not_renew') {
      const ends = vendor.plan_renews_at ? niceDate(vendor.plan_renews_at) : 'the end of this month';
      await notify(vendor.id, 'plan_ending', `Your Pro plan won't renew. It stays on until ${ends}, then you're back on the free plan (20 orders a month).`);
    } else {
      await sql`UPDATE vendors SET plan = 'free', updated_at = now() WHERE id = ${vendor.id}`;
      await notify(vendor.id, 'plan_ending', "Your Pro plan has ended, so you're back on the free plan (20 orders a month). You can upgrade again any time in Settings.");
    }
    return { applied: true };
  }

  if (event === 'invoice.payment_failed') {
    const key = String(data.invoice_code || data.id || crypto.randomUUID());
    const fresh = await remember(event, key, vendorId, amount, data);
    if (!fresh || !vendor) return { applied: false };
    await notify(vendor.id, 'plan_ending', "We couldn't charge your card for Pro. Update it in Settings → Plan so your store keeps unlimited orders.");
    return { applied: true };
  }

  // Anything else: keep a record, change nothing.
  await remember(event || 'unknown', String(data.reference || data.id || data.subscription_code || crypto.randomUUID()), vendorId, amount, data);
  return { applied: false };
}

module.exports = { configured, paystack, signatureValid, metadata, applyEvent };
