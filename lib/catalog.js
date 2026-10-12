// Product options (like Size or Colour) and categories.
//
// options: up to 2 per product, each with up to 20 choices:
//   [{ name: "Size", choices: [{ id, label, extraKobo, soldOut }] }]
// A customer picks one choice from every option. The price is the product
// price plus the extraKobo of each picked choice, worked out on the server.
// Choice ids stay the same when a seller renames a choice, so saved carts
// and old links keep working.
const crypto = require('crypto');
const { HttpError } = require('./auth');
const { cleanText, nairaToKobo } = require('./format');

const MAX_OPTIONS = 2;
const MAX_CHOICES = 20;
const MAX_EXTRA_KOBO = 100000000; // ₦1,000,000
const MAX_STOCK = 1000000;

// "" or null -> not counted; otherwise a whole number of items left.
function readStock(raw, label = 'Stock') {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/[,\s]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) {
    throw new HttpError(400, `${label}: enter how many you have, like 12, or leave it empty if you don't count.`, { field: 'stock' });
  }
  return n;
}

function newChoiceId(taken) {
  let id;
  do { id = crypto.randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8); }
  while (id.length < 6 || taken.has(id));
  return id;
}

// What a seller typed in the product editor -> the saved options list.
function readOptions(raw) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'The options look wrong. Reload and try again.', { field: 'options' });
  if (raw.length > MAX_OPTIONS) throw new HttpError(400, `A product can have up to ${MAX_OPTIONS} options, like Size and Colour.`, { field: 'options' });
  const ids = new Set();
  const names = new Set();
  const options = raw.map((group) => {
    const g = group && typeof group === 'object' ? group : {};
    const name = cleanText(g.name);
    if (name.length < 1 || name.length > 20) throw new HttpError(400, 'Give each option a short name, like Size or Colour.', { field: 'options' });
    if (names.has(name.toLowerCase())) throw new HttpError(400, `You have "${name}" twice. Give each option a different name.`, { field: 'options' });
    names.add(name.toLowerCase());
    const list = Array.isArray(g.choices) ? g.choices : [];
    if (!list.length) throw new HttpError(400, `Add at least one choice to ${name}, or remove it.`, { field: 'options' });
    if (list.length > MAX_CHOICES) throw new HttpError(400, `${name} can have up to ${MAX_CHOICES} choices.`, { field: 'options' });
    const labels = new Set();
    const choices = list.map((c) => {
      const ch = c && typeof c === 'object' ? c : {};
      const label = cleanText(ch.label);
      if (label.length < 1 || label.length > 40) throw new HttpError(400, `Give every ${name} choice a name (up to 40 characters).`, { field: 'options' });
      if (labels.has(label.toLowerCase())) throw new HttpError(400, `${name} has "${label}" twice.`, { field: 'options' });
      labels.add(label.toLowerCase());
      let extra = 0;
      if (ch.extra != null && String(ch.extra).trim() !== '') {
        extra = nairaToKobo(ch.extra);
        if (extra === null) throw new HttpError(400, `Enter the extra price for "${label}" in naira, like 5000, or leave it empty.`, { field: 'options' });
      } else if (Number.isInteger(ch.extraKobo) && ch.extraKobo >= 0) {
        extra = ch.extraKobo;
      }
      if (extra > MAX_EXTRA_KOBO) throw new HttpError(400, `The extra price for "${label}" is too high.`, { field: 'options' });
      let id = typeof ch.id === 'string' && /^[a-z0-9]{6,12}$/.test(ch.id) && !ids.has(ch.id) ? ch.id : null;
      if (!id) id = newChoiceId(ids);
      ids.add(id);
      // stock is kept in choice_stock, not in the options list (see splitStock)
      return { id, label, extraKobo: extra, soldOut: ch.soldOut === true, stock: readStock(ch.stock, `${name} "${label}"`) };
    });
    return { name, choices };
  });
  return options;
}

// Options as saved (without stock) and the counted choices as rows.
function splitStock(options) {
  const rows = [];
  const saved = options.map((g) => ({
    name: g.name,
    choices: g.choices.map((c) => {
      if (c.stock !== null && c.stock !== undefined) rows.push({ choiceId: c.id, qty: c.stock });
      return { id: c.id, label: c.label, extraKobo: c.extraKobo, soldOut: c.soldOut };
    })
  }));
  return { saved, rows };
}

