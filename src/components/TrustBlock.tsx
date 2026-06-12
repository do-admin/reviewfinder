import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Heading } from '@/components/Heading';
import { ResponsiveImage } from '@/components/ResponsiveImage';
import type { ResolvedPageData } from '@/types/page';
import { getStrings, t } from '@/lib/page-data';
import { type SupportedLanguage, DEFAULT_LANGUAGE } from '@/lib/language';

export interface TrustLogo {
  src: string;
  alt: string;
  width: number;
  height: number;
  maxHeight?: string;
  description: string;
  website: string;
}

/**
 * Trust logos come only from `partners.json` (see `injectTrustLogos` in
 * `src/lib/trust-data.ts`). Any `trust.logos` in websites.json is ignored.
 */
function getTrustLogos(pageData: ResolvedPageData | undefined): TrustLogo[] {
  if (
    pageData?.trust &&
    'logos' in pageData.trust &&
    Array.isArray(pageData.trust.logos)
  ) {
    return pageData.trust.logos as TrustLogo[];
  }
  return [];
}

interface TrustBlockProps {
  language?: SupportedLanguage;
  pageData?: ResolvedPageData;
}

export const TrustBlock = ({
  language = DEFAULT_LANGUAGE,
  pageData,
}: TrustBlockProps) => {
  const tr = pageData ?? language;
  const trustLogos = getTrustLogos(pageData);
  const strings = getStrings(tr);
  const trustBlockHeadingKey = strings['trust.H2']?.trim()
    ? 'trust.H2'
    : 'trust.partners';

  if (trustLogos.length === 0) return null;

  return (
    <TooltipProvider>
      <div className="bg-gradient-to-b from-gray-50 to-white py-8 md:py-10">
        <div className="container mx-auto px-4">
          <div className="text-center mb-8">
            <Heading level={2} className="text-4xl md:text-5xl font-bold mb-2">
              {t(trustBlockHeadingKey, tr)}
            </Heading>
            <p className="text-sm text-foreground max-w-3xl mx-auto">
              {t('trust.qualityPartners', tr)}
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-6 items-center">
            {trustLogos.map((logo, index) => (
              <div key={index} className="relative w-36">
                <Tooltip>
                  {/* Logos are non-linking on purpose; tabIndex keeps the tooltip keyboard-reachable. */}
                  <TooltipTrigger asChild>
                    <div
                      tabIndex={0}
                      role="img"
                      aria-label={logo.alt}
                      className="flex items-center justify-center p-4 bg-white rounded-xl border border-gray-100 hover:border-primary/20 hover:shadow-md transition-all duration-200 cursor-default grayscale-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <ResponsiveImage
                        preset="trust"
                        src={logo.src}
                        alt={logo.alt}
                        width={logo.width}
                        height={logo.height}
                        className="max-w-full object-contain"
                        style={{ maxHeight: logo.maxHeight || '60px' }}
                        loading="lazy"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-xs bg-gray-900 text-white border-gray-700 rounded-lg"
                  >
                    <div className="font-semibold mb-1">{logo.alt}</div>
                    <div className="text-xs leading-relaxed">
                      {logo.description}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            ))}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};
