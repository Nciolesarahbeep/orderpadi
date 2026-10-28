// The customer-facing side of a store. No login: anyone with the link.
//   GET  /api/public?store=<slug>  -> { store, products }
//   POST /api/public { action: "order", store, items: [{ productId, quantity, options?: [choiceId] }],
//                      customer: { name, phone, address }, note, zone? }
//                    -> { order, store }   (store here includes bank details)
//                    zone: the id of a delivery area, needed when the seller has areas
//                    409 { unavailable: [productId], unavailableLines: [lineKey] } when
//                    something sold out (lineKey is "productId" or "productId:choiceA.choiceB")
//                    409 { shortfalls: [{ key, left }] } when fewer are left than asked for
//                    promo: a promo code; 400 { field: "promo" } if it doesn't apply
//   POST /api/public { action: "promo", store, code, items } -> { promo: { code, label, discountKobo } }
//   GET  /api/public?invoice=<publicId>        -> { invoice, store }   (invoice.review, invoice.canReview)
//   POST /api/public { action: "paid", invoice } -> customer says they've paid
//   POST /api/public { action: "review", invoice, rating, body } -> { invoice, store }
//   POST /api/public { action: "stock-alert", store, productId, name, phone, choiceId? } -> { ok }
//                    "Tell me when it's back" on a sold-out product (lib/broadcasts.js)
//   GET  /api/public?directory=1&q=&category=&state=&page= -> { stores, categories, states, hasMore }
//   GET  /api/public?ref=<code>                -> { referrer: { name } }   (sign-up invite banner)
//   GET  /api/public?site=contact              -> { contact: { email, whatsapp } }
//   GET  /api/public?render=home|store|invoice -> the page itself, with link-preview tags
//   GET  /api/public?photo=<publicId>          -> a product photo or profile picture (also at /p/<publicId>)
//
// Prices always come from the database, never from the browser. The order,
// its items, the customer record and the seller's notification are written
// in one SQL statement, so an order is either saved completely or not at all.
const { sql } = require('../lib/db');
const { HttpError, getClientIp } = require('../lib/auth');
const { cleanSlug, cleanText, normalizeNgPhone, formatNaira } = require('../lib/format');
const { createOrder, invoiceForCustomer } = require('../lib/orders');
const { isPro, usage, noteUsage } = require('../lib/plan');
const { renderPage } = require('../lib/pages');
const { themeOf, photosForProducts, photoUrl, loadPhoto } = require('../lib/photos');
const { pictureUrlOf, loadPicture } = require('../lib/profilePicture');
const { optionsOf, lineKey, priceFor, stockRowsFor, stockShortfalls } = require('../lib/catalog');
const { zonesOf } = require('../lib/storeSettings');
const { findPromo, promoProblem, discountFor, promoLabel } = require('../lib/promos');
const { publicName, canReview, readReview, reviewForPublic, ratingSummary, EDIT_DAYS } = require('../lib/reviews');
const { CATEGORIES, STATES } = require('../lib/directory');
const { withResale, loadSellable, resaleLine } = require('../lib/resell');
const { findReferrer } = require('../lib/referrals');
const { flushPush } = require('../lib/push');
const { requestStock } = require('../lib/broadcasts');

const MAX_LINES = 50;
const MAX_QUANTITY = 99;
const ORDERS_PER_IP = 5;
const ORDER_WINDOW_MINUTES = 10;

async function findStore(rawSlug) {
  const slug = cleanSlug(rawSlug);
  if (!slug) return null;
  const rows = await sql`
    SELECT * FROM vendors
    WHERE slug = ${slug} AND email_verified = TRUE AND is_suspended = FALSE
    LIMIT 1
  `;
  return rows[0] || null;
}

function storeForCustomer(v, { withBank = false } = {}) {
  const store = {
    businessName: v.business_name,
    slug: v.slug,
    whatsappPhone: v.whatsapp_phone || null,
    deliveryFeeKobo: Number(v.default_delivery_fee_kobo || 0),
    deliveryNote: v.delivery_note || null,
    theme: themeOf(v),
    awayMessage: v.away_message || null,
    bio: v.bio || null,
    category: v.store_category || null,
    place: [v.city, v.state].filter(Boolean).join(', ') || null,
    picture: pictureUrlOf(v),       // the seller's profile picture, or null (show initials)
    branded: !isPro(v)
  };
  if (withBank) {
    store.bank = v.bank_name && v.bank_account_number && v.bank_account_name
      ? { name: v.bank_name, accountNumber: v.bank_account_number, accountName: v.bank_account_name }
      : null;
  }
  return store;
}

