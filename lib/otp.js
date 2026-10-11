// Six-digit email codes, used to confirm a new account's email and to reset
// a password. Codes are stored hashed, expire after 10 minutes, allow 5
// tries, and sending is throttled per email and per IP so nobody can use
// OrderPadi to flood someone's inbox.
const crypto = require('crypto');
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { sendEmail, codeEmail } = require('./email');

const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const RESEND_SECONDS = 60;
const MAX_PER_EMAIL_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 10;

function hashCode({ email, purpose, code }) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'orderpadi')
    .update(`${purpose}:${email}:${code}`)
    .digest('hex');
}

// Sends a fresh code unless one went out in the last minute (that one is
// still valid, so we just tell the page how long to wait before resending).
async function sendCode({ email, purpose, ip }) {
  const [stats] = await sql`
    SELECT
      count(*) FILTER (WHERE email = ${email})::int AS email_count,
      count(*) FILTER (WHERE ip = ${ip})::int AS ip_count,
      extract(epoch FROM now() - max(created_at) FILTER (WHERE email = ${email} AND purpose = ${purpose}))::int AS seconds_since_last
    FROM email_otps
    WHERE created_at > now() - interval '1 hour'
      AND (email = ${email} OR ip = ${ip})
  `;
  const since = stats.seconds_since_last == null ? null : Number(stats.seconds_since_last);
  if (since !== null && since < RESEND_SECONDS) {
    return { sent: false, resendAfterSeconds: RESEND_SECONDS - since };
  }
  if (Number(stats.email_count) >= MAX_PER_EMAIL_PER_HOUR || Number(stats.ip_count) >= MAX_PER_IP_PER_HOUR) {
    throw new HttpError(429, 'Too many codes requested. Please wait an hour and try again.');
  }

  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  // Only the newest code works: retire any older ones for this email.
  await sql`UPDATE email_otps SET used_at = now() WHERE email = ${email} AND purpose = ${purpose} AND used_at IS NULL`;
  const [row] = await sql`
    INSERT INTO email_otps (email, purpose, code_hash, expires_at, ip)
    VALUES (${email}, ${purpose}, ${hashCode({ email, purpose, code })}, now() + make_interval(mins => ${CODE_MINUTES}), ${ip})
    RETURNING id
  `;

  const { subject, html, text } = codeEmail({ code, purpose });
  const delivered = await sendEmail({ to: email, subject, html, text });
  if (!delivered) {
    await sql`DELETE FROM email_otps WHERE id = ${row.id}`;
    throw new HttpError(502, "We couldn't send the email just now. Please try again in a minute.");
  }

  if (Math.random() < 0.05) {
    sql`DELETE FROM email_otps WHERE created_at < now() - interval '2 days'`
      .catch((err) => console.error('Prune email_otps error (non-fatal):', err));
  }
  return { sent: true, resendAfterSeconds: RESEND_SECONDS };
}

// Throws HttpError if the code is wrong, expired or out of tries.
async function verifyCode({ email, purpose, code }) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) {
    throw new HttpError(400, 'Enter the 6-digit code from your email.', { field: 'code' });
  }

  // Count the try before checking the code, in one statement, so parallel
  // guesses can't get past the 5-try limit.
  const rows = await sql`
    UPDATE email_otps SET attempts = attempts + 1
    WHERE id = (
      SELECT id FROM email_otps
      WHERE email = ${email} AND purpose = ${purpose} AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    )
    AND attempts < ${MAX_TRIES}
    RETURNING id, code_hash, attempts
  `;
  const row = rows[0];
  if (!row) {
    throw new HttpError(400, 'This code has expired or had too many wrong tries. Tap "Send a new code".', { field: 'code', expired: true });
  }

  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(hashCode({ email, purpose, code: clean }), 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    const left = MAX_TRIES - Number(row.attempts);
    if (left <= 0) {
      throw new HttpError(400, 'Too many wrong tries. Tap "Send a new code".', { field: 'code', expired: true });
    }
    throw new HttpError(400, `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { field: 'code' });
  }

  const used = await sql`UPDATE email_otps SET used_at = now() WHERE id = ${row.id} AND used_at IS NULL RETURNING id`;
  if (!used.length) {
    throw new HttpError(400, 'This code was already used. Tap "Send a new code".', { field: 'code', expired: true });
  }
}

module.exports = { sendCode, verifyCode };
