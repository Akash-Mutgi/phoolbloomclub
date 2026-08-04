/**
 * Netlify Function — Razorpay webhook receiver
 *
 * POST /api/razorpay-webhook
 *
 * Razorpay signs every webhook with HMAC-SHA256 over the RAW request body
 * keyed with the dashboard webhook secret. We verify that signature against
 * the X-Razorpay-Signature header BEFORE trusting anything in the payload.
 *
 * On `subscription.charged` (fires on every successful charge, including the
 * first) we map the plan to a Kit tag and tag the buyer. Kit is the source of
 * truth for fulfilment.
 *
 * NO WELCOME EMAIL IS SENT FROM HERE. That integration and its HTML template
 * were removed deliberately: the first pass ships with Kit tagging only, fewer
 * new services, and the template still promised wallpapers "within 48 hours"
 * and a "set of four" the site no longer offers. Re-add it only with copy that
 * matches what is actually delivered.
 *
 * Built-in crypto only for the HMAC; native fetch for Kit. No npm.
 */

const crypto = require('crypto');

const KIT_API = 'https://api.kit.com/v4';

// plan_id → numeric Kit tag id
const PLAN_TO_TAG = {
  // Founding tier
  plan_T2iusRGlO8xJRb: 20425543, // paid-founding-desi
  plan_T2jLdUmiuVo2S4: 20425544, // paid-founding-global
  // Desi regular tier → paid-desi
  plan_T2iy8igtr4NNlA: 20425545,
  plan_T2j4RwqvdB20t1: 20425545,
  plan_T2j5QpPcvmcciF: 20425545,
  plan_T2j7T90UVz5uvm: 20425545,
  // Global regular tier → paid-global
  plan_T2j9gFKzuMeZV0: 20425546,
  plan_T2jAi0qikOAied: 20425546,
  plan_T2jDRG4X3DCqk6: 20425546,
  plan_T2jFAcpX9baJIb: 20425546,
};


// Razorpay only needs a 200 to stop retrying. Keep responses plain text.
const ok   = (body) => ({ statusCode: 200, body: body || 'ok' });
const bad  = (body) => ({ statusCode: 400, body: body || 'bad request' });


async function tagSubscriber(tagId, email) {
  const apiKey = process.env.KIT_API_SECRET;
  if (!apiKey) { console.error('[razorpay-webhook] KIT_API_SECRET not set'); return false; }
  const resp = await fetch(`${KIT_API}/tags/${tagId}/subscribers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': apiKey },
    body: JSON.stringify({ email_address: email }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error('[razorpay-webhook] Kit tag apply failed', resp.status, t);
    return false;
  }
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET not set');
    return { statusCode: 500, body: 'config error' };
  }

  // Verify against the RAW body exactly as received — never the re-serialized JSON.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const signature = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'] || '';
  const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

  const expBuf = Buffer.from(expected, 'utf8');
  const sigBuf = Buffer.from(signature, 'utf8');
  const valid  = expBuf.length === sigBuf.length && crypto.timingSafeEqual(expBuf, sigBuf);
  if (!valid) {
    console.warn('[razorpay-webhook] signature mismatch');
    return bad('invalid signature');
  }

  let body;
  try { body = JSON.parse(raw); }
  catch (_) { return bad('invalid json'); }

  // We only fulfil on a successful charge. Acknowledge everything else with 200
  // so Razorpay doesn't retry events we intentionally ignore.
  if (body.event !== 'subscription.charged') {
    return ok('ignored');
  }

  const sub       = body.payload?.subscription?.entity || {};
  const payment   = body.payload?.payment?.entity || {};
  const planId    = sub.plan_id;
  const email     = (sub.notes && sub.notes.email) || payment.email || '';
  // Captured for logging/fulfilment context; no longer feeds a welcome email.
  const firstName = (sub.notes && sub.notes.first_name) || '';

  const tagId = PLAN_TO_TAG[planId];
  if (!tagId) {
    console.warn('[razorpay-webhook] no tag mapping for plan', planId);
    return ok('no mapping'); // acknowledged; nothing to do
  }
  if (!email) {
    console.warn('[razorpay-webhook] no email on charged subscription', sub.id);
    return ok('no email');
  }

  try {
    const tagged = await tagSubscriber(tagId, email);
    console.log('[razorpay-webhook] subscription.charged', { plan: planId, tagId, email, firstName, tagged });
  } catch (err) {
    console.error('[razorpay-webhook] tagging error', err);
    // Still 200 — Razorpay retries on non-2xx, and a Kit hiccup shouldn't
    // trigger duplicate-charge retries. The error is logged for manual fixup.
  }

  return ok();
};
