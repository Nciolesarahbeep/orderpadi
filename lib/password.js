// Password hashing with scrypt from Node's built-in crypto (no npm package).
// Stored as: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
const crypto = require('crypto');

const N = 32768;  // CPU/memory cost (2^15)
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1048576) return false;
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, Buffer.from(parts[4], 'base64'), n, r, p);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, checkPassword };
