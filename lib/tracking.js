// Order tracking: where an order is up to, for the seller and the customer.
//
// Steps: new -> processing ("Getting it ready") -> sent ("On the way") -> delivered.
// When the seller marks an order sent out they can add how it's travelling:
//   rider:   the rider's name and phone number
//   waybill: the bus company, park or courier, the waybill number and a photo of the slip
// plus the day it should arrive and a short note. The customer sees all of it
// on their invoice page (/i/<id>), and taps "I've got it" when it arrives,
// which marks the order delivered and tells the seller.
//
// The columns and the waybill_photos table come from
// db/migrations/010_order_tracking.sql. Until that has been run, everything
// else keeps working and only "Sent out" asks for the update.
const { sql } = require('./db');
const { HttpError } = require('./auth');
const { cleanText, normalizeNgPhone } = require('./format');
const { readImage, isPhotoId, photoUrl } = require('./photos');

const KINDS = ['rider', 'waybill'];
const STEPS = ['processing', 'sent', 'delivered']; // the steps the customer's tracker shows
const MISSING_TABLE = '42P01';
const MISSING_COLUMN = '42703';
const PHOTO_KEEP_DAYS = 30;

const UPDATE_TEXT = 'Order tracking needs a quick database update first. Run db/migrations/010_order_tracking.sql in the Neon SQL Editor.';

// True when the error is only "migration 010 hasn't been run yet".
function isMissingUpdate(err) {
  if (!err) return false;
  if (err.code === MISSING_TABLE || err.code === MISSING_COLUMN) return true;
  // the old status check turning down 'sent'
  return err.code === '23514' && /orders_status_check/.test(String(err.constraint || '') + ' ' + String(err.message || ''));
}

function needsUpdate(err) {
  return isMissingUpdate(err) ? new HttpError(503, UPDATE_TEXT, { needsUpdate: true }) : err;
}

