/**
 * Per-language URL slugs for multi-page routes (configured in language.config.json `routeSlugs`).
 * Internal page names (e.g. `datenschutz`) stay stable in data; public paths vary by locale.
 */
import languageConfig from '@/data/language.config.json';

export type RouteSlugMap = Record<string, Partial<Record<string, string>>>;

const ROUTABLE_PAGE_NAMES_CONST = [
  'datenschutz',
  'impressum',
  'ueber-uns',
  'faq',
  'grounding',
] as const;

export type RoutablePageName = (typeof ROUTABLE_PAGE_NAMES_CONST)[number];

export const ROUTABLE_PAGE_NAMES: RoutablePageName[] = [
  ...ROUTABLE_PAGE_NAMES_CONST,
];

function getRawRouteSlugMap(): RouteSlugMap {
  const raw = (languageConfig as { routeSlugs?: RouteSlugMap }).routeSlugs;
  return raw && typeof raw === 'object' ? raw : {};
}

/** URL segment for `pageName` in `lang` (falls back to `pageName` when unconfigured). */
export function getLocalizedSlug(pageName: string, lang: string): string {
  const map = getRawRouteSlugMap();
  const entry = map[pageName];
  if (entry && typeof entry[lang] === 'string' && entry[lang]!.length > 0) {
    return entry[lang]!;
  }
  return pageName;
}

/** Map a slug appearing in the URL for `lang` back to internal `pageName`. */
export function getPageNameFromSlug(
  slug: string,
  lang: string
): string | undefined {
  const map = getRawRouteSlugMap();
  for (const [pageName, perLang] of Object.entries(map)) {
    if (perLang?.[lang] === slug) return pageName;
  }
  if (ROUTABLE_PAGE_NAMES.includes(slug as RoutablePageName)) return slug;
  return undefined;
}

/**
 * Resolve any localized slug (from any configured language) to internal `pageName`.
 * Used for links stored as `/ueber-uns` when the current locale uses `about-us`.
 */
export function resolvePageNameFromPathSegment(
  segment: string
): string | undefined {
  if (!segment) return undefined;
  const map = getRawRouteSlugMap();
  for (const [pageName, perLang] of Object.entries(map)) {
    if (!perLang || typeof perLang !== 'object') continue;
    for (const slug of Object.values(perLang)) {
      if (slug === segment) return pageName;
    }
  }
  if (ROUTABLE_PAGE_NAMES.includes(segment as RoutablePageName)) return segment;
  return undefined;
}

export function getLocalizedPath(pageName: string, lang: string): string {
  return `/${lang}/${getLocalizedSlug(pageName, lang)}`;
}

export function getAlternateSlugForLang(
  currentSlug: string,
  _currentLang: string,
  targetLang: string
): string {
  const pageName = resolvePageNameFromPathSegment(currentSlug);
  if (!pageName) return currentSlug;
  return getLocalizedSlug(pageName, targetLang);
}

/**
 * Enhanced `withLang`: prefixes `/<lang>/`, strips a leading language segment if present,
 * and rewrites the first path segment to the localized slug when it matches a routable page.
 */
export function applyWithLangInternal(
  href: string | undefined | null,
  currentLang: string,
  isValidLanguage: (lang: string) => boolean
): string {
  if (!href || typeof href !== 'string') return href ?? '';
  const trimmed = href.trim();
  if (!trimmed.startsWith('/')) return trimmed;

  const segments = trimmed.split('/').filter(Boolean);
  const firstIsKnownLang = segments.length > 0 && isValidLanguage(segments[0]);
  const rest = firstIsKnownLang ? segments.slice(1) : segments;

  if (rest.length === 0) {
    return `/${currentLang}`;
  }

  const [first, ...tail] = rest;
  const pageName = resolvePageNameFromPathSegment(first);
  if (pageName && tail.length === 0) {
    return `/${currentLang}/${getLocalizedSlug(pageName, currentLang)}`;
  }
  if (pageName && tail.length > 0) {
    return `/${currentLang}/${getLocalizedSlug(pageName, currentLang)}/${tail.join('/')}`;
  }

  return rest.length ? `/${currentLang}/${rest.join('/')}` : `/${currentLang}`;
}

/**
 * Redirect pairs for static hosting: from non-canonical slug to canonical slug per locale
 * (e.g. `/en/datenschutz` → `/en/privacy-policy`).
 */
export function getLegacySlugRedirects(): Array<{
  fromSuffix: string;
  toSuffix: string;
}> {
  const map = getRawRouteSlugMap();
  const pairs: Array<{ fromSuffix: string; toSuffix: string }> = [];
  for (const pageName of ROUTABLE_PAGE_NAMES) {
    const perLang = map[pageName];
    if (!perLang) continue;
    const allSlugs = new Set<string>();
    for (const s of Object.values(perLang)) {
      if (typeof s === 'string' && s.length > 0) allSlugs.add(s);
    }
    for (const lang of Object.keys(perLang)) {
      const canonical = getLocalizedSlug(pageName, lang);
      for (const legacy of allSlugs) {
        if (legacy !== canonical) {
          pairs.push({
            fromSuffix: `/${lang}/${legacy}`,
            toSuffix: `/${lang}/${canonical}`,
          });
        }
      }
    }
  }
  const dedupe = new Set<string>();
  return pairs.filter((p) => {
    const k = `${p.fromSuffix}->${p.toSuffix}`;
    if (dedupe.has(k)) return false;
    dedupe.add(k);
    return true;
  });
}
