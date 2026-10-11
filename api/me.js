// The logged-in vendor. GET /api/me -> { vendor } or 401.
// Step 3 adds updating store settings here.
const { sql } = require('../lib/db');
const { getSessionVendor, vendorForClient } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (!sql) return res.status(500).json({ error: 'The database is not connected (DATABASE_URL is missing).' });
    const vendor = await getSessionVendor(req);
    if (!vendor) return res.status(401).json({ error: 'Not logged in.' });
    return res.status(200).json({ vendor: vendorForClient(vendor) });
  } catch (err) {
    console.error('Me error:', err);
    const hint = /JWT_SECRET/.test(String(err && err.message)) ? ' (JWT_SECRET is missing on the server)' : '';
    return res.status(500).json({ error: `Something went wrong.${hint}` });
  }
};
