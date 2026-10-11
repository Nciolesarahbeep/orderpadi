// Admin panel API, used by /admin. Only admins can use it: anyone marked
// is_admin in the database, or whose email is in ADMIN_EMAILS in Netlify.
// Everyone else gets "Not found", so the panel's existence isn't advertised.
//
//   GET  /api/admin?view=overview                      -> numbers + system checks
//   GET  /api/admin?view=sellers&q=&filter=&before=    -> sellers, 50 at a time
//   GET  /api/admin?id=<sellerId>                      -> one seller + account history
//   GET  /api/admin?view=events                        -> latest payments and admin actions
//   POST /api/admin { action: "grant-pro", id, months }   months: 1, 3 or 12
//   POST /api/admin { action: "end-pro", id }             also cancels their Paystack subscription
//   POST /api/admin { action: "suspend", id, reason }     store and invoices go offline, logged out
//   POST /api/admin { action: "unsuspend", id }
//   POST /api/admin { action: "sign-out", id }            ends every login session
//
// Every action is written to billing_events as "admin.<action>" with who did it.
const crypto = require('crypto');
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor, isAdmin, endAllSessions } = require('../lib/auth');
const { FREE_MONTHLY_ORDERS, PRO_PRICE_KOBO, GRACE_DAYS, isPro } = require('../lib/plan');
const { configured, paystack } = require('../lib/paystack');
const { checkHealth } = require('../lib/health');

const PAGE_SIZE = 50;
const FILTERS = ['all', 'pro', 'free', 'limit', 'suspended', 'unverified'];

function readId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'That seller id looks wrong.');
  return id;
}