async function getStore(req, res) {
  const slug = param(req, 'store');
  const vendor = await findStore(slug);
  if (!vendor) throw new HttpError(404, "This store doesn't exist. Check the link with the seller.");
  const rows = await sql`
    SELECT id, name, description, price_kobo, category, options, stock, is_resale, source_product_id FROM products
    WHERE vendor_id = ${vendor.id} AND is_active = TRUE
    ORDER BY sort_order, created_at, id
  `;
  // Resold products take stock and photos from the supplier, and are left
  // out while the supplier isn't offering them.
  const products = (await withResale(rows)).filter((p) => !p.resale_problem);
  // On the free plan, after 20 orders this month the store takes orders on
  // WhatsApp only (the page builds the message; nothing is saved).
  const [{ capReached }, photos, rating, reviews] = await Promise.all([
    usage(vendor), photosForProducts(products.map((p) => p.stock_product_id || p.id)), ratingSummary(sql, vendor.id),
    sql`SELECT * FROM reviews WHERE vendor_id = ${vendor.id} AND is_hidden = FALSE ORDER BY created_at DESC, id DESC LIMIT 20`
  ]);
  return res.status(200).json({
    store: {
      ...storeForCustomer(vendor), deliveryZones: zonesOf(vendor), acceptingOrders: !capReached,
      rating: { average: rating.average, count: rating.count }
    },
    reviews: reviews.map(reviewForPublic),
    products: products.map((p) => ({
      id: Number(p.id),
      name: p.name,
      description: p.description || '',
      priceKobo: Number(p.price_kobo),
      category: p.category || '',
      options: optionsOf(p, p.stock_rows),
      stock: p.stock == null ? null : Number(p.stock),
      photos: (photos.get(Number(p.stock_product_id || p.id)) || []).map((ph) => ph.url)
    }))
  });
}

// Merges repeated lines (same product, same choices) and checks quantities.
// Returns Map(lineKey -> { productId, choices, quantity }).
function readCart(items) {
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Your order is empty. Add something first.');
  const merged = new Map();
  for (const item of items) {
    const id = Number(item && item.productId);
    const qty = Number(item && item.quantity);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Something in your order is not a product from this store.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
      throw new HttpError(400, `Quantities must be between 1 and ${MAX_QUANTITY}.`);
    }
    const choices = Array.isArray(item.options) ? item.options.filter((c) => typeof c === 'string' && /^[a-z0-9]{6,12}$/.test(c)).slice(0, 4) : [];
    const key = lineKey(id, choices);
    const line = merged.get(key) || { productId: id, choices, quantity: 0 };
    line.quantity = Math.min(MAX_QUANTITY, line.quantity + qty);
    merged.set(key, line);
  }
  if (merged.size > MAX_LINES) throw new HttpError(400, `An order can have up to ${MAX_LINES} different products.`);
  return merged;
}

function readCustomer(body) {
  const c = body.customer && typeof body.customer === 'object' ? body.customer : {};
  const name = cleanText(c.name);
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Enter your name.', { field: 'name' });
  const phone = normalizeNgPhone(c.phone);
  if (!phone) throw new HttpError(400, 'Enter your phone number, like 0803 123 4567.', { field: 'phone' });
  const address = cleanText(c.address);
  if (address.length > 300) throw new HttpError(400, 'Keep the address under 300 characters.', { field: 'address' });
  const note = cleanText(body.note);
  if (note.length > 300) throw new HttpError(400, 'Keep the note under 300 characters.', { field: 'note' });
  return { name, phone, address: address || null, note: note || null };
}

// Current prices and options from the database, only for this seller's live
// products. Returns the priced lines plus anything no longer available.
async function priceCart(vendor, cart) {
  const all = await loadSellable(vendor.id, [...cart.values()].map((l) => l.productId), { activeOnly: true });
  const found = new Map([...all].filter(([, p]) => !p.resale_problem));
  const unavailable = [...new Set([...cart.values()].filter((l) => !found.has(l.productId)).map((l) => l.productId))];
  const unavailableLines = [];
  const lines = [];
  for (const [key, l] of cart) {
    const p = found.get(l.productId);
    if (!p) { unavailableLines.push(key); continue; }
    const priced = priceFor(p, l.choices);
    if (priced.problem || (p.stock !== null && Number(p.stock) <= 0)) { unavailableLines.push(key); continue; }
    lines.push({
      key, product_id: l.productId, name: p.name, option_text: priced.optionText, option_ids: priced.optionIds,
      unit_price_kobo: priced.unitPriceKobo, quantity: l.quantity, ...resaleLine(p, priced.unitPriceKobo)
    });
  }
  const subtotal = lines.reduce((sum, l) => sum + l.unit_price_kobo * l.quantity, 0);
  return { found, lines, subtotal, unavailable, unavailableLines };
}

