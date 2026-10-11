// Netlify entry point. One function serves every /api/... request and the
// pages that need link previews; everything else is a static file.
// The handlers themselves live in api/*.js (see lib/webAdapter.js).
import adapter from '../../lib/webAdapter.js';

export default async (request, context) => {
  // The handlers read settings from process.env; make sure Netlify's are there.
  const netlifyEnv = globalThis.Netlify && globalThis.Netlify.env;
  if (netlifyEnv && typeof netlifyEnv.toObject === 'function') {
    for (const [key, value] of Object.entries(netlifyEnv.toObject())) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  try {
    return await adapter.handle(request, context);
  } catch (err) {
    console.error('OrderPadi request failed:', err);
    return new Response('Something went wrong. Please try again.', { status: 500, headers: { 'content-type': 'text/plain' } });
  }
};

export const config = {
  path: ['/api/*', '/', '/s/*', '/i/*']
};
