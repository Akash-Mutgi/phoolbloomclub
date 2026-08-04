/**
 * Netlify Function — Razorpay subscription creation
 *
 * POST /api/create-subscription
 *   body: { plan_id, first_name, last_name, email, phone,
 *           address: { line1, line2?, city, state, pincode, country } }
 *
 * The client sends the address STRUCTURED, not pre-joined, so every part can
 * be re-validated here. The client checks are UX; these are what protect the
 * data. The canonical address string for Razorpay notes is assembled below,
 * from the validated parts only.
 *
 * Creates a Razorpay subscription server-side (secret never touches the
 * client) and returns its id for the Razorpay checkout modal. The actual
 * tagging/fulfilment happens later in razorpay-webhook.js on the first charge.
 *
 * Auth: Basic <base64(key_id:key_secret)>. Native fetch only, no npm packages.
 */

const RAZORPAY_API = 'https://api.razorpay.com/v1/subscriptions';

// Whitelist of valid plan ids → total_count (number of billing cycles the
// subscription runs). Doubles as the allow-list: an unknown plan_id is rejected.
//
// total_count must be chosen per billing period so the UPI AutoPay mandate end
// date (start + total_count × period) stays under Razorpay's 30-year cap —
// otherwise UPI fails with "expire_at cannot be more than 30 years for upi".
//   monthly      120 cycles = 10 years
//   quarterly    100 cycles = 25 years
//   half-yearly   50 cycles = 25 years
//   yearly        25 cycles = 25 years
const PLAN_TOTAL_COUNT = new Map([
  // Desi regular tier
  ['plan_T2iy8igtr4NNlA', 120], // Monthly      ₹555
  ['plan_T2j4RwqvdB20t1', 100], // Quarterly    ₹1499
  ['plan_T2j5QpPcvmcciF',  50], // Half-yearly  ₹2799
  ['plan_T2j7T90UVz5uvm',  25], // Yearly       ₹4999
  // Global regular tier
  ['plan_T2j9gFKzuMeZV0', 120], // Monthly      ₹1100
  ['plan_T2jAi0qikOAied', 100], // Quarterly    ₹3299
  ['plan_T2jDRG4X3DCqk6',  50], // Half-yearly  ₹5299
  ['plan_T2jFAcpX9baJIb',  25], // Yearly       ₹10999
]);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { error: 'Invalid JSON' }); }

  const planId    = (payload.plan_id    || '').trim();
  const firstName = (payload.first_name || '').trim();
  const lastName  = (payload.last_name  || '').trim();
  const email     = (payload.email      || '').trim();
  const phone     = (payload.phone      || '').trim();

  const addr    = payload.address || {};
  const line1   = (addr.line1   || '').trim();
  const line2   = (addr.line2   || '').trim();
  const city    = (addr.city    || '').trim();
  const state   = (addr.state   || '').trim();
  const pincode = (addr.pincode || '').trim();
  const country = (addr.country || '').trim();

  if (!PLAN_TOTAL_COUNT.has(planId)) {
    return json(400, { error: 'Unknown or missing plan_id' });
  }
  if (!firstName || !lastName) {
    return json(400, { error: 'first_name and last_name are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Invalid email address' });
  }

  // Phone is REQUIRED: it is the delivery contact couriers call.
  // Canonical shape is "<+code> <digits>", e.g. "+49 17636071945".
  if (!/^\+\d{1,4} \d{6,14}$/.test(phone)) {
    return json(400, { error: 'A phone number with country code is required, e.g. +91 9876543210' });
  }

  if (!line1 || !city || !state || !pincode || !country) {
    return json(400, { error: 'Delivery address is incomplete' });
  }

  // Postcode: India has one exact format, so check it properly. Everywhere
  // else gets a loose sanity check rather than a guessed national regex —
  // a wrong strict rule would reject real customers.
  const pcOk = country === 'India'
    ? /^[1-9]\d{5}$/.test(pincode)
    : (pincode.length >= 3 && pincode.length <= 12 &&
       /^[A-Za-z0-9][A-Za-z0-9 -]*[A-Za-z0-9]$/.test(pincode) &&
       !/^(.)\1+$/.test(pincode.replace(/[ -]/g, '')));
  if (!pcOk) {
    return json(400, { error: country === 'India'
      ? 'Please enter a valid 6-digit Indian pincode'
      : 'Please enter a valid postal code' });
  }

  // Canonical address string, assembled here from validated parts.
  const address = [line1, line2, city, state, pincode, country].filter(Boolean).join(', ');

  // Razorpay caps each notes VALUE at 255 chars. Truncating a delivery
  // address would silently drop the pincode and country (they are last),
  // so reject instead and let the customer shorten it.
  if (address.length > 255) {
    return json(400, { error: 'Delivery address is too long — please shorten it to under 255 characters' });
  }

  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.error('[create-subscription] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env var not set');
    return json(500, { error: 'Server configuration error' });
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  // notify_info carries the contact Razorpay uses for its own charge emails.
  const notifyInfo = { notify_email: email };
  if (phone) notifyInfo.notify_phone = phone;

  const body = {
    plan_id:        planId,
    total_count:    PLAN_TOTAL_COUNT.get(planId),
    quantity:       1,
    customer_notify: 1,
    notify_info:    notifyInfo,
    // Razorpay caps each notes value at 255 chars — keep address within bounds.
    // Each value stays under Razorpay's 255-char notes limit. Name and phone
    // are separate keys, so they do not eat into the address budget.
    notes: {
      first_name: firstName,
      last_name:  lastName,
      email:      email,
      phone:      phone,
      address:    address,
    },
  };

  try {
    const resp = await fetch(RAZORPAY_API, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

    if (!resp.ok) {
      console.error('[create-subscription] Razorpay error', resp.status, data);
      return json(502, { error: 'Could not create subscription', details: data?.error || data });
    }

    return json(200, { subscription_id: data.id });
  } catch (err) {
    console.error('[create-subscription] network error', err);
    return json(502, { error: 'Could not reach payment provider' });
  }
};
