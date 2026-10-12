// Everything about getting in: sign up, confirm email, log in, log out,
// forgot/reset password, and checking whether a store link is free.
// One function routed by "action" (the same pattern as Apex's
// auth-session.js), to keep the number of server functions small.
//
// POST /api/auth  { action: "signup" | "verify" | "resend" | "login" | "logout"
//                           | "forgot" | "reset" | "check-slug", ...fields }
const { hashPassword, checkPassword: passwordMatches } = require('../lib/password');
const { sql } = require('../lib/db');
const {
  HttpError, normalizeEmail, getClientIp,
  startSession, endSession, endAllSessions, vendorForClient
} = require('../lib/auth');
const { findReferrer } = require('../lib/referrals');
const { sendCode, verifyCode } = require('../lib/otp');
const { checkLoginRateLimit, recordLoginAttempt, clearLoginFailures, pruneOldAttempts } = require('../lib/rateLimit');
const { cleanSlug, slugProblem } = require('../lib/format');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function checkEmail(email) {
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new HttpError(400, 'Enter a valid email address.', { field: 'email' });
  }
}

let dummy = null;
async function dummyHash() {
  if (!dummy) dummy = await hashPassword('not-a-real-password-' + Math.random());
  return dummy;
}

// Long enough to be safe; capped so a huge password can't slow the server down.
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Use a password of at least 8 characters.', { field: 'password' });
  }
  if (password.length > 72) {
    throw new HttpError(400, 'Use a password of 72 characters or fewer.', { field: 'password' });
  }
}

// A sign-up that never confirmed its email gives up its email and store link
// after a day, so an abandoned attempt can't hold a name forever.
async function clearStaleSignups({ email, slug }) {
  await sql`
    DELETE FROM vendors
    WHERE email_verified = FALSE
      AND updated_at < now() - interval '1 day'
      AND (email = ${email} OR slug = ${slug})
  `;
}

function codeSentResponse(res, { email, purpose, resendAfterSeconds }) {
  return res.status(200).json({ verify: true, email, purpose, resendAfterSeconds });
}

async function signup(req, res, body) {
  const email = normalizeEmail(body.email);
  const businessName = String(body.businessName || '').trim().replace(/\s+/g, ' ');
  const slug = cleanSlug(body.slug || businessName);

  if (businessName.length < 2 || businessName.length > 60) {
    throw new HttpError(400, 'Enter your business name (2 to 60 characters).', { field: 'businessName' });
  }
  const problem = slugProblem(slug);
  if (problem) throw new HttpError(400, problem, { field: 'slug' });
  checkEmail(email);
  checkPassword(body.password);

  await clearStaleSignups({ email, slug });
  const existing = await sql`SELECT id, email, slug, email_verified FROM vendors WHERE email = ${email} OR slug = ${slug}`;
  const mine = existing.find((r) => r.email === email);
  if (mine && mine.email_verified) {
    throw new HttpError(409, 'An account with this email already exists. Log in instead.', { field: 'email' });
  }
  const slugOwner = existing.find((r) => r.slug === slug);
  if (slugOwner && (!mine || String(slugOwner.id) !== String(mine.id))) {
    throw new HttpError(409, 'That store link is taken. Try another.', { field: 'slug' });
  }

  const passwordHash = await hashPassword(body.password);
  // Invited by another seller (?ref= on the sign-up link): both get a free
  // Pro month after this seller's first store order.
  const referrer = body.ref ? await findReferrer(body.ref) : null;
  const referredBy = referrer ? Number(referrer.id) : null;
  if (mine) {
    // Same email signing up again before confirming: take the new details.
    await sql`
      UPDATE vendors
      SET password_hash = ${passwordHash}, business_name = ${businessName}, slug = ${slug},
          referred_by = coalesce(${referredBy}, referred_by), updated_at = now()
      WHERE id = ${mine.id}
    `;
  } else {
    await sql`
      INSERT INTO vendors (email, password_hash, business_name, slug, referred_by)
      VALUES (${email}, ${passwordHash}, ${businessName}, ${slug}, ${referredBy})
    `;
  }

  const sent = await sendCode({ email, purpose: 'signup', ip: getClientIp(req) });
  return codeSentResponse(res, { email, purpose: 'signup', resendAfterSeconds: sent.resendAfterSeconds });
}

async function verify(req, res, body) {
  const email = normalizeEmail(body.email);
  checkEmail(email);
  await verifyCode({ email, purpose: 'signup', code: body.code });

  const rows = await sql`UPDATE vendors SET email_verified = TRUE, updated_at = now() WHERE email = ${email} RETURNING *`;
  const vendor = rows[0];
  if (!vendor) throw new HttpError(400, "We couldn't find that sign-up. Please start again.", { restart: true });
  if (vendor.is_suspended) throw new HttpError(403, 'This account has been suspended. Contact support.');

  await startSession(req, res, vendor.id);
  return res.status(200).json({ vendor: vendorForClient(vendor) });
}

