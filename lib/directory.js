// The store directory at /stores: sellers who choose to be listed, by
// category and state. Stores need at least one product on show to appear.
const { HttpError } = require('./auth');
const { cleanText } = require('./format');

const CATEGORIES = [
  'Fashion & clothing', 'Hair & wigs', 'Beauty & skincare', 'Shoes & bags', 'Jewellery & accessories',
  'Food & drinks', 'Cakes & pastries', 'Phones & gadgets', 'Home & kitchen', 'Kids & baby',
  'Health & wellness', 'Books & stationery', 'Services', 'Other'
];

const STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta',
  'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi',
  'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers',
  'Sokoto', 'Taraba', 'Yobe', 'Zamfara'
];

const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

// Changes the profile fields that were sent; returns the full profile.
function readProfile(body, current) {
  const next = { ...current };
  if (has(body, 'bio')) {
    const bio = cleanText(body.bio);
    if (bio.length > 160) throw new HttpError(400, 'Keep the line about your store under 160 characters.', { field: 'bio' });
    next.bio = bio || null;
  }
  if (has(body, 'storeCategory')) {
    const cat = String(body.storeCategory || '');
    if (cat && !CATEGORIES.includes(cat)) throw new HttpError(400, 'Pick one of the categories.', { field: 'storeCategory' });
    next.store_category = cat || null;
  }
  if (has(body, 'state')) {
    const state = String(body.state || '');
    if (state && !STATES.includes(state)) throw new HttpError(400, 'Pick your state.', { field: 'state' });
    next.state = state || null;
  }
  if (has(body, 'city')) {
    const city = cleanText(body.city);
    if (city.length > 40) throw new HttpError(400, 'Keep the town or city under 40 characters.', { field: 'city' });
    next.city = city || null;
  }
  if (has(body, 'inDirectory')) next.in_directory = body.inDirectory === true;
  if (next.in_directory && (!next.store_category || !next.state)) {
    throw new HttpError(400, 'Pick a category and your state so customers can find you.', { field: next.store_category ? 'state' : 'storeCategory' });
  }
  return next;
}

module.exports = { CATEGORIES, STATES, readProfile };
