/* ============================================================
   PHOOL BLOOM CLUB — RAZORPAY CHECKOUT WIRING
   ============================================================

   HOW TO USE
   1. Fill in the CHECKOUT_LINKS block below. Nothing else needs editing.
   2. Paste this whole file into a <script> tag at the end of index.html,
      after the existing tier-selection script.

   WHERE THE VALUES COME FROM
   Razorpay Dashboard -> Subscriptions -> open a plan -> create a
   Subscription Link. Copy the resulting URL (looks like
   https://rzp.io/rzp/xxxxxxx). Paste it against the matching tier.

   IMPORTANT
   - These are SUBSCRIPTION LINK URLs, not plan_ IDs and not Payment
     Links. Payment Links charge once and never renew.
   - Never put your Razorpay KEY SECRET in this file. It is public.
     Only shareable links belong here.
   - Any tier left as an empty string keeps its current behaviour and
     scrolls to the waitlist. Nothing breaks if you fill in some and
     not others — you can ship the two you need today and add the
     rest later.
   ============================================================ */

const CHECKOUT_LINKS = {

  // ---- FOUNDING MEMBER ----
  // The founding cards were removed from the page, so these keys render
  // nowhere. founding_india's link (subscription sub_TLMnXtqnz4N0i5) is
  // parked and shared directly with one customer — the URL is deliberately
  // NOT written here, because this file is served publicly and printing it
  // would let anyone subscribe at the founding rate. It is in the Razorpay
  // Dashboard. Left empty deliberately.
  founding_india:         '',
  founding_intl:          '',

  // ---- CHECKOUT DELIBERATELY CLOSED ----------------------------------
  // All eight values are emptied on purpose, so every tier button falls
  // back to #pricing and no new subscription can start through these
  // links. This is NOT an unfinished config.
  //
  // WHY: the rzp.io hosted subscription page cannot collect a postal
  // address, and this is a mail business — subscribers arriving this way
  // could not be shipped to. Those links also carried a total_count that
  // ends the subscription after 12 months.
  //
  // The eight subscription links still exist and still work for anyone
  // already holding one. They are DELIBERATELY NOT LISTED HERE: this file
  // is served publicly, and printing them would let anyone read the source
  // and subscribe through the very links this change is closing.
  // The full list is in the commit message of 9ae9ef5, and in the Razorpay
  // Dashboard under Subscriptions.
  //
  // NEXT: replaced by /checkout/desi/ and /checkout/global/, which collect
  // the address before payment and create the subscription server-side.
  // --------------------------------------------------------------------

  // ---- DESI PHOOL / INDIA (the four tier rows) ----
  desi_monthly:           '',   // Rs 555   / month
  desi_seasonal:          '',   // Rs 1,499 / 3 months
  desi_halfyear:          '',   // Rs 2,799 / 6 months
  desi_year:              '',   // Rs 4,999 / 12 months

  // ---- GLOBAL PHOOL / INTERNATIONAL (the four tier rows) ----
  global_monthly:         '',   // Rs 1,100  / month
  global_seasonal:        '',   // Rs 3,299  / 3 months
  global_halfyear:        '',   // Rs 5,299  / 6 months
  global_year:            '',   // Rs 10,999 / 12 months
};


/* ============================================================
   BLOCKLIST — plan IDs that must NEVER reach a live button
   ============================================================

   These plans exist in Razorpay and cannot be deleted, but they are
   wrong and no subscription link should ever be created against them.
   The guard below is belt-and-braces: if a link built on one of these
   plans ever lands in CHECKOUT_LINKS, the affected button falls back
   to the waitlist and a clear error is logged at startup.

   Matching is by substring, so it catches both a bare plan ID pasted
   as a value and a subscription-link URL that carries the ID inside it.

   To retire an entry, delete the whole object. Do not edit the id
   string — a typo here silently disables the protection.
   ============================================================ */
const BLOCKED_PLAN_IDS = [
  {
    id:     'plan_T2izHiwMZzF8aI',
    reason: '$750/month — almost certainly a typo',
  },
  {
    id:     'plan_T2jBHlx5hfmfKg',
    reason: 'Rs 5,299 billed MONTHLY, not half-yearly',
  },
];


/* ============================================================
   Below this line: no editing needed.
   ============================================================ */
