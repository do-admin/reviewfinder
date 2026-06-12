/**
 * Click-to-load Google Maps embed (DSGVO-konform).
 *
 * On page load, looks for `[data-google-map-consent]` placeholders and:
 *   - Loads the iframe immediately when the user has already accepted all
 *     cookies (`localStorage.cookieConsent === 'accepted'`) or has
 *     previously opted in to maps only (`localStorage.mapConsent === 'accepted'`).
 *   - Otherwise, renders a placeholder with a "Karte laden" button. Clicking
 *     it stores `mapConsent=accepted` in localStorage and replaces the
 *     placeholder with the actual `<iframe>`.
 *
 * Listens for `site-notice:consent` events (dispatched by site-notice.js) so
 * the map auto-loads as soon as the user accepts all cookies in the banner.
 */
(function () {
  'use strict';

  var COOKIE_KEY = 'cookieConsent';
  var MAP_KEY = 'mapConsent';

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_err) {
      /* private mode */
    }
  }

  function hasMapConsent() {
    return (
      readStorage(MAP_KEY) === 'accepted' ||
      readStorage(COOKIE_KEY) === 'accepted'
    );
  }

  function loadIframe(container) {
    if (container.getAttribute('data-google-map-consent-loaded') === 'true') {
      return;
    }
    var src = container.getAttribute('data-iframe-src');
    if (!src) return;
    var title = container.getAttribute('data-iframe-title') || '';
    var iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.border = '0';
    iframe.allowFullscreen = true;
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    if (title) iframe.title = title;
    iframe.className = 'w-full h-full';
    var srcPath = container.getAttribute('data-iframe-src-path');
    if (srcPath) iframe.setAttribute('data-hero-factory-src-path', srcPath);
    container.innerHTML = '';
    container.appendChild(iframe);
    container.setAttribute('data-google-map-consent-loaded', 'true');
  }

  function bindButton(container) {
    var button = container.querySelector('[data-google-map-consent-accept]');
    if (!button) return;
    button.addEventListener('click', function () {
      writeStorage(MAP_KEY, 'accepted');
      loadIframe(container);
    });
  }

  function init() {
    var containers = document.querySelectorAll('[data-google-map-consent]');
    if (containers.length === 0) return;
    var consented = hasMapConsent();
    for (var i = 0; i < containers.length; i++) {
      if (consented) {
        loadIframe(containers[i]);
      } else {
        bindButton(containers[i]);
      }
    }
  }

  function onConsentChange(event) {
    var detail = event && event.detail;
    if (!detail || detail.choice !== 'accepted') return;
    var containers = document.querySelectorAll('[data-google-map-consent]');
    for (var i = 0; i < containers.length; i++) {
      loadIframe(containers[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.addEventListener('site-notice:consent', onConsentChange);
})();
