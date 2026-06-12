import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { Quote, Star } from 'lucide-react';
import { DEFAULT_LANGUAGE } from '@/lib/language';
import { cn } from '@/lib/utils';
import { buildSrcPath, type SrcPathInfo } from '@/lib/src-path';
import { Heading } from './Heading';

interface ReviewsComponentProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  /** Server-only callers may pass a function. `client:*` islands MUST use `srcPathInfo` instead. */
  srcPath?: SrcPathFn;
  /** Serializable companion for `srcPath`; required when this component is hydrated as a `client:*` island. */
  srcPathInfo?: SrcPathInfo;
}

function getInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

function getReviewText(review: {
  text?: { text: string };
  originalText?: { text: string };
}): string {
  return review.originalText?.text?.trim() || review.text?.text?.trim() || '';
}

function StarRating({ rating }: { rating: number }) {
  const value = Number.isFinite(rating) ? rating : 0;
  return (
    <div className="flex items-center gap-0.5" aria-label={`${value} von 5 Sternen`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={cn(
            'h-4 w-4',
            star <= value ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-amber-200'
          )}
          aria-hidden
        />
      ))}
    </div>
  );
}

export const GoogleReviews = ({
  pageData,
  language = DEFAULT_LANGUAGE,
  srcPath: srcPathProp,
  srcPathInfo,
}: ReviewsComponentProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stops, setStops] = useState<number[]>([0]);
  const [activePage, setActivePage] = useState(0);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());

  const srcPath = useMemo<SrcPathFn | undefined>(() => {
    if (srcPathInfo) return (fragment: string) => buildSrcPath(srcPathInfo, fragment);
    return srcPathProp;
  }, [srcPathInfo, srcPathProp]);

  const {
    title,
    subtitle,
    reviewData,
    minimumRating = 4,
    maxDisplayCount = 6,
    reviewerRoleLabel = 'Eigentümer',
  } = pageData.reviews;

  const brandName = pageData.business.brandName;

  const reviews = useMemo(
    () =>
      (reviewData.reviews ?? [])
        .filter((r) => r.rating >= minimumRating && getReviewText(r).length > 0)
        .slice(0, maxDisplayCount),
    [reviewData.reviews, minimumRating, maxDisplayCount]
  );

  // Each dot maps to a distinct reachable scroll position (the scrollLeft needed
  // to bring a card to the left edge). Trailing cards that can only clamp to the
  // same max-scroll collapse into one final dot, so every dot moves the carousel.
  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, Math.round(el.scrollWidth - el.clientWidth));
    const elLeft = el.getBoundingClientRect().left;
    const next: number[] = [];
    Array.from(el.children).forEach((child) => {
      const childLeft = (child as HTMLElement).getBoundingClientRect().left;
      const target = Math.min(
        Math.max(0, Math.round(el.scrollLeft + (childLeft - elLeft))),
        maxScroll
      );
      if (next.length === 0 || Math.abs(target - next[next.length - 1]) > 8) {
        next.push(target);
      }
    });
    if (next.length === 0) next.push(0);
    setStops(next);

    let active = 0;
    let best = Infinity;
    next.forEach((stop, i) => {
      const distance = Math.abs(stop - el.scrollLeft);
      if (distance < best) {
        best = distance;
        active = i;
      }
    });
    setActivePage(active);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    recompute();
    el.addEventListener('scroll', recompute, { passive: true });
    const resizeObserver = new ResizeObserver(recompute);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      resizeObserver.disconnect();
    };
  }, [recompute, reviews.length]);

  const scrollToPage = (page: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: stops[page] ?? 0, behavior: 'smooth' });
    setActivePage(page);
  };

  const handleImageError = (index: number) => {
    setImageErrors((prev) => new Set(prev).add(index));
  };

  if (reviews.length === 0) {
    return null;
  }

  return (
    <section
      id="reviews"
      className="scroll-mt-[92px] bg-white py-14 md:py-20"
      aria-labelledby="reviews-heading"
    >
      <div className="container mx-auto px-4">
        <div className="mx-auto mb-10 max-w-3xl text-center md:mb-12">
          <Heading
            level={2}
            center
            underline={false}
            className="mb-3 mt-0 text-3xl font-bold tracking-tight text-heading-foreground font-heading md:text-4xl lg:text-5xl"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('reviews.title'),
            })}
          >
            {title}
          </Heading>
          <p
            className="text-base text-muted-foreground md:text-lg"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('reviews.subtitle'),
            })}
          >
            {subtitle}
          </p>
          <div className="mt-8">
            <p className="text-5xl font-bold text-heading-foreground md:text-6xl">
              100%
            </p>
            <p className="mt-2 text-sm text-muted-foreground md:text-base">
              unserer Kunden empfehlen {brandName} weiter
            </p>
          </div>
        </div>

        <div
          ref={scrollRef}
          className="flex snap-x snap-mandatory gap-6 overflow-x-auto pb-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {reviews.map((review, index) => {
            const authorName = review.authorAttribution.displayName;
            const body = getReviewText(review);
            const reviewUrl = review.googleMapsUri?.trim() || undefined;
            const hasPhoto =
              !!review.authorAttribution.photoUri && !imageErrors.has(index);

            const cardClassName = cn(
              'relative flex w-[min(100%,320px)] shrink-0 snap-start flex-col rounded-2xl border border-border/60 bg-card p-6 shadow-md transition-shadow md:w-[340px]',
              reviewUrl && 'hover:shadow-lg'
            );

            const cardInner = (
              <>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <StarRating rating={review.rating} />
                  <Quote
                    className="h-8 w-8 shrink-0 text-primary/30"
                    aria-hidden
                  />
                </div>
                <p className="mb-6 flex-1 text-sm leading-relaxed text-foreground/90 md:text-[15px]">
                  {body}
                </p>
                <div className="flex items-center gap-3 border-t border-border/50 pt-4">
                  <div
                    className="h-10 w-10 shrink-0 overflow-hidden rounded-full"
                    aria-hidden
                  >
                    {hasPhoto ? (
                      <img
                        src={review.authorAttribution.photoUri}
                        alt={authorName}
                        className="h-full w-full object-cover"
                        width={40}
                        height={40}
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        onError={() => handleImageError(index)}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-primary/10 text-sm font-semibold text-primary">
                        {getInitial(authorName)}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-heading font-semibold text-heading-foreground">
                      {authorName}
                    </p>
                    <p className="text-xs text-muted-foreground md:text-sm">
                      {reviewerRoleLabel} · Google Bewertung
                    </p>
                  </div>
                </div>
              </>
            );

            return reviewUrl ? (
              <a
                key={index}
                href={reviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Google-Bewertung von ${authorName} auf Google Maps ansehen`}
                className={cardClassName}
              >
                {cardInner}
              </a>
            ) : (
              <div key={index} className={cardClassName}>
                {cardInner}
              </div>
            );
          })}
        </div>

        {stops.length > 1 && (
          <div
            className="mt-6 flex justify-center gap-2"
            role="tablist"
            aria-label="Bewertungen durchblättern"
          >
            {stops.map((_, page) => (
              <button
                key={page}
                type="button"
                role="tab"
                aria-selected={page === activePage}
                aria-label={`Bewertungen Seite ${page + 1}`}
                onClick={() => scrollToPage(page)}
                className={cn(
                  'h-2.5 w-2.5 cursor-pointer rounded-full transition-colors',
                  page === activePage
                    ? 'bg-primary'
                    : 'bg-primary/25 hover:bg-primary/40'
                )}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
