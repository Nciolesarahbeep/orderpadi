// Phone alerts (web push) for sellers. When something lands in a seller's
// bell (a new order, "I've paid", a review…), it also pops up on every phone
// where they turned alerts on, even with the app closed.
//
// No npm packages: each message is encrypted for the phone (RFC 8291,
// "aes128gcm") and signed with the server's VAPID key (RFC 8292) using
// Node's own crypto, then posted to the phone's push service.
const crypto = require('crypto');
const { sql } = require('./db');
// HttpError is loaded when needed: lib/auth.js loads lib/plan.js, which uses this file.
function HttpError(status, message, extra) {
  const { HttpError: E } = require('./auth');
  return new E(status, message, extra);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s == null ? '' : s), 'base64url');

const MAX_DEVICES = 10;        // phones and browsers per seller
const PUSH_WINDOW_MINUTES = 10; // older bell items are never sent as alerts
const PER_FLUSH = 3;           // alerts per seller per request; the rest wait in the bell

// The push services browsers use. The server only ever posts to these.
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,        // Chrome, Samsung Internet, Opera, Edge on Android
  /(^|\.)android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)push\.apple\.com$/,            // Safari on iPhone (home screen app) and Mac
  /(^|\.)notify\.windows\.com$/         // Edge on Windows
];

function env(name) {
  const netlify = globalThis.Netlify && globalThis.Netlify.env;
  return String(process.env[name] || (netlify && netlify.get(name)) || '').trim();
}

// ---------- keys ----------
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the host's settings win; otherwise
// a key pair is made once and kept in the database, so alerts work with no setup.
let cachedKeys = null;
async function vapidKeys() {
  if (cachedKeys) return cachedKeys;
  const pub = env('VAPID_PUBLIC_KEY');
  const priv = env('VAPID_PRIVATE_KEY');
  if (pub && priv) return (cachedKeys = { publicKey: pub, privateKey: priv });
  const [row] = await sql`SELECT value FROM app_keys WHERE name = 'vapid'`;
  if (row && row.value && row.value.publicKey) return (cachedKeys = row.value);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const made = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pad32(ecdh.getPrivateKey())) };
  await sql`INSERT INTO app_keys (name, value) VALUES ('vapid', ${JSON.stringify(made)}::jsonb) ON CONFLICT (name) DO NOTHING`;
  const [saved] = await sql`SELECT value FROM app_keys WHERE name = 'vapid'`;
  return (cachedKeys = saved.value);
}

function pad32(buf) {
  return buf.length >= 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
}

function subject() {
  const email = env('SUPPORT_EMAIL');
  if (email && /^[^\s@]+@[^\s@]+$/.test(email)) return 'mailto:' + email;
  const site = env('URL') || env('APP_URL');
  return /^https:\/\//.test(site) ? site : 'https://orderpadi.netlify.app';
}

// "vapid t=<signed token>, k=<public key>": proves the alert comes from us.
function vapidHeader(endpoint, keys, now = Date.now()) {
  const pub = fromB64u(keys.publicKey);
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(pad32(fromB64u(keys.privateKey))), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk'
  });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject() }));
  const data = head + '.' + claims;
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ---------- encryption (RFC 8291) ----------
// `fixed` is only for tests: { privateKey, salt } to reproduce known output.
function encrypt(p256dh, authSecret, payload, fixed = {}) {
  const uaPublic = fromB64u(p256dh);
  const auth = fromB64u(authSecret);
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed.privateKey) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt || crypto.randomBytes(16);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const one = Buffer.from([1]);
  const zero = Buffer.from([0]);

  const prkKey = hmac(auth, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info'), zero, uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, one]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), zero, one])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce'), zero, one])).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the message, then 0x02 to mark it as the last one.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

