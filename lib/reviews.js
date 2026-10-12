// Reviews: a customer rates their order (1 to 5 stars, with an optional
// note) from the invoice link, once it's paid or delivered. One review per
// order; the customer can change it for 30 days. Sellers can reply.
const { HttpError } = require('./auth');

const EDIT_DAYS = 30;

// "Tola Ade Bello" -> "Tola B."
function publicName(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}' -]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'A customer';
  const first = words[0].slice(0, 20);
  return words.length > 1 ? first + ' ' + words[words.length - 1][0].toUpperCase() + '.' : first;
}

// A customer can rate an order once it has been paid or delivered.
function canReview(order) {
  return order.status !== 'cancelled' && (order.status === 'delivered' || order.payment_status === 'paid');
}

function readReview(body) {
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Tap the stars to choose a rating.', { field: 'rating' });
  const text = String(body.body == null ? '' : body.body).trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (text.length > 500) throw new HttpError(400, 'Keep your review under 500 characters.', { field: 'body' });
  return { rating, body: text || null };
}

function readReply(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/\r\n/g, '\n');
  if (text.length > 500) throw new HttpError(400, 'Keep your reply under 500 characters.', { field: 'reply' });
  return text || null;
}

function reviewForPublic(r) {
  return {
    rating: Number(r.rating),
    body: r.body || '',
    name: r.customer_name,
    reply: r.reply || '',
    repliedAt: r.replied_at || null,
    createdAt: r.created_at
  };
}

async function ratingSummary(sql, vendorId) {
  const [row] = await sql`
    SELECT count(*)::int AS n, coalesce(round(avg(rating)::numeric, 1), 0)::float AS avg,
           count(*) FILTER (WHERE rating = 5)::int AS r5, count(*) FILTER (WHERE rating = 4)::int AS r4,
           count(*) FILTER (WHERE rating = 3)::int AS r3, count(*) FILTER (WHERE rating = 2)::int AS r2,
           count(*) FILTER (WHERE rating = 1)::int AS r1
    FROM reviews WHERE vendor_id = ${vendorId} AND is_hidden = FALSE
  `;
  return {
    average: Number(row.avg),
    count: Number(row.n),
    breakdown: { 5: Number(row.r5), 4: Number(row.r4), 3: Number(row.r3), 2: Number(row.r2), 1: Number(row.r1) }
  };
}

module.exports = { EDIT_DAYS, publicName, canReview, readReview, readReply, reviewForPublic, ratingSummary };
