// Setup check: confirms the database connects, schema.sql and each step's
// database update ran, and the environment variables are set. Opened by /setup.
// Delete this file before launch to free up a function slot.
const { sql } = require('../lib/db');

const EXPECTED = [
  'vendors', 'email_otps', 'user_sessions', 'login_attempts',
  'products', 'customers', 'orders', 'order_items', 'payments',
  'notifications', 'billing_events',
  'vendor_month_usage', 'customer_balances'
];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  // Only report whether each variable exists, never its value.
  const env = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL),
    JWT_SECRET: Boolean(process.env.JWT_SECRET),
    RESEND_API_KEY: Boolean(process.env.RESEND_API_KEY),
    // Only needed for Pro billing (step 7); not counted in "ok".
    PAYSTACK_SECRET_KEY: Boolean(process.env.PAYSTACK_SECRET_KEY),
    PAYSTACK_PLAN_CODE: Boolean(process.env.PAYSTACK_PLAN_CODE)
  };

  if (!sql) {
    return res.status(500).json({ ok: false, db: false, missing: EXPECTED, env, error: 'DATABASE_URL is not set' });
  }

  try {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    const found = new Set(rows.map((r) => r.table_name));
    const missing = EXPECTED.filter((name) => !found.has(name));

    // Database updates added after schema.sql, one entry per step.
    const otpIp = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_otps' AND column_name = 'ip'
    `;
    const migrations = { step2: otpIp.length > 0 };

    const ok = missing.length === 0 && migrations.step2 && env.JWT_SECRET && env.RESEND_API_KEY;
    return res.status(200).json({ ok, db: true, missing, migrations, env });
  } catch (err) {
    console.error('Health check failed:', err);
    return res.status(500).json({ ok: false, db: false, missing: EXPECTED, env, error: 'Could not connect to the database' });
  }
};
