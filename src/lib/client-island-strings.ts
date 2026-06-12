/**
 * Server-only helpers: resolve UI strings for client-hydrated islands so they
 * never import `@/lib/page-data` (and bundled website JSON) on the client.
 */
import type { ResolvedPageData } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { t } from '@/lib/page-data';

export type HeaderStrings = {
  logoUrl: string;
  logoAlt: string;
  ariaLabelNavigation: string;
  callNowAriaLabel: string;
  ariaMenuClose: string;
  ariaMenuOpen: string;
  selectLanguageLabel: string;
};

export type GalleryStrings = {
  ariaLabel: string;
  prevImage: string;
  nextImage: string;
  /** Template with `{current}` and `{total}` placeholders. */
  imageOfTemplate: string;
};

export function buildHeaderStrings(
  tr: ResolvedPageData | SupportedLanguage
): HeaderStrings {
  return {
    logoUrl: t('header.logoUrl', tr) || '/images/logo.png',
    logoAlt: t('header.logoAlt', tr),
    ariaLabelNavigation: t('header.ariaLabelNavigation', tr),
    callNowAriaLabel: t('hero.callNow', tr, undefined, 'Jetzt anrufen'),
    ariaMenuClose: t('header.ariaMenuClose', tr),
    ariaMenuOpen: t('header.ariaMenuOpen', tr),
    selectLanguageLabel: t(
      'common.selectLanguage',
      tr,
      undefined,
      'Sprache wählen'
    ),
  };
}

export function buildGalleryStrings(
  tr: ResolvedPageData | SupportedLanguage
): GalleryStrings {
  return {
    ariaLabel: t('gallery.ariaLabel', tr),
    prevImage: t('gallery.prevImage', tr),
    nextImage: t('gallery.nextImage', tr),
    imageOfTemplate: t('gallery.imageOf', tr),
  };
}
