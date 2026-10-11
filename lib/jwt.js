// Signed login tokens (JWT, HS256) using Node's built-in crypto, so no npm
// package is needed. Same shape as before: { vid, jti, iat, exp }.
const crypto = require('crypto');

const b64url = (input) => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (text) => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function sign(payload, secret, { expiresIn } = {}) {
  if (!secret) throw new Error('A secret is needed to sign a token');
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now };
  if (expiresIn) body.exp = now + Number(expiresIn);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  return `${data}.${b64url(hmac(data, secret))}`;
}

// Reads the payload without checking the signature (only for logout).
function decode(token) {
  try {
    return JSON.parse(fromB64url(String(token).split('.')[1]).toString('utf8'));
  } catch (err) {
    return null;
  }
}

// Throws unless the token was signed with this secret, uses HS256 and hasn't expired.
function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  let header;
  try { header = JSON.parse(fromB64url(parts[0]).toString('utf8')); } catch (err) { throw new Error('Malformed token'); }
  if (!header || header.alg !== 'HS256') throw new Error('Unexpected token algorithm');
  const expected = hmac(`${parts[0]}.${parts[1]}`, secret);
  const given = fromB64url(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new Error('Bad token signature');
  const payload = decode(token);
  if (!payload) throw new Error('Malformed token');
  if (payload.exp && payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

module.exports = { sign, verify, decode };
