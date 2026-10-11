// Plans: Free (20 orders a month) and Pro (unlimited, ₦2,500/month via Paystack).
// "Pro" is checked from the vendor row, with a few days' grace after the
// renewal date in case a renewal webhook arrives late.
const { sql } = require('./db');

const FREE_MONTHLY_ORDERS = 20;
const PRO_PRICE_KOBO = 250000;
const GRACE_DAYS = 3;

function isPro(vendor) {
  if (!vendor || vendor.plan !== 'pro') return false;
  if (!vendor.plan_renews_at) return true;
  return new Date(vendor.plan_renews_at).getTime() + GRACE_DAYS * 86400000 > Date.now();
}

// Orders created this calendar month, Lagos time (cancelled ones count too,
// so cancelling can't be used to get around the limit).
async function ordersThisMonth(vendorId) {
  const rows = await sql`SELECT orders_this_month FROM vendor_month_usage WHERE vendor_id = ${vendorId}`;
  return rows.length ? Number(rows[0].orders_this_month) : 0;
}

async function usage(vendor) {
  const pro = isPro(vendor);
  const used = await ordersThisMonth(vendor.id);
  return {
    plan: pro ? 'pro' : 'free',
    used,
    limit: pro ? null : FREE_MONTHLY_ORDERS,
    remaining: pro ? null : Math.max(0, FREE_MONTHLY_ORDERS - used),
    capReached: !pro && used >= FREE_MONTHLY_ORDERS
  };
}

// "October" and "1 November" in Lagos time, for messages about the limit.
function monthWords(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', year: 'numeric', month: 'numeric' })
      .formatToParts(now).map((p) => [p.type, p.value])
  );
  const month = now.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', month: 'long' });
  const next = new Date(Date.UTC(Number(parts.year), Number(parts.month), 1))
    .toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long' });
  return { month, next };
}

// Called after a free-plan order is saved: warns at 5 left, and when the
// limit is reached.
async function noteUsage(vendor) {
  if (isPro(vendor)) return;
  const used = await ordersThisMonth(vendor.id);
  const { month, next } = monthWords();
  let type;
  let message;
  if (used === FREE_MONTHLY_ORDERS) {
    type = 'cap_reached';
    message = `You've used all ${FREE_MONTHLY_ORDERS} free orders for ${month}. Until ${next}, your store link takes orders on WhatsApp only. Upgrade to Pro for unlimited orders.`;
  } else if (used === FREE_MONTHLY_ORDERS - 5) {
    type = 'cap_warning';
    message = `5 free orders left for ${month}. Upgrade to Pro for unlimited orders.`;
  } else {
    return;
  }
  await sql`INSERT INTO notifications (vendor_id, type, message) VALUES (${vendor.id}, ${type}, ${message})`;
}

module.exports = { FREE_MONTHLY_ORDERS, PRO_PRICE_KOBO, GRACE_DAYS, isPro, ordersThisMonth, usage, monthWords, noteUsage };
