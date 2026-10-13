// Reselling: a supplier lets other sellers resell a product by setting the
// price resellers pay (resell_price_kobo). A reseller adds it to their own
// store at their own price; their copy (is_resale, source_product_id) takes
// its stock, photos and availability from the supplier's product, and its
// name, description and options are kept in step whenever the supplier edits.
// Each order with resold items makes a supply order for the supplier, who
// sends the items to the customer; the reseller keeps the difference.
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { nairaToKobo, formatNaira } = require('./format');
const { stockRowsFor } = require('./catalog');

const MAX_RESELL_KOBO = 100000000; // ₦1,000,000

// "" or null -> not for resale.
function readResellPrice(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const kobo = nairaToKobo(raw);
  if (kobo === null || kobo <= 0 || kobo > MAX_RESELL_KOBO) {
    throw new HttpError(400, 'Enter the price resellers pay you in naira, like 30000, or leave it empty.', { field: 'resellPrice' });
  }
  return kobo;
}

// Why a reseller's copy can't be sold right now, or null if it can.
function resaleProblem(row) {
  if (!row.is_resale) return null;
  if (!row.source_product_id) return 'gone';
  if (!row.source_active || row.cost_kobo == null || row.supplier_off) return 'off';
  if (Number(row.price_kobo) < Number(row.cost_kobo)) return 'price';
  return null;
}

const RESALE_TEXT = {
  gone: 'The supplier removed this product.',
  off: "The supplier isn't offering this for resale right now.",
  price: 'The supplier now charges more than your price. Raise your price to sell it again.'
};

// Source details for a list of product rows (any seller's), joined on so the
// caller can work out stock, cost and availability.
async function sourcesFor(rows) {
  const ids = [...new Set(rows.filter((r) => r.is_resale && r.source_product_id).map((r) => Number(r.source_product_id)))];
  const map = new Map();
  if (!ids.length) return map;
  const found = await sql`
    SELECT s.id, s.vendor_id, s.is_active, s.resell_price_kobo, s.stock, sv.business_name, sv.slug,
           (sv.is_suspended OR NOT sv.email_verified) AS supplier_off
    FROM products s JOIN vendors sv ON sv.id = s.vendor_id
    WHERE s.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::bigint)
  `;
  found.forEach((s) => map.set(Number(s.id), s));
  return map;
}

// Adds the resale fields to product rows: source_active, cost_kobo, supplier_*,
// the stock that applies, and the stock rows to check choices against.
async function withResale(rows) {
  const sources = await sourcesFor(rows);
  const stockIds = rows.map((r) => (r.is_resale ? r.source_product_id : r.id)).filter(Boolean);
  const stock = await stockRowsFor(sql, stockIds);
  return rows.map((r) => {
    if (!r.is_resale) return { ...r, stock_rows: stock.get(Number(r.id)) || [], stock_product_id: null, resale_problem: null };
    const s = r.source_product_id ? sources.get(Number(r.source_product_id)) : null;
    const out = {
      ...r,
      source_active: !!(s && s.is_active),
      cost_kobo: s ? s.resell_price_kobo : null,
      supplier_id: s ? Number(s.vendor_id) : null,
      supplier_name: s ? s.business_name : null,
      supplier_slug: s ? s.slug : null,
      supplier_off: s ? !!s.supplier_off : true,
      stock: s ? s.stock : 0,
      stock_rows: s ? stock.get(Number(s.id)) || [] : [],
      stock_product_id: s ? Number(s.id) : null
    };
    out.resale_problem = resaleProblem(out);
    return out;
  });
}

// A seller's products by id, ready to be priced into an order.
async function loadSellable(vendorId, productIds, { activeOnly }) {
  const ids = JSON.stringify([...new Set(productIds.map(Number).filter((n) => n > 0))]);
  const rows = await sql`
    SELECT id, vendor_id, name, price_kobo, options, stock, is_active, is_resale, source_product_id, cost_kobo FROM products
    WHERE vendor_id = ${vendorId} AND (${activeOnly ? 1 : 0} = 0 OR is_active)
      AND id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::bigint)
  `;
  return new Map((await withResale(rows)).map((p) => [Number(p.id), p]));
}

// The extra order-line fields: what one item cost the seller (their cost
// price, when they set one), and for a resold product whose stock it takes,
// which supplier sends it, and what the reseller owes per item.
function resaleLine(p, unitPriceKobo) {
  if (!p.is_resale) return { unit_cost_kobo: p.cost_kobo == null ? null : Number(p.cost_kobo) };
  const extras = unitPriceKobo - Number(p.price_kobo);
  return { stock_product_id: p.stock_product_id, supplier_id: p.supplier_id, unit_cost_kobo: Number(p.cost_kobo) + extras };
}

// After a supplier edits their product, their resellers' copies follow.
async function syncCopies(source) {
  await sql`
    UPDATE products SET name = ${source.name}, description = ${source.description},
      options = ${JSON.stringify(source.options || [])}::jsonb, updated_at = now()
    WHERE source_product_id = ${source.id} AND is_resale = TRUE
  `;
}

module.exports = { readResellPrice, resaleProblem, RESALE_TEXT, sourcesFor, withResale, loadSellable, resaleLine, syncCopies, formatNaira };