// The promo code a customer typed, checked against the items' total.
async function applyPromo(vendor, code, subtotal) {
  const row = await findPromo(sql, vendor.id, code);
  const problem = promoProblem(row, subtotal);
  if (problem) throw new HttpError(400, problem, { field: 'promo' });
  return { row, discount: discountFor(row, subtotal) };
}

async function checkPromo(body, res) {
  const vendor = await findStore(body.store);
  if (!vendor) throw new HttpError(404, "This store doesn't exist. Check the link with the seller.");
  if (!String(body.code || '').trim()) throw new HttpError(400, 'Type the promo code first.', { field: 'promo' });
  const { subtotal } = await priceCart(vendor, readCart(body.items));
  const { row, discount } = await applyPromo(vendor, body.code, subtotal);
  return res.status(200).json({ promo: { code: row.code, label: promoLabel(row), discountKobo: discount } });
}

async function placeOrder(req, res, body) {
  const vendor = await findStore(body.store);
  if (!vendor) throw new HttpError(404, "This store doesn't exist. Check the link with the seller.");
  const cart = readCart(body.items);
  const customer = readCustomer(body);
  const ip = getClientIp(req);
  const zones = zonesOf(vendor);
  let zone = null;
  if (zones.length) {
    zone = zones.find((z) => z.id === String(body.zone || ''));
    if (!zone) throw new HttpError(400, 'Choose where we should deliver to.', { field: 'zone' });
  }

  if ((await usage(vendor)).capReached) {
    throw new HttpError(403, 'This store is taking orders on WhatsApp right now. Tap the button to send your order to the seller.', { capReached: true });
  }

  const [recent] = await sql`
    SELECT count(*)::int AS n FROM orders
    WHERE created_ip = ${ip} AND created_at > now() - make_interval(mins => ${ORDER_WINDOW_MINUTES})
  `;
  if (Number(recent.n) >= ORDERS_PER_IP) {
    throw new HttpError(429, 'Too many orders from this phone in the last few minutes. Wait a little, or message the seller on WhatsApp.');
  }

  const { found, lines, subtotal, unavailable, unavailableLines } = await priceCart(vendor, cart);
  if (unavailableLines.length) {
    throw new HttpError(409, 'Some items or choices are no longer available, so we removed them. Check your order and try again.', { unavailable, unavailableLines });
  }
  const short = stockShortfalls(
    lines.map((l) => ({ key: l.key, productId: l.product_id, quantity: l.quantity, optionIds: l.option_ids, optionText: l.option_text })),
    found
  );
  if (short.length) {
    const s = short[0];
    throw new HttpError(409, `Only ${s.left} left of ${s.name}. We changed your order to match. Check it and try again.`, {
      shortfalls: short.map((x) => ({ key: x.key, left: x.left }))
    });
  }

  const promo = String(body.promo || '').trim() ? await applyPromo(vendor, body.promo, subtotal) : null;

  const order = await createOrder({
    vendorId: vendor.id,
    customer,
    lines: lines.map(({ key, ...line }) => line),
    deliveryFeeKobo: zone ? zone.feeKobo : Number(vendor.default_delivery_fee_kobo || 0),
    deliveryZone: zone ? zone.name : null,
    discountKobo: promo ? promo.discount : 0,
    promo: promo ? { id: Number(promo.row.id), code: promo.row.code } : null,
    note: customer.note,
    source: 'link',
    ip,
    notify: true
  });
  await noteUsage(vendor);

  const { id: internalId, ...publicOrder } = order; // customers don't need our row id
  return res.status(201).json({
    order: { ...publicOrder, customer: { name: customer.name, address: customer.address }, note: customer.note },
    store: storeForCustomer(vendor, { withBank: true })
  });
}

