// Seller tools that grow the store: promo codes and reviews.
//   GET  /api/tools?view=promos                -> { promos, limit }
//   POST /api/tools { action: "promo", id?, code, kind, value, minOrder?, maxUses?, expires?, isActive? }
//        kind: "percent" (value 1–90) or "amount" (value in naira); expires: "2026-12-31"
//                                              -> { promo, promos, limit }
//   POST /api/tools { action: "promo-delete", id } -> { promos, limit }
//   GET  /api/tools?view=reviews               -> { summary, reviews }
//   POST /api/tools { action: "reply", id, reply } -> { review }   ("" removes the reply)
//   GET  /api/tools?view=summary               -> { activePromos, rating, unreplied, supplyNew, resale }   (for the More tab)
// Referrals
//   GET  /api/tools?view=referrals             -> { code, invited: [{ name, joinedAt, status }], monthsEarned, rewardDays }
// Reselling (lib/resell.js)
//   GET  /api/tools?view=market&q=&category=&page= -> { products, hasMore }   other sellers' products you can resell
//   POST /api/tools { action: "resell-add", productId, price?, category? } -> { productId }
//   GET  /api/tools?view=supply&side=in|out    -> { supply }   in: orders you send for resellers; out: your resold items
//   POST /api/tools { action: "supply-status", id, status }  (supplier) accepted | shipped | delivered | cancelled | new
//   POST /api/tools { action: "supply-paid", id, paid }      (supplier) the reseller paid you, or not
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor } = require('../lib/auth');
const { promoLimit, readPromo, promoForClient } = require('../lib/promos');
const { readReply, ratingSummary } = require('../lib/reviews');
const { isPro } = require('../lib/plan');
const { cleanText, nairaToKobo, formatNaira } = require('../lib/format');
const { ensureReferralCode, REWARD_DAYS } = require('../lib/referrals');
const { optionsOf, stockRowsFor } = require('../lib/catalog');
const { photosForProducts, themeOf } = require('../lib/photos');
const { CATEGORIES } = require('../lib/directory');

