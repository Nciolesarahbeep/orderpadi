// Serves the home, store and invoice pages with their link-preview tags
// (title, description, picture) filled in on the server. WhatsApp and
// Instagram don't run the page's JavaScript when they build a preview, so
// without this every store link would preview as a blank "Order online".
// The page then loads its data in the browser exactly as before.
//
// vercel.json sends "/", "/s/<slug>" and "/i/<id>" here and bundles the
// .html files with the function (functions → includeFiles).
const fs = require('fs');
const path = require('path');
const { sql } = require('./db');
const { isPro } = require('./plan');
const { STORE_THEMES } = require('./photos');
const { formatNaira } = require('./format');

// The seller's profile picture, when the address is one we wrote (see lib/profilePicture.js).
const PICTURE_PATH = /^\/p\/[0-9a-f]{16}$/;
const pictureOf = (row) => (row && typeof row.logo_url === 'string' && PICTURE_PATH.test(row.logo_url) ? row.logo_url : null);
const PICTURE_SIZE = [640, 640];

function themeId(id) {
  return Object.prototype.hasOwnProperty.call(STORE_THEMES, id) ? id : 'green';
}

const files = {};
// The page files are bundled with the function (vercel.json → includeFiles).
// If they ever aren't, fetch the same file from the site's static copy
// ("/home", "/store", "/invoice") so the page still loads.
async function readPage(name, base) {
  if (files[name]) return files[name];
  const places = [path.join(__dirname, '..', name), path.join(process.cwd(), name)];
  for (const file of places) {
    try {
      files[name] = fs.readFileSync(file, 'utf8');
      return files[name];
    } catch (err) { /* try the next place */ }
  }
  if (base) {
    const response = await fetch(`${base}/${name.replace(/\.html$/, '')}`, { redirect: 'follow' });
    if (response.ok) {
      files[name] = await response.text();
      return files[name];
    }
  }
  throw new Error(`Could not find ${name}`);
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function origin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return /^[a-z0-9.:-]+$/i.test(host) ? `${proto === 'http' ? 'http' : 'https'}://${host}` : '';
}

function fill(html, { title, description, url, image, imageSize = [1200, 630], siteName, canonical = true, theme }) {
  const tags = [
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(title)}">`,
    description && `<meta property="og:description" content="${esc(description)}">`,
    url && `<meta property="og:url" content="${esc(url)}">`,
    image && `<meta property="og:image" content="${esc(image)}">`,
    image && imageSize && `<meta property="og:image:width" content="${imageSize[0]}">`,
    image && imageSize && `<meta property="og:image:height" content="${imageSize[1]}">`,
    siteName && `<meta property="og:site_name" content="${esc(siteName)}">`,
    // A square picture (a seller's profile picture) previews best as a small card.
    `<meta name="twitter:card" content="${image && !(imageSize && imageSize[0] === imageSize[1]) ? 'summary_large_image' : 'summary'}">`,
    canonical && url && `<link rel="canonical" href="${esc(url)}">`
  ].filter(Boolean).join('\n  ');
  let out = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`);
  if (theme) {
    // The seller's store colour, there before the page's data loads.
    const id = themeId(theme);
    out = out.replace(/<meta name="theme-color"[^>]*>/g, () => `<meta name="theme-color" content="${STORE_THEMES[id].hex}">`);
    out = out.replace(/<html([^>]*)>/, (m, attrs) => `<html${attrs.replace(/\sdata-store="[^"]*"/, '')} data-store="${id}">`);
  }
  if (description) {
    out = /<meta name="description"[^>]*>/.test(out)
      ? out.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(description)}">`)
      : out.replace('<!--meta-->', () => `<meta name="description" content="${esc(description)}">\n  <!--meta-->`);
  }
  return out.replace('<!--meta-->', () => tags);
}

function send(res, status, html, cache) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  return res.status(status).send(html);
}

async function renderHome(req, res) {
  const base = origin(req);
  const html = await readPage('home.html', base);
  const title = (/<title>([\s\S]*?)<\/title>/.exec(html) || [])[1] || 'OrderPadi';
  const description = (/<meta name="description" content="([^"]*)">/.exec(html) || [])[1] || '';
  return send(res, 200, fill(html, {
    title: title.replace(/&amp;/g, '&'),
    description: description.replace(/&amp;/g, '&'),
    url: base ? `${base}/` : '',
    image: base ? `${base}/og.png` : '',
    siteName: 'OrderPadi'
  }), 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
}

