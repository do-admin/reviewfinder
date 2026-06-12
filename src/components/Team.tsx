import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { Phone, Mail, User } from 'lucide-react';
import { useState } from 'react';
import { DEFAULT_LANGUAGE } from '@/lib/language';
import { ResponsiveImage } from '@/components/ResponsiveImage';
import { Heading } from '@/components/Heading';
import { formatPhoneForDisplay } from '@/lib/business';

interface TeamComponentProps {
  pageData: ResolvedPageData;
  isSeparateTeamPage?: boolean;
  language?: SupportedLanguage;
  srcPath?: SrcPathFn;
}

export const Team = ({
  pageData,
  isSeparateTeamPage = false,
  language = DEFAULT_LANGUAGE,
  srcPath,
}: TeamComponentProps) => {
  const [imageError, setImageError] = useState(false);
  const { team, business } = pageData;
  const { contactPerson } = business;

  return (
    <section className="py-14 md:py-20 bg-white scroll-mt-[92px]" id="team">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          {isSeparateTeamPage ? (
            <Heading
              level={1}
              className="mt-0 text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('team.title'),
              })}
            >
              {team.title} in der {business.name}
            </Heading>
          ) : (
            <Heading
              level={2}
              className="mt-0 text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('team.title'),
              })}
            >
              {team.title}
            </Heading>
          )}
          <p
            className="text-lg text-foreground max-w-2xl mx-auto mb-8"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('team.subtitle'),
            })}
          >
            {team.subtitle}
          </p>
        </div>

        {isSeparateTeamPage && team.teamDescription && (
          <div className="max-w-4xl mx-auto mb-16">
            <div className="bg-muted rounded-2xl p-8">
              <div className="prose prose-lg max-w-none text-foreground">
                <div
                  className="text-lg leading-relaxed"
                  {...(srcPath && {
                    'data-hero-factory-src-path': srcPath(
                      'team.teamDescription'
                    ),
                  })}
                >
                  {team.teamDescription}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div className="text-center lg:text-left">
              <div className="relative mb-8 lg:mb-0">
                {!imageError && contactPerson.imageUrl ? (
                  <ResponsiveImage
                    preset="team"
                    src={contactPerson.imageUrl}
                    alt={`${contactPerson.name}, ${contactPerson.title}`}
                    className="w-64 h-64 rounded-full mx-auto lg:mx-0 object-cover shadow-lg"
                    role="img"
                    onError={() => setImageError(true)}
                    loading="lazy"
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath(
                        'business.contactPerson.imageUrl'
                      ),
                    })}
                  />
                ) : (
                  <div className="w-64 h-64 rounded-full mx-auto lg:mx-0 bg-muted flex items-center justify-center shadow-lg">
                    <User className="w-32 h-32 text-foreground opacity-50" />
                  </div>
                )}
              </div>
            </div>

            <div className="text-center lg:text-left">
              <p
                className="text-3xl font-bold text-heading-foreground mb-2 font-heading"
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath(
                    'business.contactPerson.name'
                  ),
                })}
              >
                {contactPerson.name}
              </p>
              <p
                className="text-xl text-primary font-semibold mb-6"
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath(
                    'business.contactPerson.title'
                  ),
                })}
              >
                {contactPerson.title}
              </p>

              <div className="space-y-4 mb-8">
                <a
                  href={`tel:${business.phone}`}
                  className="flex items-center justify-center lg:justify-start space-x-3 text-foreground hover:text-primary transition-colors"
                  aria-label={formatPhoneForDisplay(business.phone)}
                >
                  <Phone className="h-5 w-5" aria-hidden="true" />
                  <span
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath('business.phone'),
                    })}
                  >
                    {formatPhoneForDisplay(business.phone)}
                  </span>
                </a>
                <a
                  href={`mailto:${business.email}`}
                  className="flex items-center justify-center lg:justify-start space-x-3 text-foreground hover:text-primary transition-colors"
                  aria-label={business.email}
                >
                  <Mail className="h-5 w-5" aria-hidden="true" />
                  <span
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath('business.email'),
                    })}
                  >
                    {business.email}
                  </span>
                </a>
              </div>

              <div className="bg-muted rounded-2xl p-6">
                <blockquote
                  className="text-lg text-foreground italic leading-relaxed"
                  {...(srcPath && {
                    'data-hero-factory-src-path': srcPath(
                      'team.teamMember.quote'
                    ),
                  })}
                >
                  "{team.teamMember.quote}"
                </blockquote>
              </div>
            </div>
          </div>
        </div>

        {isSeparateTeamPage && team.meetAndGreet && (
          <div className="max-w-4xl mx-auto mt-16">
            <div className="bg-primary rounded-2xl p-8 text-center">
              <p
                className="text-lg text-white leading-relaxed"
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('team.meetAndGreet'),
                })}
              >
                {team.meetAndGreet}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
