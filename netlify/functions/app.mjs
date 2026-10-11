// Netlify entry point. One function serves every /api/... request and the
// pages that need link previews; everything else is a static file.
// The handlers themselves live in api/*.js (see lib/webAdapter.js).
import adapter from '../../lib/webAdapter.js';
import db from '../../lib/db.js';

export default async (request, context) => {
  // Temporary: database check at /?diag=orderpadi-check (removed after launch checks)
  if (new URL(request.url).searchParams.get('diag') === 'orderpadi-check') {
    let report;
    try {
      const rows = await db.sql`SELECT now() AS t, current_database() AS db, (SELECT count(*) FROM vendors) AS vendors, ${true}::boolean AS flag`;
      report = 'DB OK ' + JSON.stringify(rows[0]);
    } catch (err) {
      report = 'DB ERROR ' + (err.stack || err.message);
    }
    return new Response(report, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return adapter.handle(request, context);
};

export const config = {
  path: ['/api/*', '/', '/s/*', '/i/*']
};
