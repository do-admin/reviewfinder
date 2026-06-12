import { ResponsiveImage } from '@/components/ResponsiveImage';
import { Heading } from '@/components/Heading';
import { Button } from '@/components/ui/button';
import { Phone, Mail, Map as MapIcon } from 'lucide-react';
import type { ResolvedPageData, SrcPathFn, HeroButton } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { t } from '@/lib/page-data';
import { DEFAULT_LANGUAGE, withLang } from '@/lib/language';
import { getThemeConfig } from '@/lib/theme';
import { resolveHeroCardIcon } from '@/lib/hero-lucide-icons';

interface HeroComponentProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  srcPath?: SrcPathFn;
}

export const Hero = ({
  pageData,
  language = DEFAULT_LANGUAGE,
  srcPath,
}: HeroComponentProps) => {
  const tr = pageData ?? language;
  const { hero, business } = pageData;

  const hasLine = (s: string | undefined) =>
    s != null && String(s).trim().length > 0;

  const Card1Icon = resolveHeroCardIcon(hero.card1Icon, 0);
  const Card2Icon = resolveHeroCardIcon(hero.card2Icon, 1);
  const Card3Icon = resolveHeroCardIcon(hero.card3Icon, 2);

  const showCard1 = hasLine(hero.card1Line1) || hasLine(hero.card1Line2);
  const showCard2 = hasLine(hero.card2Line1) || hasLine(hero.card2Line2);
  const showCard3 = hasLine(hero.card3Line1) || hasLine(hero.card3Line2);
  const visibleCardCount =
    (showCard1 ? 1 : 0) + (showCard2 ? 1 : 0) + (showCard3 ? 1 : 0);
  const highlightGridColsClass =
    visibleCardCount === 0
      ? 'md:grid-cols-1'
      : visibleCardCount === 1
        ? 'md:grid-cols-1'
        : visibleCardCount === 2
          ? 'md:grid-cols-2'
          : 'md:grid-cols-3';

  const themeColors = getThemeConfig().colors;
  const h1Color = hero.h1Color ?? themeColors?.['hero-h1'];
  const resolveCssColor = (color?: string): string | undefined => {
    if (!color) return undefined;
    const normalized = color.trim();
    if (
      normalized.startsWith('#') ||
      normalized.startsWith('rgb') ||
      normalized.startsWith('hsl') ||
      normalized.startsWith('var(')
    ) {
      return normalized;
    }
    // Theme custom colors may be provided as raw HSL components ("0 0% 100%").
    if (/^[\d.\s,%-]+$/.test(normalized) && normalized.includes('%')) {
      return `hsl(${normalized})`;
    }
    return normalized;
  };
  const resolvedH1Color = resolveCssColor(h1Color);

  const visibleHeroButtons = (hero.buttons ?? []).filter(
    (b) => String(b.text ?? '').trim() && String(b.link ?? '').trim()
  );

  return (
    <section
      id="hero"
      // Mobile top-anchor avoids content-length-dependent dead space from min-h-screen + items-center.
      className="relative min-h-screen flex items-start md:items-center justify-center overflow-hidden scroll-mt-[92px]"
    >
      {/* LCP hero: ResponsiveImage emits a plain <img> with src/srcSet/fetchPriority for preload scanner */}
      <ResponsiveImage
        preset="hero"
        src={hero.backgroundImage}
        alt={hero.backgroundImageAlt}
        fetchPriority="high"
        loading="eager"
        decoding="async"
        width="1920"
        height="1080"
        className="absolute inset-0 w-full h-full object-cover object-center"
        {...(srcPath && {
          'data-hero-factory-src-path': srcPath('hero.backgroundImageAlt'),
        })}
      />
      {/* Dark overlay — separate from the image so it doesn't affect LCP */}
      <div className="absolute inset-0 bg-black/20" aria-hidden="true" />

      <div className="relative z-10 container mx-auto px-4 py-8 text-center text-white">
        <div className="max-w-4xl mx-auto">
          {hero.h1 ? (
            <Heading
              level={1}
              className={`text-4xl md:text-7xl font-bold mb-6 text-balance leading-tight font-heading pt-20 md:pt-0 mt-0${h1Color ? '' : ' text-white'}`}
              {...(resolvedH1Color && { style: { color: resolvedH1Color } })}
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('hero.h1'),
              })}
            >
              {hero.h1}
            </Heading>
          ) : hero.suburb ? (
            <Heading
              level={1}
              className="text-5xl md:text-7xl font-bold mb-6 text-balance leading-tight font-heading pt-20 md:pt-0 mt-0"
            >
              <span
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('hero.locationPrefix'),
                })}
              >
                {t('hero.locationPrefix', tr)}
              </span>{' '}
              <span
                className={resolvedH1Color ? undefined : 'text-primary'}
                style={resolvedH1Color ? { color: resolvedH1Color } : undefined}
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('hero.suburb'),
                })}
              >
                {hero.suburb}
              </span>{' '}
              <span
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('hero.locationSuffix'),
                })}
              >
                {t('hero.locationSuffix', tr)}
              </span>
            </Heading>
          ) : (
            <Heading
              level={1}
              className={`text-5xl md:text-7xl font-bold mb-6 text-balance leading-tight font-heading pt-20 md:pt-0 mt-0${h1Color ? '' : ' text-primary'}`}
              {...(resolvedH1Color && { style: { color: resolvedH1Color } })}
            >
              <span
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('hero.namePrefix'),
                })}
              >
                {t('hero.namePrefix', tr)}
              </span>{' '}
              <span
                className={resolvedH1Color ? undefined : 'text-primary'}
                style={resolvedH1Color ? { color: resolvedH1Color } : undefined}
                {...(srcPath && {
                  'data-hero-factory-src-path': srcPath('business.name'),
                })}
              >
                {business.name}
              </span>
            </Heading>
          )}

          {visibleCardCount > 0 && (
            <div
              className={`grid grid-cols-1 ${highlightGridColsClass} gap-4 mb-8 text-left max-w-3xl mx-auto order-2 md:order-1 items-stretch`}
            >
              {showCard1 && (
                <div className="bg-black/40 backdrop-blur-sm rounded-xl p-4 h-full min-w-0">
                  {(() => {
                    const a = (hero.card1Line1 ?? '').trim();
                    const b = (hero.card1Line2 ?? '').trim();
                    const primary = a || b;
                    const secondary = a && b ? b : '';
                    if (!primary) return null;
                    return (
                      <>
                        <div
                          className={`font-semibold flex items-start gap-2 min-w-0${
                            secondary ? ' text-lg mb-1' : ' text-lg'
                          }`}
                        >
                          <Card1Icon className="h-5 w-5 mt-1 shrink-0" />
                          <span
                            className="min-w-0 flex-1 hyphens-auto break-words"
                            {...(srcPath && {
                              'data-hero-factory-src-path': srcPath(
                                a ? 'hero.card1Line1' : 'hero.card1Line2'
                              ),
                            })}
                          >
                            {primary}
                          </span>
                        </div>
                        {secondary ? (
                          <div
                            className="text-sm opacity-90 pl-7 hyphens-auto break-words"
                            {...(srcPath && {
                              'data-hero-factory-src-path':
                                srcPath('hero.card1Line2'),
                            })}
                          >
                            {secondary}
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              )}
              {showCard2 && (
                <div className="bg-black/40 backdrop-blur-sm rounded-xl p-4 h-full min-w-0">
                  {(() => {
                    const a = (hero.card2Line1 ?? '').trim();
                    const b = (hero.card2Line2 ?? '').trim();
                    const primary = a || b;
                    const secondary = a && b ? b : '';
                    if (!primary) return null;
                    return (
                      <>
                        <div
                          className={`font-semibold flex items-start gap-2 min-w-0${
                            secondary ? ' text-lg mb-1' : ' text-lg'
                          }`}
                        >
                          <Card2Icon className="h-5 w-5 mt-1 shrink-0" />
                          <span
                            className="min-w-0 flex-1 hyphens-auto break-words"
                            {...(srcPath && {
                              'data-hero-factory-src-path': srcPath(
                                a ? 'hero.card2Line1' : 'hero.card2Line2'
                              ),
                            })}
                          >
                            {primary}
                          </span>
                        </div>
                        {secondary ? (
                          <div
                            className="text-sm opacity-90 pl-7 hyphens-auto break-words"
                            {...(srcPath && {
                              'data-hero-factory-src-path':
                                srcPath('hero.card2Line2'),
                            })}
                          >
                            {secondary}
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              )}
              {showCard3 && (
                <div className="bg-black/40 backdrop-blur-sm rounded-xl p-4 h-full min-w-0">
                  {(() => {
                    const a = (hero.card3Line1 ?? '').trim();
                    const b = (hero.card3Line2 ?? '').trim();
                    const primary = a || b;
                    const secondary = a && b ? b : '';
                    if (!primary) return null;
                    return (
                      <>
                        <div
                          className={`font-semibold flex items-start gap-2 min-w-0${
                            secondary ? ' text-lg mb-1' : ' text-lg'
                          }`}
                        >
                          <Card3Icon className="h-5 w-5 mt-1 shrink-0" />
                          <span
                            className="min-w-0 flex-1 hyphens-auto break-words"
                            {...(srcPath && {
                              'data-hero-factory-src-path': srcPath(
                                a ? 'hero.card3Line1' : 'hero.card3Line2'
                              ),
                            })}
                          >
                            {primary}
                          </span>
                        </div>
                        {secondary ? (
                          <div
                            className="text-sm opacity-90 pl-7 hyphens-auto break-words"
                            {...(srcPath && {
                              'data-hero-factory-src-path':
                                srcPath('hero.card3Line2'),
                            })}
                          >
                            {secondary}
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {visibleHeroButtons.length > 0 && (
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mt-6 sm:mt-12 order-1 md:order-2">
              {visibleHeroButtons.map((button: HeroButton, index: number) => {
                const isPrimary =
                  button.variant === 'primary' ||
                  (button.variant === undefined && index === 0);
                const isExternal =
                  button.link.startsWith('http://') ||
                  button.link.startsWith('https://');
                return (
                  <Button
                    key={index}
                    size="lg"
                    variant={isPrimary ? 'default' : 'outline'}
                    asChild
                    className={
                      isPrimary
                        ? 'bg-hero-cta hover:bg-hero-cta/90 text-hero-cta-foreground px-8 py-4 rounded-full font-semibold text-lg transition-all duration-300 hover:scale-105'
                        : 'border-2 border-white text-foreground hover:bg-white hover:text-foreground px-8 py-4 rounded-full font-semibold text-lg transition-all duration-300 hover:scale-105 bg-white'
                    }
                  >
                    <a
                      href={withLang(button.link, language)}
                      className="flex items-center justify-center"
                      aria-label={button.text}
                      {...(isExternal && {
                        target: '_blank',
                        rel: 'noopener noreferrer',
                      })}
                    >
                      {(button.link.includes('google.com/maps') ||
                        button.link.includes('maps.google.') ||
                        button.link.includes('maps.app.goo.gl')) && (
                        <MapIcon className="h-5 w-5 mr-2 shrink-0" />
                      )}
                      {button.link.startsWith('tel:') && (
                        <Phone className="h-5 w-5 mr-2 shrink-0" />
                      )}
                      {button.link.startsWith('mailto:') && (
                        <Mail className="h-5 w-5 mr-2 shrink-0" />
                      )}
                      <span
                        {...(srcPath && {
                          'data-hero-factory-src-path': srcPath(
                            `hero.buttons.${index}.text`
                          ),
                        })}
                      >
                        {button.text}
                      </span>
                    </a>
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 animate-bounce hidden md:block">
        <div className="w-6 h-10 border-2 border-white rounded-full flex justify-center">
          <div className="w-1 h-3 bg-white rounded-full mt-2 animate-pulse"></div>
        </div>
      </div>
    </section>
  );
};
