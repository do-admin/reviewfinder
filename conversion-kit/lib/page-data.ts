import type {
  WebsiteData,
  PageData,
  ResolvedPageData,
  WebsitesFile,
  SectionId,
  SectionConfig,
  SectionVisibility,
} from '@/types/page';
import {
  type SupportedLanguage,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  getLanguageConfig,
  type LanguageMetadata,
} from './language';

const websiteModules = import.meta.glob<{ default: WebsitesFile }>(
  '/src/data/current/websites*.json'
);

/** German (`de`) content always lives in `websites.json`; every other locale uses `websites-<lang>.json`. */
const GERMAN_LANG = 'de';

function moduleKeyForLang(lang: string): string {
  return lang === GERMAN_LANG
    ? '/src/data/current/websites.json'
    : `/src/data/current/websites-${lang}.json`;
}

function normalizeLoadedData(data: WebsitesFile | undefined): {
  websites: WebsiteData[];
  sectionIds: SectionConfig[] | undefined;
  clientDomain: string | undefined;
} {
  if (!data)
    return { websites: [], sectionIds: undefined, clientDomain: undefined };
  if (Array.isArray(data))
    return { websites: data, sectionIds: undefined, clientDomain: undefined };
  const clientDomain = data.clientDomain;
  if (!Array.isArray(data.sectionIds) || data.sectionIds.length === 0) {
    return {
      websites: data.websites ?? [],
      sectionIds: undefined,
      clientDomain,
    };
  }
  return {
    websites: data.websites ?? [],
    sectionIds: data.sectionIds,
    clientDomain,
  };
}

/** Flatten nested object into dot-notation keys (only string values). */
function flattenStrings(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenStrings(v as Record<string, unknown>, key));
    } else if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return out;
}

const init = (async () => {
  const websitesByLanguage: Partial<Record<SupportedLanguage, WebsiteData[]>> =
    {};
  let defaultSectionIds: SectionConfig[] | undefined;
  let topLevelClientDomain: string | undefined;

  if (!SUPPORTED_LANGUAGES.includes(GERMAN_LANG)) {
    const primeLoader = websiteModules['/src/data/current/websites.json'];
    if (primeLoader) {
      try {
        const mod = await primeLoader();
        const {
          sectionIds,
          clientDomain,
        } = normalizeLoadedData(mod?.default);
        if (sectionIds?.length) defaultSectionIds = sectionIds;
        if (clientDomain) topLevelClientDomain = clientDomain;
      } catch {
        /* ignore */
      }
    }
  }

  const others = SUPPORTED_LANGUAGES.filter((l) => l !== DEFAULT_LANGUAGE);
  const loadOrder = [
    DEFAULT_LANGUAGE,
    ...others.sort((a, b) => {
      if (a === GERMAN_LANG && b !== GERMAN_LANG) return -1;
      if (b === GERMAN_LANG && a !== GERMAN_LANG) return 1;
      return 0;
    }),
  ];

  for (const lang of loadOrder) {
    const loader = websiteModules[moduleKeyForLang(lang)];
    if (!loader) {
      websitesByLanguage[lang] = websitesByLanguage[DEFAULT_LANGUAGE] ?? [];
      continue;
    }
    try {
      const mod = await loader();
      const {
        websites: list,
        sectionIds,
        clientDomain,
      } = normalizeLoadedData(mod?.default);
      websitesByLanguage[lang] =
        list.length > 0 ? list : (websitesByLanguage[DEFAULT_LANGUAGE] ?? []);
      if (lang === GERMAN_LANG) {
        if (sectionIds?.length) defaultSectionIds = sectionIds;
        if (clientDomain) topLevelClientDomain = clientDomain;
      }
    } catch {
      websitesByLanguage[lang] = websitesByLanguage[DEFAULT_LANGUAGE] ?? [];
    }
  }

  const defaultWebsites = websitesByLanguage[DEFAULT_LANGUAGE] ?? [];

  return {
    websitesByLanguage,
    defaultWebsites,
    defaultSectionIds,
    topLevelClientDomain,
  };
})();

const {
  websitesByLanguage,
  defaultWebsites,
  defaultSectionIds,
  topLevelClientDomain,
} = await init;

export function getWebsite(
  websiteId: string,
  language: SupportedLanguage = DEFAULT_LANGUAGE
): WebsiteData | undefined {
  const list =
    websitesByLanguage[language] ??
    websitesByLanguage[DEFAULT_LANGUAGE] ??
    defaultWebsites;
  return list.find((w) => w.id === websiteId);
}

export function getPage(
  websiteId: string,
  pageName: string | undefined,
  language: SupportedLanguage = DEFAULT_LANGUAGE
): PageData | undefined {
  const website = getWebsite(websiteId, language);
  if (!website?.pages?.length) return undefined;
  if (pageName) {
    return website.pages.find((p) => p.name === pageName) as PageData | undefined;
  }
  return website.pages[0] as PageData;
}