(function () {
  'use strict';

  // Fallback destination for any tier with no usable link. The waitlist
  // section no longer exists; #pricing is the live plans section, so an
  // unconfigured button scrolls there rather than at a dead anchor.
  var WAITLIST = '#pricing';

  var TAG = '[razorpay-checkout]';

  // Returns the offending blocklist entry, or null. Never throws.
  function blockedMatch(v) {
    if (typeof v !== 'string' || !v) return null;
    var list = (typeof BLOCKED_PLAN_IDS !== 'undefined' && BLOCKED_PLAN_IDS) || [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (entry && typeof entry.id === 'string' && entry.id &&
          v.indexOf(entry.id) !== -1) {
        return entry;
      }
    }
    return null;
  }

  function clean(v, key) {
    if (typeof v !== 'string') return '';
    v = v.trim();
    if (!v || v === '#') return '';

    // Blocked plans can never produce a live destination, no matter how
    // the value is shaped. Refuse and fall back to the waitlist.
    var blocked = blockedMatch(v);
    if (blocked) {
      console.error(
        TAG + ' REFUSED blocked plan for "' + (key || 'unknown') + '": ' +
        blocked.id + ' (' + blocked.reason + '). ' +
        'Button falls back to ' + WAITLIST + '.'
      );
      return '';
    }

    // only allow real https links — guards against a half-pasted value
    return /^https:\/\//i.test(v) ? v : '';
  }

  /* Startup audit — scans the whole config once and reports every
     problem at load, rather than waiting for a click to surface it. */
  function auditConfig() {
    if (typeof CHECKOUT_LINKS !== 'object' || !CHECKOUT_LINKS) return;

    var blocked = [];
    var looksLikePlanId = [];

    for (var key in CHECKOUT_LINKS) {
      if (!Object.prototype.hasOwnProperty.call(CHECKOUT_LINKS, key)) continue;
      var raw = CHECKOUT_LINKS[key];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      var value = raw.trim();

      var hit = blockedMatch(value);
      if (hit) {
        blocked.push({ key: key, id: hit.id, reason: hit.reason });
        continue;
      }
      // Secondary check: this config takes subscription-link URLs only.
      // A bare plan_ ID is always a mistake here, blocked or not.
      if (/^plan_/i.test(value) || !/^https:\/\//i.test(value)) {
        looksLikePlanId.push({ key: key, value: value });
      }
    }

    if (blocked.length) {
      console.error(
        TAG + ' ' + blocked.length + ' BLOCKED PLAN ID(S) FOUND IN CHECKOUT_LINKS. ' +
        'These buttons will fall back to ' + WAITLIST + ' and cannot take payment. ' +
        'Remove them and use a subscription link built on a correct plan:'
      );
      blocked.forEach(function (b) {
        console.error(TAG + '   • ' + b.key + ' → ' + b.id + ' — ' + b.reason);
      });
    }

    if (looksLikePlanId.length) {
      console.error(
        TAG + ' ' + looksLikePlanId.length + ' value(s) in CHECKOUT_LINKS are not ' +
        'https:// subscription links. This config takes subscription-link URLs ' +
        '(https://rzp.io/...) only — plan IDs do not work here. Affected: ' +
        looksLikePlanId.map(function (p) { return p.key; }).join(', ')
      );
    }
  }

  function apply(anchor, url) {
    if (!anchor) return;
    var next = url || WAITLIST;

    // Write only on an actual change. Both the click listener and the
    // MutationObserver call syncCard for the same selection, so an
    // unconditional write would set href twice per change. This keeps it
    // to exactly one write, and to zero when nothing moved.
    if (anchor.getAttribute('href') !== next) {
      anchor.setAttribute('href', next);
    }

    if (url) {
      anchor.setAttribute('rel', 'noopener');
    } else {
      anchor.removeAttribute('target');
    }
  }

  // ---- 1. the two founding-member buttons ----
  function wireFounding() {
    var cards = document.querySelectorAll('.fm-price-card');
    var keys = ['founding_india', 'founding_intl'];
    for (var i = 0; i < cards.length && i < keys.length; i++) {
      apply(cards[i].querySelector('a.fm-cta, a.btn-amber, a.btn-pw'),
            clean(CHECKOUT_LINKS[keys[i]], keys[i]));
    }
  }

  // ---- 2. the two tier cards, following the current selection ----
  var TIER_KEYS = [
    ['desi_monthly', 'desi_seasonal', 'desi_halfyear', 'desi_year'],
    ['global_monthly', 'global_seasonal', 'global_halfyear', 'global_year']
  ];

  function selectedIndex(card) {
    var rows = card.querySelectorAll('[role="radio"]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('aria-checked') === 'true') return i;
    }
    return 0; // monthly is the default
  }

  function syncCard(card, cardIndex) {
    var keys = TIER_KEYS[cardIndex];
    if (!keys) return;
    var key = keys[selectedIndex(card)];
    apply(card.querySelector('a.btn-po, a.btn-pw'), clean(CHECKOUT_LINKS[key], key));
  }

  function wireTiers() {
    var cards = document.querySelectorAll('.plan-block');
    for (var i = 0; i < cards.length; i++) {
      (function (card, idx) {
        syncCard(card, idx);
        // re-sync whenever the selection changes, however it changed
        card.addEventListener('click', function () { syncCard(card, idx); });
        card.addEventListener('keyup', function () { syncCard(card, idx); });
        if (window.MutationObserver) {
          new MutationObserver(function () { syncCard(card, idx); })
            .observe(card, {
              subtree: true,
              attributes: true,
              attributeFilter: ['aria-checked']
            });
        }
      })(cards[i], i);
    }
  }

  function init() {
    // Audit first so the warning is visible even if wiring later fails.
    try { auditConfig(); }  catch (e) { /* never block wiring on the audit */ }
    try { wireFounding(); } catch (e) { /* leave waitlist fallback intact */ }
    try { wireTiers(); }    catch (e) { /* leave waitlist fallback intact */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
