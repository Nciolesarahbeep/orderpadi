// Runs the api/*.js handlers (written in the Node req/res style) on hosts
// whose functions take a web-standard Request and return a Response, such
// as Netlify. netlify/functions/app.mjs sends every /api/... request here,
// plus the three pages served with link previews: "/", "/s/<slug>", "/i/<id>",
// and product photos at "/p/<id>".
const handlers = {
  admin: require('../api/admin'),
  auth: require('../api/auth'),
  billing: require('../api/billing'),
  health: require('../api/health'),
  me: require('../api/me'),
  orders: require('../api/orders'),
  'paystack-webhook': require('../api/paystack-webhook'),
  products: require('../api/products'),
  public: require('../api/public'),
  tools: require('../api/tools')
};

function decode(value) {
  try { return decodeURIComponent(value); } catch (err) { return ''; }
}

// Which handler a path belongs to, and the query it should see.
function route(url) {
  let m;
  if ((m = /^\/api\/([a-z-]+)\/?$/.exec(url.pathname))) return { name: m[1], query: Object.fromEntries(url.searchParams) };
  if (url.pathname === '/') return { name: 'public', query: { render: 'home' } };
  if ((m = /^\/s\/([^/]+)\/?$/.exec(url.pathname))) return { name: 'public', query: { render: 'store', slug: decode(m[1]) } };
  if ((m = /^\/i\/([^/]+)\/?$/.exec(url.pathname))) return { name: 'public', query: { render: 'invoice', id: decode(m[1]) } };
  if ((m = /^\/p\/([0-9a-f]{16})(?:\.(?:jpg|webp))?$/.exec(url.pathname))) return { name: 'public', query: { photo: m[1] } };
  return null;
}

// The small part of Node's response object the handlers use.
class NodeStyleResponse {
  constructor() { this.statusCode = 200; this.headers = {}; this.body = ''; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  status(code) { this.statusCode = code; return this; }
  json(data) {
    if (!this.headers['content-type']) this.headers['content-type'] = 'application/json; charset=utf-8';
    this.body = JSON.stringify(data);
    return this;
  }
  send(data) { this.body = data == null ? '' : data; return this; }
  end(data) { if (data != null) this.body = data; return this; }
  toResponse() {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.headers)) {
      [].concat(value).forEach((v) => headers.append(name, String(v)));
    }
    // Same safety headers the static pages get from netlify.toml.
    if (!headers.has('x-content-type-options')) headers.set('x-content-type-options', 'nosniff');
    if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    if (!headers.has('x-frame-options')) headers.set('x-frame-options', 'DENY');
    const empty = this.statusCode === 204 || this.statusCode === 304;
    // Photos are Buffers; everything else is text.
    return new Response(empty ? null : this.body, { status: this.statusCode, headers });
  }
}

async function handle(request, context = {}) {
  const url = new URL(request.url);
  const target = route(url);
  if (!target || !handlers[target.name]) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const headers = {};
  request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  // Use the platform's view of the visitor's address, not what the browser claims.
  const ip = context.ip || headers['x-nf-client-connection-ip'] || String(headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  headers['x-forwarded-for'] = ip;
  headers['x-forwarded-host'] = url.host;
  headers['x-forwarded-proto'] = url.protocol.replace(':', '');
  headers.host = url.host;

  const raw = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  let body;
  if (raw && String(headers['content-type'] || '').includes('application/json')) {
    try { body = JSON.parse(raw); } catch (err) { body = {}; }
  } else if (raw) {
    body = raw;
  }
  const search = new URLSearchParams(target.query).toString();
  const req = {
    method: request.method,
    url: `/api/${target.name}${search ? '?' + search : ''}`,
    headers,
    query: target.query,
    body,
    rawBody: raw, // the exact bytes, for checking Paystack's signature
    socket: { remoteAddress: ip }
  };
  const res = new NodeStyleResponse();
  try {
    await handlers[target.name](req, res);
  } catch (err) {
    console.error('Unhandled error in', target.name, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  return res.toResponse();
}

module.exports = { handle, route };
