/**
 * Keep in sync with `src/lib/site-url.ts` (https, www, no trailing slash).
 * Used by Node entrypoints (Astro config, sitemap) that cannot import TS.
 */

export function shouldSkipWww(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.endsWith('.vercel.app') || h.endsWith('.netlify.app')) return true;
  return false;
}

export function normalizePublicUrl(input) {
  const trimmed = String(input).trim();
  if (!trimmed) return input;
  const withProtocol =
    trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;
  let parsed;
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
