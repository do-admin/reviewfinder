import { MapPin, Phone, Mail, Clock, Facebook, Instagram } from 'lucide-react';
import { Heading } from '@/components/Heading';
import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { TrustBlock } from './TrustBlock';
import { Word } from './Word';
import { createSrcPath, t } from '@/lib/page-data';
import { DEFAULT_LANGUAGE, withLang } from '@/lib/language';
import { getLocalizedPath } from '@/lib/route-slugs';
import { getDisplayAddress, formatPhoneForDisplay } from '@/lib/business';
import { footerContactLinkDisplayLabel } from '@/lib/footer-contact-display-label';

/** True for http(s):// links — opens in new tab. Accepts unknown for resilience against malformed JSON data. */
function isExternalUrl(href: unknown): boolean {
  if (typeof href !== 'string') return false;
  return /^https?:\/\//i.test(href.trim());
}

interface FooterProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  srcPath?: SrcPathFn;
}

interface FooterLink {
  link: string;
  linkLabel: string;
}

interface FooterLinkSection {
  label: string;
  links: FooterLink[];
}

export const Footer = ({
  pageData,
  language = DEFAULT_LANGUAGE,
  srcPath,
}: FooterProps) => {
  const tr = pageData;
  const { business, footer } = pageData;
  const { phone, email } = business;
  const { address, srcRoot: addressSrcRoot } = getDisplayAddress(business);

  /** Footer map-pin headline: operating address city only (`business.locationAddress`). */
  const locationHeadline = address.city.trim();
  const locationHeadlineSrcPath = `${addressSrcRoot}.city`;

  const navSection = footer?.navigation as FooterLinkSection | undefined;
  const contactSection = footer?.contact as FooterLinkSection | undefined;

  const navLinks = navSection?.links ?? [];
  const contactLinks = contactSection?.links ?? [];

  // Optional per-site override; falls back to brand name.
  const footerHeadingRaw = (footer as Record<string, unknown> | undefined)
    ?.locationName;
  const footerHeading =
    typeof footerHeadingRaw === 'string' && footerHeadingRaw.trim().length > 0
      ? footerHeadingRaw.trim()
      : business.brandName;
  const footerHeadingSrcPath = srcPath?.(
    typeof footerHeadingRaw === 'string' && footerHeadingRaw.trim().length > 0
      ? 'footer.locationName'
      : 'business.brandName'
  );

  const hasSocials =
    !!business.social?.facebook || !!business.social?.instagram;

  const navLabel = navSection?.label ?? t('footer.navigation', tr);
  const contactLabel = contactSection?.label ?? t('footer.contact', tr);
  const footerAny = footer as Record<string, unknown> | undefined;
  const socialsLabel =
    (footerAny?.followUs as string | undefined) ??
    ((footerAny?.socials as Record<string, unknown> | undefined)?.label as
      | string
      | undefined) ??
    t('footer.followUs', tr);

  // const j = createSrcPath(0, 0, DEFAULT_LANGUAGE);
  // const footerLocationNameSrcPath = j('footer.locationName');
  // console.log(footerLocationNameSrcPath);

  //sections/hero.json#badgeRating
  //data/current/websites.json#0.footer.locationName
  return (
    <>
      <footer className="bg-primary text-primary-foreground pt-16 pb-10">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
            <div>
              <Heading
                level={3}
                className="mb-3 mt-0 text-2xl font-bold font-heading text-white"
              >
                {/* <Word
                  className="text-2xl font-bold mb-4 font-heading"
                  sourceDataPath={j('footer.locationName')}
                  text={footerHeading}
                /> */}
                <Word
                  as="div"
                  className="font-semibold"
                  dataHeroFactorySrcPath={footerHeadingSrcPath}
                >
                  {footerHeading}
                </Word>
              </Heading>

              <div className="space-y-3 text-sm">
                <div className="flex items-start space-x-3">
                  <MapPin className="h-4 w-4 mt-1 flex-shrink-0" />
                  <div>
                    <Word
                      as="div"
                      className="font-semibold"
                      dataHeroFactorySrcPath={srcPath?.(
                        locationHeadlineSrcPath
                      )}
                    >
                      {locationHeadline}
                    </Word>
                    <Word
                      as="div"
                      dataHeroFactorySrcPath={srcPath?.(
                        `${addressSrcRoot}.street`
                      )}
                    >
                      {address.street}
                    </Word>
                    <div>
                      <Word
                        as="span"
                        dataHeroFactorySrcPath={srcPath?.(
                          `${addressSrcRoot}.postalCode`
                        )}
                      >
                        {address.postalCode}
                      </Word>{' '}
                      <Word
                        as="span"
                        dataHeroFactorySrcPath={srcPath?.(
                          `${addressSrcRoot}.city`
                        )}
                      >
                        {address.city}
                      </Word>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <Word
                as="p"
                className="text-xl font-bold mb-4 font-heading"
                dataHeroFactorySrcPath={srcPath?.('footer.contact.label')}
              >
                {contactLabel}
              </Word>
              <div className="space-y-3 text-sm">
                {contactLinks.length > 0 ? (
                  contactLinks.map((item, i) => {
                    const contactDisplayLabel = footerContactLinkDisplayLabel(
                      item.link,
                      item.linkLabel
                    );
                    return (
                      <a
                        key={i}
                        href={withLang(item.link, language)}
                        className="flex items-center space-x-3 hover:opacity-70 transition-opacity"
                        aria-label={contactDisplayLabel}
                      >
                        {item.link.startsWith('tel:') ? (
                          <Phone
                            className="h-4 w-4 flex-shrink-0"
                            aria-hidden="true"
                          />
                        ) : item.link.startsWith('mailto:') ? (
                          <Mail
                            className="h-4 w-4 flex-shrink-0"
                            aria-hidden="true"
                          />
                        ) : null}
                        <span>{contactDisplayLabel}</span>
                      </a>
                    );
                  })
                ) : (
                  <>
                    <a
                      href={`tel:${phone.replace(/\D+/g, '')}`}
                      className="flex items-center space-x-3 hover:opacity-70 transition-opacity"
                    >
                      <Phone
                        className="h-4 w-4 flex-shrink-0"
                        aria-hidden="true"
                      />
                      <span>{formatPhoneForDisplay(phone)}</span>
                    </a>
                    <a
                      href={`mailto:${email}`}
                      className="flex items-center space-x-3 hover:opacity-70 transition-opacity"
                    >
                      <Mail
                        className="h-4 w-4 flex-shrink-0"
                        aria-hidden="true"
                      />
                      <span>{email}</span>
                    </a>
                  </>
                )}
              </div>
            </div>

            <div>
              <Word
                as="p"
                className="text-xl font-bold mb-4 font-heading"
                dataHeroFactorySrcPath={srcPath?.('footer.navigation.label')}
              >
                {navLabel}
              </Word>
              <div className="space-y-2 text-sm">
                {navLinks.length > 0 ? (
                  navLinks.map((item, i) => {
                    const external = isExternalUrl(item.link);
                    return (
                      <a
                        key={i}
                        href={
                          external ? item.link : withLang(item.link, language)
                        }
                        className="block hover:opacity-70 transition-opacity"
                        aria-label={item.linkLabel}
                        {...(external && {
                          target: '_blank',
                          rel: 'noopener noreferrer',
                        })}
                      >
                        {item.linkLabel}
                      </a>
                    );
                  })
                ) : (
                  <>
                    <a
                      href={withLang(t('footer.careerUrl', tr), language)}
                      className="block hover:opacity-70 transition-opacity"
                    >
                      {t('footer.career', tr)}
                    </a>
                    <a
                      href={withLang(t('footer.blogUrl', tr), language)}
                      className="block hover:opacity-70 transition-opacity"
                    >
                      {t('footer.blog', tr)}
                    </a>
                  </>
                )}
              </div>
            </div>

            <div>
              <Word
                as="p"
                className="text-xl font-bold mb-4 font-heading"
                dataHeroFactorySrcPath={srcPath?.('footer.openingHoursLabel')}
              >
                {t('footer.openingHoursLabel', tr)}
              </Word>
              <div className="space-y-2 text-sm mb-6">
                <div className="flex items-center space-x-3">
                  <Clock className="h-4 w-4 flex-shrink-0" />
                  <Word
                    as="span"
                    dataHeroFactorySrcPath={srcPath?.(
                      'business.openingHours.display'
                    )}
                  >
                    {business.openingHours.display}
                  </Word>
                </div>
              </div>

              {hasSocials && (
                <>
                  <Word className="font-bold mb-2">{socialsLabel}</Word>
                  <div className="flex space-x-4">
                    {business.social?.facebook && (
                      <a
                        href={business.social.facebook}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center hover:bg-white/30 transition-colors"
                        aria-label={t(
                          'footer.facebookAria',
                          tr,
                          undefined,
                          'Facebook'
                        )}
                      >
                        <Facebook className="h-5 w-5" aria-hidden="true" />
                      </a>
                    )}
                    {business.social?.instagram && (
                      <a
                        href={business.social.instagram}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center hover:bg-white/30 transition-colors"
                        aria-label={t(
                          'footer.instagramAria',
                          tr,
                          undefined,
                          'Instagram'
                        )}
                      >
                        <Instagram className="h-5 w-5" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="border-t border-white/20 pt-8">
            <div className="flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
              <div className="flex flex-wrap justify-center md:justify-start space-x-6 text-sm">
                <Word
                  as="a"
                  href={getLocalizedPath('impressum', language)}
                  className="hover:opacity-70 transition-opacity"
                  dataHeroFactorySrcPath={srcPath?.('footer.imprint')}
                >
                  {t('footer.imprint', tr)}
                </Word>
                <Word
                  as="a"
                  href={getLocalizedPath('datenschutz', language)}
                  className="hover:opacity-70 transition-opacity"
                  dataHeroFactorySrcPath={srcPath?.('footer.privacy')}
                >
                  {t('footer.privacy', tr)}
                </Word>
                <Word
                  as="a"
                  href={getLocalizedPath('grounding', language)}
                  className="hover:opacity-70 transition-opacity"
                  dataHeroFactorySrcPath={srcPath?.('footer.grounding')}
                >
                  {t('footer.grounding', tr)}
                </Word>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
};