// ---------- overview ----------
async function overview() {
  const [n] = await sql`
    WITH b AS (
      SELECT date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS today,
             date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS month
    ), pro AS (
      SELECT id, paystack_subscription_code FROM vendors
      WHERE plan = 'pro' AND (plan_renews_at IS NULL OR plan_renews_at > now() - make_interval(days => ${GRACE_DAYS}))
    )
    SELECT
      (SELECT count(*) FROM vendors WHERE email_verified)::int AS sellers,
      (SELECT count(*) FROM vendors WHERE NOT email_verified)::int AS unverified,
      (SELECT count(*) FROM vendors WHERE email_verified AND created_at >= b.today)::int AS new_today,
      (SELECT count(*) FROM vendors WHERE email_verified AND created_at >= now() - interval '7 days')::int AS new_7d,
      (SELECT count(*) FROM vendors WHERE email_verified AND created_at >= now() - interval '30 days')::int AS new_30d,
      (SELECT count(*) FROM vendors WHERE is_suspended)::int AS suspended,
      (SELECT count(*) FROM pro WHERE paystack_subscription_code IS NOT NULL)::int AS pro_paying,
      (SELECT count(*) FROM pro WHERE paystack_subscription_code IS NULL)::int AS pro_given,
      (SELECT count(*) FROM vendor_month_usage u
         WHERE u.orders_this_month >= ${FREE_MONTHLY_ORDERS} AND u.vendor_id NOT IN (SELECT id FROM pro))::int AS at_limit,
      (SELECT count(DISTINCT vendor_id) FROM orders WHERE created_at >= now() - interval '7 days')::int AS active_7d,
      (SELECT count(*) FROM orders WHERE created_at >= b.today)::int AS orders_today,
      (SELECT count(*) FROM orders WHERE created_at >= now() - interval '7 days')::int AS orders_7d,
      (SELECT count(*) FROM orders WHERE created_at >= b.month)::int AS orders_month,
      (SELECT coalesce(sum(total_kobo), 0) FROM orders WHERE status <> 'cancelled' AND created_at >= b.month)::bigint AS value_month,
      (SELECT coalesce(sum(amount_kobo), 0) FROM billing_events
         WHERE event = 'charge.success' AND vendor_id IS NOT NULL AND payload->>'status' = 'success'
           AND created_at >= now() - interval '30 days')::bigint AS collected_30d
    FROM b
  `;
  const days = await sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS day, count(v.id)::int AS signups
    FROM generate_series(
      date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') - interval '13 days',
      date_trunc('day', now() AT TIME ZONE 'Africa/Lagos'),
      interval '1 day'
    ) AS d
    LEFT JOIN vendors v ON v.email_verified AND date_trunc('day', v.created_at AT TIME ZONE 'Africa/Lagos') = d
    GROUP BY d ORDER BY d
  `;
  const num = (k) => Number(n[k]);
  return {
    sellers: { total: num('sellers'), unverified: num('unverified'), today: num('new_today'), week: num('new_7d'), month: num('new_30d'), suspended: num('suspended'), activeWeek: num('active_7d'), atLimit: num('at_limit') },
    pro: { paying: num('pro_paying'), given: num('pro_given'), mrrKobo: num('pro_paying') * PRO_PRICE_KOBO, collected30dKobo: num('collected_30d') },
    orders: { today: num('orders_today'), week: num('orders_7d'), month: num('orders_month'), valueMonthKobo: num('value_month') },
    signups: days.map((d) => ({ day: d.day, count: Number(d.signups) })),
    health: await checkHealth()
  };
}

// ---------- sellers ----------
function sellerRow(v) {
  return {
    id: Number(v.id),
    businessName: v.business_name,
    slug: v.slug,
    email: v.email,
    verified: !!v.email_verified,
    plan: isPro(v) ? 'pro' : 'free',
    planRenewsAt: v.plan_renews_at || null,
    paying: isPro(v) && !!v.paystack_subscription_code,
    suspended: !!v.is_suspended,
    admin: isAdmin(v),
    joinedAt: v.created_at,
    ordersThisMonth: Number(v.orders_this_month || 0),
    ordersTotal: Number(v.orders_total || 0),
    lastOrderAt: v.last_order_at || null
  };
}

async function sellers(params) {
  const filter = FILTERS.includes(params.get('filter')) ? params.get('filter') : 'all';
  const q = String(params.get('q') || '').trim().slice(0, 80);
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const before = Math.max(0, Number(params.get('before')) || 0);
  const rows = await sql`
    SELECT * FROM (
      SELECT v.*, coalesce(u.orders_this_month, 0)::int AS orders_this_month,
        (SELECT count(*) FROM orders o WHERE o.vendor_id = v.id)::int AS orders_total,
        (SELECT max(o.created_at) FROM orders o WHERE o.vendor_id = v.id) AS last_order_at,
        (v.plan = 'pro' AND (v.plan_renews_at IS NULL OR v.plan_renews_at > now() - make_interval(days => ${GRACE_DAYS}))) AS pro_now
      FROM vendors v
      LEFT JOIN vendor_month_usage u ON u.vendor_id = v.id
      WHERE (${q} = '' OR v.business_name ILIKE ${like} OR v.email ILIKE ${like} OR v.slug ILIKE ${like})
        AND (${before} = 0 OR v.id < ${before})
    ) s
    WHERE ${filter} = 'all'
       OR (${filter} = 'pro' AND s.pro_now)
       OR (${filter} = 'free' AND NOT s.pro_now)
       OR (${filter} = 'limit' AND NOT s.pro_now AND s.orders_this_month >= ${FREE_MONTHLY_ORDERS})
       OR (${filter} = 'suspended' AND s.is_suspended)
       OR (${filter} = 'unverified' AND NOT s.email_verified)
    ORDER BY s.id DESC
    LIMIT ${PAGE_SIZE + 1}
  `;
  const page = rows.slice(0, PAGE_SIZE);
  return {
    sellers: page.map(sellerRow),
    hasMore: rows.length > PAGE_SIZE,
    nextBefore: page.length ? Number(page[page.length - 1].id) : null
  };
}

async function sellerDetail(id) {
  const [v] = await sql`
    SELECT v.*, coalesce(u.orders_this_month, 0)::int AS orders_this_month,
      (SELECT count(*) FROM orders o WHERE o.vendor_id = v.id)::int AS orders_total,
      (SELECT max(o.created_at) FROM orders o WHERE o.vendor_id = v.id) AS last_order_at,
      (SELECT count(*) FROM products p WHERE p.vendor_id = v.id AND p.is_active)::int AS products,
      (SELECT count(*) FROM customers c WHERE c.vendor_id = v.id)::int AS customers,
      (SELECT coalesce(sum(o.total_kobo - o.amount_paid_kobo), 0) FROM orders o
         WHERE o.vendor_id = v.id AND o.status <> 'cancelled' AND o.payment_status <> 'paid')::bigint AS owed,
      (SELECT coalesce(sum(p.amount_kobo), 0) FROM payments p WHERE p.vendor_id = v.id)::bigint AS received,
      (SELECT max(s.created_at) FROM user_sessions s WHERE s.vendor_id = v.id) AS last_login_at,
      (SELECT count(*) FROM user_sessions s WHERE s.vendor_id = v.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS live_sessions
    FROM vendors v
    LEFT JOIN vendor_month_usage u ON u.vendor_id = v.id
    WHERE v.id = ${id}
  `;
  if (!v) throw new HttpError(404, 'No seller with that id.');
  const events = await sql`
    SELECT event, amount_kobo, payload->>'by' AS by, payload->>'reason' AS reason, payload->>'months' AS months, created_at
    FROM billing_events WHERE vendor_id = ${id}
    ORDER BY id DESC LIMIT 30
  `;
  return {
    seller: {
      ...sellerRow(v),
      whatsappPhone: v.whatsapp_phone || null,
      hasBank: !!(v.bank_name && v.bank_account_number),
      paystackCustomer: v.paystack_customer_code || null,
      paystackSubscription: v.paystack_subscription_code || null,
      products: Number(v.products),
      customers: Number(v.customers),
      owedKobo: Number(v.owed),
      receivedKobo: Number(v.received),
      lastLoginAt: v.last_login_at || null,
      liveSessions: Number(v.live_sessions)
    },
    events: events.map((e) => ({
      event: e.event,
      amountKobo: e.amount_kobo == null ? null : Number(e.amount_kobo),
      by: e.by || null,
      reason: e.reason || null,
      months: e.months ? Number(e.months) : null,
      at: e.created_at
    }))
  };
}

async function events() {
  const rows = await sql`
    SELECT e.event, e.amount_kobo, e.vendor_id, e.payload->>'by' AS by, e.payload->>'reason' AS reason,
           e.payload->>'months' AS months, e.created_at, v.business_name
    FROM billing_events e LEFT JOIN vendors v ON v.id = e.vendor_id
    ORDER BY e.id DESC LIMIT 50
  `;
  return {
    events: rows.map((e) => ({
      event: e.event,
      amountKobo: e.amount_kobo == null ? null : Number(e.amount_kobo),
      sellerId: e.vendor_id == null ? null : Number(e.vendor_id),
      businessName: e.business_name || null,
      by: e.by || null,
      reason: e.reason || null,
      months: e.months ? Number(e.months) : null,
      at: e.created_at
    }))
  };
}

// ---------- actions ----------
async function logAction(admin, sellerId, action, extra = {}) {
  await sql`
    INSERT INTO billing_events (vendor_id, event, dedupe_key, payload)
    VALUES (${sellerId}, ${'admin.' + action}, ${crypto.randomUUID()}, ${JSON.stringify({ by: admin.email, ...extra })}::jsonb)
  `;
}

async function notify(sellerId, type, message) {
  await sql`INSERT INTO notifications (vendor_id, type, message) VALUES (${sellerId}, ${type}, ${message})`;
}

function niceDate(value) {
  return new Date(value).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' });
}

async function loadTarget(id) {
  const [v] = await sql`SELECT * FROM vendors WHERE id = ${id}`;
  if (!v) throw new HttpError(404, 'No seller with that id.');
  return v;
}

async function grantPro(admin, target, months) {
  if (![1, 3, 12].includes(months)) throw new HttpError(400, 'Choose 1, 3 or 12 months.');
  const [row] = await sql`
    UPDATE vendors SET
      plan = 'pro',
      plan_renews_at = greatest(coalesce(plan_renews_at, now()), now()) + make_interval(months => ${months}),
      updated_at = now()
    WHERE id = ${target.id}
    RETURNING plan_renews_at
  `;
  await logAction(admin, target.id, 'grant-pro', { months });
  await notify(target.id, 'plan_renewed', `You've been given Pro until ${niceDate(row.plan_renews_at)}. Unlimited orders, no OrderPadi branding, and full sales reports are on.`);
  return {};
}

// Paystack needs the subscription's email token to cancel it.
async function cancelSubscription(code) {
  const sub = await paystack(`/subscription/${encodeURIComponent(code)}`);
  await paystack('/subscription/disable', { method: 'POST', body: { code, token: sub.email_token } });
}

async function endPro(admin, target) {
  let warning = null;
  let cancelled = false;
  const code = target.paystack_subscription_code;
  if (code) {
    if (!configured()) {
      warning = 'Paystack keys are not set, so their Paystack subscription was not cancelled. Cancel it in your Paystack dashboard.';
    } else {
      try {
        await cancelSubscription(code);
        cancelled = true;
        // Paystack will confirm with a subscription.disable webhook; mark it
        // as already handled so the seller isn't told twice.
        await sql`
          INSERT INTO billing_events (vendor_id, event, dedupe_key, payload)
          VALUES (${target.id}, 'subscription.disable', ${code}, ${JSON.stringify({ by: admin.email, source: 'admin' })}::jsonb)
          ON CONFLICT (event, dedupe_key) DO NOTHING
        `;
      } catch (err) {
        warning = `Couldn't cancel their Paystack subscription (${err.message}). Cancel it in your Paystack dashboard so they aren't charged again.`;
      }
    }
  }
  await sql`
    UPDATE vendors SET
      plan = 'free',
      plan_renews_at = NULL,
      paystack_subscription_code = CASE WHEN ${cancelled} THEN NULL ELSE paystack_subscription_code END,
      updated_at = now()
    WHERE id = ${target.id}
  `;
  await logAction(admin, target.id, 'end-pro', { cancelledPaystack: cancelled });
  await notify(target.id, 'plan_ending', `Your Pro plan has ended, so you're back on the free plan (${FREE_MONTHLY_ORDERS} orders a month). You can upgrade again any time in Settings.`);
  return warning ? { warning } : {};
}

async function suspend(admin, target, reason) {
  if (Number(target.id) === Number(admin.id)) throw new HttpError(400, "You can't suspend your own account.");
  if (isAdmin(target)) throw new HttpError(400, "Admins can't be suspended here. Remove them from ADMIN_EMAILS first.");
  const why = String(reason || '').trim().slice(0, 300);
  if (why.length < 3) throw new HttpError(400, 'Write a short reason, so there is a record of why.', { field: 'reason' });
  await sql`UPDATE vendors SET is_suspended = TRUE, updated_at = now() WHERE id = ${target.id}`;
  await endAllSessions(target.id);
  await logAction(admin, target.id, 'suspend', { reason: why });
  return {};
}

async function unsuspend(admin, target) {
  await sql`UPDATE vendors SET is_suspended = FALSE, updated_at = now() WHERE id = ${target.id}`;
  await logAction(admin, target.id, 'unsuspend');
  return {};
}

async function signOut(admin, target) {
  await endAllSessions(target.id);
  await logAction(admin, target.id, 'sign-out');
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    if (!sql) return res.status(500).json({ error: 'The database is not connected (DATABASE_URL is missing).' });
    const admin = await getSessionVendor(req);
    if (!admin) return res.status(401).json({ error: 'Not logged in.' });
    if (!isAdmin(admin)) return res.status(404).json({ error: 'Not found.' });

    if (req.method === 'GET') {
      const params = new URL(req.url || '/', 'http://x').searchParams;
      if (params.get('id')) return res.status(200).json(await sellerDetail(readId(params.get('id'))));
      if (params.get('view') === 'sellers') return res.status(200).json(await sellers(params));
      if (params.get('view') === 'events') return res.status(200).json(await events());
      return res.status(200).json(await overview());
    }

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const actions = {
      'grant-pro': (t) => grantPro(admin, t, Number(body.months)),
      'end-pro': (t) => endPro(admin, t),
      suspend: (t) => suspend(admin, t, body.reason),
      unsuspend: (t) => unsuspend(admin, t),
      'sign-out': (t) => signOut(admin, t)
    };
    const run = actions[body.action];
    if (!run) return res.status(400).json({ error: 'Unknown action.' });
    const target = await loadTarget(readId(body.id));
    const extra = await run(target);
    return res.status(200).json({ ...(await sellerDetail(Number(target.id))), ...extra });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
