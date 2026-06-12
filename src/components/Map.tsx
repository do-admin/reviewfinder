import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { MapPin, Bus, Car, ExternalLink } from 'lucide-react';
import { t } from '@/lib/page-data';
import { DEFAULT_LANGUAGE } from '@/lib/language';
import { Heading } from '@/components/Heading';
import { getDisplayAddress } from '@/lib/business';

const MAP_CONSENT_FALLBACKS: Record<SupportedLanguage, {
  title: string;
  description: string;
  button: string;
}> = {
  de: {
    title: 'Karte aktivieren',
    description:
      'Beim Laden der Karte werden Daten an Google übertragen. Klicke auf "Karte laden", um die interaktive Karte anzuzeigen.',
    button: 'Karte laden',
  },
  en: {
    title: 'Activate map',
    description:
      'Loading the map will share data with Google. Click "Load map" to display the interactive map.',
    button: 'Load map',
  },
};

function getConsentFallback(language: SupportedLanguage) {
  return (
    MAP_CONSENT_FALLBACKS[language] ?? MAP_CONSENT_FALLBACKS[DEFAULT_LANGUAGE]
  );
}

interface MapComponentProps {
  pageData: ResolvedPageData;
  isSeparatePage: boolean;
  language?: SupportedLanguage;
  srcPath?: SrcPathFn;
}

