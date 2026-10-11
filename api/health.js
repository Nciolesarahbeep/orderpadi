// Setup check: confirms the database connects, schema.sql and each step's
// database update ran, and the environment variables are set. Opened by /setup.
// The same checks are in the admin panel, so once you've launched you can
// delete this file and setup.html to free a function slot.
const { checkHealth } = require('../lib/health');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const result = await checkHealth();
  return res.status(result.db ? 200 : 500).json(result);
};
