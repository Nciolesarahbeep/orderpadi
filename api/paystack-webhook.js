// Paystack calls this for every billing event (payments, renewals,
// cancellations). Set its URL in Paystack: Settings → API Keys & Webhooks →
// Webhook URL = https://<your domain>/api/paystack-webhook
//
// Every request must carry a valid x-paystack-signature (HMAC-SHA512 of the
// body with your secret key), or it is rejected. Events are applied once,
// even if Paystack sends them again.
const { sql } = require('../lib/db');
const { signatureValid, applyEvent } = require('../lib/paystack');

// The exact bytes Paystack sent, when the platform still has them.
function readRawBody(req) {
  return new Promise((resolve) => {
    if (!req || typeof req.on !== 'function' || req.readableEnded || req.readable === false) return resolve('');
    const chunks = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', finish);
    req.on('error', finish);
    setTimeout(finish, 1500);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.PAYSTACK_SECRET_KEY || !sql) {
    return res.status(503).json({ error: 'Billing is not set up.' });
  }

  const signature = req.headers['x-paystack-signature'];
  const raw = await readRawBody(req);
  // Check the raw bytes first; fall back to the parsed body re-serialised,
  // which is what Paystack's own Node example does.
  const candidates = [];
  if (raw) candidates.push(raw);
  if (typeof req.body === 'string') candidates.push(req.body);
  else if (Buffer.isBuffer(req.body)) candidates.push(req.body.toString('utf8'));
  else if (req.body && typeof req.body === 'object') candidates.push(JSON.stringify(req.body));
  const body = candidates.find((c) => signatureValid(c, signature));
  if (!body) return res.status(401).json({ error: 'Invalid signature.' });

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }

  try {
    await applyEvent(String(payload.event || ''), payload.data);
    return res.status(200).json({ received: true });
  } catch (err) {
    // A 500 makes Paystack retry later, which is what we want for a database hiccup.
    console.error('Paystack webhook error:', err);
    return res.status(500).json({ error: 'Could not process the event.' });
  }
};
