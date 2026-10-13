// Setup checks shared by /api/health (the public /setup page, used before
// anyone can log in) and the admin panel's System section.
// Only ever reports whether a setting exists, never its value.
const { sql } = require('./db');

const EXPECTED = [
  'vendors', 'email_otps', 'user_sessions', 'login_attempts',
  'products', 'customers', 'orders', 'order_items', 'payments',
  'notifications', 'billing_events',
  'vendor_month_usage', 'customer_balances'
];

function envStatus() {
  const netlify = globalThis.Netlify && globalThis.Netlify.env;
  const has = (name) => Boolean(String(process.env[name] || (netlify && netlify.get(name)) || '').trim());
  return {
    DATABASE_URL: has('DATABASE_URL') || has('POSTGRES_URL'),
    JWT_SECRET: has('JWT_SECRET'),
    RESEND_API_KEY: has('RESEND_API_KEY'),
    // Needed before launch, but the app runs without them:
    EMAIL_FROM: has('EMAIL_FROM'),               // a verified Resend domain, so anyone can get codes
    PAYSTACK_SECRET_KEY: has('PAYSTACK_SECRET_KEY'),
    PAYSTACK_PLAN_CODE: has('PAYSTACK_PLAN_CODE'),
    ADMIN_EMAILS: has('ADMIN_EMAILS'),
    SUPPORT_CONTACT: has('SUPPORT_EMAIL') || has('SUPPORT_WHATSAPP')
  };
}

async function checkHealth() {
  const env = envStatus();
  if (!env.DATABASE_URL) return { ok: false, db: false, missing: EXPECTED, migrations: {}, env, error: 'DATABASE_URL is not set' };
  try {
    const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const found = new Set(rows.map((r) => r.table_name));
    const missing = EXPECTED.filter((name) => !found.has(name));
    // Database updates added after schema.sql, one entry per step.
    const otpIp = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_otps' AND column_name = 'ip'
    `;
    const [redesign] = await sql`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'store_theme') AS theme,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'product_photos') AS photos
    `;
    const [catalog] = await sql`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'options') AS options,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'option_text') AS picked
    `;
    const [tools] = await sql`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'order_events') AS events,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'choice_stock') AS stock,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'delivery_zones') AS zones
    `;
    const [grow] = await sql`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reviews') AS reviews,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'promo_codes') AS promos,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'in_directory') AS directory
    `;
    const [earn] = await sql`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'supply_orders') AS supply,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'referred_by') AS referrals,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_resale') AS resale
    `;
    const [alerts] = await sql`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'push_subscriptions') AS push,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'broadcasts') AS broadcasts,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'expenses') AS expenses,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'cost_kobo') AS cost
    `;
    const migrations = {
      step2: otpIp.length > 0,
      step3: !!(redesign && redesign.theme && redesign.photos),
      step4: !!(catalog && catalog.options && catalog.picked),
      step5: !!(tools && tools.events && tools.stock && tools.zones),
      step6: !!(grow && grow.reviews && grow.promos && grow.directory),
      step7: !!(earn && earn.supply && earn.referrals && earn.resale),
      step8: !!(alerts && alerts.push && alerts.broadcasts && alerts.expenses && alerts.cost)
    };
    const ok = missing.length === 0 && Object.values(migrations).every(Boolean) && env.JWT_SECRET && env.RESEND_API_KEY;
    return { ok, db: true, missing, migrations, env };
  } catch (err) {
    console.error('Health check failed:', err);
    return { ok: false, db: false, missing: EXPECTED, migrations: {}, env, error: 'Could not connect to the database' };
  }
}

module.exports = { checkHealth, envStatus };
