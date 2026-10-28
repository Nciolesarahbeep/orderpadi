// The logged-in vendor and their store settings.
//   GET   /api/me  -> { vendor, setup }
//   PATCH /api/me  { businessName?, slug?, whatsappPhone?, bankName?,
//                    bankAccountNumber?, bankAccountName?, deliveryFee?, deliveryNote?,
//                    storeTheme?, deliveryZones?, quickReplies?, awayMessage? }
//                  storeTheme: green, coral, sun, sky, grape or night
//                  deliveryZones: [{ id?, name, fee }] (fee in naira); quickReplies: [{ id?, title, body }]
//                  awayMessage: shown on the store while you're away ("" to turn it off)
//                  bio?, storeCategory?, state?, city?, inDirectory?: the listing at /stores
//                  -> { vendor, setup }
// Only the fields sent are changed. "setup" drives the checklist on Home.
// Phone alerts (lib/push.js):
//   GET   /api/me also returns push: { key, devices }  (key: the server's public key for subscribing)
//   POST  /api/me { action: "push-on", subscription }  -> { push }   this phone gets alerts
//   POST  /api/me { action: "push-off", endpoint }     -> { push }
//   POST  /api/me { action: "push-test", endpoint }    -> { sent: true }   409 { resubscribe } if it must turn on again
// Profile picture (lib/profilePicture.js), cropped to a square on the phone first:
//   POST  /api/me { action: "picture-set", image: "data:image/jpeg;base64,..." } -> { vendor, setup }
//   POST  /api/me { action: "picture-remove" }                                   -> { vendor, setup }
const { sql } = require('../lib/db');
const { HttpError, getSessionVendor, vendorForClient, sessionJti } = require('../lib/auth');
const { cleanSlug, slugProblem, cleanText, nairaToKobo, normalizeNgPhone } = require('../lib/format');
const { STORE_THEMES } = require('../lib/photos');
const { readZones, readQuickReplies, readAwayMessage } = require('../lib/storeSettings');
const { readProfile } = require('../lib/directory');
const { saveSubscription, removeSubscription, sendTest, pushInfo } = require('../lib/push');
const { setPicture, removePicture } = require('../lib/profilePicture');

async function setupStatus(vendor) {
  const [row] = await sql`SELECT count(*)::int AS n FROM products WHERE vendor_id = ${vendor.id} AND is_active = TRUE`;
  return {
    whatsapp: !!vendor.whatsapp_phone,
    bank: !!(vendor.bank_name && vendor.bank_account_number && vendor.bank_account_name),
    products: Number(row.n)
  };
}

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