async function renderStore(req, res, rawSlug, rawProduct) {
  const base = origin(req);
  const html = await readPage('store.html', base);
  const slug = String(rawSlug || '').toLowerCase();
  let vendor = null;
  if (/^[a-z0-9-]{3,40}$/.test(slug) && sql) {
    const rows = await sql`
      SELECT v.business_name, v.plan, v.plan_renews_at, v.store_theme, v.logo_url, (
        SELECT ph.public_id FROM product_photos ph JOIN products p ON p.id = ph.product_id
        WHERE ph.vendor_id = v.id AND p.is_active = TRUE
        ORDER BY p.sort_order, p.created_at, p.id, ph.position, ph.id LIMIT 1
      ) AS cover_photo
      FROM vendors v
      WHERE v.slug = ${slug} AND v.email_verified = TRUE AND v.is_suspended = FALSE
      LIMIT 1
    `;
    vendor = rows[0] || null;
  }
  if (!vendor) {
    return send(res, 404, fill(html, { title: 'Store not found', canonical: false }), 'public, max-age=0, s-maxage=30');
  }
  const name = vendor.business_name;
  // A link to one product (/s/<slug>?p=<id>): its name, price and photo in the preview.
  const productId = /^\d{1,12}$/.test(String(rawProduct || '')) ? Number(rawProduct) : 0;
  if (productId) {
    const [p] = await sql`
      SELECT p.name, p.price_kobo, p.description,
        (SELECT ph.public_id FROM product_photos ph
         WHERE ph.product_id = CASE WHEN p.is_resale THEN p.source_product_id ELSE p.id END
         ORDER BY ph.position, ph.id LIMIT 1) AS photo
      FROM products p JOIN vendors v ON v.id = p.vendor_id
      WHERE p.id = ${productId} AND v.slug = ${slug} AND p.is_active = TRUE
      LIMIT 1
    `;
    if (p) {
      const desc = String(p.description || '').replace(/\s+/g, ' ').trim();
      return send(res, 200, fill(html, {
        title: `${p.name} · ${formatNaira(Number(p.price_kobo))} · ${name}`,
        description: desc ? (desc.length > 150 ? desc.slice(0, 147) + '…' : desc) : `Order from ${name} in a minute.`,
        url: base ? `${base}/s/${slug}?p=${productId}` : '',
        image: base ? (p.photo ? `${base}/p/${p.photo}` : (vendor.cover_photo ? `${base}/p/${vendor.cover_photo}` : (pictureOf(vendor) ? base + pictureOf(vendor) : `${base}/og-shop.png`))) : '',
        imageSize: p.photo || vendor.cover_photo ? null : (pictureOf(vendor) ? PICTURE_SIZE : [1200, 630]),
        siteName: isPro(vendor) ? null : 'OrderPadi',
        canonical: false,
        theme: themeId(vendor.store_theme)
      }), 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    }
  }
  return send(res, 200, fill(html, {
    title: `${name} · Order online`,
    description: `See what ${name} has available and send your order in a minute.`,
    url: base ? `${base}/s/${slug}` : '',
    // The first product photo makes a far better WhatsApp preview than a logo;
    // a store with no photos yet shows the seller's profile picture.
    image: base ? (vendor.cover_photo ? `${base}/p/${vendor.cover_photo}` : (pictureOf(vendor) ? base + pictureOf(vendor) : `${base}/og-shop.png`)) : '',
    imageSize: vendor.cover_photo ? null : (pictureOf(vendor) ? PICTURE_SIZE : [1200, 630]),
    siteName: isPro(vendor) ? null : 'OrderPadi',
    theme: themeId(vendor.store_theme)
  }), 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
}

async function renderInvoice(req, res, rawId) {
  const base = origin(req);
  const html = await readPage('invoice.html', base);
  const id = String(rawId || '').toLowerCase();
  let order = null;
  if (/^[0-9a-f]{16}$/.test(id) && sql) {
    const rows = await sql`
      SELECT o.order_number, o.payment_status, o.status, v.business_name, v.plan, v.plan_renews_at, v.store_theme, v.logo_url
      FROM orders o JOIN vendors v ON v.id = o.vendor_id
      WHERE o.public_id = ${id} AND v.is_suspended = FALSE
      LIMIT 1
    `;
    order = rows[0] || null;
  }
  if (!order) {
    return send(res, 404, fill(html, { title: 'Invoice not found', canonical: false }), 'public, max-age=0, s-maxage=30');
  }
  const n = order.order_number;
  const name = order.business_name;
  let title = `Invoice #${n} from ${name}`;
  let description = 'Tap to see what you ordered and how to pay.';
  if (order.status === 'cancelled') {
    title = `Order #${n} from ${name} (cancelled)`;
    description = 'This order was cancelled.';
  } else if (order.payment_status === 'paid') {
    title = `Receipt #${n} from ${name}`;
    description = 'Tap to see your receipt.';
  }
  return send(res, 200, fill(html, {
    title,
    description,
    url: base ? `${base}/i/${id}` : '',
    // The seller's profile picture, so customers see who the invoice is from.
    image: base ? (pictureOf(order) ? base + pictureOf(order) : `${base}/og-shop.png`) : '',
    imageSize: pictureOf(order) ? PICTURE_SIZE : [1200, 630],
    siteName: isPro(order) ? null : 'OrderPadi',
    canonical: false,
    theme: themeId(order.store_theme)
  }), 'public, max-age=0, s-maxage=30');
}

// Never fail to show the page: if the database is down, serve it without
// the preview tags and let the page show its own error.
async function renderPage(req, res, kind, key, extra) {
  try {
    if (kind === 'home') return await renderHome(req, res);
    if (kind === 'store') return await renderStore(req, res, key, extra);
    if (kind === 'invoice') return await renderInvoice(req, res, key);
  } catch (err) {
    console.error('Page render error:', err);
    const file = { home: 'home.html', store: 'store.html', invoice: 'invoice.html' }[kind];
    try { return send(res, 200, await readPage(file, origin(req)), 'no-store'); } catch (e) { /* fall through */ }
  }
  return send(res, 404, 'Not found', 'no-store');
}

module.exports = { renderPage, esc };
