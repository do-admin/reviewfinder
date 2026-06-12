import type { LegalContentBlock, ResolvedPageData } from '@/types/page';
import { getDisplayAddress } from './business';
import datenschutzContent from '../data/_template/legal/datenschutz-content.json';

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
  pageData: ResolvedPageData
): LegalContentBlock[] {
  const business = pageData.business;
  const responsibleMode = pageData.datenschutzResponsibleMode ?? 'client';
  const useHeroPagesResponsible = responsibleMode === 'heroPages';
  const legalName = useHeroPagesResponsible
    ? HERO_PAGES_RESPONSIBLE.name
    : business.legalName || business.name;
  const { address } = getDisplayAddress(business);
  const phone = useHeroPagesResponsible
    ? HERO_PAGES_RESPONSIBLE.phone
    : business.phone || '';
  const email = useHeroPagesResponsible
    ? HERO_PAGES_RESPONSIBLE.email
    : business.email || '';
  const responsibleVariant = useHeroPagesResponsible
    ? datenschutzContent.variants.heroPages
    : datenschutzContent.variants.client;
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
        { type: 'text', value: datenschutzContent.shared.contactLabelPhone },
        { type: 'link', href: telHref(phone), value: phone || '-' },
        { type: 'br' },
        { type: 'text', value: datenschutzContent.shared.contactLabelEmail },
        { type: 'link', href: `mailto:${email}`, value: email || '-' },
      ],
    },
    {
      type: 'heading',
      level: 2,
      text: datenschutzContent.shared.hostingHeading,
    },
    {
      type: 'paragraph',
      parts: text(datenschutzContent.shared.hostingParagraph1),
    },
    {
      type: 'paragraph',
      parts: text(datenschutzContent.shared.hostingParagraph2),
    },
    {
      type: 'heading',
      level: 2,
      text: datenschutzContent.shared.contactHeading,
    },
    {
      type: 'paragraph',
      parts: text(datenschutzContent.shared.contactParagraph),
    },
    {
      type: 'heading',
      level: 2,
      text: datenschutzContent.shared.cookiesHeading,
    },
    {
      type: 'paragraph',
      parts: text(datenschutzContent.shared.cookiesParagraph),
    },
  ];

  if (hasGoogleAnalytics) {
    blocks.push(
      {
        type: 'heading',
        level: 2,
        text: '5. ' + datenschutzContent.googleAnalytics.heading,
      },
      {
        type: 'paragraph',
        parts: text(datenschutzContent.googleAnalytics.paragraph1),
      },
      {
        type: 'paragraph',
        parts: text(datenschutzContent.googleAnalytics.paragraph2),
      },
      {
        type: 'paragraph',
        parts: text(datenschutzContent.googleAnalytics.paragraph3),
      },
      {
        type: 'paragraph',
        parts: [
          { type: 'text', value: datenschutzContent.googleAnalytics.linkLabel },
          {
            type: 'link',
            href: datenschutzContent.googleAnalytics.linkHref,
            value: datenschutzContent.googleAnalytics.linkHref,
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
        text: `${hasGoogleAnalytics ? '6' : '5'}. ${datenschutzContent.googleMaps.heading}`,
      },
      {
        type: 'paragraph',
        parts: text(datenschutzContent.googleMaps.paragraph1),
      },
      {
        type: 'paragraph',
        parts: text(datenschutzContent.googleMaps.paragraph2),
      },
      {
        type: 'paragraph',
        parts: [
          { type: 'text', value: datenschutzContent.googleMaps.linkLabel },
          {
            type: 'link',
            href: datenschutzContent.googleMaps.linkHref,
            value: datenschutzContent.googleMaps.linkHref,
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
      text: `${hasGoogleMaps ? (hasGoogleAnalytics ? '7' : '6') : hasGoogleAnalytics ? '6' : '5'}. ${datenschutzContent.rights.heading}`,
    },
    {
      type: 'paragraph',
      parts: text(datenschutzContent.rights.paragraph1),
    },
    {
      type: 'paragraph',
      parts: text(datenschutzContent.rights.paragraph2),
    }
  );

  return blocks;
}
