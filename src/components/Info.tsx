import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { Leaf, Heart, Users, Sun, Sprout, Utensils } from 'lucide-react';
import { t } from '@/lib/page-data';
import { DEFAULT_LANGUAGE } from '@/lib/language';
import { LucideIcon } from './LucideIcon';
import { Heading } from './Heading';
import { ResponsiveImage } from '@/components/ResponsiveImage';

interface InfoComponentProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  srcPath?: SrcPathFn;
}

export const Info = ({
  pageData,
  language = DEFAULT_LANGUAGE,
  srcPath,
}: InfoComponentProps) => {
  const tr = pageData ?? language;
  const { info, business } = pageData;
  const {
    description,
    textHeading,
    paragraph1,
    paragraph2,
    quote,
    imageUrl,
    imageAlt,
    activities,
    nutrition,
    garden,
    values,
    valueIcons = {},
  } = info;

  return (
    <section id="info" className="py-14 md:py-20 bg-white scroll-mt-[92px]">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <Heading
            level={2}
            className="text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('info.sectionTitle'),
            })}
          >
            {t('info.sectionTitle', tr, {
              name: business.name,
              location: business.location.city,
            })}
          </Heading>
          <p
            className="text-lg text-foreground max-w-3xl mx-auto"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('info.description'),
            })}
          >
            {description}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-stretch mb-16">
          <div className="flex flex-col">
            {textHeading && (
              <p
                className="text-2xl md:text-3xl font-bold text-heading-foreground mb-6 font-heading"
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('info.textHeading'),
                })}
              >
                {textHeading}
              </p>
            )}
            <p
              className="text-lg text-foreground mb-6"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.paragraph1'),
              })}
            >
              {paragraph1}
            </p>
            <p
              className="text-lg text-foreground mb-6"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.paragraph2'),
              })}
            >
              {paragraph2}
            </p>
            {quote && quote.trim().length > 0 && (
              <div className="bg-muted rounded-2xl p-6 mt-auto">
                <blockquote
                  className="text-lg text-foreground italic leading-relaxed"
                  {...(srcPath && {
                    'data-hero-factory-src-path': srcPath('info.quote'),
                  })}
                >
                  "{quote}"
                </blockquote>
              </div>
            )}
          </div>

          <figure className="relative h-full">
            <ResponsiveImage
              preset="info"
              src={imageUrl}
              alt={imageAlt}
              width="600"
              height="400"
              className="w-full h-64 md:h-80 lg:h-full min-h-[320px] object-cover rounded-2xl shadow-lg"
              loading="lazy"
              role="img"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.imageUrl'),
              })}
            />
            <figcaption className="sr-only">{imageAlt}</figcaption>
          </figure>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
          <div className="rounded-2xl bg-primary/20 p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary">
              <LucideIcon
                name={activities.icon}
                fallback={Leaf}
                className="h-8 w-8 text-primary-foreground"
                aria-hidden="true"
              />
            </div>
            <p
              className="text-2xl font-bold text-heading-foreground mb-4 font-heading hyphens-auto break-words"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.activities.title'),
              })}
            >
              {activities.title}
            </p>
            <p
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  'info.activities.description'
                ),
              })}
            >
              {activities.description}
            </p>
          </div>

          <div className="rounded-2xl bg-secondary/20 p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
              <LucideIcon
                name={nutrition.icon}
                fallback={Utensils}
                className="h-8 w-8 text-secondary-foreground"
                aria-hidden="true"
              />
            </div>
            <p
              className="text-2xl font-bold text-heading-foreground mb-4 font-heading hyphens-auto break-words"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.nutrition.title'),
              })}
            >
              {nutrition.title}
            </p>
            <p
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  'info.nutrition.description'
                ),
              })}
            >
              {nutrition.description}
            </p>
          </div>

          <div className="rounded-2xl bg-accent/20 p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-accent">
              <LucideIcon
                name={garden.icon}
                fallback={Sprout}
                className="h-8 w-8 text-accent-foreground"
                aria-hidden="true"
              />
            </div>
            <p
              className="text-2xl font-bold text-heading-foreground mb-4 font-heading hyphens-auto break-words"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.garden.title'),
              })}
            >
              {garden.title}
            </p>
            <p
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  'info.garden.description'
                ),
              })}
            >
              {garden.description}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <LucideIcon
                name={valueIcons.mindfulness}
                fallback={Heart}
                className="h-8 w-8 text-foreground"
                aria-hidden="true"
              />
            </div>
            <p
              className="text-xl font-bold text-heading-foreground mb-2"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.mindfulness'),
              })}
            >
              {t('info.mindfulness', tr)}
            </p>
            <p
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  'info.values.mindfulness'
                ),
              })}
            >
              {values.mindfulness}
            </p>
          </div>

          <div className="text-center">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <LucideIcon
                name={valueIcons.nature}
                fallback={Sun}
                className="h-8 w-8 text-foreground"
                aria-hidden="true"
              />
            </div>
            <p
              className="text-xl font-bold text-heading-foreground mb-2"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.nature'),
              })}
            >
              {t('info.nature', tr)}
            </p>
            <p
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.values.nature'),
              })}
            >
              {values.nature}
            </p>
          </div>

          <div className="text-center">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <LucideIcon
                name={valueIcons.participation}
                fallback={Users}
                className="h-8 w-8 text-foreground"
                aria-hidden="true"
              />
            </div>
            <p
              className="text-xl font-bold text-heading-foreground mb-2"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('info.participation'),
              })}
            >
              {t('info.participation', tr)}
            </p>
            <p
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  'info.values.participation'
                ),
              })}
            >
              {values.participation}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