// The invoice (or receipt, once paid) a customer opens from /i/<publicId>.
async function loadInvoice(publicId) {
  const id = String(publicId || '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const rows = await sql`
    SELECT o.*, v.business_name, v.slug, v.whatsapp_phone, v.bank_name, v.bank_account_number,
           v.bank_account_name, v.default_delivery_fee_kobo, v.delivery_note, v.plan, v.plan_renews_at,
           v.store_theme, v.away_message, v.bio, v.store_category, v.city, v.state, v.logo_url
    FROM orders o
    JOIN vendors v ON v.id = o.vendor_id
    WHERE o.public_id = ${id} AND v.is_suspended = FALSE
    LIMIT 1
  `;
  const order = rows[0];
  if (!order) return null;
  const [items, payments, reviews] = await Promise.all([
    sql`
      SELECT oi.*, (
        SELECT ph.public_id FROM product_photos ph
        WHERE ph.product_id = oi.product_id
        ORDER BY ph.position, ph.id LIMIT 1
      ) AS photo_id
      FROM order_items oi WHERE oi.order_id = ${order.id} ORDER BY oi.id
    `,
    sql`SELECT amount_kobo, paid_at FROM payments WHERE order_id = ${order.id} ORDER BY paid_at, id`,
    sql`SELECT * FROM reviews WHERE order_id = ${order.id} LIMIT 1`
  ]);
  const vendorShape = {
    business_name: order.business_name, slug: order.slug, whatsapp_phone: order.whatsapp_phone,
    bank_name: order.bank_name, bank_account_number: order.bank_account_number, bank_account_name: order.bank_account_name,
    default_delivery_fee_kobo: order.default_delivery_fee_kobo, delivery_note: order.delivery_note, plan: order.plan,
    plan_renews_at: order.plan_renews_at, store_theme: order.store_theme, away_message: order.away_message,
    bio: order.bio, store_category: order.store_category, city: order.city, state: order.state,
    logo_url: order.logo_url
  };
  return { order, items, payments, review: reviews[0] || null, vendor: vendorShape };
}

async function getInvoice(publicId, res) {
  const found = await loadInvoice(publicId);
  if (!found) throw new HttpError(404, "This invoice doesn't exist. Check the link with the seller.");
  const invoice = invoiceForCustomer(found.order, found.items, found.payments);
  invoice.items.forEach((item, i) => {
    item.photo = found.items[i].photo_id ? photoUrl(found.items[i].photo_id) : null;
  });
  const r = found.review;
  invoice.review = r ? reviewForPublic(r) : null;
  invoice.canReview = canReview(found.order) && (!r || Date.now() - new Date(r.created_at).getTime() < EDIT_DAYS * 86400000);
  return res.status(200).json({ invoice, store: storeForCustomer(found.vendor, { withBank: true }) });
}

// Customer taps "I've paid". Only the first tap notifies the seller.
async function markPaid(body, res) {
  const found = await loadInvoice(body.invoice);
  if (!found) throw new HttpError(404, "This invoice doesn't exist. Check the link with the seller.");
  const o = found.order;
  if (o.status === 'cancelled') throw new HttpError(409, 'This order was cancelled, so there is nothing to pay.');
  if (o.payment_status !== 'paid' && !o.customer_marked_paid_at) {
    const balance = Math.max(0, Number(o.total_kobo) - Number(o.amount_paid_kobo));
    await sql`
      WITH marked AS (
        UPDATE orders SET customer_marked_paid_at = now(), updated_at = now()
        WHERE id = ${o.id} AND customer_marked_paid_at IS NULL
        RETURNING id
      ),
      history AS (
        INSERT INTO order_events (order_id, vendor_id, kind, message)
        SELECT id, ${o.vendor_id}, 'customer_paid', ${o.customer_name + ' tapped "I\'ve paid" on the invoice'} FROM marked
        RETURNING 1
      )
      INSERT INTO notifications (vendor_id, type, message, order_id)
      SELECT ${o.vendor_id}, 'payment_claimed',
             ${o.customer_name + ' says they paid ' + formatNaira(balance) + ' for order #' + o.order_number + '. Check your bank app, then mark it paid.'},
             id
      FROM marked
    `;
    await flushPush([o.vendor_id]);
  }
  return getInvoice(body.invoice, res);
}

// A customer rates their order from the invoice. The first review tells the
// seller; changing it later just updates it.
async function leaveReview(body, res) {
  const found = await loadInvoice(body.invoice);
  if (!found) throw new HttpError(404, "This invoice doesn't exist. Check the link with the seller.");
  const o = found.order;
  if (!canReview(o)) throw new HttpError(409, 'You can rate this order once it has been paid for or delivered.');
  if (found.review && Date.now() - new Date(found.review.created_at).getTime() >= EDIT_DAYS * 86400000) {
    throw new HttpError(409, 'This review can no longer be changed.');
  }
  const { rating, body: text } = readReview(body);
  const name = publicName(o.customer_name);
  const stars = rating + '★';
  const [saved] = await sql`
    INSERT INTO reviews (vendor_id, order_id, rating, body, customer_name)
    VALUES (${o.vendor_id}, ${o.id}, ${rating}, ${text}, ${name})
    ON CONFLICT (order_id) DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, updated_at = now()
    RETURNING (xmax = 0) AS inserted
  `;
  if (saved.inserted) {
    const quote = text ? ': "' + (text.length > 60 ? text.slice(0, 57) + '…' : text) + '"' : '';
    await sql`
      WITH ev AS (
        INSERT INTO order_events (order_id, vendor_id, kind, message)
        VALUES (${o.id}, ${o.vendor_id}, 'review', ${name + ' rated this order ' + stars})
      )
      INSERT INTO notifications (vendor_id, type, message, order_id)
      VALUES (${o.vendor_id}, 'review', ${name + ' gave order #' + o.order_number + ' ' + stars + quote}, ${o.id})
    `;
    await flushPush([o.vendor_id]);
  } else {
    await sql`INSERT INTO order_events (order_id, vendor_id, kind, message) VALUES (${o.id}, ${o.vendor_id}, 'review', ${name + ' changed their rating to ' + stars})`;
  }
  return getInvoice(body.invoice, res);
}

// Stores that chose to be listed, with at least one product on show.
const DIRECTORY_PAGE = 30;
async function directory(req, res) {
  const q = cleanText(param(req, 'q') || '').slice(0, 60);
  const like = q ? '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%' : '';
  const category = CATEGORIES.includes(param(req, 'category')) ? param(req, 'category') : '';
  const state = STATES.includes(param(req, 'state')) ? param(req, 'state') : '';
  const page = Math.min(50, Math.max(0, Number(param(req, 'page')) || 0));
  const rows = await sql`
    WITH listed AS (
      SELECT v.id, v.business_name, v.slug, v.store_theme, v.bio, v.store_category, v.state, v.city, v.created_at, v.logo_url,
             (SELECT count(*) FROM products p WHERE p.vendor_id = v.id AND p.is_active)::int AS products,
             (SELECT round(avg(r.rating)::numeric, 1) FROM reviews r WHERE r.vendor_id = v.id AND NOT r.is_hidden)::float AS rating,
             (SELECT count(*) FROM reviews r WHERE r.vendor_id = v.id AND NOT r.is_hidden)::int AS reviews
      FROM vendors v
      WHERE v.in_directory AND v.email_verified AND NOT v.is_suspended
        AND (${category} = '' OR v.store_category = ${category})
        AND (${state} = '' OR v.state = ${state})
        AND (${q} = '' OR v.business_name ILIKE ${like} OR v.bio ILIKE ${like} OR v.city ILIKE ${like}
             OR EXISTS (SELECT 1 FROM products p WHERE p.vendor_id = v.id AND p.is_active AND (p.name ILIKE ${like} OR p.category ILIKE ${like})))
    )
    SELECT * FROM listed WHERE products > 0
    ORDER BY coalesce(rating, 0) * least(reviews, 10) DESC, reviews DESC, products DESC, created_at DESC, id DESC
    LIMIT ${DIRECTORY_PAGE + 1} OFFSET ${page * DIRECTORY_PAGE}
  `;
  const shown = rows.slice(0, DIRECTORY_PAGE);
  const ids = JSON.stringify(shown.map((r) => Number(r.id)));
  const [photos, counts] = await Promise.all([
    shown.length ? sql`
      SELECT vendor_id, public_id FROM (
        SELECT ph.vendor_id, ph.public_id,
               row_number() OVER (PARTITION BY ph.vendor_id ORDER BY p.sort_order, p.created_at, p.id) AS n
        FROM product_photos ph
        JOIN products p ON p.id = ph.product_id AND p.is_active
        WHERE ph.vendor_id IN (SELECT jsonb_array_elements_text(${ids}::jsonb)::bigint)
          AND ph.position = (SELECT min(q.position) FROM product_photos q WHERE q.product_id = ph.product_id)
      ) x WHERE n <= 3
    ` : [],
    sql`
      SELECT v.store_category AS category, count(*)::int AS n FROM vendors v
      WHERE v.in_directory AND v.email_verified AND NOT v.is_suspended AND v.store_category IS NOT NULL
        AND EXISTS (SELECT 1 FROM products p WHERE p.vendor_id = v.id AND p.is_active)
      GROUP BY v.store_category
    `
  ]);
  const pics = new Map();
  photos.forEach((ph) => {
    const k = Number(ph.vendor_id);
    if (!pics.has(k)) pics.set(k, []);
    pics.get(k).push(photoUrl(ph.public_id));
  });
  const byCat = new Map(counts.map((c) => [c.category, Number(c.n)]));
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
  return res.status(200).json({
    stores: shown.map((r) => ({
      name: r.business_name,
      slug: r.slug,
      theme: themeOf(r),
      bio: r.bio || '',
      category: r.store_category || '',
      place: [r.city, r.state].filter(Boolean).join(', '),
      products: Number(r.products),
      rating: r.rating == null ? null : Number(r.rating),
      reviews: Number(r.reviews),
      picture: pictureUrlOf(r),
      photos: pics.get(Number(r.id)) || []
    })),
    categories: CATEGORIES.map((c) => ({ name: c, count: byCat.get(c) || 0 })),
    states: STATES,
    hasMore: rows.length > DIRECTORY_PAGE
  });
}

// A product photo or a seller's profile picture. Its address changes whenever
// the picture does, so it can be cached for a year by the phone and by Netlify's CDN.
async function servePhoto(publicId, res) {
  const photo = (await loadPhoto(publicId)) || (await loadPicture(publicId));
  if (!photo) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(404).json({ error: 'Photo not found' });
  }
  const forever = 'public, max-age=31536000, immutable';
  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Content-Length', String(photo.bytes.length));
  res.setHeader('Cache-Control', forever);
  res.setHeader('Netlify-CDN-Cache-Control', forever);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  return res.status(200).send(photo.bytes);
}

// Query values, whether the platform parsed them (req.query) or not.
function param(req, name) {
  if (req.query && typeof req.query[name] === 'string') return req.query[name];
  return new URL(req.url || '/', 'http://x').searchParams.get(name);
}

// Who invited a new seller, for the banner on the sign-up screen.
async function referrer(req, res) {
  try {
    const r = await findReferrer(param(req, 'ref'));
    if (!r) return res.status(404).json({ error: "That invite link doesn't work any more." });
    return res.status(200).json({ referrer: { name: r.business_name } });
  } catch (err) {
    console.error('Referrer lookup failed:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}

// How customers reach the business behind OrderPadi (SUPPORT_EMAIL and
// SUPPORT_WHATSAPP in Netlify). Shown on the home, terms and privacy pages.
function contact(res) {
  const email = String(process.env.SUPPORT_EMAIL || '').trim().toLowerCase();
  const whatsapp = normalizeNgPhone(process.env.SUPPORT_WHATSAPP || '');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  return res.status(200).json({
    contact: {
      email: /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email) ? email : null,
      whatsapp: whatsapp || null
    }
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method === 'GET') {
    // Pages with link previews: "/", "/s/<slug>", "/i/<id>" (see lib/pages.js).
    const render = param(req, 'render');
    if (render === 'home') return renderPage(req, res, 'home');
    if (render === 'store') return renderPage(req, res, 'store', param(req, 'slug'), param(req, 'p'));
    if (render === 'invoice') return renderPage(req, res, 'invoice', param(req, 'id'));
    if (param(req, 'site') === 'contact') return contact(res);
    if (param(req, 'ref') !== null) return referrer(req, res);
  }

  try {
    if (!sql) throw new HttpError(500, 'The store is not connected to its database yet.');
    if (req.method === 'GET') {
      const photo = param(req, 'photo');
      if (photo !== null) return await servePhoto(photo, res);
      if (param(req, 'directory') !== null) return await directory(req, res);
      const invoice = param(req, 'invoice');
      return invoice !== null ? await getInvoice(invoice, res) : await getStore(req, res);
    }

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'order') return await placeOrder(req, res, body);
    if (body.action === 'paid') return await markPaid(body, res);
    if (body.action === 'promo') return await checkPromo(body, res);
    if (body.action === 'review') return await leaveReview(body, res);
    if (body.action === 'stock-alert') return res.status(200).json(await requestStock(body, getClientIp(req)));
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    console.error('Public store error:', err);
    return res.status(500).json({ error: "Something went wrong placing your order. Please try again, or message the seller on WhatsApp." });
  }
};
