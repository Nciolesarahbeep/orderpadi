// Netlify entry point. One function serves every /api/... request and the
// pages that need link previews; everything else is a static file.
// The handlers themselves live in api/*.js (see lib/webAdapter.js).
import adapter from '../../lib/webAdapter.js';
import db from '../../lib/db.js';

export default async (request, context) => {
  const hadEnv = Boolean(process.env.DATABASE_URL);
  // The handlers read settings from process.env; make sure Netlify's are there.
  const netlifyEnv = globalThis.Netlify && globalThis.Netlify.env;
  if (netlifyEnv && typeof netlifyEnv.toObject === 'function') {
    for (const [key, value] of Object.entries(netlifyEnv.toObject())) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  // Temporary: database check at /?diag=orderpadi-check (removed after launch checks)
  if (new URL(request.url).searchParams.get('diag') === 'orderpadi-check') {
    let report = 'ENV process-before=' + hadEnv + ' process-now=' + Boolean(process.env.DATABASE_URL) + ' netlify=' + Boolean(globalThis.Netlify && Netlify.env.get('DATABASE_URL')) + '\n';
    try {
      const rows = await db.sql`SELECT now() AS t, current_database() AS db, (SELECT count(*) FROM vendors) AS vendors, ${true}::boolean AS flag`;
      report += 'DB OK ' + JSON.stringify(rows[0]);
    } catch (err) {
      report += 'DB ERROR ' + (err.stack || err.message);
    }
    return new Response(report, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return adapter.handle(request, context);
};

export const config = {
  path: ['/api/*', '/', '/s/*', '/i/*']
};