// Saved options, tidied for sending out (old rows may be null). stockRows
// are this product's choice_stock rows; a choice without one isn't counted.
function optionsOf(product, stockRows) {
  const raw = product && product.options;
  if (!Array.isArray(raw)) return [];
  const left = new Map((stockRows || []).map((r) => [String(r.choice_id), Number(r.qty)]));
  return raw.map((g) => ({
    name: String(g.name || ''),
    choices: (Array.isArray(g.choices) ? g.choices : []).map((c) => ({
      id: String(c.id || ''), label: String(c.label || ''), extraKobo: Number(c.extraKobo) || 0, soldOut: c.soldOut === true,
      stock: left.has(String(c.id)) ? left.get(String(c.id)) : null
    }))
  }));
}

function readCategory(raw) {
  const text = cleanText(raw);
  if (text.length > 40) throw new HttpError(400, 'Keep the category under 40 characters.', { field: 'category' });
  return text || null;
}

// The same line in a cart, whichever order the choices arrive in.
function lineKey(productId, choiceIds) {
  const ids = (choiceIds || []).map(String).filter(Boolean).sort();
  return ids.length ? `${productId}:${ids.join('.')}` : String(productId);
}

// Price and label for one product with the picked choices.
// Returns { unitPriceKobo, optionText } or { problem } when a choice is
// missing, unknown or sold out (sold out is fine for the seller's own orders).
function priceFor(product, choiceIds, { allowSoldOut = false, stockRows } = {}) {
  const options = optionsOf(product, stockRows || product.stock_rows);
  const picked = new Set((Array.isArray(choiceIds) ? choiceIds : []).map(String));
  let price = Number(product.price_kobo);
  const labels = [];
  const ids = [];
  for (const group of options) {
    const choice = group.choices.find((c) => picked.has(c.id));
    if (!choice) return { problem: 'choose', option: group.name };
    if (choice.stock !== null && choice.stock <= 0) return { problem: 'no_stock', option: group.name, choice: choice.label };
    if (choice.soldOut && !allowSoldOut) return { problem: 'sold_out', option: group.name, choice: choice.label };
    price += choice.extraKobo;
    labels.push(choice.label);
    ids.push(choice.id);
  }
  return { unitPriceKobo: price, optionText: labels.length ? labels.join(', ') : null, optionIds: ids.length ? ids : null };
}

// Loads choice_stock rows for some products: Map(productId -> rows).
async function stockRowsFor(sql, productIds) {
  const ids = [...new Set(productIds.map(Number).filter((n) => n > 0))];
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await sql`
    SELECT product_id, choice_id, qty FROM choice_stock
    WHERE product_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::bigint)
  `;
  rows.forEach((r) => { const k = Number(r.product_id); if (map.has(k)) map.get(k).push(r); });
  return map;
}

// Replaces a product's counted choices with the given rows.
async function saveChoiceStock(sql, productId, rows) {
  await sql`
    WITH gone AS (
      DELETE FROM choice_stock
      WHERE product_id = ${productId}
        AND choice_id NOT IN (SELECT r->>'choiceId' FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) r)
    )
    INSERT INTO choice_stock (product_id, choice_id, qty)
    SELECT ${productId}, r->>'choiceId', (r->>'qty')::int FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) r
    ON CONFLICT (product_id, choice_id) DO UPDATE SET qty = EXCLUDED.qty
  `;
}

// How many of each product and choice an order needs, checked against what's
// left. Returns a list of shortfalls: [{ key, name, left }].
function stockShortfalls(lines, products) {
  const needP = new Map();
  const needC = new Map();
  lines.forEach((l) => {
    needP.set(l.productId, (needP.get(l.productId) || 0) + l.quantity);
    (l.optionIds || []).forEach((c) => { const k = l.productId + ':' + c; needC.set(k, (needC.get(k) || 0) + l.quantity); });
  });
  const short = [];
  lines.forEach((l) => {
    const p = products.get(l.productId);
    if (!p) return;
    if (p.stock !== null && p.stock !== undefined && needP.get(l.productId) > Number(p.stock)) {
      short.push({ key: l.key, name: p.name, left: Number(p.stock) });
      return;
    }
    for (const row of p.stock_rows || []) {
      const k = l.productId + ':' + row.choice_id;
      if ((l.optionIds || []).includes(String(row.choice_id)) && needC.get(k) > Number(row.qty)) {
        short.push({ key: l.key, name: p.name + (l.optionText ? ` (${l.optionText})` : ''), left: Number(row.qty) });
        return;
      }
    }
  });
  return short;
}

module.exports = {
  MAX_OPTIONS, MAX_CHOICES, readOptions, optionsOf, splitStock, readStock, readCategory, lineKey, priceFor,
  stockRowsFor, saveChoiceStock, stockShortfalls
};