export const MapSection = ({
  pageData,
  isSeparatePage,
  language = DEFAULT_LANGUAGE,
  srcPath,
}: MapComponentProps) => {
  const tr = pageData ?? language;
  const { map, business, reviews } = pageData;
  const { location } = business;
  const { address, srcRoot: addressSrcRoot } = getDisplayAddress(business);
  const name = business.name;

  const googlePlacesId =
    business.googlePlacesId?.trim() ||
    (
      reviews as { googlePlacesId?: string } | undefined
    )?.googlePlacesId?.trim();
  const embedApiKey =
    typeof import.meta.env.PUBLIC_GOOGLE_MAPS_EMBED_API_KEY === 'string'
      ? import.meta.env.PUBLIC_GOOGLE_MAPS_EMBED_API_KEY.trim()
      : '';

  const mapEmbedSrc =
    googlePlacesId && embedApiKey
      ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(embedApiKey)}&q=${encodeURIComponent(`place_id:${googlePlacesId}`)}`
      : (map.mapEmbedUrl?.trim() ?? '');

  return (
    <section id="map" className="py-14 md:py-20 bg-white scroll-mt-[92px]">
      <div className="container mx-auto px-4">
        <div
          id="hier-findest-du-uns"
          className="text-center mb-12 scroll-mt-[92px]"
        >
          {isSeparatePage ? (
            <Heading
              level={1}
              className="mt-0 text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('map.sectionTitle'),
              })}
            >
              {t('map.sectionTitle', tr, { name })} {address.city}
            </Heading>
          ) : (
            <Heading
              level={2}
              className="mt-0 text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('map.sectionTitle'),
              })}
            >
              {t('map.sectionTitle', tr, { location: name })}
            </Heading>
          )}
          <p
            className="text-lg text-foreground max-w-3xl mx-auto whitespace-pre-line"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('map.description'),
            })}
          >
            {map.description}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">
          <div>
            <div className="bg-muted rounded-2xl p-8 h-full">
              <div className="flex items-start space-x-4 mb-6">
                <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                  <MapPin className="h-6 w-6 text-white" />
                </div>
                <div>
                  <p
                    className="text-xl font-bold text-heading-foreground mb-2 mt-0"
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath('map.addressTitle'),
                    })}
                  >
                    {business.name} - {t('map.addressTitle', tr)}
                  </p>
                  <p className="text-foreground text-sm">
                    <span
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(`business.name`),
                      })}
                    >
                      {business.name} -{' '}
                      {t('business.location.neighborhood', tr)}
                    </span>
                    <br />
                    <span
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          `${addressSrcRoot}.street`
                        ),
                      })}
                    >
                      {address.street}
                    </span>
                    <br />
                    <span
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          `${addressSrcRoot}.postalCode`
                        ),
                      })}
                    >
                      {address.postalCode} {address.city}
                    </span>
                    <br />
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-4 mb-6">
                <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                  <Bus className="h-6 w-6 text-white" />
                </div>
                <div>
                  <p
                    className="text-xl font-heading font-bold text-heading-foreground mb-2"
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath(
                        'map.publicTransportLabel'
                      ),
                    })}
                  >
                    {t('map.publicTransportLabel', tr)}
                  </p>
                  <p
                    className="text-foreground text-sm"
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath(
                        'map.publicTransport'
                      ),
                    })}
                  >
                    {map.publicTransport}
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-4 mb-6">
                <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                  <Car className="h-6 w-6 text-white" />
                </div>
                <div>
                  <p
                    className="text-xl font-heading font-bold text-heading-foreground mb-2"
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath('map.parkingLabel'),
                    })}
                  >
                    {t('map.parkingLabel', tr)}
                  </p>
                  <p
                    className="text-foreground text-sm"
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath('map.parking'),
                    })}
                  >
                    {map.parking}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="bg-gray-100 rounded-2xl overflow-hidden shadow-lg h-96 lg:h-full min-h-[400px]">
              {mapEmbedSrc ? (
                <>
                  <MapConsentPlaceholder
                    iframeSrc={mapEmbedSrc}
                    iframeTitle={t('map.iframeTitle', tr, { name })}
                    iframeSrcPath={
                      srcPath
                        ? googlePlacesId
                          ? srcPath('business.googlePlacesId')
                          : srcPath('map.mapEmbedUrl')
                        : undefined
                    }
                    language={language}
                    pageData={pageData}
                    address={[address.street, address.postalCode, address.city]
                      .filter(Boolean)
                      .join(', ')}
                      businessName={business.name}
                    openOnMapLabel={t('map.openOnMap', tr)}
                  />
                </>
              ) : (
                <div
                  className="flex h-full min-h-[400px] items-center justify-center px-4 text-center text-sm text-muted-foreground"
                  role="status"
                >
                  Karte nicht verfügbar.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

interface MapConsentPlaceholderProps {
  iframeSrc: string;
  iframeTitle: string;
  iframeSrcPath?: string;
  language: SupportedLanguage;
  pageData: ResolvedPageData;
  address: string;
  openOnMapLabel: string;
  businessName: string;
}

/**
 * Renders a click-to-load placeholder that gets replaced with the actual
 * Google Maps `<iframe>` by `/scripts/google-map-consent.js` once the user
 * accepts (either via the cookie banner or the inline button). No request to
 * Google is made on initial page load — DSGVO-konform.
 */
function MapConsentPlaceholder({
  iframeSrc,
  iframeTitle,
  iframeSrcPath,
  language,
  pageData,
  address,
  businessName,
  openOnMapLabel,
}: MapConsentPlaceholderProps) {

  const fallback = getConsentFallback(language);
  const consentTitle = t(
    'map.consentTitle',
    pageData,
    undefined,
    fallback.title
  );
  const consentDescription = t(
    'map.consentDescription',
    pageData,
    undefined,
    fallback.description
  );
  const consentButton = t(
    'map.consentButton',
    pageData,
    undefined,
    fallback.button
  );

  const externalMapUrl = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(businessName + ' ' + address)}`
    : undefined;

  return (
    <div
      data-google-map-consent
      data-iframe-src={iframeSrc}
      data-iframe-title={iframeTitle}
      {...(iframeSrcPath ? { 'data-iframe-src-path': iframeSrcPath } : {})}
      className="relative h-full w-full"
    >
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-gray-100 px-6 py-8 text-center">
        <MapPin className="h-10 w-10 text-primary" aria-hidden="true" />
        <Heading
          level={3}
          className="mt-0 mb-0 text-xl font-bold text-heading-foreground"
        >
          {consentTitle}
        </Heading>
        <p className="max-w-md text-sm leading-relaxed text-foreground">
          {consentDescription}
        </p>
        <button
          type="button"
          data-google-map-consent-accept
          className="cursor-pointer inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground ring-offset-background transition-all duration-200 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.97]"
        >
          {consentButton}
        </button>
        {externalMapUrl ? (
          <a
            href={externalMapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-4 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {openOnMapLabel}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </div>
  );
}
