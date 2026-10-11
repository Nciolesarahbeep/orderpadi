// The seller's plan.
//   GET  /api/billing                          -> plan, usage, renewal date, whether Paystack is set up
//   POST /api/billing { action: "checkout" }   -> { url } Paystack page to pay for Pro
//   POST /api/billing { action: "verify", reference } -> plan (after coming back from Paystack)
//   POST /api/billing { action: "manage" }     -> { url } Paystack page to change card or cancel
//
// Needs PAYSTACK_SECRET_KEY and PAYSTACK_PLAN_CODE (a ₦2,500 monthly plan
// created in the Paystack dashboard) in Netlify's environment variables.
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { usage, isPro, PRO_PRICE_KOBO, FREE_MONTHLY_ORDERS } = require('../lib/plan');
const { configured, paystack, metadata, applyEvent } = require('../lib/paystack');

async function billingState(vendor) {
  const u = await usage(vendor);
  return {
    ...u,
    freeLimit: FREE_MONTHLY_ORDERS,
    priceKobo: PRO_PRICE_KOBO,
    planRenewsAt: isPro(vendor) ? vendor.plan_renews_at : null,
    hasSubscription: !!vendor.paystack_subscription_code,
    configured: configured()
  };
}

function siteOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${host}`;
}

function requireConfigured() {
  if (!configured()) throw new HttpError(503, "Payments aren't set up yet. Add PAYSTACK_SECRET_KEY and PAYSTACK_PLAN_CODE in Netlify.");
}

async function checkout(req, vendor) {
  requireConfigured();
  if (isPro(vendor) && vendor.paystack_subscription_code) {
    throw new HttpError(409, "You're already on Pro. Use \"Manage subscription\" to change your card.");
  }
  const data = await paystack('/transaction/initialize', {
    method: 'POST',
    body: {
      email: vendor.email,
      amount: PRO_PRICE_KOBO,
      plan: process.env.PAYSTACK_PLAN_CODE,
      callback_url: `${siteOrigin(req)}/app`,
      metadata: { vendor_id: Number(vendor.id), purpose: 'orderpadi_pro' }
    }
  });
  return { url: data.authorization_url };
}

// Back from Paystack: confirm the payment ourselves instead of waiting for the webhook.
async function verify(vendor, body) {
  requireConfigured();
  const reference = String(body.reference || '').trim();
  if (!/^[A-Za-z0-9_.=-]{4,100}$/.test(reference)) throw new HttpError(400, 'That payment reference looks wrong.');
  const data = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  const meta = metadata(data);
  const email = String((data.customer && data.customer.email) || '').toLowerCase();
  const mine = Number(meta.vendor_id) === Number(vendor.id) || (!meta.vendor_id && email === vendor.email);
  if (!mine) throw new HttpError(403, "That payment doesn't belong to this account.");
  if (data.status === 'success') await applyEvent('charge.success', data);
  const [fresh] = await sql`SELECT * FROM vendors WHERE id = ${vendor.id}`;
  return { ...(await billingState(fresh)), paymentStatus: data.status };
}

async function manage(vendor) {
  requireConfigured();
  if (!vendor.paystack_subscription_code) throw new HttpError(400, "There's no Pro subscription on this account yet.");
  const data = await paystack(`/subscription/${encodeURIComponent(vendor.paystack_subscription_code)}/manage/link`);
  return { url: data.link };
}

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
    if (req.method === 'GET') return res.status(200).json(await billingState(vendor));

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'checkout') return res.status(200).json(await checkout(req, vendor));
    if (body.action === 'verify') return res.status(200).json(await verify(vendor, body));
    if (body.action === 'manage') return res.status(200).json(await manage(vendor));
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Billing error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
