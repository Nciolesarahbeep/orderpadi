// Shared rules for cleaning what people type: store links, naira amounts
// and Nigerian phone numbers. The pages use the same rules, so what a seller
// sees while typing is what gets saved.

const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'www', 'help', 'support', 'login', 'signup', 'settings',
  'billing', 'orderpadi', 'store', 'shop', 'invoice', 'setup', 'test', 'static', 'assets'
]);

// "Ada's Wigs & More!" -> "adas-wigs-and-more"
function cleanSlug(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

function slugProblem(slug) {
  if (slug.length < 3) return 'Your store link needs at least 3 letters or numbers.';
  if (RESERVED_SLUGS.has(slug)) return 'That store link is reserved. Try another.';
  return null;
}

// Trims and collapses spaces. Length limits are checked by the caller.
function cleanText(input) {
  return String(input == null ? '' : input).trim().replace(/\s+/g, ' ');
}

// "₦4,500", "4500", "4500.5" -> 450000 kobo. Returns null if it isn't a
// sensible amount. Done with string maths so no floating-point rounding.
function nairaToKobo(input) {
  if (typeof input === 'number') input = String(input);
  const text = String(input == null ? '' : input).replace(/[₦,\s]/g, '').replace(/^ngn/i, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function formatNaira(kobo) {
  const value = Number(kobo || 0) / 100;
  const decimals = Number(kobo) % 100 === 0 ? 0 : 2;
  return '₦' + value.toLocaleString('en-NG', { minimumFractionDigits: decimals, maximumFractionDigits: 2 });
}

// Nigerian mobile numbers in any common form -> "2348031234567" (for wa.me
// links). "0803 123 4567", "+234 803 123 4567", "8031234567" all work.
function normalizeNgPhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (/^234[789]\d{9}$/.test(digits)) return digits;
  if (/^0[789]\d{9}$/.test(digits)) return '234' + digits.slice(1);
  if (/^[789]\d{9}$/.test(digits)) return '234' + digits;
  return null;
}

module.exports = { RESERVED_SLUGS, cleanSlug, slugProblem, cleanText, nairaToKobo, formatNaira, normalizeNgPhone };
