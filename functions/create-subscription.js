/**
 * Netlify Function — Razorpay subscription creation
 *
 * POST /api/create-subscription
 *   body: { plan_id, first_name, email, phone?, notes: { address } }
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
  const email     = (payload.email      || '').trim();
  const phone     = (payload.phone      || '').trim();
  const address   = ((payload.notes && payload.notes.address) || '').trim();

  if (!PLAN_TOTAL_COUNT.has(planId)) {
    return json(400, { error: 'Unknown or missing plan_id' });
  }
  if (!firstName || !email) {
    return json(400, { error: 'first_name and email are required' });
  }
  if (!address) {
    return json(400, { error: 'Delivery address is required' });
  }
  // Combined address format from checkout:
  //   "line1, [line2,] city, state, pincode, country" (line2 optional)
  // → require at least 5 non-empty comma-separated parts so a structured,
  //   deliverable address always reaches fulfilment.
  const addressParts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (addressParts.length < 5) {
    return json(400, { error: 'Delivery address looks incomplete' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Invalid email address' });
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
    notes: { first_name: firstName, email, address: address.slice(0, 255) },
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
