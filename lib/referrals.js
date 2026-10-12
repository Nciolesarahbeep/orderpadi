// Referrals: a seller shares their invite link (/app?start=signup&ref=CODE).
// When the seller they invited gets their first order through their store
// link, both get a free month of Pro.
const crypto = require('crypto');
const { sql } = require('./db');

const REWARD_DAYS = 30;

const cleanRef = (raw) => String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

// The seller's code, made the first time it's needed: up to 4 letters of the
// business name and 2 random characters, like ADAW7K.
async function ensureReferralCode(vendor) {
  if (vendor.referral_code) return vendor.referral_code;
  const letters = (String(vendor.business_name || '').toUpperCase().replace(/[^A-Z]/g, '') + 'SHOP').slice(0, 4);
  for (let i = 0; i < 8; i++) {
    const tail = crypto.randomBytes(2).toString('hex').toUpperCase().replace(/[01]/g, 'X').slice(0, i < 4 ? 2 : 3);
    const code = letters + tail;
    const rows = await sql`
      UPDATE vendors SET referral_code = ${code}
      WHERE id = ${vendor.id} AND referral_code IS NULL
        AND NOT EXISTS (SELECT 1 FROM vendors WHERE referral_code = ${code})
      RETURNING referral_code
    `;
    if (rows.length) return rows[0].referral_code;
    const [again] = await sql`SELECT referral_code FROM vendors WHERE id = ${vendor.id}`;
    if (again && again.referral_code) return again.referral_code;
  }
  throw new Error('Could not make a referral code');
}

async function findReferrer(code) {
  const ref = cleanRef(code);
  if (ref.length < 4) return null;
  const [row] = await sql`
    SELECT id, business_name, slug FROM vendors
    WHERE referral_code = ${ref} AND email_verified = TRUE AND is_suspended = FALSE
    LIMIT 1
  `;
  return row || null;
}

// Gives both sellers their free month, once. Called after the invited
// seller's first store order; the order statement has already marked it.
async function rewardReferral(vendorId, referrerId) {
  const rows = await sql`
    UPDATE vendors SET
      plan = 'pro',
      plan_renews_at = greatest(coalesce(plan_renews_at, now()), now()) + make_interval(days => ${REWARD_DAYS}),
      updated_at = now()
    WHERE id IN (${vendorId}, ${referrerId}) AND is_suspended = FALSE
    RETURNING id, business_name
  `;
  const name = (id) => (rows.find((r) => Number(r.id) === Number(id)) || {}).business_name || 'A seller';
  const notes = [];
  if (rows.some((r) => Number(r.id) === Number(vendorId))) {
    notes.push([vendorId, `Your first store order is in, so you and ${name(referrerId)} both got a free month of Pro. Enjoy!`]);
  }
  if (rows.some((r) => Number(r.id) === Number(referrerId))) {
    notes.push([referrerId, `${name(vendorId)}, who joined with your invite, got their first order. You both got a free month of Pro!`]);
  }
  for (const [id, message] of notes) {
    await sql`
      WITH n AS (INSERT INTO notifications (vendor_id, type, message) VALUES (${id}, 'referral', ${message}))
      INSERT INTO billing_events (vendor_id, event, dedupe_key, payload)
      VALUES (${id}, 'referral.reward', ${'referral:' + vendorId + ':' + id}, ${JSON.stringify({ invited: Number(vendorId), referrer: Number(referrerId), days: REWARD_DAYS })}::jsonb)
      ON CONFLICT (event, dedupe_key) DO NOTHING
    `;
  }
}

module.exports = { REWARD_DAYS, cleanRef, ensureReferralCode, findReferrer, rewardReferral };
