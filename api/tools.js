// Seller tools that grow the store: promo codes and reviews.
//   GET  /api/tools?view=promos                -> { promos, limit }
//   POST /api/tools { action: "promo", id?, code, kind, value, minOrder?, maxUses?, expires?, isActive? }
//        kind: "percent" (value 1–90) or "amount" (value in naira); expires: "2026-12-31"
//                                              -> { promo, promos, limit }
//   POST /api/tools { action: "promo-delete", id } -> { promos, limit }
//   GET  /api/tools?view=reviews               -> { summary, reviews }
//   POST /api/tools { action: "reply", id, reply } -> { review }   ("" removes the reply)
//   GET  /api/tools?view=summary               -> { activePromos, rating, unreplied }   (for the More tab)
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { promoLimit, readPromo, promoForClient } = require('../lib/promos');
const { readReply, ratingSummary } = require('../lib/reviews');
const { isPro } = require('../lib/plan');

function readId(value, what) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Which ${what}? The id is missing.`);
  return id;
}

// ---------- promo codes ----------
async function promoList(vendor) {
  const rows = await sql`SELECT * FROM promo_codes WHERE vendor_id = ${vendor.id} ORDER BY is_active DESC, created_at DESC, id DESC`;
  return { promos: rows.map(promoForClient), limit: promoLimit(vendor) };
}

async function savePromo(vendor, body) {
  const p = readPromo(body);
  let row;
  try {
    if (body.id != null && body.id !== '') {
      const id = readId(body.id, 'code');
      [row] = await sql`
        UPDATE promo_codes SET code = ${p.code}, kind = ${p.kind}, value = ${p.value}, min_order_kobo = ${p.minOrderKobo},
          max_uses = ${p.maxUses}, expires_at = ${p.expiresAt}, is_active = ${p.isActive}
        WHERE id = ${id} AND vendor_id = ${vendor.id}
        RETURNING *
      `;
      if (!row) throw new HttpError(404, "That code doesn't exist any more.");
    } else {
      const limit = promoLimit(vendor);
      [row] = await sql`
        INSERT INTO promo_codes (vendor_id, code, kind, value, min_order_kobo, max_uses, expires_at, is_active)
        SELECT ${vendor.id}, ${p.code}, ${p.kind}, ${p.value}, ${p.minOrderKobo}, ${p.maxUses}, ${p.expiresAt}, ${p.isActive}
        WHERE (SELECT count(*) FROM promo_codes WHERE vendor_id = ${vendor.id}) < ${limit}
        RETURNING *
      `;
      if (!row) {
        throw new HttpError(403, isPro(vendor)
          ? `You can have up to ${limit} promo codes. Delete old ones to add more.`
          : `The free plan has ${limit} promo codes. Delete one, or go Pro for up to 50.`, { upgrade: !isPro(vendor) });
      }
    }
  } catch (err) {
    if (err && err.code === '23505') throw new HttpError(409, `You already have a code called ${p.code}.`, { field: 'code' });
    if (err && err.code === '23514' && /uses/.test(String(err.constraint || err.message))) {
      throw new HttpError(400, 'This code has already been used more times than that.', { field: 'maxUses' });
    }
    throw err;
  }
  return { promo: promoForClient(row), ...(await promoList(vendor)) };
}

async function deletePromo(vendor, body) {
  const id = readId(body.id, 'code');
  const rows = await sql`DELETE FROM promo_codes WHERE id = ${id} AND vendor_id = ${vendor.id} RETURNING id`;
  if (!rows.length) throw new HttpError(404, "That code doesn't exist any more.");
  return promoList(vendor);
}

// ---------- reviews ----------
function reviewForSeller(r) {
  return {
    id: Number(r.id),
    rating: Number(r.rating),
    body: r.body || '',
    name: r.customer_name,
    reply: r.reply || '',
    repliedAt: r.replied_at || null,
    hidden: !!r.is_hidden,
    createdAt: r.created_at,
    orderId: Number(r.order_id),
    orderNumber: r.order_number == null ? null : Number(r.order_number)
  };
}

async function reviews(vendor) {
  const [summary, rows] = await Promise.all([
    ratingSummary(sql, vendor.id),
    sql`
      SELECT r.*, o.order_number FROM reviews r JOIN orders o ON o.id = r.order_id
      WHERE r.vendor_id = ${vendor.id}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 200
    `
  ]);
  return { summary, reviews: rows.map(reviewForSeller) };
}

async function reply(vendor, body) {
  const id = readId(body.id, 'review');
  const text = readReply(body.reply);
  const [row] = await sql`
    WITH r AS (
      UPDATE reviews SET reply = ${text}, replied_at = ${text ? new Date() : null}, updated_at = now()
      WHERE id = ${id} AND vendor_id = ${vendor.id}
      RETURNING *
    )
    SELECT r.*, o.order_number FROM r JOIN orders o ON o.id = r.order_id
  `;
  if (!row) throw new HttpError(404, "That review doesn't exist.");
  return { review: reviewForSeller(row) };
}

async function summary(vendor) {
  const [[row], rating] = await Promise.all([
    sql`
      SELECT
        (SELECT count(*) FROM promo_codes p WHERE p.vendor_id = ${vendor.id} AND p.is_active
           AND (p.expires_at IS NULL OR p.expires_at > now()) AND (p.max_uses IS NULL OR p.uses < p.max_uses))::int AS promos,
        (SELECT count(*) FROM reviews r WHERE r.vendor_id = ${vendor.id} AND r.reply IS NULL AND NOT r.is_hidden)::int AS unreplied
    `,
    ratingSummary(sql, vendor.id)
  ]);
  return { activePromos: Number(row.promos), unreplied: Number(row.unreplied), rating: { average: rating.average, count: rating.count } };
}

const ACTIONS = { promo: savePromo, 'promo-delete': deletePromo, reply };

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    if (!sql) return res.status(500).json({ error: 'The database is not connected (DATABASE_URL is missing).' });
    const vendor = await getSessionVendor(req);
    if (!vendor) return res.status(401).json({ error: 'Not logged in.' });

    if (req.method === 'GET') {
      const view = new URL(req.url || '/', 'http://x').searchParams.get('view');
      if (view === 'promos') return res.status(200).json(await promoList(vendor));
      if (view === 'reviews') return res.status(200).json(await reviews(vendor));
      if (view === 'summary') return res.status(200).json(await summary(vendor));
      return res.status(400).json({ error: 'Unknown view.' });
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const run = ACTIONS[body.action];
    if (!run) return res.status(400).json({ error: 'Unknown action.' });
    const created = body.action === 'promo' && (body.id == null || body.id === '');
    return res.status(created ? 201 : 200).json(await run(vendor, body));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Tools error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
