// Promo codes a seller shares, like ADA10 for 10% off. A code takes a
// percentage or a naira amount off the items (never the delivery fee), and
// can have a minimum order, a limit on how many times it's used, and an end date.
const { HttpError } = require('./auth');
const { nairaToKobo, formatNaira } = require('./format');
const { isPro } = require('./plan');

const FREE_PROMOS = 2;
const PRO_PROMOS = 50;
const MAX_AMOUNT_KOBO = 100000000; // ₦1,000,000

const promoLimit = (vendor) => (isPro(vendor) ? PRO_PROMOS : FREE_PROMOS);

// "ada 10!" -> "ADA10"
function cleanCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

// End of the given day in Lagos time, from "2026-12-31".
function endOfDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(text + 'T23:59:59+01:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

// What the seller typed in the promo form -> the saved values.
function readPromo(body) {
  const code = cleanCode(body.code);
  if (code.length < 3) throw new HttpError(400, 'Use 3 to 20 letters or numbers for the code, like ADA10.', { field: 'code' });
  const kind = body.kind === 'amount' ? 'amount' : 'percent';
  let value;
  if (kind === 'percent') {
    value = Number(String(body.value == null ? '' : body.value).replace(/[%\s]/g, ''));
    if (!Number.isInteger(value) || value < 1 || value > 90) throw new HttpError(400, 'Enter a percentage from 1 to 90.', { field: 'value' });
  } else {
    value = nairaToKobo(body.value);
    if (value === null || value <= 0 || value > MAX_AMOUNT_KOBO) throw new HttpError(400, 'Enter the amount off in naira, like 2000.', { field: 'value' });
  }
  let minOrderKobo = 0;
  if (body.minOrder != null && String(body.minOrder).trim() !== '') {
    minOrderKobo = nairaToKobo(body.minOrder);
    if (minOrderKobo === null) throw new HttpError(400, 'Enter the minimum order in naira, like 20000, or leave it empty.', { field: 'minOrder' });
  }
  if (kind === 'amount' && minOrderKobo && minOrderKobo < value) {
    throw new HttpError(400, 'The minimum order should be more than the amount off.', { field: 'minOrder' });
  }
  let maxUses = null;
  if (body.maxUses != null && String(body.maxUses).trim() !== '') {
    maxUses = Number(String(body.maxUses).replace(/[,\s]/g, ''));
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) throw new HttpError(400, 'Enter how many times the code can be used, like 50, or leave it empty.', { field: 'maxUses' });
  }
  let expiresAt = null;
  if (body.expires != null && String(body.expires).trim() !== '') {
    expiresAt = endOfDay(String(body.expires).trim());
    if (!expiresAt) throw new HttpError(400, 'Pick the last day the code works, or leave it empty.', { field: 'expires' });
    if (expiresAt.getTime() < Date.now()) throw new HttpError(400, 'The last day has already passed. Pick a day from today on.', { field: 'expires' });
  }
  return { code, kind, value, minOrderKobo, maxUses, expiresAt, isActive: body.isActive !== false };
}

function promoLabel(row) {
  const off = row.kind === 'percent' ? Number(row.value) + '% off' : formatNaira(Number(row.value)) + ' off';
  return Number(row.min_order_kobo) > 0 ? off + ' orders of ' + formatNaira(Number(row.min_order_kobo)) + '+' : off;
}

function promoStatus(row) {
  if (!row.is_active) return 'off';
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  if (row.max_uses != null && Number(row.uses) >= Number(row.max_uses)) return 'used_up';
  return 'active';
}

function promoForClient(row) {
  return {
    id: Number(row.id),
    code: row.code,
    kind: row.kind,
    value: Number(row.value),
    minOrderKobo: Number(row.min_order_kobo),
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    uses: Number(row.uses),
    expiresAt: row.expires_at || null,
    isActive: !!row.is_active,
    label: promoLabel(row),
    status: promoStatus(row)
  };
}

function discountFor(row, subtotalKobo) {
  const sub = Math.max(0, Number(subtotalKobo) || 0);
  if (row.kind === 'percent') return Math.floor((sub * Number(row.value)) / 100);
  return Math.min(Number(row.value), sub);
}

// Why a code can't be used on this order, or null if it can.
function promoProblem(row, subtotalKobo) {
  if (!row) return "That code doesn't work for this store. Check the spelling.";
  const status = promoStatus(row);
  if (status === 'off') return "That code doesn't work for this store. Check the spelling.";
  if (status === 'expired') return 'That code has expired.';
  if (status === 'used_up') return 'That code has been used up.';
  if (Number(subtotalKobo) < Number(row.min_order_kobo)) return 'That code works on orders of ' + formatNaira(Number(row.min_order_kobo)) + ' or more.';
  if (discountFor(row, subtotalKobo) <= 0) return "That code doesn't take anything off this order.";
  return null;
}

async function findPromo(sql, vendorId, rawCode) {
  const code = cleanCode(rawCode);
  if (code.length < 3) return null;
  const [row] = await sql`SELECT * FROM promo_codes WHERE vendor_id = ${vendorId} AND code = ${code} LIMIT 1`;
  return row || null;
}

// True when an order failed because the code reached its limit at that moment.
function isPromoUsedUp(err) {
  return !!err && err.code === '23514' && /promo_codes_uses_check/.test(String(err.constraint || '') + ' ' + String(err.message || ''));
}

module.exports = {
  FREE_PROMOS, PRO_PROMOS, promoLimit, cleanCode, readPromo, promoLabel, promoStatus, promoForClient,
  discountFor, promoProblem, findPromo, isPromoUsedUp
};
