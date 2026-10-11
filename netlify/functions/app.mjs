// Netlify entry point. One function serves every /api/... request and the
// pages that need link previews; everything else is a static file.
// The handlers themselves live in api/*.js (see lib/webAdapter.js).
let loadError = null;
const adapterReady = import('../../lib/webAdapter.js')
  .then((m) => m.default || m)
  .catch((err) => { loadError = err; console.error('OrderPadi failed to start:', err); return null; });

export default async (request, context) => {
  const adapter = await adapterReady;
  if (!adapter) {
    // Temporary: show why start-up failed at /?diag=orderpadi-check
    if (new URL(request.url).searchParams.get('diag') === 'orderpadi-check') {
      const fs = await import('node:fs');
      const look = (dir) => { try { return dir + ': ' + fs.readdirSync(dir).join(', '); } catch (e) { return dir + ': (missing)'; } };
      const listing = ['/var/task', '/var/task/node_modules', '/var/task/node_modules/@neondatabase', '/var/task/netlify/functions', '/var/task/netlify/functions/node_modules', process.cwd()].map(look).join('\n');
      return new Response('START-UP ERROR\n' + (loadError && (loadError.stack || loadError.message)) + '\n\nFILES\n' + listing, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('OrderPadi is starting up. Please try again in a minute.', { status: 503 });
  }
  try {
    return await adapter.handle(request, context);
  } catch (err) {
    console.error('OrderPadi request failed:', err);
    if (new URL(request.url).searchParams.get('diag') === 'orderpadi-check') {
      return new Response('REQUEST ERROR\n' + (err.stack || err.message), { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('Something went wrong.', { status: 500 });
  }
};

export const config = {
  path: ['/api/*', '/', '/s/*', '/i/*']
};
