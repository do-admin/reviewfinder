import type { SupportedLanguage } from '@/lib/language';

/** German (`de`) content always lives in `websites.json`; other locales use `websites-<lang>.json`. */
const GERMAN_LANG = 'de';

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

/**
 * Serializable counterpart to `createSrcPath`. Use this on `client:*` islands so
 * Astro can pass it across the SSR/hydration boundary; the function form is not
 * JSON-safe and arrives as `null` on the client (causing hydration mismatches).
 */
export type SrcPathInfo = {
  websiteIndex: number;
  pageIndex: number;
  language: SupportedLanguage;
};

export function buildSrcPath(info: SrcPathInfo, fragment: string): string {
  const file =
    info.language === GERMAN_LANG
      ? 'data/current/websites.json'
      : `data/current/websites-${info.language}.json`;
  const top = fragment.split('.')[0];
  if (SHARED_FRAGMENT_TOP.includes(top)) {
    return `${file}#${info.websiteIndex}.${fragment}`;
  }
  return `${file}#${info.websiteIndex}.pages.${info.pageIndex}.${fragment}`;
}

export function createSrcPath(
  websiteIndex: number,
  pageIndexInWebsite: number,
  language: SupportedLanguage
): (fragment: string) => string {
  const info: SrcPathInfo = {
    websiteIndex,
    pageIndex: pageIndexInWebsite,
    language,
  };
  return (fragment: string) => buildSrcPath(info, fragment);
}
