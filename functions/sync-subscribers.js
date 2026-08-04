/**
 * Netlify Function — Razorpay ↔ Kit reconciliation (manual / scheduled)
 *
 * GET /api/sync-subscribers   (header: X-Sync-Secret: <SYNC_SECRET>)
 *
 * Safety net for the webhook. When Netlify is down/paused, Razorpay's
 * `subscription.charged` webhooks fail and subscribers never get tagged
 * in Kit (see razorpay-webhook.js). This endpoint reconciles the two systems:
 * it walks Razorpay subscriptions, maps each plan to its Kit tag (the SAME
 * mapping razorpay-webhook.js uses), and tags anyone who's missing it.
 *
 * Idempotent: subscribers already carrying the right tag are left untouched.
 *
 * Returns { checked, alreadyTagged, newlyTagged, failed: [...] }.
 *
 * Auth: a static shared secret in the X-Sync-Secret header, compared in
 * constant time against SYNC_SECRET. Razorpay = Basic auth; Kit = X-Kit-Api-Key.
 * Native fetch only, no npm packages.
 */

const crypto = require('crypto');

const KIT_API      = 'https://api.kit.com/v4';
const RAZORPAY_API = 'https://api.razorpay.com/v1/subscriptions';

// plan_id → numeric Kit tag id.
// MUST stay in sync with PLAN_TO_TAG in razorpay-webhook.js — that function is
// the live path; this one is the reconciliation backstop for the same mapping.
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

// Which Razorpay subscription states represent a member we should tag. A
// subscription is tagged on first charge in the live path; here we reconcile
// only 'active' subscriptions — i.e. confirmed, paying members. 'created'
// subscriptions (checkout started but never authenticated/charged) are
// intentionally excluded so abandoned checkouts don't get tagged.
const SYNCABLE_STATUSES = new Set(['active']);

const RAZORPAY_PAGE = 100; // count per page (task spec); we page with skip below

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Constant-time secret comparison that won't throw on length mismatch.
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function kitFetch(path, apiKey, init) {
  const resp = await fetch(`${KIT_API}${path}`, {
    method: (init && init.method) || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': apiKey },
    body: init && init.body,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

// Walk every Razorpay subscription via skip-based pagination.
async function fetchAllSubscriptions(authHeader) {
  const items = [];
  // Defensive guard: at 100/page this covers 5000 subscriptions.
  for (let skip = 0, guard = 0; guard < 50; skip += RAZORPAY_PAGE, guard++) {
    const url = `${RAZORPAY_API}?count=${RAZORPAY_PAGE}&skip=${skip}`;
    const resp = await fetch(url, { headers: { Authorization: authHeader } });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = {}; }
    if (!resp.ok) {
      throw new Error(`Razorpay list failed ${resp.status}: ${text.slice(0, 200)}`);
    }
    const page = data.items || [];
    items.push(...page);
    if (page.length < RAZORPAY_PAGE) break; // last page
  }
  return items;
}

// Authoritative check: does this subscriber already carry the tag?
// Uses the subscriber→tags endpoint (not the tag→subscribers listing, which is
// eventually-consistent and can lag fresh tag writes).
// Returns { subscriberId: string|null, hasTag: boolean }.
async function lookupTagState(email, tagId, apiKey) {
  const lookup = await kitFetch(
    `/subscribers?email_address=${encodeURIComponent(email)}`,
    apiKey,
  );
  if (!lookup.ok) throw new Error(`Kit subscriber lookup failed ${lookup.status}`);
  const sub = (lookup.data.subscribers || [])[0];
  if (!sub) return { subscriberId: null, hasTag: false };

  const tagsResp = await kitFetch(`/subscribers/${sub.id}/tags?per_page=500`, apiKey);
  if (!tagsResp.ok) throw new Error(`Kit subscriber tags lookup failed ${tagsResp.status}`);
  const hasTag = (tagsResp.data.tags || []).some((t) => Number(t.id) === Number(tagId));
  return { subscriberId: sub.id, hasTag };
}

// Create the subscriber (idempotent upsert) then apply the tag — the same
// create-then-tag flow used elsewhere in this codebase.
async function createAndTag(email, tagId, subscriberExists, apiKey) {
  if (!subscriberExists) {
    const create = await kitFetch('/subscribers', apiKey, {
      method: 'POST',
      body: JSON.stringify({ email_address: email }),
    });
    // 200/201 = created or already-exists; anything else is a real failure.
    if (!create.ok) throw new Error(`Kit create failed ${create.status}`);
  }
  const tag = await kitFetch(`/tags/${tagId}/subscribers`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ email_address: email }),
  });
  if (!tag.ok) throw new Error(`Kit tag apply failed ${tag.status}`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const syncSecret = process.env.SYNC_SECRET;
  if (!syncSecret) {
    console.error('[sync-subscribers] SYNC_SECRET env var not set');
    return json(500, { error: 'Server configuration error' });
  }
  const provided = event.headers['x-sync-secret'] || event.headers['X-Sync-Secret'];
  if (!secretMatches(provided, syncSecret)) {
    return json(401, { error: 'Unauthorized' });
  }

  const kitKey    = process.env.KIT_API_SECRET;
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!kitKey || !keyId || !keySecret) {
    console.error('[sync-subscribers] missing KIT_API_SECRET / RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET');
    return json(500, { error: 'Server configuration error' });
  }
  const razorpayAuth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  let subscriptions;
  try {
    subscriptions = await fetchAllSubscriptions(razorpayAuth);
  } catch (err) {
    console.error('[sync-subscribers] Razorpay fetch error', err);
    return json(502, { error: 'Could not fetch Razorpay subscriptions' });
  }

  let checked = 0;
  let alreadyTagged = 0;
  let newlyTagged = 0;
  const failed = [];

  for (const sub of subscriptions) {
    if (!SYNCABLE_STATUSES.has(sub.status)) continue;

    const planId = sub.plan_id;
    const email  = (sub.notes && sub.notes.email) || '';
    const tagId  = PLAN_TO_TAG[planId];

    // Count anything we attempt to reconcile.
    checked++;

    if (!tagId) {
      failed.push({ subscription_id: sub.id, plan_id: planId, email, reason: 'no tag mapping for plan' });
      continue;
    }
    if (!email) {
      failed.push({ subscription_id: sub.id, plan_id: planId, email, reason: 'no email in subscription notes' });
      continue;
    }

    try {
      const { subscriberId, hasTag } = await lookupTagState(email, tagId, kitKey);
      if (hasTag) {
        alreadyTagged++;
        continue;
      }
      await createAndTag(email, tagId, Boolean(subscriberId), kitKey);
      newlyTagged++;
      console.log('[sync-subscribers] tagged', { email, planId, tagId, subscription_id: sub.id });
    } catch (err) {
      console.error('[sync-subscribers] reconcile failed', { email, planId, tagId }, err);
      failed.push({ subscription_id: sub.id, plan_id: planId, email, reason: String(err.message || err) });
    }
  }

  const summary = { checked, alreadyTagged, newlyTagged, failed };
  console.log('[sync-subscribers] done', summary);
  return json(200, summary);
};
