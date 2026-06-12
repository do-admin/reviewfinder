/**
 * GA4 config after gtag.js loads (async). measurement id from data-measurement-id.
 */
(function () {
  const script = document.currentScript;
  const measurementId = script?.getAttribute('data-measurement-id')?.trim();
  if (!measurementId) return;

  function configure() {
    if (typeof window.gtag !== 'function') return false;
    window.gtag('js', new Date());
    window.gtag('config', measurementId);
    return true;
  }

  if (configure()) return;

  const deadline = Date.now() + 10000;
  const timer = window.setInterval(function () {
    if (configure() || Date.now() > deadline) {
      window.clearInterval(timer);
    }
  }, 50);
})();
