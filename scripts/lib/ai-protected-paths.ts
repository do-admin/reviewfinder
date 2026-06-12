/**
 * Shared list of AI-protected paths and blocked leaf patterns.
 *
 * These paths must NEVER be generated or overwritten by AI.
 * They are managed by tooling, Excel import, or external data sources.
 *
 * Used by:
 *   - 06-generate-website.ts 
  'id',
  'deployDomain',
  'googleTagId',
  'datenschutzResponsibleMode',
  'impressumResponsibleMode',
  'business.email',
  'business.phone',
  'business.bookingUrl',
  'business.legalName',
  'business.legalAddress',
  // Operating / hotel-location address — factual, extracted from the client's
  // main / contact page. Must never be invented by AI.
  'business.locationAddress',
  'business.registergericht', (generation / fill-blanks)
 *   - 08-refine-website-data.ts (refinement / validation / content quality)
 *   - improve-copy.ts (candidate filtering before OpenRouter)
 */

/**
 * Wildcard-based protected paths.
 * `[*]` matches any array index, e.g. "pages[*].hero.backgroundImage"
 * matches "pages[0].hero.backgroundImage", "pages[1].hero.backgroundImage", etc.
 *
 * These paths are:
 *   1. Communicated to the AI model so it knows not to touch them.
 *   2. Programmatically stripped from AI output before merging (safety net).
 */
export const AI_PROTECTED_PATHS: string[] = [
  'clientDomain',
  'clientName',
  'websiteBriefing',
  'driveFolderId',
  'sectionIds',
  'business.hrbNummer',
  'business.ustId',
  'business.vertreter',
  'business.social.instagram',
  'business.social.facebook',
  'business.social.whatsappNumber',
  'business.googlePlacesId',
  'business.contactPerson.imageUrl',
  'header.logoUrl',
  // Template-filled navigation labels (must remain stable across AI runs)
  'header.links[*].type',
  // Template pages structure exists and must not be regenerated wholesale by AI
  'pages[*].name',
  'pages[*].hero.backgroundImage',
  // Excel: Hero Button 1/2 Text & Link — do not overwrite from AI.
  'pages[*].hero.buttons',
  'pages[*].hero.buttons[*].variant',
  'pages[*].info.imageUrl',
  'pages[*].gallery.images[*].src',
  'pages[*].metadata.openGraph.images[*].url',
  'pages[*].metadata.openGraph.images[*].width',
  'pages[*].metadata.openGraph.images[*].height',
  'pages[*].metadata.twitter.images[*].url',
  'pages[*].metadata.twitter.images[*].width',
  'pages[*].metadata.twitter.images[*].height',
  'pages[*].metadata.schema[*].data.logo',
  'pages[*].faq.faqDataFile',
  'pages[*].faq.faqs',
  'pages[*].faqDataFile',
  // Gallery counter template — must contain `{current}` and `{total}`
  // placeholders; AI kept filling bare "Bild von" causing a broken counter.
  'pages[*].gallery.imageOf',
  'pages[*].schema',
  // Do not use `pages[*].reviews` (would strip `title` / `subtitle` before merge). Strip only
  // factual / tooling parts; UI labels in `reviews` are merged from template/source in 06/clone.
  'pages[*].reviews.reviewData',
  'pages[*].reviews.minimumRating',
  'pages[*].trust.logos',
  'pages[*].map.mapEmbedUrl',
  // Template-filled UI labels / boilerplate (non-location-specific).
  // Protected from AI generation/refinement; scripts/translation/translate-data.ts
  // explicitly allowlists these paths so DE→EN (etc.) still translates the copy.
  'footer.contact.label',
  'footer.followUs',
  'footer.imprint',
  'footer.privacy',
  'footer.grounding',
  // Cookie banner copy — protected from AI generation; translate-data allowlists.
  'cookie.title',
  'cookie.description',
  'cookie.acceptAll',
  'cookie.acceptEssential',
  'cookie.moreInfo',
  'index.redirectTitle',
  'index.redirectTo',
  'impressumBacklink',
  'languages',
];

