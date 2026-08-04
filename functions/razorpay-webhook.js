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
 * first) we:
 *   1. map the plan to a Kit tag and tag the buyer (source of truth for
 *      fulfilment), and
 *   2. send a branded welcome email via Resend (best-effort).
 *
 * Built-in crypto only for the HMAC; native fetch for Kit + Resend. No npm.
 */

const crypto = require('crypto');

const KIT_API    = 'https://api.kit.com/v4';
const RESEND_API = 'https://api.resend.com/emails';

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

// Welcome email template (inlined at build time from
// ~/Desktop/phoolbloom-welcome-email.html — NOT read at runtime). The
// "{{ subscriber.first_name | default: \"there\" }}" token is replaced per send.
const WELCOME_EMAIL_HTML = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>Your wallpapers, in the making.</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <!-- Brand web fonts (honoured by Apple Mail / iOS Mail; other clients fall back to serif/sans-serif) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;1,400;1,500;1,600&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    /* Progressive enhancement only — all critical styling is inlined below. */
    body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table { border-collapse:collapse !important; }
    img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
    a { text-decoration:none; }
    @media only screen and (max-width:600px) {
      .email-container { width:100% !important; }
      .px { padding-left:24px !important; padding-right:24px !important; }
      .btn-a { width:100% !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#f5f4ed;">

  <!-- Preheader (hidden inbox preview text) -->
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:#f5f4ed; opacity:0;">
    Two preview wallpapers are inside — your full set arrives within 48 hours. ✿
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>

  <!-- Full-width background -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f4ed;">
    <tr>
      <td align="center" style="padding:24px 12px 40px 12px;">

        <!-- 600px centered container -->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-container" style="width:600px; max-width:600px;">

          <!-- ── Header / logo (cream) ── -->
          <tr>
            <td align="center" style="padding:14px 32px 30px 32px;">
              <a href="https://phoolbloomclub.com" target="_blank" style="text-decoration:none;">
                <img src="https://phoolbloomclub.com/logo-nav.png" width="44" height="44" alt="Phool Bloom Club" style="display:inline-block; vertical-align:middle; height:44px; width:auto; border:0;">
              </a>
            </td>
          </tr>

          <!-- ── Hero card (white) ── -->
          <tr>
            <td style="background-color:#ffffff; border:1px solid #ece5f6; border-radius:20px; box-shadow:0 8px 28px rgba(107,75,168,0.08);">

              <!-- Hero copy -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="px" align="center" style="padding:48px 44px 0 44px;">
                    <h1 style="margin:0; font-family:'Playfair Display', Georgia, 'Times New Roman', serif; font-style:italic; font-weight:500; font-size:34px; line-height:1.2; color:#241820;">
                      Your wallpapers,<br><span style="color:#6b4ba8;">in the making.</span>
                    </h1>
                  </td>
                </tr>
                <tr>
                  <td class="px" align="left" style="padding:30px 44px 0 44px; font-family:'DM Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.7; color:#241820;">
                    Hi {{ subscriber.first_name | default: "there" }},
                  </td>
                </tr>
                <tr>
                  <td class="px" align="left" style="padding:14px 44px 0 44px; font-family:'DM Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; line-height:1.7; color:#5a4f6e;">
                    Welcome to the Phool Bloom Club. Inside this folder are two preview wallpapers for your phone — early designs from the collection Avnie is finalising this week. The full set of four custom-illustrated wallpapers (one for each season's flower) will arrive in your inbox within 48 hours. Thank you for joining.
                  </td>
                </tr>

                <!-- ── Bulletproof download button ── -->
                <tr>
                  <td class="px" align="center" style="padding:36px 44px 8px 44px;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="https://phoolbloomclub.com/phool-wallpapers.zip" style="height:52px;v-text-anchor:middle;width:330px;" arcsize="50%" stroke="f" fillcolor="#f6a93a">
                      <w:anchorlock/>
                      <center style="color:#241820;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;">Download Your Wallpapers &#10047;</center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-- -->
                    <a class="btn-a" href="https://phoolbloomclub.com/phool-wallpapers.zip" target="_blank"
                       style="background-color:#f6a93a; border-radius:100px; color:#241820; display:inline-block; font-family:'DM Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size:16px; font-weight:700; line-height:52px; height:52px; text-align:center; text-decoration:none; width:330px; mso-hide:all; -webkit-text-size-adjust:none;">
                      Download Your Wallpapers &#10047;
                    </a>
                    <!--<![endif]-->
                  </td>
                </tr>

                <!-- Sign off -->
                <tr>
                  <td class="px" align="left" style="padding:32px 44px 48px 44px;">
                    <div style="font-family:'Playfair Display', Georgia, 'Times New Roman', serif; font-style:italic; font-weight:500; font-size:24px; line-height:1.2; color:#6b4ba8;">— Avnie</div>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- ── Footer (dark) ── -->
          <tr>
            <td align="center" style="padding:32px 24px 8px 24px;">
              <img src="https://phoolbloomclub.com/logo-footer.png" width="36" height="36" alt="" style="display:inline-block; height:36px; width:auto; border:0; opacity:0.85;">
              <div style="margin-top:10px; font-family:'Playfair Display', Georgia, 'Times New Roman', serif; font-style:italic; font-size:18px; color:#241820;">Phool Bloom Club</div>
              <div style="margin-top:14px; font-family:'DM Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size:12px; line-height:1.6; color:#9a9099;">
                You're receiving this because you subscribed at
                <a href="https://phoolbloomclub.com" target="_blank" style="color:#6b4ba8; text-decoration:none;">phoolbloomclub.com</a>
              </div>
              <div style="margin-top:8px; font-family:'DM Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size:12px; color:#b3aab8;">
                © 2026 Phool Bloom Club · Made with petals &amp; ink 🌸
              </div>
            </td>
          </tr>

        </table>
        <!-- /600px container -->

      </td>
    </tr>
  </table>

</body>
</html>
`;
const NAME_TOKEN = '{{ subscriber.first_name | default: "there" }}';

// Razorpay only needs a 200 to stop retrying. Keep responses plain text.
const ok   = (body) => ({ statusCode: 200, body: body || 'ok' });
const bad  = (body) => ({ statusCode: 400, body: body || 'bad request' });

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

// Best-effort welcome email via Resend. NEVER throws — a failure here must not
// affect the 200 we owe Razorpay.
async function sendWelcomeEmail(email, firstName) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[razorpay-webhook] RESEND_API_KEY not set — skipping welcome email');
    return false;
  }
  const name = escapeHtml((firstName || '').trim() || 'there');
  // split/join avoids regex + "$" replacement pitfalls; replaces all occurrences
  const html = WELCOME_EMAIL_HTML.split(NAME_TOKEN).join(name);
  try {
    const resp = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Avnie at Phool Bloom Club <avnie@phoolbloomclub.com>',
        to: email,
        subject: 'Your Phool Bloom Club subscription is confirmed 🌸',
        html,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error('[razorpay-webhook] Resend send failed', resp.status, t);
      return false;
    }
    const data = await resp.json().catch(() => ({}));
    console.log('[razorpay-webhook] welcome email sent', { to: email, id: data.id });
    return true;
  } catch (err) {
    console.error('[razorpay-webhook] Resend error (non-fatal)', err);
    return false;
  }
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
    console.log('[razorpay-webhook] subscription.charged', { plan: planId, tagId, email, tagged });
  } catch (err) {
    console.error('[razorpay-webhook] tagging error', err);
    // Still 200 — Razorpay retries on non-2xx, and a Kit hiccup shouldn't
    // trigger duplicate-charge retries. The error is logged for manual fixup.
  }

  // Welcome email — best-effort; sendWelcomeEmail never throws, but guard anyway
  // so nothing here can stop us returning 200 to Razorpay.
  try {
    await sendWelcomeEmail(email, firstName);
  } catch (err) {
    console.error('[razorpay-webhook] welcome email error (non-fatal)', err);
  }

  return ok();
};