async function resend(req, res, body) {
  const email = normalizeEmail(body.email);
  const purpose = body.purpose === 'reset' ? 'reset' : 'signup';
  checkEmail(email);

  const rows = purpose === 'signup'
    ? await sql`SELECT id FROM vendors WHERE email = ${email} AND email_verified = FALSE LIMIT 1`
    : await sql`SELECT id FROM vendors WHERE email = ${email} AND is_suspended = FALSE LIMIT 1`;

  let resendAfterSeconds = 60;
  if (rows.length) {
    const sent = await sendCode({ email, purpose, ip: getClientIp(req) });
    resendAfterSeconds = sent.resendAfterSeconds;
  }
  return res.status(200).json({ ok: true, resendAfterSeconds });
}

async function login(req, res, body) {
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) throw new HttpError(400, 'Enter your email and password.');

  const ip = getClientIp(req);
  const limit = await checkLoginRateLimit({ email, ip });
  if (limit.blocked) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    throw new HttpError(429, `Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password.`);
  }

  const rows = await sql`SELECT * FROM vendors WHERE email = ${email} LIMIT 1`;
  const vendor = rows[0];
  // Check a password even when the email is unknown, so timing doesn't reveal which emails have accounts.
  const passwordOk = (await passwordMatches(password, vendor ? vendor.password_hash : await dummyHash())) && !!vendor;
  if (!passwordOk) {
    await recordLoginAttempt({ email, ip, success: false });
    throw new HttpError(401, 'Wrong email or password.');
  }
  await recordLoginAttempt({ email, ip, success: true });
  if (Math.random() < 0.05) {
    pruneOldAttempts().catch((err) => console.error('Prune login_attempts error (non-fatal):', err));
  }

  if (vendor.is_suspended) throw new HttpError(403, 'This account has been suspended. Contact support.');

  // Right password but the email was never confirmed: send a code first.
  if (!vendor.email_verified) {
    const sent = await sendCode({ email, purpose: 'signup', ip });
    return codeSentResponse(res, { email, purpose: 'signup', resendAfterSeconds: sent.resendAfterSeconds });
  }

  await startSession(req, res, vendor.id);
  return res.status(200).json({ vendor: vendorForClient(vendor) });
}

async function logout(req, res) {
  await endSession(req, res);
  return res.status(200).json({ ok: true });
}

async function forgot(req, res, body) {
  const email = normalizeEmail(body.email);
  checkEmail(email);

  const rows = await sql`SELECT id FROM vendors WHERE email = ${email} AND is_suspended = FALSE LIMIT 1`;
  if (rows.length) {
    try {
      await sendCode({ email, purpose: 'reset', ip: getClientIp(req) });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      console.error('Reset code not sent:', err.message);
    }
  }
  // Same answer either way, so this can't be used to find out who has an account.
  return codeSentResponse(res, { email, purpose: 'reset', resendAfterSeconds: 60 });
}

async function reset(req, res, body) {
  const email = normalizeEmail(body.email);
  checkEmail(email);
  checkPassword(body.password); // before the code, so a weak password doesn't use up a try
  await verifyCode({ email, purpose: 'reset', code: body.code });

  const passwordHash = await hashPassword(body.password);
  const rows = await sql`
    UPDATE vendors
    SET password_hash = ${passwordHash}, email_verified = TRUE, updated_at = now()
    WHERE email = ${email}
    RETURNING *
  `;
  const vendor = rows[0];
  if (!vendor) throw new HttpError(400, "We couldn't find that account.");
  if (vendor.is_suspended) throw new HttpError(403, 'This account has been suspended. Contact support.');

  await endAllSessions(vendor.id); // sign out every other device
  await clearLoginFailures(email); // lift any lockout caused by someone else's guesses
  await startSession(req, res, vendor.id);
  return res.status(200).json({ vendor: vendorForClient(vendor) });
}

async function checkSlug(req, res, body) {
  const slug = cleanSlug(body.slug);
  const problem = slugProblem(slug);
  if (problem) return res.status(200).json({ slug, available: false, message: problem });

  const rows = await sql`
    SELECT 1 FROM vendors
    WHERE slug = ${slug}
      AND (email_verified = TRUE OR updated_at > now() - interval '1 day')
    LIMIT 1
  `;
  const taken = rows.length > 0;
  return res.status(200).json({ slug, available: !taken, message: taken ? 'That store link is taken. Try another.' : null });
}

const ACTIONS = { signup, verify, resend, login, logout, forgot, reset, 'check-slug': checkSlug };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  // JSON only: a plain form on another website can't send this content type,
  // which keeps cross-site form tricks away from the session cookie.
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    return res.status(415).json({ error: 'Send the request as JSON.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const run = ACTIONS[body.action];
  if (!run) return res.status(400).json({ error: 'Unknown action.' });

  try {
    if (!sql) throw new HttpError(500, 'The database is not connected (DATABASE_URL is missing).');
    return await run(req, res, body);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'That email or store link was just taken. Try another.' });
    }
    console.error(`Auth "${body.action}" error:`, err);
    const hint = err && /JWT_SECRET/.test(String(err.message)) ? ' (JWT_SECRET is missing on the server)' : '';
    return res.status(500).json({ error: `Something went wrong. Please try again.${hint}` });
  }
};
