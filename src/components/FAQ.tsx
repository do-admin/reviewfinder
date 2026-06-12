import { useMemo } from 'react';
import { cn, createSlug } from '@/lib/utils';
import type { ResolvedPageData, SrcPathFn } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';
import { Heading } from '@/components/Heading';
import { getCustomCssClass } from '@/lib/theme';
import { buildSrcPath, type SrcPathInfo } from '@/lib/page-data';

interface FAQComponentProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  /** Server-only callers may pass a function. `client:*` islands MUST use `srcPathInfo` instead. */
  srcPath?: SrcPathFn;
  /** Serializable companion for `srcPath`; required when this component is hydrated as a `client:*` island. */
  srcPathInfo?: SrcPathInfo;
}

export const FAQ = ({
  pageData,
  srcPath: srcPathProp,
  srcPathInfo,
}: FAQComponentProps) => {
  const srcPath = useMemo<SrcPathFn | undefined>(() => {
    if (srcPathInfo) return (fragment: string) => buildSrcPath(srcPathInfo, fragment);
    return srcPathProp;
  }, [srcPathInfo, srcPathProp]);
  const { faq } = pageData;
  const { title, subtitle, faqs } = faq;
  /** Omitted or true → muted section + card accordions; only `false` uses the light band. */
  const mutedSection = faq.mutedSectionBackground !== false;

  if (!faqs || faqs.length === 0) {
    return null;
  }

  return (
    <section
      id="faq"
      className={cn(
        'py-14 md:py-20 scroll-mt-[92px]',
        mutedSection ? 'bg-muted' : 'bg-background'
      )}
    >
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <Heading
            level={2}
            className="mt-0 text-4xl md:text-5xl font-bold text-heading-foreground mb-4 font-heading"
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('faq.title'),
            })}
          >
            {title}
          </Heading>
          <p
            className={cn(
              'text-lg max-w-2xl mx-auto',
              mutedSection ? 'text-muted-foreground' : 'text-foreground'
            )}
            {...(srcPath && {
              'data-hero-factory-src-path': srcPath('faq.subtitle'),
            })}
          >
            {subtitle}
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <div className="space-y-4">
            {faqs.map((faq, index) => {
              const slug = createSlug(faq.question);
              return (
                <details
                  key={index}
                  className={cn(
                    'group rounded-lg',
                    mutedSection
                      ? 'border border-border/80 bg-card text-card-foreground shadow-sm'
                      : 'border-none bg-muted'
                  )}
                  id={slug}
                  style={{ scrollMarginTop: '92px' }}
                >
                  <summary
                    className={cn(
                      'flex list-none items-center justify-between gap-4 font-heading tracking-wide cursor-pointer px-6 py-4 rounded-lg transition-colors text-left [&>span]:min-w-0 [&::-webkit-details-marker]:hidden',
                      mutedSection ? 'hover:bg-muted/70' : 'hover:bg-muted/80'
                    )}
                  >
                    <span
                      className={`text-left ${getCustomCssClass('faqHeading', 'text-xl')} text-heading-foreground tracking-wide`}
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          `faq.faqs.${index}.question`
                        ),
                      })}
                    >
                      {faq.question}
                    </span>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 shrink-0 transition-transform duration-200 group-open:rotate-180"
                      aria-hidden="true"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </summary>
                  <div
                    className={cn(
                      'px-6 pb-4',
                      mutedSection ? 'text-muted-foreground' : 'text-foreground'
                    )}
                  >
                    <div
                      dangerouslySetInnerHTML={{ __html: faq.answer }}
                      {...(srcPath && {
                        'data-hero-factory-src-path': srcPath(
                          `faq.faqs.${index}.answer`
                        ),
                      })}
                    />
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};
