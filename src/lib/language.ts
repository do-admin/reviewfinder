/**
 * Language configuration for the location template.
 * Supported languages and default are read from src/data/language.config.json
 * (via src/data/current). German (`de`) website data is always loaded from `websites.json`;
 * other locales load from `websites-<lang>.json`.
 * Edit that file to enable/disable languages per project. Any language code can be
 * added there; metadata (name, flag, etc.) is taken from LANGUAGE_CONFIG when
 * present, otherwise a minimal fallback is used.
 */

import languageConfig from '@/data/language.config.json';
import { applyWithLangInternal } from '@/lib/route-slugs';

/** Language code type. Any string can be a supported language (from config). */
export type SupportedLanguage = string;

const FALLBACK_DEFAULT = 'de';

const rawDefault =
  typeof languageConfig?.defaultLanguage === 'string'
    ? languageConfig.defaultLanguage
    : FALLBACK_DEFAULT;
const rawList = Array.isArray(languageConfig?.supportedLanguages)
  ? languageConfig.supportedLanguages
  : [FALLBACK_DEFAULT];

/** Languages enabled for this template (from language.config.json). No hardcoded limit. */
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = rawList.filter(
  (lang): lang is SupportedLanguage => typeof lang === 'string' && lang.length > 0
);
if (SUPPORTED_LANGUAGES.length === 0) {
  (SUPPORTED_LANGUAGES as SupportedLanguage[]).push(FALLBACK_DEFAULT);
}

/** Default language (hreflang x-default, fallback for missing translations). */
export const DEFAULT_LANGUAGE: SupportedLanguage =
  SUPPORTED_LANGUAGES.includes(rawDefault as SupportedLanguage)
    ? rawDefault
    : SUPPORTED_LANGUAGES[0] ?? FALLBACK_DEFAULT;
if (!SUPPORTED_LANGUAGES.includes(DEFAULT_LANGUAGE)) {
  (SUPPORTED_LANGUAGES as SupportedLanguage[]).unshift(DEFAULT_LANGUAGE);
}

export type LanguageMetadata = {
  name: string;
  nativeName: string;
  flag: string;
  locale: string;
  hreflang: string;
  direction: 'ltr' | 'rtl';
};

/** Metadata for known languages (used by switchers, hreflang). Add entries here for full display; others get a minimal fallback. */
export const LANGUAGE_CONFIG: Record<string, LanguageMetadata> = {
  de: {
    name: 'German',
    nativeName: 'Deutsch',
    flag: '🇩🇪',
    locale: 'de_DE',
    hreflang: 'de',
    direction: 'ltr',
  },
  en: {
    name: 'English',
    nativeName: 'English',
    flag: '🇬🇧',
    locale: 'en_US',
    hreflang: 'en',
    direction: 'ltr',
  },
  sq: {
    name: 'Albanian',
    nativeName: 'Shqip',
    flag: '🇦🇱',
    locale: 'sq_AL',
    hreflang: 'sq',
    direction: 'ltr',
  },
  uk: {
    name: 'Ukrainian',
    nativeName: 'Українська',
    flag: '🇺🇦',
    locale: 'uk_UA',
    hreflang: 'uk',
    direction: 'ltr',
  },
  tr: {
    name: 'Turkish',
    nativeName: 'Türkçe',
    flag: '🇹🇷',
    locale: 'tr_TR',
    hreflang: 'tr',
    direction: 'ltr',
  },
  ar: {
    name: 'Arabic',
    nativeName: 'العربية',
    flag: '🇸🇦',
    locale: 'ar_SA',
    hreflang: 'ar',
    direction: 'rtl',
  },
  hi: {
    name: 'Hindi',
    nativeName: 'हिन्दी',
    flag: '🇮🇳',
    locale: 'hi_IN',
    hreflang: 'hi',
    direction: 'ltr',
  },
};

export function isValidLanguage(lang: string): lang is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage);
}

function fallbackLanguageMetadata(code: string): LanguageMetadata {
  return {
    name: code,
    nativeName: code,
    flag: '',
    locale: code,
    hreflang: code,
    direction: 'ltr',
  };
}

/** Returns metadata for a language. Uses LANGUAGE_CONFIG when present, otherwise a minimal fallback. */
export function getLanguageConfig(language: SupportedLanguage): LanguageMetadata {
  return LANGUAGE_CONFIG[language] ?? fallbackLanguageMetadata(language);
}

/**
 * Prefix an internal path with the current language segment.
 * Authoritative rule for internal navigation: data stores language-agnostic
 * slugs (e.g. `/ueber-uns`); the template adds `/<currentLang>` at render time.
 *
 * Behaviour:
 *   - `/ueber-uns`     → `/<currentLang>/<localized slug for ueber-uns>`
 *   - `/`              → `/<currentLang>`
 *   - `/<known-lang>/…` → `/<currentLang>/…` (defensive — rewrites legacy data)
 *   - Known page segments (datenschutz, about-us, etc.) are rewritten via `routeSlugs` in language.config.json
 *   - `mailto:…`, `tel:…`, `#…`, `http(s)://…` → unchanged
 */
export function withLang(
  href: string | undefined | null,
  currentLang: SupportedLanguage
): string {
  return applyWithLangInternal(href, currentLang, isValidLanguage);
}
