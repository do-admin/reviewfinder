import type { FAQ, ResolvedPageData } from '@/types/page';
import type { SupportedLanguage } from '@/lib/language';

/** Same pattern as `[lang]/faq.astro`: literal globs under active client (`src/data/current/`). */
const homeFaqModules = {
  ...import.meta.glob<{ default: FAQ[] }>('/src/data/current/faq.json'),
  ...import.meta.glob<{ default: FAQ[] }>('/src/data/current/faq-*.json'),
};

/**
 * When the home page `faq` block has no inlined `faqs`, load them from
 * `faq-<lang>.json` or `faq.json` next to `websites.json` (active client folder).
 */
export async function mergeHomeFaqFromFaqJson(
  pageData: ResolvedPageData,
  language: SupportedLanguage
): Promise<void> {
  const faqSection = pageData.faq as typeof pageData.faq | undefined;
  if (!faqSection || (faqSection.faqs?.length ?? 0) > 0) return;

  const candidates = [`faq-${language}.json`, 'faq.json'];
  const matchKey = candidates
    .map((name) =>
      Object.keys(homeFaqModules).find((k) => k.endsWith(`/${name}`))
    )
    .find(Boolean);
  if (!matchKey) return;

  const mod = await homeFaqModules[matchKey]();
  const list = mod.default;
  if (!Array.isArray(list) || list.length === 0) return;

  (faqSection as { faqs: FAQ[] }).faqs = list;
}