const MAX_PRODUCTS = 200;

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
      WITH month AS (SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS start)
      SELECT
        (SELECT count(*) FROM promo_codes p WHERE p.vendor_id = ${vendor.id} AND p.is_active
           AND (p.expires_at IS NULL OR p.expires_at > now()) AND (p.max_uses IS NULL OR p.uses < p.max_uses))::int AS promos,
        (SELECT count(*) FROM reviews r WHERE r.vendor_id = ${vendor.id} AND r.reply IS NULL AND NOT r.is_hidden)::int AS unreplied,
        (SELECT count(*) FROM supply_orders s WHERE s.supplier_vendor_id = ${vendor.id} AND s.status = 'new')::int AS supply_new,
        (SELECT coalesce(sum(i.quantity), 0) FROM order_items i JOIN orders o ON o.id = i.order_id, month
           WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND i.unit_cost_kobo IS NOT NULL AND o.created_at >= month.start)::int AS resold,
        (SELECT coalesce(sum(i.line_total_kobo - i.unit_cost_kobo * i.quantity), 0) FROM order_items i JOIN orders o ON o.id = i.order_id, month
           WHERE o.vendor_id = ${vendor.id} AND o.status <> 'cancelled' AND i.unit_cost_kobo IS NOT NULL AND o.created_at >= month.start)::bigint AS earned,
        (SELECT count(*) FROM vendors v WHERE v.referred_by = ${vendor.id} AND v.email_verified)::int AS invited
    `,
    ratingSummary(sql, vendor.id)
  ]);
  return {
    activePromos: Number(row.promos), unreplied: Number(row.unreplied), rating: { average: rating.average, count: rating.count },
    supplyNew: Number(row.supply_new), invited: Number(row.invited),
    resale: { itemsThisMonth: Number(row.resold), earnedThisMonthKobo: Number(row.earned) }
  };
}

// ---------- referrals ----------
async function referrals(vendor) {
  const code = await ensureReferralCode(vendor);
  const rows = await sql`
    SELECT business_name, created_at, email_verified, referral_rewarded_at FROM vendors
    WHERE referred_by = ${vendor.id} AND email_verified = TRUE
    ORDER BY created_at DESC LIMIT 200
  `;
  const invited = rows.map((r) => ({
    name: r.business_name,
    joinedAt: r.created_at,
    status: r.referral_rewarded_at ? 'rewarded' : 'waiting'
  }));
  return {
    code,
    rewardDays: REWARD_DAYS,
    invited,
    monthsEarned: invited.filter((i) => i.status === 'rewarded').length + (vendor.referral_rewarded_at ? 1 : 0)
  };
}

// ---------- reselling ----------
const MARKET_PAGE = 30;
async function market(vendor, params) {
  const q = cleanText(params.get('q') || '').slice(0, 60);
  const like = q ? '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%' : '';
  const category = CATEGORIES.includes(params.get('category')) ? params.get('category') : '';
  const page = Math.min(50, Math.max(0, Number(params.get('page')) || 0));
  const rows = await sql`
    SELECT p.id, p.name, p.description, p.price_kobo, p.options, p.resell_price_kobo, p.category, p.stock,
           v.business_name, v.slug, v.state, v.city, v.store_theme, v.store_category,
           (SELECT round(avg(r.rating)::numeric, 1) FROM reviews r WHERE r.vendor_id = v.id AND NOT r.is_hidden)::float AS rating,
           (SELECT count(*) FROM reviews r WHERE r.vendor_id = v.id AND NOT r.is_hidden)::int AS reviews,
           (SELECT m.id FROM products m WHERE m.vendor_id = ${vendor.id} AND m.source_product_id = p.id LIMIT 1) AS my_copy
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE p.resell_price_kobo IS NOT NULL AND p.is_active AND NOT p.is_resale
      AND v.id <> ${vendor.id} AND v.email_verified AND NOT v.is_suspended
      AND (p.stock IS NULL OR p.stock > 0)
      AND (${category} = '' OR v.store_category = ${category})
      AND (${q} = '' OR p.name ILIKE ${like} OR p.category ILIKE ${like} OR p.description ILIKE ${like} OR v.business_name ILIKE ${like})
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${MARKET_PAGE + 1} OFFSET ${page * MARKET_PAGE}
  `;
  const shown = rows.slice(0, MARKET_PAGE);
  const [photos, stock] = await Promise.all([photosForProducts(shown.map((p) => p.id)), stockRowsFor(sql, shown.map((p) => p.id))]);
  return {
    products: shown.map((p) => ({
      id: Number(p.id),
      name: p.name,
      description: p.description || '',
      priceKobo: Number(p.price_kobo),
      costKobo: Number(p.resell_price_kobo),
      category: p.category || '',
      options: optionsOf(p, stock.get(Number(p.id)) || []),
      stock: p.stock == null ? null : Number(p.stock),
      photos: (photos.get(Number(p.id)) || []).map((ph) => ph.url),
      added: p.my_copy != null,
      myProductId: p.my_copy == null ? null : Number(p.my_copy),
      supplier: {
        name: p.business_name, slug: p.slug, theme: themeOf(p), category: p.store_category || '',
        place: [p.city, p.state].filter(Boolean).join(', '),
        rating: p.rating == null ? null : Number(p.rating), reviews: Number(p.reviews)
      }
    })),
    hasMore: rows.length > MARKET_PAGE
  };
}

async function resellAdd(vendor, body) {
  const id = readId(body.productId, 'product');
  const [src] = await sql`
    SELECT p.* FROM products p JOIN vendors v ON v.id = p.vendor_id
    WHERE p.id = ${id} AND p.resell_price_kobo IS NOT NULL AND p.is_active AND NOT p.is_resale
      AND v.id <> ${vendor.id} AND v.email_verified AND NOT v.is_suspended
    LIMIT 1
  `;
  if (!src) throw new HttpError(404, "That product isn't available to resell any more.");
  const cost = Number(src.resell_price_kobo);
  let price = Math.max(Number(src.price_kobo), cost);
  if (body.price != null && String(body.price).trim() !== '') {
    price = nairaToKobo(body.price);
    if (price === null || price <= 0) throw new HttpError(400, 'Enter your selling price in naira, like 45000.', { field: 'price' });
    if (price < cost) throw new HttpError(400, `Your price must be at least ${formatNaira(cost)}, what the supplier charges you.`, { field: 'price' });
  }
  const category = cleanText(body.category).slice(0, 40) || src.category || null;
  const rows = await sql`
    INSERT INTO products (vendor_id, name, description, price_kobo, category, options, is_resale, source_product_id)
    SELECT ${vendor.id}, ${src.name}, ${src.description}, ${price}, ${category}, ${JSON.stringify(src.options || [])}::jsonb, TRUE, ${src.id}
    WHERE NOT EXISTS (SELECT 1 FROM products WHERE vendor_id = ${vendor.id} AND source_product_id = ${src.id})
      AND (SELECT count(*) FROM products WHERE vendor_id = ${vendor.id}) < ${MAX_PRODUCTS}
    RETURNING id
  `;
  if (!rows.length) {
    const [dupe] = await sql`SELECT id FROM products WHERE vendor_id = ${vendor.id} AND source_product_id = ${src.id} LIMIT 1`;
    if (dupe) throw new HttpError(409, "It's already in your store.", { productId: Number(dupe.id) });
    throw new HttpError(400, `You can have up to ${MAX_PRODUCTS} products. Delete some you no longer sell.`);
  }
  return { productId: Number(rows[0].id), priceKobo: price, costKobo: cost };
}

const SUPPLY_STATUSES = ['new', 'accepted', 'shipped', 'delivered', 'cancelled'];
const SUPPLY_VERB = {
  new: 'moved the items back to new', accepted: 'accepted the items', shipped: 'sent the items',
  delivered: 'delivered the items', cancelled: "can't supply the items"
};

function supplyForClient(r, side) {
  const out = {
    id: Number(r.id),
    status: r.status,
    cancelReason: r.cancel_reason || null,
    items: Array.isArray(r.items) ? r.items : [],
    totalKobo: Number(r.total_kobo),
    paid: !!r.paid_at,
    createdAt: r.created_at,
    orderNumber: Number(r.order_number)
  };
  if (side === 'in') {
    out.reseller = { name: r.partner_name, whatsappPhone: r.partner_phone || null, slug: r.partner_slug };
    out.sendTo = { name: r.customer_name, phone: r.customer_phone, address: r.delivery_address || '', area: r.delivery_zone || '', note: r.note || '' };
  } else {
    out.supplier = { name: r.partner_name, whatsappPhone: r.partner_phone || null, slug: r.partner_slug };
    out.orderId = Number(r.order_id);
  }
  return out;
}

async function supplyList(vendor, params) {
  const side = params.get('side') === 'out' ? 'out' : 'in';
  const rows = side === 'in'
    ? await sql`
        SELECT so.*, o.order_number, o.customer_name, o.customer_phone, o.delivery_address, o.delivery_zone, o.note,
               v.business_name AS partner_name, v.whatsapp_phone AS partner_phone, v.slug AS partner_slug
        FROM supply_orders so JOIN orders o ON o.id = so.order_id JOIN vendors v ON v.id = so.reseller_vendor_id
        WHERE so.supplier_vendor_id = ${vendor.id}
        ORDER BY (so.status = 'new') DESC, so.created_at DESC, so.id DESC LIMIT 100
      `
    : await sql`
        SELECT so.*, o.order_number, v.business_name AS partner_name, v.whatsapp_phone AS partner_phone, v.slug AS partner_slug
        FROM supply_orders so JOIN orders o ON o.id = so.order_id JOIN vendors v ON v.id = so.supplier_vendor_id
        WHERE so.reseller_vendor_id = ${vendor.id}
        ORDER BY so.created_at DESC, so.id DESC LIMIT 100
      `;
  return { side, supply: rows.map((r) => supplyForClient(r, side)) };
}

async function supplyStatus(vendor, body) {
  const id = readId(body.id, 'resale order');
  if (!SUPPLY_STATUSES.includes(body.status)) throw new HttpError(400, 'Unknown status.');
  const [cur] = await sql`SELECT * FROM supply_orders WHERE id = ${id} AND supplier_vendor_id = ${vendor.id}`;
  if (!cur) throw new HttpError(404, "That resale order doesn't exist.");
  if (cur.cancel_reason === 'order_cancelled' && body.status !== 'cancelled') {
    throw new HttpError(409, 'The seller cancelled this order, so there is nothing to send.');
  }
  if (cur.status !== body.status) {
    const message = `${vendor.business_name} ${SUPPLY_VERB[body.status]}`;
    await sql`
      WITH u AS (
        UPDATE supply_orders SET status = ${body.status}, cancel_reason = NULL, updated_at = now()
        WHERE id = ${id} AND supplier_vendor_id = ${vendor.id}
        RETURNING order_id, reseller_vendor_id
      ),
      ev AS (
        INSERT INTO order_events (order_id, vendor_id, kind, message)
        SELECT u.order_id, u.reseller_vendor_id, 'supply', ${message} FROM u
      )
      INSERT INTO notifications (vendor_id, type, message, order_id)
      SELECT u.reseller_vendor_id, 'supply_update', ${message} || ' for order #' || o.order_number, u.order_id
      FROM u JOIN orders o ON o.id = u.order_id
    `;
  }
  return supplyOne(vendor, id);
}

async function supplyPaid(vendor, body) {
  const id = readId(body.id, 'resale order');
  const paid = body.paid !== false;
  const [row] = await sql`
    UPDATE supply_orders SET paid_at = ${paid ? new Date() : null}, updated_at = now()
    WHERE id = ${id} AND supplier_vendor_id = ${vendor.id}
    RETURNING order_id, reseller_vendor_id, total_kobo
  `;
  if (!row) throw new HttpError(404, "That resale order doesn't exist.");
  if (paid) {
    await sql`
      INSERT INTO order_events (order_id, vendor_id, kind, message)
      VALUES (${row.order_id}, ${row.reseller_vendor_id}, 'supply', ${vendor.business_name + ' confirmed your payment of ' + formatNaira(Number(row.total_kobo))})
    `;
  }
  return supplyOne(vendor, id);
}

async function supplyOne(vendor, id) {
  const [r] = await sql`
    SELECT so.*, o.order_number, o.customer_name, o.customer_phone, o.delivery_address, o.delivery_zone, o.note,
           v.business_name AS partner_name, v.whatsapp_phone AS partner_phone, v.slug AS partner_slug
    FROM supply_orders so JOIN orders o ON o.id = so.order_id JOIN vendors v ON v.id = so.reseller_vendor_id
    WHERE so.id = ${id} AND so.supplier_vendor_id = ${vendor.id}
  `;
  return { item: supplyForClient(r, 'in') };
}

const ACTIONS = {
  promo: savePromo, 'promo-delete': deletePromo, reply,
  'resell-add': resellAdd, 'supply-status': supplyStatus, 'supply-paid': supplyPaid
};

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
      const params = new URL(req.url || '/', 'http://x').searchParams;
      const view = params.get('view');
      if (view === 'promos') return res.status(200).json(await promoList(vendor));
      if (view === 'referrals') return res.status(200).json(await referrals(vendor));
      if (view === 'market') return res.status(200).json(await market(vendor, params));
      if (view === 'supply') return res.status(200).json(await supplyList(vendor, params));
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
    const created = (body.action === 'promo' && (body.id == null || body.id === '')) || body.action === 'resell-add';
    return res.status(created ? 201 : 200).json(await run(vendor, body));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Tools error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