// ---------- subscriptions ----------
function allowedEndpoint(url) {
  const test = env('PUSH_TEST_ENDPOINT'); // local tests only: a fake push service
  if (test && url.startsWith(test)) return true;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

function readSubscription(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const endpoint = String(s.endpoint || '');
  const keys = s.keys && typeof s.keys === 'object' ? s.keys : {};
  if (!endpoint || endpoint.length > 1000 || !allowedEndpoint(endpoint)) {
    throw HttpError(400, "This browser's alert service isn't supported. Try Chrome or Safari.");
  }
  const p256dh = fromB64u(keys.p256dh);
  const auth = fromB64u(keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length < 16 || auth.length > 64) {
    throw HttpError(400, 'The alert details from this browser look wrong. Turn alerts off and on again.');
  }
  return { endpoint, p256dh: b64u(p256dh), auth: b64u(auth) };
}

function deviceOf(userAgent) {
  const ua = String(userAgent || '');
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Computer';
}

// Logins that are still live: alerts stop when the seller logs out.
async function liveDevices(vendorId) {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM push_subscriptions ps
    WHERE ps.vendor_id = ${vendorId}
      AND EXISTS (SELECT 1 FROM user_sessions s WHERE s.jti = ps.session_jti AND s.vendor_id = ps.vendor_id
                  AND s.revoked_at IS NULL AND s.expires_at > now())
  `;
  return Number(row.n);
}

async function saveSubscription(vendorId, sessionJti, raw, userAgent) {
  const sub = readSubscription(raw);
  await sql`
    WITH up AS (
      INSERT INTO push_subscriptions (vendor_id, session_jti, endpoint, p256dh, auth, device)
      VALUES (${vendorId}, ${sessionJti}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth}, ${deviceOf(userAgent)})
      ON CONFLICT (endpoint) DO UPDATE SET
        vendor_id = EXCLUDED.vendor_id, session_jti = EXCLUDED.session_jti, p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth, device = EXCLUDED.device, failures = 0
      RETURNING id
    ),
    -- what's already in the bell isn't sent again
    seen AS (
      UPDATE notifications SET pushed_at = now() WHERE vendor_id = ${vendorId} AND pushed_at IS NULL
    )
    DELETE FROM push_subscriptions
    WHERE vendor_id = ${vendorId}
      AND id NOT IN (SELECT id FROM up)
      AND id NOT IN (SELECT id FROM push_subscriptions WHERE vendor_id = ${vendorId} ORDER BY created_at DESC, id DESC LIMIT ${MAX_DEVICES - 1})
  `;
  return liveDevices(vendorId);
}

async function removeSubscription(vendorId, endpoint) {
  await sql`DELETE FROM push_subscriptions WHERE vendor_id = ${vendorId} AND endpoint = ${String(endpoint || '')}`;
  return liveDevices(vendorId);
}

// ---------- sending ----------
const TITLES = {
  new_order: 'New order', payment_claimed: 'Customer says they paid', review: 'New review',
  supply_order: 'Resale order', supply_update: 'Resale update', referral: 'Free month of Pro',
  stock_request: "Wants it when it's back", cap_warning: 'Free plan', cap_reached: 'Free plan',
  plan_renewed: 'OrderPadi Pro', plan_ending: 'OrderPadi Pro', test: 'OrderPadi'
};

function urlFor(n) {
  if (n.order_id) return '/app#order/' + n.order_id;
  if (n.type === 'supply_order') return '/app#resell/send';
  if (n.type === 'stock_request') return '/app#stock';
  if (n.type === 'referral') return '/app#invite';
  return '/app#notifications';
}

// Posts one alert. Returns the push service's status code (0 if unreachable).
async function deliver(sub, payload, keys) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        Urgency: 'high',
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: vapidHeader(sub.endpoint, keys)
      },
      body: encrypt(sub.p256dh, sub.auth, JSON.stringify(payload)),
      signal: AbortSignal.timeout(4000)
    });
    return res.status;
  } catch (err) {
    return 0;
  }
}

// Sends to a list of subscriptions and tidies up: phones that unsubscribed
// (404/410) are removed, and so are ones that keep failing.
async function sendAll(jobs, keys) {
  if (!jobs.length) return [];
  const results = await Promise.all(jobs.map(async (j) => ({ sub: j.sub, status: await deliver(j.sub, j.payload, keys) })));
  const ok = new Set();
  const gone = new Set();
  const failed = new Set();
  results.forEach((r) => {
    const id = Number(r.sub.id);
    if (r.status >= 200 && r.status < 300) ok.add(id);
    else if (r.status === 404 || r.status === 410) gone.add(id);
    else failed.add(id);
  });
  ok.forEach((id) => failed.delete(id));
  const list = (set) => JSON.stringify([...set]);
  await sql`
    WITH g AS (
      DELETE FROM push_subscriptions
      WHERE id IN (SELECT jsonb_array_elements_text(${list(gone)}::jsonb)::bigint)
         OR (id IN (SELECT jsonb_array_elements_text(${list(failed)}::jsonb)::bigint) AND failures >= 9)
      RETURNING id
    ),
    f AS (
      UPDATE push_subscriptions SET failures = failures + 1
      WHERE id IN (SELECT jsonb_array_elements_text(${list(failed)}::jsonb)::bigint) AND id NOT IN (SELECT id FROM g)
    )
    UPDATE push_subscriptions SET failures = 0, last_sent_at = now()
    WHERE id IN (SELECT jsonb_array_elements_text(${list(ok)}::jsonb)::bigint)
  `;
  return results;
}

// Sends what's new in these sellers' bells to their phones. Call it after
// any statement that adds notifications; it never throws.
async function flushPush(vendorIds) {
  const ids = [...new Set([].concat(vendorIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || !sql) return 0;
  try {
    const list = JSON.stringify(ids);
    const rows = await sql`
      WITH claimed AS (
        UPDATE notifications n SET pushed_at = now()
        WHERE n.vendor_id IN (SELECT jsonb_array_elements_text(${list}::jsonb)::bigint)
          AND n.pushed_at IS NULL
          AND n.created_at > now() - make_interval(mins => ${PUSH_WINDOW_MINUTES})
          AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.vendor_id = n.vendor_id)
        RETURNING n.id, n.vendor_id, n.type, n.message, n.order_id
      )
      SELECT c.*, (SELECT count(*) FROM notifications u WHERE u.vendor_id = c.vendor_id AND u.read_at IS NULL)::int AS unread
      FROM claimed c ORDER BY c.id
    `;
    if (!rows.length) return 0;
    const subs = await sql`
      SELECT ps.* FROM push_subscriptions ps
      WHERE ps.vendor_id IN (SELECT jsonb_array_elements_text(${list}::jsonb)::bigint)
        AND EXISTS (SELECT 1 FROM user_sessions s WHERE s.jti = ps.session_jti AND s.vendor_id = ps.vendor_id
                    AND s.revoked_at IS NULL AND s.expires_at > now())
    `;
    if (!subs.length) return 0;
    const keys = await vapidKeys();
    const jobs = [];
    ids.forEach((vid) => {
      const mine = rows.filter((r) => Number(r.vendor_id) === vid).slice(-PER_FLUSH);
      const phones = subs.filter((s) => Number(s.vendor_id) === vid);
      mine.forEach((n) => phones.forEach((sub) => jobs.push({
        sub,
        payload: { title: TITLES[n.type] || 'OrderPadi', body: n.message, url: urlFor(n), tag: 'n' + n.id, badge: Number(n.unread) }
      })));
    });
    const results = await sendAll(jobs, keys);
    return results.filter((r) => r.status >= 200 && r.status < 300).length;
  } catch (err) {
    console.error('Push alerts failed (orders still saved):', err);
    return 0;
  }
}

// Adds a bell item and sends it as an alert.
async function notifyNow(vendorId, type, message, orderId = null) {
  await sql`INSERT INTO notifications (vendor_id, type, message, order_id) VALUES (${vendorId}, ${type}, ${message}, ${orderId})`;
  await flushPush([vendorId]);
}

// "Send a test alert" from the app, to this phone only.
async function sendTest(vendorId, endpoint) {
  const [sub] = await sql`SELECT * FROM push_subscriptions WHERE vendor_id = ${vendorId} AND endpoint = ${String(endpoint || '')} LIMIT 1`;
  if (!sub) throw HttpError(404, 'Alerts are off on this phone. Turn them on first.', { resubscribe: true });
  const keys = await vapidKeys();
  const [r] = await sendAll([{ sub, payload: { title: 'OrderPadi alerts are on', body: "This is how new orders will show up on this phone.", url: '/app#alerts', tag: 'test' } }], keys);
  if (r.status >= 200 && r.status < 300) return { sent: true };
  if (r.status === 404 || r.status === 410 || r.status === 403 || r.status === 401) {
    // The phone's subscription is stale or was made with another key: start again.
    await sql`DELETE FROM push_subscriptions WHERE id = ${sub.id}`;
    throw HttpError(409, 'This phone needs to turn alerts on again.', { resubscribe: true });
  }
  throw HttpError(502, "Couldn't reach this phone's alert service. Check your internet and try again.");
}

async function pushInfo(vendorId) {
  const [keys, devices] = await Promise.all([vapidKeys(), liveDevices(vendorId)]);
  return { key: keys.publicKey, devices };
}

module.exports = {
  vapidKeys, vapidHeader, encrypt, readSubscription, allowedEndpoint, deviceOf,
  saveSubscription, removeSubscription, liveDevices, flushPush, notifyNow, sendTest, pushInfo,
  _reset: () => { cachedKeys = null; }
};
