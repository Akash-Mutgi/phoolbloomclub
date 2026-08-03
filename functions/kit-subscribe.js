/**
 * Netlify Function — Kit (formerly ConvertKit) waitlist subscription proxy
 *
 * Strategy:
 *   1. Create/update subscriber via POST /v4/subscribers
 *   2. Add to waitlist form via POST /v4/forms/{id}/subscribers (triggers PDF)
 *   3. Find-or-create a "city-{slug}" tag, then attach to subscriber
 *
 * Why tags for city (not a custom field):
 *   Custom Fields require a per-account setup step that proved finicky
 *   in Kit's UI. Tags work on every Kit plan with zero pre-config and
 *   are equally good for segmentation (Avnie can filter "city-pune" etc.).
 *
 * Auth header: X-Kit-Api-Key
 */

const KIT_FORM_ID = '9517204';
const KIT_API     = 'https://api.kit.com/v4';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

// Turn "Mumbai" / "New Delhi" / "Bengaluru / Bangalore" into "city-mumbai" / "city-new-delhi" / "city-bengaluru-bangalore"
function cityToTagName(city) {
  const slug = city
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')                       // non-alphanum -> hyphen
    .replace(/^-+|-+$/g, '')                           // trim hyphens
    .slice(0, 40);                                     // sanity cap
  return `city-${slug || 'unknown'}`;
}

async function kitFetch(path, init, apiKey) {
  const resp = await fetch(`${KIT_API}${path}`, {
    ...init,
    headers: {
      'Content-Type':   'application/json',
      'X-Kit-Api-Key':  apiKey,
      ...(init?.headers || {}),
    },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

// Find a tag by exact name. Returns tag object or null.
// Kit v4 paginates tags; the cap is 500 per page and most accounts
// will have far fewer than that for a long time.
async function findTagByName(name, apiKey) {
  const { ok, data } = await kitFetch('/tags?per_page=500', { method: 'GET' }, apiKey);
  if (!ok) return null;
  const tags = data.tags || [];
  return tags.find(t => t.name === name) || null;
}

async function createTag(name, apiKey) {
  const { ok, data } = await kitFetch('/tags', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }, apiKey);
  if (!ok) return null;
  return data.tag || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { error: 'Invalid JSON' }); }

  const firstName = (payload.first_name    || '').trim();
  const email     = (payload.email_address || '').trim();
  const city      = (payload.city          || '').trim();

  if (!firstName || !email || !city) {
    return json(400, { error: 'first_name, email_address and city are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Invalid email address' });
  }

  const apiKey = process.env.KIT_API_SECRET;
  if (!apiKey) {
    console.error('[kit-subscribe] KIT_API_SECRET env var not set');
    return json(500, { error: 'Server configuration error' });
  }

  try {
    // ── Step 1: Create/update subscriber (no custom fields — city goes in a tag below) ──
    const sub = await kitFetch('/subscribers', {
      method: 'POST',
      body: JSON.stringify({
        email_address: email,
        first_name:    firstName,
        state:         'active',
      }),
    }, apiKey);

    if (!sub.ok) {
      console.error('[kit-subscribe] step 1 failed', sub.status, sub.data);
      return json(502, { error: 'Could not create subscriber', stage: 'create_subscriber', details: sub.data });
    }

    const subscriber = sub.data.subscriber;
    if (!subscriber || !subscriber.id) {
      console.error('[kit-subscribe] subscriber missing id', sub.data);
      return json(502, { error: 'Subscriber created but no id returned', stage: 'create_subscriber', details: sub.data });
    }

    // ── Step 2: Add to founding waitlist form (triggers incentive email + PDF) ──
    const formAdd = await kitFetch(`/forms/${KIT_FORM_ID}/subscribers`, {
      method: 'POST',
      body: JSON.stringify({ email_address: email }),
    }, apiKey);

    if (!formAdd.ok) {
      console.error('[kit-subscribe] step 2 failed', formAdd.status, formAdd.data);
      return json(502, { error: 'Subscriber created but could not add to waitlist', stage: 'add_to_form', details: formAdd.data });
    }

    // ── Step 3: Find or create the city tag, then attach to subscriber ──
    const tagName = cityToTagName(city);
    let tag = await findTagByName(tagName, apiKey);
    if (!tag) {
      tag = await createTag(tagName, apiKey);
    }
    if (tag && tag.id) {
      const tagApply = await kitFetch(`/tags/${tag.id}/subscribers/${subscriber.id}`, {
        method: 'POST',
        body: JSON.stringify({}),
      }, apiKey);
      if (!tagApply.ok) {
        // Non-fatal: subscriber is already in Kit + on the waitlist; only the
        // city tag failed. Log and continue.
        console.warn('[kit-subscribe] tag apply failed (non-fatal)', tagApply.status, tagApply.data);
      }
    } else {
      console.warn('[kit-subscribe] could not find or create city tag:', tagName);
    }

    return json(200, {
      ok:         true,
      subscriber: { id: subscriber.id, email_address: subscriber.email_address, first_name: subscriber.first_name },
      city_tag:   tag ? tag.name : null,
    });

  } catch (err) {
    console.error('[kit-subscribe] network error', err);
    return json(502, { error: 'Could not reach subscription provider' });
  }
};
