import { Button } from '@/components/ui/button';
import { MapPin, Clock, Users, Phone, Mail, Calendar } from 'lucide-react';
import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { t } from '@/lib/page-data';
import { DEFAULT_LANGUAGE } from '@/lib/language';
import { Heading } from '@/components/Heading';
import { getDisplayAddress, formatPhoneForDisplay } from '@/lib/business';

interface ContactComponentProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  srcPath?: SrcPathFn;
}

export const Contact = ({
  pageData,
  language = DEFAULT_LANGUAGE,
  srcPath,
}: ContactComponentProps) => {
  const tr = pageData ?? language;
  const { business } = pageData;
  const { phone, email, openingHours, bookingUrl } = business;
  const { address, srcRoot: addressSrcRoot } = getDisplayAddress(business);
  const name = business.name;
  const mailFallbackHref =
    typeof email === 'string' && email.trim().length > 0
      ? `mailto:${email.trim()}`
      : '';
  const telFallbackHref =
    typeof phone === 'string' && phone.trim().length > 0
      ? `tel:${phone.replace(/\s+/g, '')}`
      : '';
  const resolvedBookingHref =
    (bookingUrl?.trim() ?? '') || mailFallbackHref || telFallbackHref;
  const bookingIsExternal =
    resolvedBookingHref.startsWith('http://') ||
    resolvedBookingHref.startsWith('https://');

  return (
    <section id="contact" className="py-14 md:py-20 bg-accent/20 scroll-mt-0">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <Heading
            level={2}
            className="mt-0 text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('contact.bookOnline'),
            })}
          >
            {t('contact.bookOnline', tr)}
          </Heading>
          <p
            className="text-lg text-foreground max-w-3xl mx-auto"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('contact.bookOnlineDesc'),
            })}
          >
            {t('contact.bookOnlineDesc', tr, {
              name,
              location: business.location.city,
            })}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
          <div className="space-y-8">
            <div className="bg-white rounded-2xl p-8 shadow-lg">
              <Heading
                level={3}
                className="text-2xl font-bold text-heading-foreground mb-6 font-heading"
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('contact.infoTitle'),
                })}
              >
                {t('contact.infoTitle', tr)}
              </Heading>

              <div className="space-y-6">
                <div className="flex items-start space-x-4">
                  <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                    <MapPin className="h-6 w-6 text-white" />
                  </div>
                  <div>
                    <p
                      className="font-heading font-bold text-xl text-heading-foreground mb-1"
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          'contact.addressLabel'
                        ),
                      })}
                    >
                      {t('contact.addressLabel', tr)}
                    </p>
                    <p className="text-foreground">
                      <span
                        {...(srcPath && {
                          'data-hero-factory-src-path': srcPath(
                            'contact.addressName'
                          ),
                        })}
                      >
                        {t('contact.addressName', tr, { name })}
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
                    </p>
                  </div>
                </div>

                {/* Anchor target for the Hero opening-hours card. */}
                <div
                  id="opening-hours"
                  className="flex items-start space-x-4 scroll-mt-[92px]"
                >
                  <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                    <Clock className="h-6 w-6 text-white" />
                  </div>
                  <div>
                    <p
                      className="font-heading font-bold text-xl text-heading-foreground mb-1"
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          'contact.openingHoursLabel'
                        ),
                      })}
                    >
                      {t('contact.openingHoursLabel', tr)}
                    </p>
                    <p
                      className="text-foreground whitespace-pre-line"
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          'business.openingHours.detailed'
                        ),
                      })}
                    >
                      {openingHours.detailed}
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-4">
                  <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                    <Users className="h-6 w-6 text-white" />
                  </div>
                  <div>
                    <p
                      className="font-heading font-bold text-xl text-heading-foreground mb-1"
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          'contact.locationLabel'
                        ),
                      })}
                    >
                      {t('contact.locationLabel', tr)}
                    </p>
                    <p
                      className="text-foreground"
                      {...(srcPath && {
                        'data-hero-factory-src-path':
                          srcPath('contact.location'),
                      })}
                    >
                      {t('contact.location', tr)}
                    </p>
                  </div>
                </div>

                {/* Whole row is the tel: link (matches the email row below). */}
                <a
                  href={`tel:${phone.replace(/\s+/g, '')}`}
                  className="flex items-start space-x-4 hover:bg-muted rounded-lg p-2 -m-2 transition-colors"
                  aria-label={formatPhoneForDisplay(phone)}
                >
                  <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                    <Phone className="h-6 w-6 text-white" aria-hidden="true" />
                  </div>
                  <div>
                    <p
                      className="font-heading font-bold text-xl text-heading-foreground mb-1"
                      {...(srcPath && {
                        'data-hero-factory-src-path':
                          srcPath('contact.phoneLabel'),
                      })}
                    >
                      {t('contact.phoneLabel', tr)}
                    </p>
                    <span
                      className="text-primary hover:underline"
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath('business.phone'),
                      })}
                    >
                      {formatPhoneForDisplay(phone)}
                    </span>
                  </div>
                </a>

                <a
                  href={`mailto:${email}`}
                  className="flex items-start space-x-4 hover:bg-muted rounded-lg p-2 -m-2 transition-colors"
                  aria-label={email}
                >
                  <div className="flex-shrink-0 w-12 h-12 bg-primary rounded-full flex items-center justify-center">
                    <Mail className="h-6 w-6 text-white" aria-hidden="true" />
                  </div>
                  <div>
                    <p
                      className="font-heading font-bold text-xl text-heading-foreground mb-1"
                      {...(srcPath && {
                        'data-hero-factory-src-path':
                          srcPath('contact.emailLabel'),
                      })}
                    >
                      {t('contact.emailLabel', tr)}
                    </p>
                    <span
                      className="text-primary hover:underline"
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath('business.email'),
                      })}
                    >
                      {email}
                    </span>
                  </div>
                </a>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl p-8 shadow-lg">
            <p
              className="text-2xl font-bold text-heading-foreground mb-6 font-heading"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('contact.bookingTitle'),
              })}
            >
              {t('contact.bookingTitle', tr, { name })}
            </p>
            <div className="text-center">
              <div className="bg-muted rounded-2xl p-6 mb-6">
                <Calendar className="h-16 w-16 text-primary mx-auto mb-4" />
                <p
                  className="text-foreground"
                  {...(srcPath && {
                    'data-hero-factory-src-path': srcPath(
                      'contact.bookingIntro'
                    ),
                  })}
                >
                  {t('contact.bookingIntro', tr, { name })}
                </p>
              </div>

              {resolvedBookingHref && (
                <Button
                  size="lg"
                  className="bg-primary hover:bg-primary-dark text-primary-foreground px-8 py-4 rounded-full font-semibold text-lg hover-lift w-full"
                  asChild
                >
                  <a
                    href={resolvedBookingHref}
                    {...(bookingIsExternal && {
                      target: '_blank',
                      rel: 'noopener noreferrer',
                    })}
                    className="flex items-center justify-center"
                    aria-label={t('contact.bookingButton', tr)}
                  >
                    <Calendar className="mr-2 h-5 w-5" aria-hidden="true" />
                    <span
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          'contact.bookingButton'
                        ),
                      })}
                    >
                      {t('contact.bookingButton', tr)}
                    </span>
                  </a>
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
