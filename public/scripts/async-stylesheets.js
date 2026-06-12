/**
 * Activates async stylesheets without inline onload handlers (CSP-friendly).
 * - data-async-stylesheet: link[rel=stylesheet][media=print] → media=all on load
 * - data-preload-as-stylesheet: link[rel=preload][as=style] → rel=stylesheet on load
 */
(function () {
  function activatePrintStylesheet(link) {
    function apply() {
      link.media = 'all';
    }
    link.addEventListener('load', apply);
    if (link.sheet) apply();
  }

  function activatePreloadStylesheet(link) {
    function apply() {
      link.rel = 'stylesheet';
    }
    link.addEventListener('load', apply);
    if (link.sheet) apply();
  }

  document.querySelectorAll('link[data-async-stylesheet]').forEach(activatePrintStylesheet);
  document
    .querySelectorAll('link[data-preload-as-stylesheet]')
    .forEach(activatePreloadStylesheet);
})();
