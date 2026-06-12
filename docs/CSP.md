# Content-Security-Policy (CSP) readiness

Static sites built from **template.location** are served through the HeroKit **route-worker** (`herokit-builder/apps/route-worker`). Security headers (including CSP) are added at the edge, not in this repo.

This document describes what the template expects so report-only or enforcing CSP does not break production sites.

## Template changes (CSP-friendly)

| Before | After |
|--------|--------|
| Inline Consent Mode script in `BaseLayout.astro` (early version) | Inline `<script is:inline>` Consent Mode bootstrap in `BaseLayout.astro` (kept inline to avoid render-blocking request) |
| Inline cookie banner script in `SiteNoticeStatic` | `/scripts/site-notice.js` |
| `onload="..."` on stylesheet links | `/scripts/async-stylesheets.js` + `data-async-stylesheet` / `data-preload-as-stylesheet` |
| Inline redirect on `/` (early version) | Inline `<script is:inline>` redirect in `index.astro` reading `data-default-lang` |
| `googleTagId` in data only (not loaded) | `GoogleAnalytics.astro` → external `gtag/js` + `/scripts/gtag-config.js` |

## Edge policy reference

Canonical directive list for the route-worker lives in:

- `src/lib/csp.ts` — `CSP_THIRD_PARTY_HOSTS`, `buildReportOnlyCspDirective()`

Recommended rollout:

1. Deploy template changes (this repo) and rebuild client sites.
2. Enable **`Content-Security-Policy-Report-Only`** on the worker for ≥1 week.
3. Validate with DevTools Console (`[Report Only] Refused…`) on homepage, FAQ, contact, impressum, after cookie accept.
4. Switch header to **`Content-Security-Policy`** (enforcing) when clean.

Example report-only value (single header line):

```http
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://region1.google-analytics.com https://stats.g.doubleclick.net https://api.hero-pages.com; frame-src 'self' https://www.google.com https://maps.googleapis.com; frame-ancestors 'self'
```

Add `https://media.hero-pages.com` to `img-src` / `connect-src` if a site uses the media CDN for images.

## Third-party origins by feature

| Feature | Hosts |
|---------|--------|
| GA4 / Consent Mode | `www.googletagmanager.com`, `www.google-analytics.com`, `*.google-analytics.com`, `region1.google-analytics.com`, `stats.g.doubleclick.net` |
| Google Fonts | `fonts.googleapis.com`, `fonts.gstatic.com` |
| Maps embed | `www.google.com` (`/maps/embed/...`), optional `maps.googleapis.com` |
| Text editor (dev / flag only) | `api.hero-pages.com` |
| Media CDN | `media.hero-pages.com` |

## Still requires `'unsafe-inline'` (report-only / phase 1)

- **Inline Consent Mode bootstrap** (`BaseLayout.astro`) — tiny `<script is:inline>` that sets `gtag('consent', 'default', …)` before `gtag.js` loads. Inlined to remove a render-blocking request.
- **Inline language redirect** (`index.astro`) — tiny `<script is:inline>` that redirects `/` to the default language using `data-default-lang` on `<html>`.
- **JSON-LD** (`SchemaOrg.astro`) — allowed as `application/ld+json`, not `script-src`.
- **Trusted HTML** in FAQ / Über uns (`dangerouslySetInnerHTML`) — must not contain `<script>`; CSP blocks injected scripts if present.
- **React client islands** (`client:load` / `client:visible`) — may emit inline hydration scripts; keep `'unsafe-inline'` in `script-src` until nonces are implemented at the edge.

## Validation checklist

- [ ] Document response includes `Content-Security-Policy-Report-Only` (after worker change).
- [ ] No `[Report Only]` errors on `/de/` (essential + accept-all cookie paths).
- [ ] Fonts and layout unchanged.
- [ ] Map iframe loads when `googlePlacesId` + embed API key are set.
- [ ] GA network requests only after “accept all” (Consent Mode).
- [ ] Root `/` redirects to default language.

## Local testing without the worker

CSP is not set in `astro dev`. To preview violations locally, use a browser extension or temporary meta tag (dev only):

```html
<!-- dev only — remove before commit -->
<meta http-equiv="Content-Security-Policy-Report-Only" content="default-src 'self'; ..." />
```

Prefer validating on a **preview domain** behind the route-worker once the header is enabled.