export function getResolvedPageData(
  websiteId: string,
  pageName: string | undefined,
  language: SupportedLanguage = DEFAULT_LANGUAGE
): ResolvedPageData {
  const website = getWebsite(websiteId, language);
  if (!website) {
    throw new Error(`Website data for id ${websiteId} not found`);
  }
  const page = getPage(websiteId, pageName, language);
  if (!page) {
    throw new Error(`Page data for website ${websiteId} not found`);
  }

  const pageAny = page as unknown as Record<string, unknown>;
  let datenschutz: import('@/types/page').LegalPageContent | undefined;
  let impressum: import('@/types/page').LegalPageContent | undefined;
  let ueberUns: import('@/types/page').LegalPageContent | undefined;

  if (
    pageAny.name === 'impressum' &&
    pageAny.pageTitle != null &&
    pageAny.blocks
  ) {
    impressum = {
      pageTitle: String(pageAny.pageTitle),
      blocks: pageAny.blocks as import('@/types/page').LegalContentBlock[],
    };
  } else if (
    pageAny.name === 'datenschutz' &&
    pageAny.pageTitle != null &&
    pageAny.blocks
  ) {
    datenschutz = {
      pageTitle: String(pageAny.pageTitle),
      blocks: pageAny.blocks as import('@/types/page').LegalContentBlock[],
    };
  } else if (
    pageAny.name === 'ueber-uns' &&
    pageAny.pageTitle != null &&
    pageAny.blocks
  ) {
    ueberUns = {
      pageTitle: String(pageAny.pageTitle),
      blocks: pageAny.blocks as import('@/types/page').LegalContentBlock[],
    };
  }

  const sectionConfigs: SectionConfig[] = defaultSectionIds ?? [
    { id: 'hero', visible: true },
    { id: 'info', visible: true },
    { id: 'gallery', visible: true },
    { id: 'team', visible: true },
    { id: 'faq', visible: true },
    { id: 'reviews', visible: true },
    { id: 'map', visible: true },
    { id: 'contact', visible: true },
    { id: 'trust', visible: true },
  ];
  const sectionVisibility: SectionVisibility = Object.fromEntries(
    sectionConfigs.map(({ id, visible }) => [
      id,
      website.sectionVisibility?.[id] ?? visible,
    ])
  ) as SectionVisibility;

  const merged: ResolvedPageData = {
    ...pageAny,
    id: website.id,
    deployDomain: website.deployDomain,
    clientDomain:
      website.clientDomain ?? website.deployDomain ?? topLevelClientDomain ?? '',
    googleTagId: website.googleTagId,
    business: website.business,
    header: website.header,
    contact: website.contact ?? pageAny.contact,
    footer: website.footer,
    cookie: website.cookie,
    notFound: website.notFound,
    trust: website.trust ?? pageAny.trust,
    disclaimer: website.disclaimer,
    index: website.index,
    cityExample: website.cityExample,
    // Merge translationsMetadata.common into common so keys like "common.selectLanguage"
    // resolve via t() — clients historically put these under translationsMetadata.
    common: {
      ...((website as unknown as { translationsMetadata?: { common?: Record<string, string> } })
        .translationsMetadata?.common ?? {}),
      ...(website.common ?? {}),
    },
    datenschutz,
    impressum,
    ueberUns,
    impressumBacklink: website.impressumBacklink,
    metadata: page.metadata,
    hero: page.hero,
    sectionVisibility,
    info: (page as any).info,
    gallery: (page as any).gallery,
    team: (page as any).team,
    map: (page as any).map,
    reviews: (page as any).reviews,
    faq: (page as any).faq,
  } as ResolvedPageData;
  return merged;
}

export function getUiStrings(
  context: ResolvedPageData | SupportedLanguage
): Record<string, string> {
  return getStrings(context);
}

export function getStrings(
  context: ResolvedPageData | SupportedLanguage
): Record<string, string> {
  if (typeof context === 'string') {
    const list =
      websitesByLanguage[context] ??
      websitesByLanguage[DEFAULT_LANGUAGE] ??
      defaultWebsites;
    const website = list[0];
    if (!website?.pages?.length) return {};
    const page = website.pages[0] as PageData;
    const pageRecord = page as unknown as Record<string, unknown>;
    const resolved = {
      ...pageRecord,
      id: website.id,
      deployDomain: website.deployDomain,
        clientDomain:
        website.clientDomain ?? website.deployDomain ?? topLevelClientDomain ?? '',
      googleTagId: website.googleTagId,
      business: website.business,
      header: website.header,
      contact: website.contact ?? pageRecord.contact,
      footer: website.footer,
      cookie: website.cookie,
      notFound: website.notFound,
      trust: website.trust ?? pageRecord.trust,
      disclaimer: website.disclaimer,
      index: website.index,
      cityExample: website.cityExample,
      // Merge translationsMetadata.common into common so keys like "common.selectLanguage"
      // resolve via t() — clients historically put these under translationsMetadata.
      common: {
        ...((website as unknown as { translationsMetadata?: { common?: Record<string, string> } })
          .translationsMetadata?.common ?? {}),
        ...(website.common ?? {}),
      },
      metadata: page.metadata,
      hero: page.hero,
    };
    return flattenStrings(resolved as unknown as Record<string, unknown>);
  }
  return flattenStrings(context as unknown as Record<string, unknown>);
}