/**
 * Leaf-level patterns that block a path from being AI-fillable,
 * regardless of depth. Applied via regex test on the full dot-notation path.
 */
export const BLOCKED_LEAF_PATTERNS: RegExp[] = [
  /\.faqDataFile$/,
  /\.mapEmbedUrl$/,
  /\.reviewData(\.|$)/,
  /\.logoUrl$/,
  /\.backgroundImage$/,
  /\.imageUrl$/,
  /\.src$/,
  /\.url$/,
  /\.link$/,
  /\.href$/,
  /\.phone$/,
  /\.email$/,
  /\.telephone$/,
  /\.postalCode$/,
  /\.street$/,
  /\.city$/,
  /\.latitude$/,
  /\.longitude$/,
  /\.icbm$/,
  /\.position$/,
  /\.region$/,
  /\.whatsappNumber$/,
  /\.ustId$/,
  /\.hrbNummer$/,
  /\.registergericht$/,
  /\.googlePlacesId$/,
  /\.logoWidth$/,
  /\.minimumRating$/,
  /\.width$/,
  /\.height$/,
  /^id$/,
  /^websiteBriefing$/,
  /^deployDomain$/,
  /^clientDomain$/,
  /^googleTagId$/,
];

/**
 * Convert a wildcard protected path like "pages[*].hero.backgroundImage"
 * into a regex that matches concrete paths like "pages[0].hero.backgroundImage".
 */
export function protectedPathToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\[\\\*\\\]/g, '\\[\\d+\\]');
  return new RegExp(`^${escaped}($|\\.)`);
}

const PROTECTED_PATH_REGEXES = AI_PROTECTED_PATHS.map(protectedPathToRegex);

/**
 * Map tooling-specific dot paths to the canonical shape used by
 * {@link AI_PROTECTED_PATHS} / {@link protectedPathToRegex} (e.g. scripts that
 * use `pages[0(home)]` or duplicate schema segments).
 */
export function normalizePathForAiProtection(pathValue: string): string {
  if (!pathValue) return '';
  let p = pathValue;
  p = p.replace(/pages\[(\d+)\([^)]*\)\]/g, 'pages[$1]');
  p = p.replace(
    /\.metadata\.schema\.pages\.home\.metadata\.schema/g,
    '.metadata.schema'
  );
  return p;
}

/**
 * Check whether a concrete dot-notation path is fillable by AI.
 * Returns false for protected paths and blocked leaf patterns.
 */
export function isAiFillablePath(pathValue: string): boolean {
  if (!pathValue) return false;
  const canonical = normalizePathForAiProtection(pathValue);
  if (!canonical) return false;
  if (PROTECTED_PATH_REGEXES.some((rx) => rx.test(canonical))) return false;
  if (BLOCKED_LEAF_PATTERNS.some((rx) => rx.test(canonical))) return false;
  return true;
}

/**
 * Derive a section key from a dot-notation path for context-aware grouping.
 *
 * Home page (pages[0]) is split by section — hero, info, contact, etc. —
 * so each batch has full context for that section.
 * Non-home pages are grouped per page (smaller, mostly metadata + blocks).
 * Top-level keys (header, footer, cookie, …) are grouped individually.
 */
export function getSectionKey(pathValue: string): string {
  const pageSection = /^(pages\[\d+\])\.(\w+)/.exec(pathValue);
  if (pageSection) {
    const [, page, section] = pageSection;
    if (page === 'pages[0]') return `${page}.${section}`;
    return page;
  }
  return pathValue.split('.')[0].split('[')[0];
}

export type SectionBatch = { section: string; paths: string[] };

export function groupPathsBySections(paths: string[]): SectionBatch[] {
  const map = new Map<string, string[]>();
  for (const p of paths) {
    const key = getSectionKey(p);
    let group = map.get(key);
    if (!group) {
      group = [];
      map.set(key, group);
    }
    group.push(p);
  }
  return Array.from(map.entries()).map(([section, sectionPaths]) => ({
    section,
    paths: sectionPaths,
  }));
}
