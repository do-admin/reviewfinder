import type { TrustLogo } from '@/components/TrustBlock';
import type { ResolvedPageData } from '@/types/page';
import { getPreferredTrustDataFile } from '@/lib/page-data';
import {
  DEFAULT_LANGUAGE,
  type SupportedLanguage,
} from '@/lib/language';

type RawPartner = {
  name: string;
  url: string;
  logo: string;
  description: string;
  width?: number;
  height?: number;
};

type PartnerEntry = TrustLogo | RawPartner;

function isTrustLogo(entry: PartnerEntry): entry is TrustLogo {
  return 'src' in entry;
}

function buildTrustLogoSrc(
  logoFileName: string,
  siteId: string | null
): string {
  if (siteId) return `/images/${siteId}/trustblock/${siteId}-${logoFileName}`;
  return `/images/trustblock/${logoFileName}`;
}

/**
 * Normalizes partner data from either the TrustLogo format (partners.json)
 * or the raw partner format (*-partner.json) into TrustLogo objects.
 */
export function normalizeTrustLogos(
  data: PartnerEntry[],
  options?: { siteId?: string | null }
): TrustLogo[] {
  if (!data.length) return [];
  const siteId = options?.siteId ?? null;
  return data.map((entry) => {
    if (isTrustLogo(entry)) return entry;
    return {
      src: buildTrustLogoSrc(entry.logo, siteId),
      alt: entry.name,
      width: entry.width ?? 120,
      height: entry.height ?? 60,
      description: entry.description,
      website: entry.url,
    };
  });
}

type TrustModules = Record<string, () => Promise<{ default: PartnerEntry[] }>>;

const PARTNERS_FILENAME = 'partners.json';

/** Vite must see string-literal globs here (not in callers). */
const trustModules = import.meta.glob<{ default: PartnerEntry[] }>([
  '/src/data/current/partners.json',
  '/src/data/current/partners-*.json',
  '/src/data/current/**/*partner*.json',
  '/src/data/current/**/*partner*-*.json',
]);

function findTrustModuleKey(
  trustModulesMap: TrustModules,
  fileName: string,
  language?: string
): string | undefined {
  const withJson = fileName.endsWith('.json') ? fileName : `${fileName}.json`;
  const base = withJson.replace(/\.json$/, '');
  const candidates = language
    ? [`${base}-${language}.json`, withJson]
    : [withJson];
  return candidates
    .map((name) =>
      Object.keys(trustModulesMap).find((k) => k.endsWith(`/${name}`))
    )
    .find(Boolean);
}

type TrustSection = {
  logos?: TrustLogo[];
};

/**
 * Load trust/partner logos from `src/data/current/partners.json` (or
 * `trust.trustDataFile`) into `pageData.trust.logos`.
 *
 * Any `logos` array in websites.json is cleared and ignored — partners JSON
 * is the only source of truth at build time.
 */
export async function injectTrustLogos(
  pageData: ResolvedPageData,
  language?: SupportedLanguage
): Promise<void> {
  const trust = pageData.trust as
    | (typeof pageData.trust & TrustSection)
    | undefined;
  if (!trust) return;

  delete trust.logos;

  const lang = (language ?? DEFAULT_LANGUAGE) as SupportedLanguage;
  const preferredName =
    getPreferredTrustDataFile(pageData, lang) ?? PARTNERS_FILENAME;

  let matchKey = findTrustModuleKey(trustModules, preferredName, language);
  if (!matchKey && preferredName !== PARTNERS_FILENAME) {
    matchKey = findTrustModuleKey(trustModules, PARTNERS_FILENAME, language);
  }
  if (!matchKey) {
    trust.logos = [];
    return;
  }

  const mod = await trustModules[matchKey]();
  trust.logos = normalizeTrustLogos(mod.default, {
    siteId: pageData.id,
  });
}
