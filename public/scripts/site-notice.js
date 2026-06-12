/**
 * Cookie banner + Consent Mode updates. Replaces inline script in SiteNoticeStatic.
 */
(function () {
  const storageKey = 'cookieConsent';
  const exemptPath = /\/(datenschutz|impressum)\/?$/i;
  const notice = document.querySelector('[data-site-notice]');
  const dialog = notice?.querySelector('[data-site-notice-dialog]');
  const acceptButton = notice?.querySelector('[data-site-notice-accept]');
  const essentialButton = notice?.querySelector('[data-site-notice-essential]');
  if (!notice || !dialog || !acceptButton || !essentialButton) return;

  function updateConsent(granted) {
    const gtag = window.gtag;
    if (typeof gtag !== 'function') return;
    const value = granted ? 'granted' : 'denied';
    gtag('consent', 'update', {
      analytics_storage: value,
      ad_storage: value,
      ad_user_data: value,
      ad_personalization: value,
    });
  }

  function dispatchConsent(choice) {
    try {
      window.dispatchEvent(
        new CustomEvent('site-notice:consent', { detail: { choice: choice } })
      );
    } catch (_err) {
      /* CustomEvent unsupported (very old browsers) — silent no-op */
    }
  }

  const stored = window.localStorage.getItem(storageKey);
  if (stored !== null) {
    updateConsent(stored === 'accepted');
    dispatchConsent(stored);
    return;
  }
  if (exemptPath.test(window.location.pathname)) return;

  const previousOverflow = document.body.style.overflow;
  const previousPaddingRight = document.body.style.paddingRight;
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

  function close(choice) {
    try {
      window.localStorage.setItem(storageKey, choice);
    } catch {
      /* private mode */
    }
    updateConsent(choice === 'accepted');
    dispatchConsent(choice);
    notice.classList.add('hidden');
    notice.classList.remove('flex');
    document.body.style.overflow = previousOverflow;
    document.body.style.paddingRight = previousPaddingRight;
    document.removeEventListener('keydown', trapFocus);
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const focusable = dialog.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  notice.classList.remove('hidden');
  notice.classList.add('flex');
  document.body.style.overflow = 'hidden';
  if (scrollbarWidth > 0) {
    document.body.style.paddingRight = `${scrollbarWidth}px`;
  }
  acceptButton.focus();
  document.addEventListener('keydown', trapFocus);
  acceptButton.addEventListener('click', () => close('accepted'));
  essentialButton.addEventListener('click', () => close('declined'));
})();
