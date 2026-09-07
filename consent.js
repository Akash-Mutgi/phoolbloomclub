/* ============================================================
   Cookie consent for GA4 — Phool Bloom Club

   Consent-first, not Consent Mode. gtag.js is never fetched and no
   Google cookie is ever set until the visitor clicks Accept. Declining
   is stored and the script is then never loaded on any page, on any
   later visit.

   Loaded in <head> on all five pages, ahead of any page code, so
   window.gtag always exists by the time a page fires an event.

   How the queue works
   -------------------
   Before a decision, gtag() collects calls in a private array instead
   of pushing to dataLayer. That does two things: nothing can reach
   Google while the visitor is still deciding, and the required
   ordering (js -> config -> events) survives an Accept that happens
   *after* the page has already fired its events. On Accept the queue
   is replayed behind the config call. On Decline it is dropped.

   Adding an event to a page needs nothing from here beyond the usual
   gtag('event', ...). Guard the call site with a typeof check so an
   ad blocker eating this file cannot throw inside page logic.
============================================================ */
(function () {
  'use strict';

  var GA_ID       = 'G-EK1XCDZWTH';
  var STORAGE_KEY = 'pb_consent';   // 'granted' | 'denied'
  var pending     = [];             // gtag calls made before a decision

  window.dataLayer = window.dataLayer || [];

  function realGtag() { window.dataLayer.push(arguments); }

  /* Pre-decision gtag: swallow into `pending`, touch nothing else. */
  window.gtag = function () { pending.push(arguments); };

  /* localStorage throws outright in some privacy modes, so every access
     is guarded and a failure is read as "no decision yet" — which means
     nothing loads. Failing closed is the safe direction here. */
  function readChoice() {
    try { return window.localStorage.getItem(STORAGE_KEY); }
    catch (e) { return null; }
  }
  function saveChoice(value) {
    try { window.localStorage.setItem(STORAGE_KEY, value); }
    catch (e) { /* honour the click for this page view regardless */ }
  }

  function loadAnalytics() {
    window.gtag = realGtag;
    // Called directly rather than through the global `gtag` binding: same
    // effect, but it does not depend on window being the global object.
    realGtag('js', new Date());
    realGtag('config', GA_ID);

    // Replay anything the page fired while the banner was still up.
    for (var i = 0; i < pending.length; i++) {
      window.dataLayer.push(pending[i]);
    }
    pending.length = 0;

    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  /* ── Banner ────────────────────────────────────────────────── */

  var CSS = [
    '#pb-consent{position:fixed;left:0;right:0;bottom:0;z-index:9999;',
      'background:#f5f4ed;border-top:1px solid rgba(107,75,168,.22);',
      'box-shadow:0 -2px 14px rgba(36,24,32,.07);',
      "font-family:'DM Sans',system-ui,-apple-system,sans-serif;color:#241820;",
      'padding:14px 40px 14px 18px;font-size:.88rem;line-height:1.55;',
      'animation:pb-consent-in .22s ease-out}',
    '@keyframes pb-consent-in{from{transform:translateY(100%)}to{transform:none}}',
    '@media (prefers-reduced-motion:reduce){#pb-consent{animation:none}}',
    '.pb-consent-inner{max-width:940px;margin:0 auto;display:flex;flex-wrap:wrap;',
      'align-items:center;gap:12px 18px}',
    '.pb-consent-text{flex:1 1 320px;margin:0;min-width:0}',
    '.pb-consent-actions{display:flex;gap:10px;flex-shrink:0}',
    /* Both buttons share every dimension, border and weight. The only
       difference is fill, so neither is visually the "safe" default. */
    '.pb-consent-btn{font:inherit;font-size:.84rem;font-weight:600;',
      'letter-spacing:.02em;padding:9px 22px;min-width:104px;border-radius:100px;',
      'border:1.5px solid #6b4ba8;cursor:pointer;transition:opacity .15s ease}',
    '.pb-consent-btn:hover{opacity:.84}',
    '.pb-consent-btn:focus-visible{outline:2px solid #241820;outline-offset:2px}',
    '.pb-consent-accept{background:#6b4ba8;color:#f5f4ed}',
    '.pb-consent-decline{background:#ede5f8;color:#6b4ba8}',
    '.pb-consent-close{position:absolute;top:8px;right:10px;background:none;',
      'border:0;font:inherit;font-size:1.1rem;line-height:1;color:#5a4f6e;',
      'cursor:pointer;padding:4px 7px;border-radius:50%}',
    '.pb-consent-close:hover{color:#241820}',
    '.pb-consent-close:focus-visible{outline:2px solid #241820;outline-offset:1px}',
    '@media(max-width:560px){',
      '#pb-consent{padding:30px 16px 16px;font-size:.84rem}',
      '.pb-consent-actions{width:100%}',
      '.pb-consent-btn{flex:1 1 0}}'
  ].join('');

  function showBanner() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var bar = document.createElement('div');
    bar.id = 'pb-consent';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.innerHTML =
      '<button type="button" class="pb-consent-close" aria-label="Dismiss — decide later">&times;</button>' +
      '<div class="pb-consent-inner">' +
        '<p class="pb-consent-text">We’d like to use Google Analytics to see how people ' +
        'find the Club. It sets cookies, so it only runs if you say yes — ' +
        'nothing is loaded until you choose.</p>' +
        '<div class="pb-consent-actions">' +
          '<button type="button" class="pb-consent-btn pb-consent-decline">Decline</button>' +
          '<button type="button" class="pb-consent-btn pb-consent-accept">Accept</button>' +
        '</div>' +
      '</div>';

    function close() { if (bar.parentNode) bar.parentNode.removeChild(bar); }

    bar.querySelector('.pb-consent-accept').addEventListener('click', function () {
      saveChoice('granted');
      close();
      loadAnalytics();
    });

    bar.querySelector('.pb-consent-decline').addEventListener('click', function () {
      saveChoice('denied');
      pending.length = 0;
      close();
    });

    /* Dismiss is NOT a decision: nothing is stored and nothing is loaded,
       so the visitor is asked again next visit. Treating a dismissal as
       consent is exactly the dark pattern this is meant to avoid. */
    bar.querySelector('.pb-consent-close').addEventListener('click', close);

    document.body.appendChild(bar);
  }

  /* ── Boot ──────────────────────────────────────────────────── */

  var choice = readChoice();

  if (choice === 'granted') {
    loadAnalytics();                 // no banner, straight through
  } else if (choice !== 'denied') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showBanner);
    } else {
      showBanner();
    }
  }
  // 'denied' — do nothing at all, on this and every future page view.
})();
