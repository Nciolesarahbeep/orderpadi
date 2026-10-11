// Netlify entry point. One function serves every /api/... request and the
// pages that need link previews; everything else is a static file.
// The handlers themselves live in api/*.js (see lib/webAdapter.js).
import adapter from '../../lib/webAdapter.js';

export default (request, context) => adapter.handle(request, context);

export const config = {
  path: ['/api/*', '/', '/s/*', '/i/*']
};
