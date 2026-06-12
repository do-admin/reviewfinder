/**
 * Schema.org JSON-LD builder for all supported types.
 * Data shapes match what is stored in page JSON and edited in SEOEditorModal.
 */

import { normalizePublicUrl } from '@/lib/site-url';

export type SchemaOrgType =
  | 'organization'
  | 'website'
  | 'article'
  | 'donation'
  | 'faq'
  | 'faqPage'
  | 'course'
  | 'learningResource'
  | 'breadcrumb'
  | 'localBusiness'
  | 'product'
  | 'person'
  | 'place';

export interface SchemaComponent {
  id: string;
  schemaType: SchemaOrgType;
  data: Record<string, unknown>;
}

const DEFAULT_SITE_URL = () => '';

/**
 * Build a single JSON-LD object for the given schema type and data.
 * Resolves relative URLs using siteUrl (defaults to getAbsoluteUrl('/')).
 */
export function buildSchemaJsonLd(
  schemaType: SchemaOrgType,
  data: Record<string, unknown>,
  options?: { siteUrl?: string }
): Record<string, unknown> {
  const baseUrl = normalizePublicUrl(
    (options?.siteUrl ?? DEFAULT_SITE_URL()).replace(/\/$/, '') || 'https://example.com'
  );
  const resolve = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return normalizePublicUrl(trimmed);
    }
    if (trimmed.startsWith('#')) {
      return `${baseUrl}${trimmed}`;
    }
    return normalizePublicUrl(
      `${baseUrl}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
    );
  };
  const resolveSameAs = (urls: string[]) =>
    urls.map((u) => resolve(String(u))).filter(Boolean);

  switch (schemaType) {
    case 'organization': {
      const d = data as Record<string, unknown>;
      const orgId = d['@id'] != null ? resolve(String(d['@id'])) : `${baseUrl}#organization`;
      const brandId = `${baseUrl}#brand`;
      const hasOfferCatalog = d.hasOfferCatalog as Record<string, unknown> | undefined;
      return {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        '@id': orgId,
        ...(d.name != null && { name: d.name }),
        ...(d.legalName != null && { legalName: d.legalName }),
        ...(d.alternateName != null && { alternateName: d.alternateName }),
        ...(d.description != null && { description: d.description }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.logo != null && { logo: resolve(String(d.logo)) }),
        ...(d.image != null && { image: resolve(String(d.image)) }),
        ...(d.sameAs != null &&
          Array.isArray(d.sameAs) &&
          resolveSameAs(d.sameAs as string[]).length > 0 && {
            sameAs: resolveSameAs(d.sameAs as string[]),
          }),
        ...(d.address != null && {
          address: Array.isArray(d.address)
            ? (d.address as Record<string, unknown>[]).map((a) => ({
                '@type': 'PostalAddress',
                ...a,
              }))
            : typeof d.address === 'object' && d.address !== null
              ? { '@type': 'PostalAddress', ...(d.address as Record<string, unknown>) }
              : d.address,
        }),
        ...(d.contactPoint != null && { contactPoint: d.contactPoint }),
        ...(d.email != null && { email: d.email }),
        ...(d.telephone != null && { telephone: d.telephone }),
        ...(d.areaServed != null && { areaServed: d.areaServed }),
        ...(d.slogan != null && { slogan: d.slogan }),
        ...(d.identifier != null && { identifier: d.identifier }),
        ...(d.taxID != null && { taxID: d.taxID }),
        ...(d.foundingLocation != null &&
          typeof d.foundingLocation === 'object' && {
            foundingLocation: {
              '@type': 'Place',
              ...(d.foundingLocation as Record<string, unknown>),
            },
          }),
        ...(d.founder != null && Array.isArray(d.founder) && {
          founder: (d.founder as Record<string, unknown>[]).map((f) => ({ '@type': 'Person', ...f })),
        }),
        ...(d.priceRange != null && { priceRange: d.priceRange }),
        ...(d.mainEntityOfPage != null && { mainEntityOfPage: d.mainEntityOfPage }),
        ...(d.brand != null && { brand: d.brand }),
        ...(d.knowsAbout != null && { knowsAbout: d.knowsAbout }),
        ...(d.knowsLanguage != null && { knowsLanguage: d.knowsLanguage }),
        ...(hasOfferCatalog != null &&
          typeof hasOfferCatalog === 'object' &&
          hasOfferCatalog.name != null &&
          Array.isArray(hasOfferCatalog.itemListElement) && {
            hasOfferCatalog: {
              '@type': 'OfferCatalog',
              '@id': `${baseUrl}#offer-catalog`,
              name: hasOfferCatalog.name,
              itemListElement: (hasOfferCatalog.itemListElement as Record<string, unknown>[]).map(
                (item) => ({
                  '@type': 'Offer',
                  itemOffered: { '@type': 'Service', ...item },
                })
              ),
            },
          }),
      };
    }

    case 'website': {
      const d = data as Record<string, unknown>;
      return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        ...(d.name != null && { name: d.name }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.description != null && { description: d.description }),
        ...(d.inLanguage != null && { inLanguage: d.inLanguage }),
        ...(d.publisher != null && {
          publisher:
            typeof d.publisher === 'object' && d.publisher !== null
              ? (() => {
                  const pub = d.publisher as Record<string, unknown>;
                  // Normalize malformed "[@id]" key (JSON typo) to proper "@id"
                  const idValue = pub['[@id]'] ?? pub['@id'];
                  const out: Record<string, unknown> = {
                    '@type': 'Organization',
                    ...pub,
                  };
                  if (idValue != null) {
                    out['@id'] = resolve(String(idValue));
                  }
                  delete out['[@id]'];
                  return out;
                })()
              : d.publisher,
        }),
        ...(d.potentialAction != null && { potentialAction: d.potentialAction }),
      };
    }

    case 'article': {
      const d = data as Record<string, unknown>;
      return {
        '@context': 'https://schema.org',
        '@type': 'Article',
        ...(d.headline != null && { headline: d.headline }),
        ...(d.description != null && { description: d.description }),
        ...(d.image != null && {
          image: Array.isArray(d.image)
            ? (d.image as string[]).map((u) => resolve(String(u)))
            : resolve(String(d.image)),
        }),
        ...(d.author != null && {
          author:
            typeof d.author === 'object' && d.author !== null
              ? { '@type': 'Person', ...(d.author as Record<string, unknown>) }
              : d.author,
        }),
        ...(d.publisher != null && {
          publisher:
            typeof d.publisher === 'object' && d.publisher !== null
              ? { '@type': 'Organization', ...(d.publisher as Record<string, unknown>) }
              : d.publisher,
        }),
        ...(d.datePublished != null && { datePublished: d.datePublished }),
        ...(d.dateModified != null && { dateModified: d.dateModified }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
      };
    }

    case 'donation': {
      const d = data as Record<string, unknown>;
      return {
        '@context': 'https://schema.org',
        '@type': 'DonateAction',
        ...(d.name != null && { name: d.name }),
        ...(d.description != null && { description: d.description }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.recipient != null && {
          recipient:
            typeof d.recipient === 'object' && d.recipient !== null
              ? { '@type': 'Organization', ...(d.recipient as Record<string, unknown>) }
              : d.recipient,
        }),
        ...(d.amount != null && { amount: d.amount }),
      };
    }

    case 'faq': {
      const d = data as Record<string, unknown>;
      const items = Array.isArray(d.items) ? d.items : [];
      return {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.name != null && { name: d.name }),
        mainEntity: items.map((item: unknown) => {
          const i = item as Record<string, unknown>;
          return {
            '@type': 'Question',
            name: i.question ?? '',
            acceptedAnswer: {
              '@type': 'Answer',
              text: i.answer ?? '',
            },
          };
        }),
      };
    }

    case 'faqPage': {
      const d = data as Record<string, unknown>;
      const entities = Array.isArray(d.mainEntity) ? d.mainEntity : [];
      return {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.name != null && { name: d.name }),
        mainEntity: entities.map((item: unknown) => {
          const i = item as Record<string, unknown>;
          return {
            '@type': 'Question',
            name: i.question ?? '',
            acceptedAnswer: {
              '@type': 'Answer',
              text: i.answer ?? '',
            },
          };
        }),
      };
    }

    case 'course': {
      const d = data as Record<string, unknown>;
      return {
        '@context': 'https://schema.org',
        '@type': 'Course',
        ...(d.name != null && { name: d.name }),
        ...(d.description != null && { description: d.description }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.provider != null && {
          provider:
            typeof d.provider === 'object' && d.provider !== null
              ? { '@type': 'Organization', ...(d.provider as Record<string, unknown>) }
              : d.provider,
        }),
        ...(d.offers != null && { offers: d.offers }),
        ...(d.hasCourseInstance != null && { hasCourseInstance: d.hasCourseInstance }),
        ...(d.learningResourceType != null && { learningResourceType: d.learningResourceType }),
      };
    }

    case 'learningResource': {
      const d = data as Record<string, unknown>;
      return {
        '@context': 'https://schema.org',
        '@type': 'LearningResource',
        ...(d.name != null && { name: d.name }),
        ...(d.description != null && { description: d.description }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.learningResourceType != null && { learningResourceType: d.learningResourceType }),
        ...(d.author != null && {
          author:
            typeof d.author === 'object' && d.author !== null
              ? { '@type': 'Person', ...(d.author as Record<string, unknown>) }
              : d.author,
        }),
        ...(d.educationalLevel != null && { educationalLevel: d.educationalLevel }),
        ...(d.inLanguage != null && { inLanguage: d.inLanguage }),
      };
    }

    case 'breadcrumb': {
      const d = data as Record<string, unknown>;
      const items = Array.isArray(d.itemListElement) ? d.itemListElement : [];
      return {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((item: unknown, index: number) => {
          const i = item as Record<string, unknown>;
          return {
            '@type': 'ListItem',
            position: index + 1,
            name: i.name ?? '',
            ...(i.item != null && { item: resolve(String(i.item)) }),
          };
        }),
      };
    }

    case 'product': {
      const d = data as Record<string, unknown>;
      const offers = d.offers as Record<string, unknown> | undefined;
      return {
        '@context': 'https://schema.org',
        '@type': 'Product',
        ...(d.name != null && { name: d.name }),
        ...(d.description != null && { description: d.description }),
        ...(d.image != null && {
          image: Array.isArray(d.image)
            ? (d.image as string[]).map((u) => resolve(String(u)))
            : resolve(String(d.image)),
        }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.category != null && { category: d.category }),
        ...(d.sku != null && { sku: d.sku }),
        ...(d.identifier != null && { identifier: d.identifier }),
        ...(d.brand != null && {
          brand:
            typeof d.brand === 'object' && d.brand !== null
              ? { '@type': 'Organization', ...(d.brand as Record<string, unknown>) }
              : d.brand,
        }),
        ...(offers != null &&
          typeof offers === 'object' && {
            offers: {
              '@type': 'Offer',
              ...(offers.price != null && { price: offers.price }),
              ...(offers.priceCurrency != null && { priceCurrency: offers.priceCurrency }),
              ...(offers.availability != null && { availability: offers.availability }),
              ...(offers.url != null && { url: resolve(String(offers.url)) }),
              ...(offers.priceValidUntil != null && { priceValidUntil: offers.priceValidUntil }),
              ...(offers.seller != null &&
                typeof offers.seller === 'object' &&
                offers.seller !== null && {
                  seller: { '@type': 'Organization', ...(offers.seller as Record<string, unknown>) },
                }),
            },
          }),
      };
    }

    case 'person': {
      const d = data as Record<string, unknown>;
      return {
        '@context': 'https://schema.org',
        '@type': 'Person',
        ...(d['@id'] != null && { '@id': typeof d['@id'] === 'string' ? resolve(d['@id']) : d['@id'] }),
        ...(d.name != null && { name: d.name }),
        ...(d.givenName != null && { givenName: d.givenName }),
        ...(d.familyName != null && { familyName: d.familyName }),
        ...(d.additionalName != null && { additionalName: d.additionalName }),
        ...(d.alternateName != null && { alternateName: d.alternateName }),
        ...(d.description != null && { description: d.description }),
        ...(d.image != null && {
          image: Array.isArray(d.image)
            ? (d.image as string[]).map((u) => resolve(String(u)))
            : resolve(String(d.image)),
        }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.jobTitle != null && { jobTitle: d.jobTitle }),
        ...(d.email != null && { email: d.email }),
        ...(d.telephone != null && { telephone: d.telephone }),
        ...(d.address != null && { address: d.address }),
        ...(d.sameAs != null &&
          Array.isArray(d.sameAs) &&
          resolveSameAs(d.sameAs as string[]).length > 0 && {
            sameAs: resolveSameAs(d.sameAs as string[]),
          }),
        ...(d.birthDate != null && { birthDate: d.birthDate }),
        ...(d.deathDate != null && { deathDate: d.deathDate }),
        ...(d.worksFor != null &&
          typeof d.worksFor === 'object' &&
          d.worksFor !== null && {
            worksFor: { '@type': 'Organization', ...(d.worksFor as Record<string, unknown>) },
          }),
      };
    }

    case 'place': {
      const d = data as Record<string, unknown>;
      const geo = d.geo as Record<string, unknown> | undefined;
      return {
        '@context': 'https://schema.org',
        '@type': 'Place',
        ...(d['@id'] != null && { '@id': typeof d['@id'] === 'string' ? resolve(d['@id']) : d['@id'] }),
        ...(d.name != null && { name: d.name }),
        ...(d.alternateName != null && { alternateName: d.alternateName }),
        ...(d.description != null && { description: d.description }),
        ...(d.image != null && {
          image: Array.isArray(d.image)
            ? (d.image as string[]).map((u) => resolve(String(u)))
            : resolve(String(d.image)),
        }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.address != null && { address: d.address }),
        ...(d.telephone != null && { telephone: d.telephone }),
        ...(d.sameAs != null &&
          Array.isArray(d.sameAs) &&
          resolveSameAs(d.sameAs as string[]).length > 0 && {
            sameAs: resolveSameAs(d.sameAs as string[]),
          }),
        ...(d.openingHoursSpecification != null && { openingHoursSpecification: d.openingHoursSpecification }),
        ...(geo != null &&
          typeof geo === 'object' && {
            geo: {
              '@type': 'GeoCoordinates',
              ...(geo.latitude != null && { latitude: geo.latitude }),
              ...(geo.longitude != null && { longitude: geo.longitude }),
            },
          }),
      };
    }

    case 'localBusiness': {
      const d = data as Record<string, unknown>;
      const geo = d.geo as Record<string, unknown> | undefined;
      const openingHoursSpec = d.openingHoursSpecification;
      // Support specific LocalBusiness subtypes (IceCreamShop, Restaurant, etc.) via @type in data
      const businessType = typeof d['@type'] === 'string' ? d['@type'] : 'LocalBusiness';
      return {
        '@context': 'https://schema.org',
        '@type': businessType,
        ...(d['@id'] != null && { '@id': resolve(String(d['@id'])) }),
        ...(d.name != null && { name: d.name }),
        ...(d.description != null && { description: d.description }),
        ...(d.url != null && { url: resolve(String(d.url)) }),
        ...(d.telephone != null && { telephone: d.telephone }),
        ...(d.email != null && { email: d.email }),
        ...(d.priceRange != null && { priceRange: d.priceRange }),
        ...(d.servesCuisine != null && { servesCuisine: d.servesCuisine }),
        ...(d.menu != null && { menu: resolve(String(d.menu)) }),
        ...(d.image != null && {
          image: Array.isArray(d.image)
            ? (d.image as string[]).map((u) => resolve(String(u)))
            : resolve(String(d.image)),
        }),
        ...(d.logo != null && { logo: resolve(String(d.logo)) }),
        ...(d.address != null && {
          address: typeof d.address === 'object' && d.address !== null
            ? { '@type': 'PostalAddress', ...(d.address as Record<string, unknown>) }
            : d.address,
        }),
        ...(geo != null && typeof geo === 'object' && {
          geo: {
            '@type': 'GeoCoordinates',
            ...(geo.latitude != null && { latitude: geo.latitude }),
            ...(geo.longitude != null && { longitude: geo.longitude }),
          },
        }),
        ...(openingHoursSpec != null && { openingHoursSpecification: openingHoursSpec }),
        ...(d.aggregateRating != null && { aggregateRating: d.aggregateRating }),
        ...(d.hasMap != null && { hasMap: d.hasMap }),
        ...(d.sameAs != null &&
          Array.isArray(d.sameAs) &&
          resolveSameAs(d.sameAs as string[]).length > 0 && {
            sameAs: resolveSameAs(d.sameAs as string[]),
          }),
      };
    }

    default: {
      const type = schemaType as string;
      return {
        '@context': 'https://schema.org',
        '@type': type.charAt(0).toUpperCase() + type.slice(1),
        ...data,
      };
    }
  }
}

/**
 * Build JSON-LD for multiple schema components (e.g. from page JSON).
 */
export function buildSchemaJsonLdMultiple(
  components: SchemaComponent[],
  options?: { siteUrl?: string }
): Array<Record<string, unknown>> {
  return components
    .filter((c): c is SchemaComponent => !!c.schemaType && !!c.data)
    .map((c) => buildSchemaJsonLd(c.schemaType as SchemaOrgType, c.data, options));
}

/**
 * Get the data object of the first schema component with the given schemaType.
 * Useful when code needs organization (or other) data from metadata.schema.
 */
export function getSchemaData(
  schemas: Array<{ id?: string; schemaType?: string; data?: Record<string, unknown> }> | null | undefined,
  schemaType: string
): Record<string, unknown> | undefined {
  if (!Array.isArray(schemas)) return undefined;
  const entry = schemas.find(
    (s) => String(s?.schemaType).toLowerCase() === schemaType.toLowerCase() && s?.data
  );
  return entry?.data as Record<string, unknown> | undefined;
}
