/**
 * Content-Security-Policy reference for Hero Pages static sites (template.location).
 *
 * The enforcing header is added at the edge (herokit route-worker). This module
 * documents origins the template relies on so worker policy and site output stay aligned.
 *
 * @see docs/CSP.md
 */

/** Third-party hosts used by this template (extend when adding trackers or embeds). */
export const CSP_THIRD_PARTY_HOSTS = {
  googleAnalytics: [
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    'https://*.google-analytics.com',
    'https://region1.google-analytics.com',
    'https://stats.g.doubleclick.net',
  ],
  googleFonts: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
  googleMaps: ['https://www.google.com', 'https://maps.googleapis.com'],
  heroPages: [
    'https://api.hero-pages.com',
    'https://media.hero-pages.com',
  ],
} as const;

/**
 * Recommended report-only policy for the route-worker (single line, no report-uri until endpoint exists).
 * Includes 'unsafe-inline' for legacy React hydration paths and JSON-LD; tighten in a later sprint.
 */
export function buildReportOnlyCspDirective(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://region1.google-analytics.com https://stats.g.doubleclick.net https://api.hero-pages.com https://media.hero-pages.com",
    "frame-src 'self' https://www.google.com https://maps.googleapis.com",
    "frame-ancestors 'self'",
  ].join('; ');
}
