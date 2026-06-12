import type { LegalContentBlock, ResolvedPageData } from '@/types/page';
import datenschutzContent from '../data/_template/legal/datenschutz-content.json';
import datenschutzContentEn from '../data/_template/legal/datenschutz-content-en.json';
import { getDisplayAddress, formatPhoneForDisplay } from './business';
import type { SupportedLanguage } from '@/lib/language';

function getDatenschutzContent(language?: SupportedLanguage) {
  return language === 'en' ? datenschutzContentEn : datenschutzContent;
}

const HERO_PAGES_RESPONSIBLE = {
  name: 'Hero Pages Inc.',
  email: 'legal@hero-pages.com',
  phone: '+4915121281631',
} as const;

function telHref(phone: string | undefined): string {
  if (!phone) return 'tel:';
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function text(value: string) {
  return [{ type: 'text' as const, value }];
}

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return params[key] ?? '';
  });
}

export function buildDatenschutzBlocks(
  pageData: ResolvedPageData,
  language?: SupportedLanguage
): LegalContentBlock[] {
  const content = getDatenschutzContent(language);
  const business = pageData.business;
  const responsibleMode = pageData.datenschutzResponsibleMode ?? 'client';
  const useHeroPagesResponsible = responsibleMode === 'heroPages';
  const legalName = useHeroPagesResponsible
    ? HERO_PAGES_RESPONSIBLE.name
    : business.legalName || business.name;
  // Verantwortliche: operating address (location) — not the legal / Impressum-only line.
  const { address } = getDisplayAddress(business);
  const phone = useHeroPagesResponsible
    ? HERO_PAGES_RESPONSIBLE.phone
    : business.phoneLegal || business.phone || '';
  const email = useHeroPagesResponsible
    ? HERO_PAGES_RESPONSIBLE.email
    : business.legalEmail || business.email || '';
  const responsibleVariant = useHeroPagesResponsible
    ? content.variants.heroPages
    : content.variants.client;
  const hasGoogleAnalytics = true;
  const hasGoogleMaps =
    Boolean(business.googlePlacesId) ||
    Boolean(
      pageData.map?.mapEmbedUrl && pageData.map.mapEmbedUrl.trim().length > 0
    );

  const blocks: LegalContentBlock[] = [
    { type: 'heading', level: 2, text: responsibleVariant.responsibleHeading },
    {
      type: 'paragraph',
      parts: text(
        interpolate(responsibleVariant.responsibleIntro, {
          legalName,
          street: address.street,
          postalCode: address.postalCode,
          city: address.city,
        })
      ),
    },
    {
      type: 'paragraph',
      parts: [
        { type: 'text', value: content.shared.contactLabelPhone },
        { type: 'link', href: telHref(phone), value: formatPhoneForDisplay(phone) || '-' },
        { type: 'br' },
        { type: 'text', value: content.shared.contactLabelEmail },
        { type: 'link', href: `mailto:${email}`, value: email || '-' },
      ],
    },
    {
      type: 'heading',
      level: 2,
      text: content.shared.hostingHeading,
    },
    {
      type: 'paragraph',
      parts: text(content.shared.hostingParagraph1),
    },
    {
      type: 'paragraph',
      parts: text(content.shared.hostingParagraph2),
    },
    {
      type: 'heading',
      level: 2,
      text: content.shared.contactHeading,
    },
    {
      type: 'paragraph',
      parts: text(content.shared.contactParagraph),
    },
    {
      type: 'heading',
      level: 2,
      text: content.shared.cookiesHeading,
    },
    {
      type: 'paragraph',
      parts: text(content.shared.cookiesParagraph),
    },
  ];

  if (hasGoogleAnalytics) {
    blocks.push(
      {
        type: 'heading',
        level: 2,
        text: '5. ' + content.googleAnalytics.heading,
      },
      {
        type: 'paragraph',
        parts: text(content.googleAnalytics.paragraph1),
      },
      {
        type: 'paragraph',
        parts: text(content.googleAnalytics.paragraph2),
      },
      {
        type: 'paragraph',
        parts: text(content.googleAnalytics.paragraph3),
      },
      {
        type: 'paragraph',
        parts: [
          { type: 'text', value: content.googleAnalytics.linkLabel },
          {
            type: 'link',
            href: content.googleAnalytics.linkHref,
            value: content.googleAnalytics.linkHref,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        ],
      }
    );
  }

  if (hasGoogleMaps) {
    blocks.push(
      {
        type: 'heading',
        level: 2,
        text: `${hasGoogleAnalytics ? '6' : '5'}. ${content.googleMaps.heading}`,
      },
      {
        type: 'paragraph',
        parts: text(content.googleMaps.paragraph1),
      },
      {
        type: 'paragraph',
        parts: text(content.googleMaps.paragraph2),
      },
      {
        type: 'paragraph',
        parts: [
          { type: 'text', value: content.googleMaps.linkLabel },
          {
            type: 'link',
            href: content.googleMaps.linkHref,
            value: content.googleMaps.linkHref,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        ],
      }
    );
  }

  blocks.push(
    {
      type: 'heading',
      level: 2,
      text: `${hasGoogleMaps ? (hasGoogleAnalytics ? '7' : '6') : hasGoogleAnalytics ? '6' : '5'}. ${content.rights.heading}`,
    },
    {
      type: 'paragraph',
      parts: text(content.rights.paragraph1),
    },
    {
      type: 'paragraph',
      parts: text(content.rights.paragraph2),
    }
  );

  return blocks;
}
