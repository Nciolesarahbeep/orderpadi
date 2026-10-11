// Vendor sessions: a signed cookie (JWT) that points at a row in
// user_sessions, so any session can be ended from the server (logout,
// password reset). Ported from Apex Horizon Bank's lib/auth.js, with longer
// sessions: sellers shouldn't have to log in every time they open the app.
const jwt = require('./jwt');
const crypto = require('crypto');
const { sql } = require('./db');
const { isPro } = require('./plan');

const COOKIE_NAME = 'op_session';
const SESSION_DAYS = 30;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;

// An error with an HTTP status and a message that is safe to show the user.
// `extra` is merged into the JSON response (e.g. { field: 'email' }).
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const raw = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch (err) {
      cookies[key] = raw;
    }
  });
  return cookies;
}

// Add a cookie without dropping any already set on this response.
function appendSetCookie(res, cookie) {
  const prev = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  res.setHeader('Set-Cookie', [].concat(prev || [], cookie));
}

function sessionCookie(req, value, maxAgeSeconds) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  // HTTPS-only cookie on the live site (Netlify and Vercel both say so in x-forwarded-proto).
  const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  if (proto === 'https' || process.env.VERCEL || process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

async function startSession(req, res, vendorId) {
  const secret = jwtSecret();
  const jti = crypto.randomUUID();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null;
  await sql`
    INSERT INTO user_sessions (jti, vendor_id, user_agent, ip, expires_at)
    VALUES (${jti}, ${vendorId}, ${userAgent}, ${getClientIp(req)}, now() + make_interval(days => ${SESSION_DAYS}))
  `;
  const token = jwt.sign({ vid: Number(vendorId), jti }, secret, { expiresIn: SESSION_SECONDS });
  appendSetCookie(res, sessionCookie(req, token, SESSION_SECONDS));
}

// Logout: revoke this session's row and clear the cookie. Never fails the
// logout itself; the cookie is cleared regardless.
async function endSession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  let decoded = null;
  try {
    decoded = token ? jwt.decode(token) : null;
  } catch (err) {
    decoded = null;
  }
  if (decoded && decoded.jti) {
    try {
      await sql`UPDATE user_sessions SET revoked_at = now() WHERE jti = ${String(decoded.jti)} AND revoked_at IS NULL`;
    } catch (err) {
      console.error('Session revoke error (non-fatal):', err);
    }
  }
  appendSetCookie(res, sessionCookie(req, '', 0));
}

// Used after a password reset: signs the vendor out everywhere.
async function endAllSessions(vendorId) {
  await sql`UPDATE user_sessions SET revoked_at = now() WHERE vendor_id = ${vendorId} AND revoked_at IS NULL`;
}

// The logged-in vendor's full row, or null. One query checks the session is
// live and loads the vendor. Every protected API starts with this.
async function getSessionVendor(req) {
  const secret = jwtSecret();
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch (err) {
    return null;
  }
  if (!payload || !payload.jti || !payload.vid) return null;
  const rows = await sql`
    SELECT v.* FROM user_sessions s
    JOIN vendors v ON v.id = s.vendor_id
    WHERE s.jti = ${String(payload.jti)}
      AND s.vendor_id = ${Number(payload.vid)}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND v.email_verified = TRUE
      AND v.is_suspended = FALSE
    LIMIT 1
  `;
  return rows[0] || null;
}

// Admins: anyone marked is_admin in the database, or whose email is listed
// in ADMIN_EMAILS (comma-separated) in Netlify.
function isAdmin(v) {
  if (!v) return false;
  if (v.is_admin) return true;
  const list = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  return list.includes(String(v.email || '').toLowerCase());
}

// What the browser is allowed to see about a vendor (never the password hash).
function vendorForClient(v) {
  return {
    id: Number(v.id),
    email: v.email,
    businessName: v.business_name,
    slug: v.slug,
    whatsappPhone: v.whatsapp_phone || null,
    logoUrl: v.logo_url || null,
    bankName: v.bank_name || null,
    bankAccountName: v.bank_account_name || null,
    bankAccountNumber: v.bank_account_number || null,
    deliveryFeeKobo: Number(v.default_delivery_fee_kobo || 0),
    deliveryNote: v.delivery_note || null,
    storeTheme: v.store_theme || 'green',
    plan: isPro(v) ? 'pro' : 'free',
    planRenewsAt: v.plan_renews_at || null,
    isAdmin: isAdmin(v)
  };
}

module.exports = {
  HttpError,
  COOKIE_NAME,
  normalizeEmail,
  getClientIp,
  parseCookies,
  startSession,
  endSession,
  endAllSessions,
  isAdmin,
  getSessionVendor,
  vendorForClient
};