async function updateSettings(vendor, body) {
  const next = {
    business_name: vendor.business_name,
    slug: vendor.slug,
    whatsapp_phone: vendor.whatsapp_phone,
    bank_name: vendor.bank_name,
    bank_account_number: vendor.bank_account_number,
    bank_account_name: vendor.bank_account_name,
    default_delivery_fee_kobo: Number(vendor.default_delivery_fee_kobo || 0),
    delivery_note: vendor.delivery_note,
    store_theme: vendor.store_theme || 'green',
    delivery_zones: Array.isArray(vendor.delivery_zones) ? vendor.delivery_zones : [],
    quick_replies: Array.isArray(vendor.quick_replies) ? vendor.quick_replies : [],
    away_message: vendor.away_message || null,
    bio: vendor.bio || null,
    store_category: vendor.store_category || null,
    state: vendor.state || null,
    city: vendor.city || null,
    in_directory: !!vendor.in_directory
  };

  if (has(body, 'businessName')) {
    const name = cleanText(body.businessName);
    if (name.length < 2 || name.length > 60) {
      throw new HttpError(400, 'Enter your business name (2 to 60 characters).', { field: 'businessName' });
    }
    next.business_name = name;
  }

  if (has(body, 'slug')) {
    const slug = cleanSlug(body.slug);
    const problem = slugProblem(slug);
    if (problem) throw new HttpError(400, problem, { field: 'slug' });
    if (slug !== vendor.slug) {
      const taken = await sql`
        SELECT 1 FROM vendors
        WHERE slug = ${slug} AND id <> ${vendor.id}
          AND (email_verified = TRUE OR updated_at > now() - interval '1 day')
        LIMIT 1
      `;
      if (taken.length) throw new HttpError(409, 'That store link is taken. Try another.', { field: 'slug' });
      // An abandoned, unconfirmed sign-up holding this link gives it up.
      await sql`DELETE FROM vendors WHERE slug = ${slug} AND id <> ${vendor.id} AND email_verified = FALSE`;
    }
    next.slug = slug;
  }

  if (has(body, 'whatsappPhone')) {
    const raw = cleanText(body.whatsappPhone);
    if (!raw) {
      next.whatsapp_phone = null;
    } else {
      const phone = normalizeNgPhone(raw);
      if (!phone) throw new HttpError(400, 'Enter a Nigerian WhatsApp number, like 0803 123 4567.', { field: 'whatsappPhone' });
      next.whatsapp_phone = phone;
    }
  }

  if (has(body, 'bankName')) {
    const bank = cleanText(body.bankName);
    if (bank.length > 60) throw new HttpError(400, 'That bank name is too long.', { field: 'bankName' });
    next.bank_name = bank || null;
  }
  if (has(body, 'bankAccountNumber')) {
    const digits = String(body.bankAccountNumber || '').replace(/\D/g, '');
    if (digits && digits.length !== 10) {
      throw new HttpError(400, 'Nigerian account numbers have 10 digits.', { field: 'bankAccountNumber' });
    }
    next.bank_account_number = digits || null;
  }
  if (has(body, 'bankAccountName')) {
    const name = cleanText(body.bankAccountName);
    if (name.length > 80) throw new HttpError(400, 'That account name is too long.', { field: 'bankAccountName' });
    next.bank_account_name = name || null;
  }
  // Half-filled bank details would show customers a broken invoice.
  const bankParts = [next.bank_name, next.bank_account_number, next.bank_account_name];
  if (bankParts.some(Boolean) && !bankParts.every(Boolean)) {
    const field = !next.bank_name ? 'bankName' : !next.bank_account_number ? 'bankAccountNumber' : 'bankAccountName';
    throw new HttpError(400, 'Fill in your bank name, account number and account name, or leave all three empty.', { field });
  }

  if (has(body, 'deliveryFee')) {
    const raw = body.deliveryFee;
    const kobo = raw === '' || raw == null ? 0 : nairaToKobo(raw);
    if (kobo === null) throw new HttpError(400, 'Enter the delivery fee in naira, like 1500.', { field: 'deliveryFee' });
    next.default_delivery_fee_kobo = kobo;
  }
  if (has(body, 'deliveryNote')) {
    const note = cleanText(body.deliveryNote);
    if (note.length > 140) throw new HttpError(400, 'Keep the delivery note under 140 characters.', { field: 'deliveryNote' });
    next.delivery_note = note || null;
  }

  if (has(body, 'storeTheme')) {
    const theme = String(body.storeTheme || '');
    if (!Object.prototype.hasOwnProperty.call(STORE_THEMES, theme)) {
      throw new HttpError(400, 'Pick one of the store colours.', { field: 'storeTheme' });
    }
    next.store_theme = theme;
  }

  if (has(body, 'deliveryZones')) next.delivery_zones = readZones(body.deliveryZones);
  if (has(body, 'quickReplies')) next.quick_replies = readQuickReplies(body.quickReplies);
  if (has(body, 'awayMessage')) next.away_message = readAwayMessage(body.awayMessage);
  Object.assign(next, readProfile(body, next));

  const [row] = await sql`
    UPDATE vendors SET
      business_name = ${next.business_name},
      slug = ${next.slug},
      whatsapp_phone = ${next.whatsapp_phone},
      bank_name = ${next.bank_name},
      bank_account_number = ${next.bank_account_number},
      bank_account_name = ${next.bank_account_name},
      default_delivery_fee_kobo = ${next.default_delivery_fee_kobo},
      delivery_note = ${next.delivery_note},
      store_theme = ${next.store_theme},
      delivery_zones = ${JSON.stringify(next.delivery_zones)}::jsonb,
      quick_replies = ${JSON.stringify(next.quick_replies)}::jsonb,
      away_message = ${next.away_message},
      bio = ${next.bio}, store_category = ${next.store_category}, state = ${next.state}, city = ${next.city},
      in_directory = ${next.in_directory},
      updated_at = now()
    WHERE id = ${vendor.id}
    RETURNING *
  `;
  return row;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'PATCH' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, PATCH, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!sql) return res.status(500).json({ error: 'The database is not connected (DATABASE_URL is missing).' });
    const vendor = await getSessionVendor(req);
    if (!vendor) return res.status(401).json({ error: 'Not logged in.' });

    if (req.method === 'GET') {
      const [setup, push] = await Promise.all([setupStatus(vendor), pushInfo(vendor.id).catch(() => null)]);
      return res.status(200).json({ vendor: vendorForClient(vendor), setup, push });
    }

    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'Send the request as JSON.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (req.method === 'POST') {
      if (body.action === 'push-on') {
        await saveSubscription(vendor.id, sessionJti(req), body.subscription, req.headers['user-agent']);
        return res.status(200).json({ push: await pushInfo(vendor.id) });
      }
      if (body.action === 'push-off') {
        await removeSubscription(vendor.id, body.endpoint);
        return res.status(200).json({ push: await pushInfo(vendor.id) });
      }
      if (body.action === 'push-test') return res.status(200).json(await sendTest(vendor.id, body.endpoint));
      if (body.action === 'picture-set' || body.action === 'picture-remove') {
        const updated = body.action === 'picture-set'
          ? await setPicture(vendor, body.image)
          : await removePicture(vendor.id);
        return res.status(200).json({ vendor: vendorForClient(updated || vendor), setup: await setupStatus(updated || vendor) });
      }
      return res.status(400).json({ error: 'Unknown action.' });
    }
    const updated = await updateSettings(vendor, body);
    return res.status(200).json({ vendor: vendorForClient(updated), setup: await setupStatus(updated) });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err && err.code === '23505') return res.status(409).json({ error: 'That store link was just taken. Try another.', field: 'slug' });
    console.error('Me error:', err);
    const hint = /JWT_SECRET/.test(String(err && err.message)) ? ' (JWT_SECRET is missing on the server)' : '';
    return res.status(500).json({ error: `Something went wrong.${hint}` });
  }
};
