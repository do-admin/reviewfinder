/**
 * Single source of truth for public absolute URLs (canonical, hreflang, og:url, schema base).
 * Node scripts mirror this in `scripts/lib/normalize-public-url.mjs` — keep behaviour aligned.
 * — https scheme
 * — www. on hostname (except local / preview-style hosts where it would break)
 * — no trailing slash on the path (bare origin has no path)
 */

function shouldSkipWww(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.endsWith('.vercel.app') || h.endsWith('.netlify.app')) return true;
  return false;
}

/**
 * Normalize a full absolute URL string for SEO tags and structured data locations.
 */
export function normalizePublicUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return input;

  const withProtocol =
    trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return trimmed;
  }

  let hostname = parsed.hostname;
  if (!shouldSkipWww(hostname) && !hostname.startsWith('www.')) {
    hostname = `www.${hostname}`;
  }

  let pathname = parsed.pathname;
  while (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname === '/') {
    pathname = '';
  }

  const port = parsed.port ? `:${parsed.port}` : '';
  return `https://${hostname}${port}${pathname}${parsed.search}${parsed.hash}`;
}
