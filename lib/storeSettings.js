// Store settings that are lists: delivery areas and quick replies, plus the
// away message. Checked here so the API and any other caller agree.
const crypto = require('crypto');
const { HttpError } = require('./auth');
const { cleanText, nairaToKobo } = require('./format');

const MAX_ZONES = 20;
const MAX_REPLIES = 20;

const shortId = () => crypto.randomBytes(5).toString('hex');
const keepId = (id, taken) => (typeof id === 'string' && /^[a-z0-9]{6,12}$/.test(id) && !taken.has(id) ? id : null);

// [{ id?, name, fee }] -> [{ id, name, feeKobo }]
function readZones(raw) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'The delivery areas look wrong. Reload and try again.', { field: 'deliveryZones' });
  if (raw.length > MAX_ZONES) throw new HttpError(400, `You can have up to ${MAX_ZONES} delivery areas.`, { field: 'deliveryZones' });
  const ids = new Set();
  const names = new Set();
  return raw.map((z) => {
    const zone = z && typeof z === 'object' ? z : {};
    const name = cleanText(zone.name);
    if (name.length < 2 || name.length > 40) throw new HttpError(400, 'Give each delivery area a name, like "Lekki" or "Pick up".', { field: 'deliveryZones' });
    if (names.has(name.toLowerCase())) throw new HttpError(400, `You have "${name}" twice.`, { field: 'deliveryZones' });
    names.add(name.toLowerCase());
    let fee = 0;
    if (zone.fee != null && String(zone.fee).trim() !== '') {
      fee = nairaToKobo(zone.fee);
      if (fee === null) throw new HttpError(400, `Enter the fee for ${name} in naira, like 1500 (0 for free).`, { field: 'deliveryZones' });
    } else if (Number.isInteger(zone.feeKobo) && zone.feeKobo >= 0) {
      fee = zone.feeKobo;
    }
    if (fee > 100000000) throw new HttpError(400, `The fee for ${name} is too high.`, { field: 'deliveryZones' });
    const id = keepId(zone.id, ids) || shortId();
    ids.add(id);
    return { id, name, feeKobo: fee };
  });
}

function zonesOf(vendor) {
  const raw = vendor && vendor.delivery_zones;
  return Array.isArray(raw)
    ? raw.map((z) => ({ id: String(z.id), name: String(z.name), feeKobo: Number(z.feeKobo) || 0 }))
    : [];
}

// Placeholders the app fills in when sending: {name} {order} {total}
// {balance} {link} {store}.
const DEFAULT_QUICK_REPLIES = [
  { title: 'Thanks for ordering', body: 'Hi {name}, thank you for your order #{order} from {store}! The total is {total}. Here is your invoice: {link}' },
  { title: 'Payment received', body: 'Hi {name}, we have received your payment for order #{order}. Thank you! We will let you know once it is on the way.' },
  { title: 'On the way', body: 'Hi {name}, your order #{order} is on the way to you. Please keep your phone close for the rider.' },
  { title: 'Payment reminder', body: 'Hi {name}, a gentle reminder that {balance} is still outstanding on order #{order}. You can pay here: {link}' }
];

function readQuickReplies(raw) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'The quick replies look wrong. Reload and try again.', { field: 'quickReplies' });
  if (raw.length > MAX_REPLIES) throw new HttpError(400, `You can save up to ${MAX_REPLIES} quick replies.`, { field: 'quickReplies' });
  const ids = new Set();
  return raw.map((r) => {
    const reply = r && typeof r === 'object' ? r : {};
    const title = cleanText(reply.title);
    const body = String(reply.body == null ? '' : reply.body).trim().replace(/\r\n/g, '\n');
    if (title.length < 1 || title.length > 30) throw new HttpError(400, 'Give each quick reply a short title (up to 30 characters).', { field: 'quickReplies' });
    if (body.length < 1 || body.length > 500) throw new HttpError(400, `Write the message for "${title}" (up to 500 characters).`, { field: 'quickReplies' });
    const id = keepId(reply.id, ids) || shortId();
    ids.add(id);
    return { id, title, body };
  });
}

function quickRepliesOf(vendor) {
  const raw = vendor && vendor.quick_replies;
  return Array.isArray(raw) ? raw.map((r) => ({ id: String(r.id), title: String(r.title), body: String(r.body) })) : [];
}

function readAwayMessage(raw) {
  const text = cleanText(raw);
  if (text.length > 140) throw new HttpError(400, 'Keep the away message under 140 characters.', { field: 'awayMessage' });
  return text || null;
}

module.exports = { MAX_ZONES, MAX_REPLIES, DEFAULT_QUICK_REPLIES, readZones, zonesOf, readQuickReplies, quickRepliesOf, readAwayMessage };
