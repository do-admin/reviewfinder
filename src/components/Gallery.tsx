import { useState, useCallback, useRef, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { buildSrcPath, type SrcPathInfo } from '@/lib/src-path';
import type { GalleryStrings } from '@/lib/client-island-strings';
import { DEFAULT_LANGUAGE } from '@/lib/language';
import { Heading } from './Heading';
import { ResponsiveImage } from '@/components/ResponsiveImage';

interface GalleryComponentProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  /** Server-resolved UI strings (required for `client:*` islands). */
  strings: GalleryStrings;
  /** Server-only callers may pass a function. `client:*` islands MUST use `srcPathInfo` instead. */
  srcPath?: SrcPathFn;
  /** Serializable companion for `srcPath`; required when this component is hydrated as a `client:*` island. */
  srcPathInfo?: SrcPathInfo;
}

function formatImageOf(template: string, current: number, total: number): string {
  const rendered = template
    .replace(/\{current\}/g, String(current))
    .replace(/\{total\}/g, String(total));
  const bothNumbersRendered =
    rendered.includes(String(current)) && rendered.includes(String(total));
  return bothNumbersRendered ? rendered : `${current} / ${total}`;
}

export const Gallery = ({
  pageData,
  language = DEFAULT_LANGUAGE,
  strings,
  srcPath: srcPathProp,
  srcPathInfo,
}: GalleryComponentProps) => {
  const srcPath = useMemo<SrcPathFn | undefined>(() => {
    if (srcPathInfo) return (fragment: string) => buildSrcPath(srcPathInfo, fragment);
    return srcPathProp;
  }, [srcPathInfo, srcPathProp]);
  const { gallery, business } = pageData;
  const {
    title,
    subtitle,
    images,
    roomsTitle,
    roomsDescription,
    outdoorTitle,
    outdoorDescription,
    copyright,
  } = gallery;
  const [currentImage, setCurrentImage] = useState(0);
  const [prevImage, setPrevImage] = useState(0);
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [animating, setAnimating] = useState(false);
  const isFirstRender = useRef(true);

  const goTo = useCallback(
    (idx: number, dir: 'left' | 'right') => {
      if (animating || idx === currentImage) return;
      isFirstRender.current = false;
      setPrevImage(currentImage);
      setDirection(dir);
      setCurrentImage(idx);
      setAnimating(true);
    },
    [animating, currentImage]
  );

  const nextImage = () => goTo((currentImage + 1) % images.length, 'right');
  const prevImageFn = () =>
    goTo((currentImage - 1 + images.length) % images.length, 'left');

  const animClass = isFirstRender.current
    ? ''
    : direction === 'right'
      ? 'animate-gallery-slide-from-right'
      : 'animate-gallery-slide-from-left';

  return (
    <section
      id="gallery"
      className="py-14 md:py-20 bg-muted scroll-mt-[92px]"
      aria-label={strings.ariaLabel}
    >
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <Heading
            level={2}
            className="text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading mt-0"
          >
            <span
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('gallery.title'),
              })}
            >
              {title}
            </span>{' '}
            - <span className="text-primary">{business.name}</span>
          </Heading>
          <p
            className="text-lg text-foreground max-w-2xl mx-auto"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('gallery.subtitle'),
            })}
          >
            {subtitle}
          </p>
        </div>

        <div className={`relative max-w-4xl mx-auto`}>
          <figure className="relative aspect-video overflow-hidden rounded-2xl shadow-lg">
            {animating && (
              <ResponsiveImage
                preset="gallery"
                src={images[prevImage].src}
                alt=""
                width="800"
                height="450"
                className="absolute inset-0 w-full h-full object-cover"
                aria-hidden="true"
                loading="lazy"
              />
            )}
            <ResponsiveImage
              key={currentImage}
              preset="gallery"
              src={images[currentImage].src}
              alt={images[currentImage].alt}
              width="800"
              height="450"
              className={`absolute inset-0 w-full h-full object-cover ${animClass}`}
              role="img"
              loading={currentImage === 0 ? 'eager' : 'lazy'}
              onAnimationEnd={() => setAnimating(false)}
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  `gallery.images.${currentImage}`
                ),
              })}
            />
            <figcaption className="sr-only">
              {images[currentImage].alt}
            </figcaption>
          </figure>

          <button
            onClick={prevImageFn}
            className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/80 hover:bg-white p-2 rounded-full shadow-lg transition-colors cursor-pointer"
            aria-label={strings.prevImage}
          >
            <ChevronLeft
              className="h-6 w-6 text-foreground"
              aria-hidden="true"
            />
          </button>
          <button
            onClick={nextImage}
            className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/80 hover:bg-white p-2 rounded-full shadow-lg transition-colors cursor-pointer"
            aria-label={strings.nextImage}
          >
            <ChevronRight
              className="h-6 w-6 text-foreground"
              aria-hidden="true"
            />
          </button>

          <div
            className="absolute bottom-4 right-4 bg-white/80 px-3 py-1 rounded-full text-sm"
            aria-live="polite"
            aria-atomic="true"
          >
            {formatImageOf(
              strings.imageOfTemplate,
              currentImage + 1,
              images.length
            )}
          </div>
        </div>

        {copyright && copyright.trim().length > 0 && (
          <p
            className="text-xs md:text-sm text-black text-center mb-8 mt-2"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('gallery.copyright'),
            })}
          >
            {copyright}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-white rounded-2xl p-8">
            <p
              className="text-3xl font-bold text-heading-foreground mb-4 font-heading mt-0"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('gallery.roomsTitle'),
              })}
            >
              {roomsTitle}
            </p>
            <span
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  'gallery.roomsDescription'
                ),
              })}
            >
              {roomsDescription}
            </span>
          </div>
          <div className="bg-white rounded-2xl p-8">
            <p
              className="text-3xl font-bold text-heading-foreground mb-4 font-heading mt-0"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('gallery.outdoorTitle'),
              })}
            >
              {outdoorTitle}
            </p>
            <p
              className="text-foreground"
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath(
                  'gallery.outdoorDescription'
                ),
              })}
            >
              {outdoorDescription}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