export function t(
  key: string,
  context: ResolvedPageData | SupportedLanguage = DEFAULT_LANGUAGE,
  params?: Record<string, string | number>,
  fallbackValue?: string
): string {
  const strings = getStrings(context);
  let fallback: Record<string, string>;
  if (typeof context === 'string') {
    fallback = getStrings(DEFAULT_LANGUAGE);
  } else {
    try {
      const defaultResolved = getResolvedPageData(
        context.id,
        undefined,
        DEFAULT_LANGUAGE
      );
      fallback = getStrings(defaultResolved);
    } catch {
      fallback = strings;
    }
  }
  // Precedence: active strings > default-language fallback > caller-supplied fallbackValue > raw key.
  let text = strings[key] ?? fallback[key] ?? fallbackValue ?? key;

  if (params) {
    for (const [paramKey, paramValue] of Object.entries(params)) {
      text = text.replace(
        new RegExp(`\\{${paramKey}\\}`, 'g'),
        String(paramValue)
      );
    }
  }
  return text;
}

const SHARED_FRAGMENT_TOP = [
  'header',
  'footer',
  'cookie',
  'notFound',
  'trust',
  'disclaimer',
  'common',
  'index',
  'cityExample',
  'business',
];

export function getWebsiteIndex(
  websiteId: string,
  language: SupportedLanguage = DEFAULT_LANGUAGE
): number {
  const list =
    websitesByLanguage[language] ??
    websitesByLanguage[DEFAULT_LANGUAGE] ??
    defaultWebsites;
  const idx = list.findIndex((w) => w.id === websiteId);
  return idx >= 0 ? idx : 0;
}

export function getPageIndexInWebsite(
  websiteId: string,
  pageName: string,
  language: SupportedLanguage = DEFAULT_LANGUAGE
): number {
  const website = getWebsite(websiteId, language);
  if (!website?.pages?.length) return 0;
  const idx = website.pages.findIndex((p) => p.name === pageName);
  return idx >= 0 ? idx : 0;
}

export function createSrcPath(
  websiteIndex: number,
  pageIndexInWebsite: number,
  language: SupportedLanguage
): (fragment: string) => string {
  const file =
    language === GERMAN_LANG
      ? 'data/current/websites.json'
      : `data/current/websites-${language}.json`;
  return (fragment: string) => {
    const top = fragment.split('.')[0];
    if (SHARED_FRAGMENT_TOP.includes(top)) {
      return `${file}#${websiteIndex}.${fragment}`;
    }
    return `${file}#${websiteIndex}.pages.${pageIndexInWebsite}.${fragment}`;
  };
}

export function getPageClientDomain(resolved: ResolvedPageData): string {
  if (resolved.clientDomain && resolved.clientDomain.length > 0) {
    const trimmed = resolved.clientDomain.trim();
    const withProtocol =
      trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? trimmed
        : `https://${trimmed}`;
    try {
      const parsed = new URL(withProtocol);
      return `https://${parsed.host}`;
    } catch {
      throw new Error(
        `Could not parse clientDomain from page data: "${resolved.clientDomain}"`
      );
    }
  }
  throw new Error('Could not get clientDomain from page data');
}

export type PageContext = {
  pageData: ResolvedPageData;
  clientDomain: string;
  srcPath: (fragment: string) => string;
  languageConfig: LanguageMetadata;
  alternates: Record<string, string>;
};

export function loadPageContext(
  websiteId: string,
  language: SupportedLanguage,
  options?: { pageName?: string; pathSuffix?: string }
): PageContext | null {
  let pageData: ResolvedPageData | undefined;
  if (options?.pageName !== undefined) {
    try {
      pageData = getResolvedPageData(websiteId, options.pageName, language);
    } catch {
      return null;
    }
  } else {
    try {
      pageData = getResolvedPageData(websiteId, undefined, language);
    } catch {
      return null;
    }
  }
  if (!pageData) return null;

  const clientDomain = getPageClientDomain(pageData);
  const websiteIndex = getWebsiteIndex(pageData.id, language);
  const pageName =
    (pageData as unknown as { name?: string }).name ?? pageData.id;
  const pageIndexInWebsite = getPageIndexInWebsite(
    pageData.id,
    pageName,
    language
  );
  const srcPath = createSrcPath(websiteIndex, pageIndexInWebsite, language);
  const languageConfig = getLanguageConfig(language);

  const pathSuffix = options?.pathSuffix ?? '';
  const alternates: Record<string, string> = {};
  SUPPORTED_LANGUAGES.forEach((l) => {
    const url = `${clientDomain}/${l}${pathSuffix}`;
    alternates[l] = url;
    if (l === DEFAULT_LANGUAGE) {
      alternates['x-default'] = url;
    }
  });

  return {
    pageData,
    clientDomain,
    srcPath,
    languageConfig,
    alternates,
  };
}