// 2348031234567 -> "0803 123 4567"
function localPhone(p) {
  return /^234\d{10}$/.test(p || '') ? `0${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : String(p || '');
}

// "2026-11-14" -> true when it's a real day within a sensible range.
function readDay(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, 'Pick the day it should arrive.', { field: 'expectedOn' });
  const day = new Date(text + 'T12:00:00Z');
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) {
    throw new HttpError(400, 'Pick the day it should arrive.', { field: 'expectedOn' });
  }
  const days = (day.getTime() - Date.now()) / 86400000;
  if (days < -30 || days > 90) throw new HttpError(400, 'Pick a day within the next 3 months.', { field: 'expectedOn' });
  return text;
}

// What the seller typed in the "Sent out" sheet, checked and cleaned.
function readTracking(body) {
  const kind = KINDS.includes(body.kind) ? body.kind : null;
  let name = cleanText(body.courierName);
  if (name.length > 60) throw new HttpError(400, kind === 'waybill' ? 'Keep the company or park name under 60 characters.' : "Keep the rider's name under 60 characters.", { field: 'courierName' });
  let phone = null;
  const typedPhone = cleanText(body.courierPhone);
  if (typedPhone) {
    phone = normalizeNgPhone(typedPhone);
    if (!phone) throw new HttpError(400, "Enter the rider's phone number, like 0803 123 4567.", { field: 'courierPhone' });
  }
  let code = cleanText(body.trackingCode);
  if (code.length > 40) throw new HttpError(400, 'Keep the waybill number under 40 characters.', { field: 'trackingCode' });
  const message = cleanText(body.message);
  if (message.length > 200) throw new HttpError(400, 'Keep the note under 200 characters.', { field: 'message' });
  const expectedOn = readDay(body.expectedOn);

  // Only keep what belongs to the way it's going.
  if (kind === 'rider') code = '';
  if (kind === 'waybill') phone = null;
  if (!kind) { name = ''; phone = null; code = ''; }
  const photo = kind === 'waybill' && body.photo ? readImage(body.photo) : null;
  return {
    kind,
    name: name || null,
    phone,
    code: code || null,
    message: message || null,
    expectedOn,
    photo,
    removePhoto: kind !== 'waybill' || body.removePhoto === true
  };
}

// One line for the order's history.
function sentLine(t, wasSent) {
  let how = '';
  if (t.kind === 'rider') {
    how = 'with ' + (t.name ? 'rider ' + t.name : 'a rider') + (t.phone ? ' (' + localPhone(t.phone) + ')' : '');
  } else if (t.kind === 'waybill') {
    how = 'by ' + (t.name || 'waybill') + (t.code ? ' · waybill no. ' + t.code : '');
  }
  if (wasSent) return 'Delivery details updated' + (how ? ': sent ' + how : '');
  return how ? 'Sent out ' + how : 'Marked as sent out';
}

// Records when an order reached a step (the main status change already
// happened). Quietly does nothing before migration 010.
async function stampStatus(orderId, vendorId, status) {
  if (!STEPS.includes(status)) return;
  try {
    await sql`
      UPDATE orders SET
        processing_at = CASE WHEN ${status} = 'processing' THEN now() ELSE processing_at END,
        sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END,
        delivered_at = CASE WHEN ${status} = 'delivered' THEN now() ELSE delivered_at END
      WHERE id = ${orderId} AND vendor_id = ${vendorId} AND status = ${status}
    `;
  } catch (err) {
    if (!isMissingUpdate(err)) throw err;
  }
}

// ---------- waybill photos ----------

// The photo's public id for an order, or null. Null before migration 010.
async function waybillFor(orderId) {
  try {
    const rows = await sql`SELECT public_id FROM waybill_photos WHERE order_id = ${orderId} LIMIT 1`;
    return rows.length ? rows[0].public_id : null;
  } catch (err) {
    if (isMissingUpdate(err)) return null;
    throw err;
  }
}

// Saves (or replaces) the slip photo. A new photo gets a new address. Old
// photos of this seller's finished orders go, so the database stays small.
async function saveWaybill(vendorId, orderId, image) {
  const { mime, size, b64 } = image;
  try {
    await sql`
      WITH old AS (
        DELETE FROM waybill_photos w USING orders o
        WHERE w.order_id = o.id AND w.vendor_id = ${vendorId} AND o.id <> ${orderId}
          AND o.status IN ('delivered', 'cancelled')
          AND o.updated_at < now() - make_interval(days => ${PHOTO_KEEP_DAYS})
        RETURNING 1
      )
      INSERT INTO waybill_photos (order_id, vendor_id, mime, size_bytes, data)
      VALUES (${orderId}, ${vendorId}, ${mime}, ${size}, decode(${b64}, 'base64'))
      ON CONFLICT (order_id) DO UPDATE SET
        public_id = encode(gen_random_bytes(8), 'hex'),
        mime = EXCLUDED.mime,
        size_bytes = EXCLUDED.size_bytes,
        data = EXCLUDED.data,
        created_at = now()
    `;
  } catch (err) {
    throw needsUpdate(err);
  }
}

async function removeWaybill(vendorId, orderId) {
  try {
    await sql`DELETE FROM waybill_photos WHERE order_id = ${orderId} AND vendor_id = ${vendorId}`;
  } catch (err) {
    if (!isMissingUpdate(err)) throw err;
  }
}

// The photo itself, for /p/<publicId>. Nothing for suspended stores.
async function loadWaybill(publicId) {
  if (!isPhotoId(publicId)) return null;
  try {
    const rows = await sql`
      SELECT w.mime, encode(w.data, 'base64') AS b64
      FROM waybill_photos w JOIN vendors v ON v.id = w.vendor_id
      WHERE w.public_id = ${publicId} AND v.is_suspended = FALSE
      LIMIT 1
    `;
    if (!rows.length) return null;
    return { mime: rows[0].mime, bytes: Buffer.from(rows[0].b64, 'base64'), private: true };
  } catch (err) {
    if (isMissingUpdate(err)) return null;
    throw err;
  }
}

// ---------- shapes ----------

function courierOf(o) {
  if (!KINDS.includes(o.courier_kind)) return null;
  return {
    kind: o.courier_kind,
    name: o.courier_name || '',
    phone: o.courier_phone || null,
    code: o.courier_kind === 'waybill' ? o.tracking_code || '' : ''
  };
}

// Dates come back from the database as text ("2026-11-14"); keep them that way.
const dayText = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

// For the seller's order screen.
function trackingForSeller(o, waybillId) {
  return {
    processingAt: o.processing_at || null,
    sentAt: o.sent_at || null,
    deliveredAt: o.delivered_at || null,
    customerReceivedAt: o.customer_received_at || null,
    courier: courierOf(o),
    expectedOn: dayText(o.expected_on),
    message: o.delivery_message || '',
    photo: waybillId ? photoUrl(waybillId) : null,
    available: Object.prototype.hasOwnProperty.call(o, 'sent_at') // false until migration 010
  };
}

// For the customer's invoice page: only once the seller has started on it.
function trackingForCustomer(o, waybillId) {
  if (!STEPS.includes(o.status)) return null;
  const sent = o.status === 'sent' || o.status === 'delivered';
  return {
    step: o.status,
    placedAt: o.created_at,
    processingAt: o.processing_at || null,
    sentAt: sent ? o.sent_at || null : null,
    deliveredAt: o.status === 'delivered' ? o.delivered_at || null : null,
    youConfirmed: o.status === 'delivered' && !!o.customer_received_at,
    courier: sent ? courierOf(o) : null,
    expectedOn: sent && o.status !== 'delivered' ? dayText(o.expected_on) : null,
    message: sent ? o.delivery_message || '' : '',
    photo: sent && waybillId ? photoUrl(waybillId) : null
  };
}

module.exports = {
  KINDS, STEPS, UPDATE_TEXT, isMissingUpdate, needsUpdate, readTracking, sentLine, stampStatus,
  waybillFor, saveWaybill, removeWaybill, loadWaybill, trackingForSeller, trackingForCustomer, localPhone
};
