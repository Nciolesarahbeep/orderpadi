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

function fill(html, { title, description, url, image, siteName, canonical = true }) {
  const tags = [
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(title)}">`,
    description && `<meta property="og:description" content="${esc(description)}">`,
    url && `<meta property="og:url" content="${esc(url)}">`,
    image && `<meta property="og:image" content="${esc(image)}">`,
    image && '<meta property="og:image:width" content="1200">',
    image && '<meta property="og:image:height" content="630">',
    siteName && `<meta property="og:site_name" content="${esc(siteName)}">`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    canonical && url && `<link rel="canonical" href="${esc(url)}">`
  ].filter(Boolean).join('\n  ');
  let out = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`);
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

async function renderStore(req, res, rawSlug) {
  const base = origin(req);
  const html = await readPage('store.html', base);
  const slug = String(rawSlug || '').toLowerCase();
  let vendor = null;
  if (/^[a-z0-9-]{3,40}$/.test(slug) && sql) {
    const rows = await sql`
      SELECT business_name, plan, plan_renews_at FROM vendors
      WHERE slug = ${slug} AND email_verified = TRUE AND is_suspended = FALSE
      LIMIT 1
    `;
    vendor = rows[0] || null;
  }
  if (!vendor) {
    return send(res, 404, fill(html, { title: 'Store not found', canonical: false }), 'public, max-age=0, s-maxage=30');
  }
  const name = vendor.business_name;
  return send(res, 200, fill(html, {
    title: `${name} · Order online`,
    description: `See what ${name} has available and send your order in a minute.`,
    url: base ? `${base}/s/${slug}` : '',
    image: base ? `${base}/og-shop.png` : '',
    siteName: isPro(vendor) ? null : 'OrderPadi'
  }), 'public, max-age=0, s-maxage=60, stale-while-revalidate=600');
}

async function renderInvoice(req, res, rawId) {
  const base = origin(req);
  const html = await readPage('invoice.html', base);
  const id = String(rawId || '').toLowerCase();
  let order = null;
  if (/^[0-9a-f]{16}$/.test(id) && sql) {
    const rows = await sql`
      SELECT o.order_number, o.payment_status, o.status, v.business_name, v.plan, v.plan_renews_at
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
    image: base ? `${base}/og-shop.png` : '',
    siteName: isPro(order) ? null : 'OrderPadi',
    canonical: false
  }), 'public, max-age=0, s-maxage=30');
}

// Never fail to show the page: if the database is down, serve it without
// the preview tags and let the page show its own error.
async function renderPage(req, res, kind, key) {
  try {
    if (kind === 'home') return await renderHome(req, res);
    if (kind === 'store') return await renderStore(req, res, key);
    if (kind === 'invoice') return await renderInvoice(req, res, key);
  } catch (err) {
    console.error('Page render error:', err);
    const file = { home: 'home.html', store: 'store.html', invoice: 'invoice.html' }[kind];
    try { return send(res, 200, await readPage(file, origin(req)), 'no-store'); } catch (e) { /* fall through */ }
  }
  return send(res, 404, 'Not found', 'no-store');
}

module.exports = { renderPage, esc };
