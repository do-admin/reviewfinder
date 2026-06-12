/**
 * AI Content Optimizer: improves copy fields for one website entry in websites.json
 * using OpenRouter with a large model (default: Claude Opus).
 *
 * Usage:
 *   pnpm improve-copy --client=caralingua --site-index=0
 *   pnpm improve-copy --client=caralingua --website-id=my-site-id
 *   pnpm improve-copy --client=caralingua --site-index=0 --dry-run
 *   pnpm improve-copy --client=caralingua --site-index=0 --model=anthropic/claude-opus-4.1
 *   pnpm improve-copy --client=caralingua --website-id=logopaedie-duesseldorf-com
 *   pnpm improve-copy --client=caralingua --website-id=logopaedie-duesseldorf-com --style-prompt=src/data/caralingua/logopaedie-duesseldorf-com/prompt.md
 *
 * Defaults:
 *   - In-place write to websites.json
 *   - Creates timestamped backup before writing
 *   - Auto-loads style prompt from src/data/<client>/<websiteId>/prompt.md (fallback: prompt.txt)
 *
 * Requires:
 *   - OPENROUTER_API_KEY in .env.local
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

import { isAiFillablePath } from './lib/ai-protected-paths';
import { logOpenRouterChatResponse } from './lib/log-ai-cost.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'anthropic/claude-opus-4.1';

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) return '$0.000000';
  return `$${cost.toFixed(6)}`;
}

/** Aggregated OpenRouter usage for one chat.completions call. */
type ImproveCopyAiUsage = {
  stepLabel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  hasCostData: boolean;
};

function extractUsageFromOpenRouterResponse(
  stepLabel: string,
  usage: Record<string, unknown> | undefined
): ImproveCopyAiUsage {
  const empty: ImproveCopyAiUsage = {
    stepLabel,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    hasCostData: false,
  };
  if (!usage || typeof usage !== 'object') return empty;

  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(
    usage.total_tokens ?? promptTokens + completionTokens
  );
  const promptCost = Number(usage.prompt_tokens_cost ?? 0);
  const completionCost = Number(usage.completion_tokens_cost ?? 0);
  const totalCostCandidate = Number(usage.cost);
  const sectionCost = Number.isFinite(totalCostCandidate)
    ? totalCostCandidate
    : promptCost + completionCost;

  return {
    stepLabel,
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    totalCostUsd: Number.isFinite(sectionCost) && sectionCost > 0 ? sectionCost : 0,
    hasCostData: Number.isFinite(sectionCost) && sectionCost > 0,
  };
}

function logImproveCopyAiCostSummary(steps: ImproveCopyAiUsage[]): void {
  if (steps.length === 0) return;
  console.log('\n[improve-copy] AI usage (OpenRouter)');
  let sumCost = 0;
  let anyCost = false;
  for (const s of steps) {
    console.log(
      `  • ${s.stepLabel}: ${s.promptTokens} prompt + ${s.completionTokens} completion = ${s.totalTokens} total tokens`
    );
    if (s.hasCostData) {
      console.log(`    Cost: ${formatUsd(s.totalCostUsd)}`);
      sumCost += s.totalCostUsd;
      anyCost = true;
    }
  }
  if (anyCost && steps.length > 1) {
    console.log(`  Total estimated cost: ${formatUsd(sumCost)}`);
  }
  if (!anyCost) {
    console.log(
      '  (No per-request cost in API response — see OpenRouter dashboard for billing.)'
    );
  }
}

type JsonRecord = Record<string, unknown>;
type WebsiteEntry = Record<string, unknown>;
type WebsiteFileShape =
  | WebsiteEntry[]
  | { shared?: unknown; websites: WebsiteEntry[] };

type LanguageConfig = {
  contentOptimization?: {
    openRouter?: {
      model?: string;
    };
  };
  translation?: {
    openRouter?: {
      model?: string;
    };
  };
};

type ContentOptimizationAllowlist = {
  rootPaths: string[];
  businessPaths: string[];
  pagePaths: Record<string, string[]>;
  legalBlocks?: {
    enabledForPages: string[];
  };
  schema?: {
    enabledForPages: string[];
    includeLeafKeys: string[];
    excludeLeafKeys: string[];
  };
};

type Candidate = {
  path: string;
  original: string;
  setValue: (value: string) => void;
};

type OptimizeArgs = {
  client: string;
  websiteId?: string;
  siteIndex?: number;
  model?: string;
  stylePrompt?: string;
  dryRun: boolean;
  outFile?: string;
};

type OptimizationItem = {
  path: string;
  text: string;
};

type OptimizationResponse = {
  items: OptimizationItem[];
};

function parseArgs(argv: string[]): OptimizeArgs {
  const clientArg = argv.find((a) => a.startsWith('--client='));
  const idArg = argv.find((a) => a.startsWith('--website-id='));
  const indexArg = argv.find((a) => a.startsWith('--site-index='));
  const modelArg = argv.find((a) => a.startsWith('--model='));
  const stylePromptArg = argv.find((a) => a.startsWith('--style-prompt='));
  const outArg = argv.find((a) => a.startsWith('--out='));

  return {
    client: clientArg
      ? clientArg.replace('--client=', '').trim()
      : process.env.CLIENT_ID || 'current',
    websiteId: idArg ? idArg.replace('--website-id=', '').trim() : undefined,
    siteIndex: indexArg
      ? Number(indexArg.replace('--site-index=', '').trim())
      : undefined,
    model: modelArg ? modelArg.replace('--model=', '').trim() : undefined,
    stylePrompt: stylePromptArg
      ? stylePromptArg.replace('--style-prompt=', '').trim()
      : undefined,
    dryRun: argv.includes('--dry-run'),
    outFile: outArg ? outArg.replace('--out=', '').trim() : undefined,
  };
}

function loadLanguageConfig(configPath: string): LanguageConfig | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as LanguageConfig;
  } catch {
    return null;
  }
}

function loadAllowlistConfig(configPath: string): ContentOptimizationAllowlist {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing allowlist config: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as ContentOptimizationAllowlist;
  if (
    !parsed ||
    !Array.isArray(parsed.rootPaths) ||
    !Array.isArray(parsed.businessPaths) ||
    !parsed.pagePaths
  ) {
    throw new Error(`Invalid allowlist config format: ${configPath}`);
  }
  return parsed;
}

function resolveModel(
  argsModel: string | undefined,
  config: LanguageConfig | null
): string {
  if (argsModel) return argsModel;
  const fromConfig = config?.contentOptimization?.openRouter?.model?.trim();
  if (fromConfig) return fromConfig;
  const fromTranslation = config?.translation?.openRouter?.model?.trim();
  if (fromTranslation) return fromTranslation;
  return DEFAULT_MODEL;
}

function loadWebsitesFile(websitesPath: string): WebsiteFileShape {
  const raw = fs.readFileSync(websitesPath, 'utf-8');
  return JSON.parse(raw) as WebsiteFileShape;
}

function getWebsitesArray(data: WebsiteFileShape): WebsiteEntry[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.websites)) return data.websites;
  throw new Error('websites.json must be an array or { shared, websites }');
}

function writeWebsitesFile(
  websitesPath: string,
  originalShape: WebsiteFileShape,
  websites: WebsiteEntry[]
): void {
  const payload = Array.isArray(originalShape)
    ? websites
    : { ...originalShape, websites };
  // Preserve canonical Schema.org `@type`/`@id` keys verbatim. (A previous
  // regex here wrapped them as `[@type]`/`[@id]` and broke JSON-LD parsers.)
  const json = JSON.stringify(payload, null, 2);
  fs.writeFileSync(websitesPath, `${json}\n`);
}

function createBackup(websitesPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = websitesPath.replace(/\.json$/, `.backup-${stamp}.json`);
  fs.copyFileSync(websitesPath, backupPath);
  return backupPath;
}

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksNonCopy(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (
    /^(https?:\/\/|mailto:|tel:|\/images\/|\/[a-z]{2}\/|#[a-z0-9_-]+)/i.test(
      trimmed
    )
  )
    return true;
  if (/^[0-9+\-()/. ]+$/.test(trimmed)) return true;
  if (/^[A-Z]{2,5}[-_][A-Z0-9-]+$/i.test(trimmed)) return true;
  return false;
}

function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

function looksLikeUrl(text: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(text.trim());
}

function makeCandidateCollector() {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  function addString(
    holder: JsonRecord,
    key: string,
    basePath: string,
    pathSuffix = key,
    options?: { allowTechnical?: boolean }
  ): void {
    const value = holder[key];
    if (typeof value !== 'string') return;
    const pathName = basePath ? `${basePath}.${pathSuffix}` : pathSuffix;
    if (seen.has(pathName)) return;
    if (!options?.allowTechnical && looksNonCopy(value)) return;
    seen.add(pathName);
    candidates.push({
      path: pathName,
      original: value,
      setValue(next: string) {
        holder[key] = next;
      },
    });
  }

  function addNestedString(obj: unknown, pathName: string): void {
    if (!isPlainObject(obj)) return;
    const key = pathName.split('.').pop();
    if (!key) return;
    const holderPath = pathName.split('.').slice(0, -1);
    let holder: unknown = obj;
    for (const segment of holderPath.slice(1)) {
      if (!isPlainObject(holder) && !Array.isArray(holder)) return;
      if (Array.isArray(holder)) return;
      holder = (holder as JsonRecord)[segment];
    }
    if (isPlainObject(holder) && typeof holder[key] === 'string') {
      const p = pathName;
      if (!seen.has(p) && !looksNonCopy(holder[key] as string)) {
        seen.add(p);
        const captured = holder;
        candidates.push({
          path: p,
          original: captured[key] as string,
          setValue(next: string) {
            captured[key] = next;
          },
        });
      }
    }
  }

  return { candidates, addString, addNestedString };
}

function collectSchemaContentCandidates(
  schemaData: unknown,
  basePath: string,
  add: (
    holder: JsonRecord,
    key: string,
    basePath: string,
    pathSuffix?: string,
    options?: { allowTechnical?: boolean }
  ) => void
): void {
  if (!Array.isArray(schemaData)) return;
  const copyLeafNames = new Set([
    'description',
    'slogan',
    'alternateName',
    'knowsAbout',
    'name',
    'headline',
    'text',
    'about',
  ]);
  const bannedLeafNames = new Set([
    'url',
    'email',
    'telephone',
    'streetAddress',
    'postalCode',
    'addressLocality',
    'addressRegion',
    'addressCountry',
    'logo',
    'sameAs',
    'identifier',
    '@id',
    '[@id]',
    'areaServed',
    'availableLanguage',
    'propertyID',
    'value',
  ]);

  function walk(node: unknown, pathParts: string[]): void {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++)
        walk(node[i], [...pathParts, `[${i}]`]);
      return;
    }
    if (!isPlainObject(node)) return;

    for (const [key, value] of Object.entries(node)) {
      if (bannedLeafNames.has(key)) continue;
      const nextPath = [...pathParts, key];
      if (typeof value === 'string') {
        if (
          copyLeafNames.has(key) &&
          !looksLikeEmail(value) &&
          !looksLikeUrl(value) &&
          !looksNonCopy(value)
        ) {
          add(node, key, basePath, nextPath.join('.'), {
            allowTechnical: true,
          });
        }
        continue;
      }
      walk(value, nextPath);
    }
  }

  for (let i = 0; i < schemaData.length; i++) {
    const item = schemaData[i];
    if (!isPlainObject(item)) continue;
    const data = item.data;
    walk(data, ['pages', 'home', 'metadata', 'schema', `[${i}]`, 'data']);
  }
}

function collectLegalBlockCandidates(
  blocks: unknown,
  pageName: string,
  pageIdx: number,
  add: (
    holder: JsonRecord,
    key: string,
    basePath: string,
    pathSuffix?: string,
    options?: { allowTechnical?: boolean }
  ) => void
): void {
  if (!Array.isArray(blocks)) return;

  function walkParts(parts: unknown, blockIdx: number, partPath: string): void {
    if (!Array.isArray(parts)) return;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!isPlainObject(part)) continue;
      const currentPath = `${partPath}.parts[${i}]`;
      add(
        part,
        'value',
        `pages[${pageIdx}(${pageName})].blocks[${blockIdx}]`,
        `${currentPath}.value`,
        { allowTechnical: true }
      );
      walkParts(part.parts, blockIdx, currentPath);
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isPlainObject(block)) continue;
    const base = `pages[${pageIdx}(${pageName})].blocks[${i}]`;
    add(block, 'text', base, 'text', { allowTechnical: true });
    walkParts(block.parts, i, 'root');
  }
}

function collectByPathPattern(
  root: unknown,
  pattern: string,
  basePath: string,
  add: (
    holder: JsonRecord,
    key: string,
    basePath: string,
    pathSuffix?: string,
    options?: { allowTechnical?: boolean }
  ) => void
): void {
  const segments = pattern.split('.').filter(Boolean);

  function walk(
    node: unknown,
    segmentIndex: number,
    currentPath: string
  ): void {
    if (!isPlainObject(node)) return;
    const segment = segments[segmentIndex];
    const isArraySegment = segment.endsWith('[]');
    const key = isArraySegment ? segment.slice(0, -2) : segment;
    const value = node[key];
    const nextPath = currentPath ? `${currentPath}.${key}` : key;

    if (segmentIndex === segments.length - 1) {
      if (isArraySegment) {
        if (!Array.isArray(value)) return;
        value.forEach((entry, i) => {
          if (!isPlainObject(entry)) return;
          for (const [entryKey, entryVal] of Object.entries(entry)) {
            if (typeof entryVal === 'string') {
              add(entry, entryKey, basePath, `${nextPath}[${i}].${entryKey}`, {
                allowTechnical: true,
              });
            }
          }
        });
        return;
      }
      if (typeof value === 'string') {
        add(node, key, basePath, nextPath, { allowTechnical: true });
      }
      return;
    }

    if (isArraySegment) {
      if (!Array.isArray(value)) return;
      value.forEach((entry, i) => {
        walk(entry, segmentIndex + 1, `${nextPath}[${i}]`);
      });
      return;
    }
    walk(value, segmentIndex + 1, nextPath);
  }

  walk(root, 0, '');
}

function collectSchemaContentCandidatesWithConfig(
  schemaData: unknown,
  pageBase: string,
  includeLeafKeys: string[],
  excludeLeafKeys: string[],
  add: (
    holder: JsonRecord,
    key: string,
    basePath: string,
    pathSuffix?: string,
    options?: { allowTechnical?: boolean }
  ) => void
): void {
  if (!Array.isArray(schemaData)) return;
  const copyLeafNames = new Set(includeLeafKeys);
  const bannedLeafNames = new Set(excludeLeafKeys);
  const schemaRootBase = `${pageBase}.metadata`;

  function walk(node: unknown, pathParts: string[]): void {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++)
        walk(node[i], [...pathParts, `[${i}]`]);
      return;
    }
    if (!isPlainObject(node)) return;

    for (const [key, value] of Object.entries(node)) {
      if (bannedLeafNames.has(key)) continue;
      const nextPath = [...pathParts, key];
      if (typeof value === 'string') {
        if (
          copyLeafNames.has(key) &&
          !looksLikeEmail(value) &&
          !looksLikeUrl(value) &&
          !looksNonCopy(value)
        ) {
          add(node, key, schemaRootBase, nextPath.join('.'), {
            allowTechnical: true,
          });
        }
        continue;
      }
      walk(value, nextPath);
    }
  }

  for (let i = 0; i < schemaData.length; i++) {
    const item = schemaData[i];
    if (!isPlainObject(item)) continue;
    walk(item.data, ['schema', `[${i}]`, 'data']);
  }
}

function collectCandidatesFromAllowlist(
  website: WebsiteEntry,
  allowlist: ContentOptimizationAllowlist
): Candidate[] {
  const { candidates, addString } = makeCandidateCollector();

  allowlist.rootPaths.forEach((pattern) => {
    collectByPathPattern(website, pattern, '', addString);
  });

  if (isPlainObject(website.business)) {
    allowlist.businessPaths.forEach((pattern) => {
      collectByPathPattern(website.business, pattern, 'business', addString);
    });
  }

  if (Array.isArray(website.pages)) {
    website.pages.forEach((page, pageIdx) => {
      if (!isPlainObject(page) || typeof page.name !== 'string') return;
      const pageName = page.name;
      const pagePatterns = allowlist.pagePaths[pageName] || [];
      const pageBase = `pages[${pageIdx}(${pageName})]`;

      pagePatterns.forEach((pattern) =>
        collectByPathPattern(page, pattern, pageBase, addString)
      );

      if (allowlist.legalBlocks?.enabledForPages.includes(pageName)) {
        collectLegalBlockCandidates(page.blocks, pageName, pageIdx, addString);
      }

      if (
        allowlist.schema?.enabledForPages.includes(pageName) &&
        isPlainObject(page.metadata)
      ) {
        collectSchemaContentCandidatesWithConfig(
          page.metadata.schema,
          pageBase,
          allowlist.schema.includeLeafKeys,
          allowlist.schema.excludeLeafKeys,
          addString
        );
      }
    });
  }

  return candidates;
}

function collectCandidates(website: WebsiteEntry): Candidate[] {
  const { candidates, addString } = makeCandidateCollector();

  // Global chrome copy
  if (isPlainObject(website.header)) {
    addString(website.header, 'logoAlt', 'header');
    addString(website.header, 'ariaLabelNavigation', 'header');
    addString(website.header, 'ariaMenuOpen', 'header');
    addString(website.header, 'ariaMenuClose', 'header');
    if (Array.isArray(website.header.links)) {
      website.header.links.forEach((item, i) => {
        if (!isPlainObject(item)) return;
        addString(item, 'label', `header.links[${i}]`);
        addString(item, 'ariaLabel', `header.links[${i}]`);
      });
    }
  }

  if (isPlainObject(website.footer)) {
    const footerSections = ['navigation', 'contact', 'socials'] as const;
    footerSections.forEach((section) => {
      const sectionObj = website.footer?.[section];
      if (!isPlainObject(sectionObj)) return;
      addString(sectionObj, 'label', `footer.${section}`);
      if (Array.isArray(sectionObj.links)) {
        sectionObj.links.forEach((link, i) => {
          if (!isPlainObject(link)) return;
          addString(
            link,
            'linkLabel',
            `footer.${section}.links[${i}]`,
            'linkLabel'
          );
        });
      }
    });
    addString(website.footer, 'openingHoursLabel', 'footer');
    addString(website.footer, 'imprint', 'footer');
    addString(website.footer, 'privacy', 'footer');
  }

  if (isPlainObject(website.cookie)) {
    [
      'title',
      'description',
      'acceptAll',
      'acceptEssential',
      'moreInfo',
    ].forEach((k) => addString(website.cookie as JsonRecord, k, 'cookie'));
  }

  if (isPlainObject(website.notFound)) {
    ['title', 'description', 'backHome'].forEach((k) =>
      addString(website.notFound as JsonRecord, k, 'notFound')
    );
  }

  if (isPlainObject(website.translationsMetadata)) {
    const disclaimer = website.translationsMetadata.disclaimer;
    if (isPlainObject(disclaimer)) {
      ['aiTranslation', 'dismissAria', 'infoAria'].forEach((k) =>
        addString(disclaimer, k, 'translationsMetadata.disclaimer')
      );
    }
    const common = website.translationsMetadata.common;
    if (isPlainObject(common)) {
      ['close', 'selectLanguage'].forEach((k) =>
        addString(common, k, 'translationsMetadata.common')
      );
    }
  }

  if (isPlainObject(website.index)) {
    addString(website.index, 'redirectTitle', 'index');
    addString(website.index, 'redirectTo', 'index');
  }

  if (isPlainObject(website.impressumBacklink)) {
    addString(website.impressumBacklink, 'headingTitle', 'impressumBacklink');
    addString(website.impressumBacklink, 'title', 'impressumBacklink');
  }

  if (isPlainObject(website.business)) {
    addString(website.business, 'brandName', 'business', 'brandName', {
      allowTechnical: true,
    });
    const openingHours = website.business.openingHours;
    if (isPlainObject(openingHours)) {
      ['short', 'detailed', 'display'].forEach((k) =>
        addString(openingHours, k, 'business.openingHours', k, {
          allowTechnical: true,
        })
      );
    }
    if (isPlainObject(website.business.contactPerson)) {
      addString(
        website.business.contactPerson,
        'title',
        'business.contactPerson',
        'title',
        {
          allowTechnical: true,
        }
      );
    }
  }

  if (!Array.isArray(website.pages)) return candidates;

  website.pages.forEach((page, pageIdx) => {
    if (!isPlainObject(page) || typeof page.name !== 'string') return;
    const pageName = page.name;
    const base = `pages[${pageIdx}(${pageName})]`;

    if (isPlainObject(page.metadata)) {
      addString(page.metadata, 'title', `${base}.metadata`);
      addString(page.metadata, 'description', `${base}.metadata`);
      addString(page.metadata, 'keywords', `${base}.metadata`);

      if (isPlainObject(page.metadata.openGraph)) {
        addString(
          page.metadata.openGraph,
          'title',
          `${base}.metadata.openGraph`
        );
        addString(
          page.metadata.openGraph,
          'description',
          `${base}.metadata.openGraph`
        );
        if (Array.isArray(page.metadata.openGraph.images)) {
          page.metadata.openGraph.images.forEach((img, i) => {
            if (!isPlainObject(img)) return;
            addString(img, 'alt', `${base}.metadata.openGraph.images[${i}]`);
          });
        }
      }

      if (isPlainObject(page.metadata.twitter)) {
        addString(page.metadata.twitter, 'title', `${base}.metadata.twitter`);
        addString(
          page.metadata.twitter,
          'description',
          `${base}.metadata.twitter`
        );
      }

      if (pageName === 'home') {
        collectSchemaContentCandidates(
          page.metadata.schema,
          `${base}.metadata.schema`,
          addString
        );
      }
    }

    if (pageName === 'home') {
      if (isPlainObject(page.hero)) {
        [
          'h1',
          'subtitle',
          'backgroundImageAlt',
          'card1Line1',
          'card1Line2',
          'card2Line1',
          'card2Line2',
          'card3Line1',
          'card3Line2',
          'locationPrefix',
          'locationSuffix',
          'namePrefix',
          'callAriaLabel',
          'since',
        ].forEach((k) =>
          addString(page.hero as JsonRecord, k, `${base}.hero`, k, {
            allowTechnical: true,
          })
        );
        if (Array.isArray(page.hero.buttons)) {
          page.hero.buttons.forEach((btn, i) => {
            if (!isPlainObject(btn)) return;
            addString(btn, 'text', `${base}.hero.buttons[${i}]`);
          });
        }
      }

      if (isPlainObject(page.info)) {
        [
          'description',
          'paragraph1',
          'paragraph2',
          'quote',
          'imageAlt',
          'sectionTitle',
          'activitiesLabel',
          'nutritionLabel',
          'gardenLabel',
          'mindfulness',
          'nature',
          'participation',
        ].forEach((k) =>
          addString(page.info as JsonRecord, k, `${base}.info`, k, {
            allowTechnical: true,
          })
        );
        ['activities', 'nutrition', 'garden'].forEach((group) => {
          const obj = page.info?.[group];
          if (!isPlainObject(obj)) return;
          addString(obj, 'title', `${base}.info.${group}`);
          addString(obj, 'description', `${base}.info.${group}`);
        });
        const values = page.info.values;
        if (isPlainObject(values)) {
          ['nature', 'mindfulness', 'participation'].forEach((k) =>
            addString(values, k, `${base}.info.values`)
          );
        }
      }

      if (isPlainObject(page.contact)) {
        [
          'location',
          'locationLabel',
          'addressName',
          'bookOnline',
          'bookOnlineDesc',
          'infoTitle',
          'addressLabel',
          'openingHoursLabel',
          'phoneLabel',
          'emailLabel',
          'bookingTitle',
          'bookingLocation',
          'bookingIntro',
          'bookingBoldSubtitle',
          'bookingLocation',
          'bookingGreeting',
          'bookingRole',
          'bookingButton',
          'bookingFeature1Label',
          'bookingFeature2Label',
        ].forEach((k) =>
          addString(page.contact as JsonRecord, k, `${base}.contact`, k, {
            allowTechnical: true,
          })
        );
      }

      if (isPlainObject(page.gallery)) {
        [
          'title',
          'subtitle',
          'ariaLabel',
          'roomsTitle',
          'roomsDescription',
          'outdoorTitle',
          'outdoorDescription',
          'imageOf',
          'rooms',
          'outdoor',
          'prevImage',
          'nextImage',
        ].forEach((k) =>
          addString(page.gallery as JsonRecord, k, `${base}.gallery`, k, {
            allowTechnical: true,
          })
        );
        if (Array.isArray(page.gallery.images)) {
          page.gallery.images.forEach((img, i) => {
            if (!isPlainObject(img)) return;
            addString(img, 'alt', `${base}.gallery.images[${i}]`);
          });
        }
      }

      if (isPlainObject(page.team)) {
        addString(page.team, 'title', `${base}.team`);
        addString(page.team, 'subtitle', `${base}.team`);
        if (isPlainObject(page.team.teamMember))
          addString(page.team.teamMember, 'quote', `${base}.team.teamMember`);
      }

      if (isPlainObject(page.map)) {
        [
          'description',
          'publicTransport',
          'parking',
          'addressTitle',
          'iframeTitle',
          'sectionTitle',
          'openOnMap',
          'visitUs',
          'publicTransportLabel',
          'parkingLabel',
        ].forEach((k) =>
          addString(page.map as JsonRecord, k, `${base}.map`, k, {
            allowTechnical: true,
          })
        );
      }

      if (isPlainObject(page.reviews)) {
        addString(page.reviews, 'title', `${base}.reviews`);
        addString(page.reviews, 'subtitle', `${base}.reviews`);
        addString(page.reviews, 'rating', `${base}.reviews`);
      }

      if (isPlainObject(page.faq)) {
        addString(page.faq, 'title', `${base}.faq`);
        addString(page.faq, 'subtitle', `${base}.faq`);
        if (Array.isArray(page.faq.faqs)) {
          page.faq.faqs.forEach((item, i) => {
            if (!isPlainObject(item)) return;
            addString(item, 'question', `${base}.faq.faqs[${i}]`, 'question', {
              allowTechnical: true,
            });
            addString(item, 'answer', `${base}.faq.faqs[${i}]`, 'answer', {
              allowTechnical: true,
            });
          });
        }
      }

      if (isPlainObject(page.trust)) {
        ['partner', 'partners', 'H2', 'qualityPartners'].forEach((k) =>
          addString(page.trust as JsonRecord, k, `${base}.trust`, k, {
            allowTechnical: true,
          })
        );
      }
    }

    if (pageName === 'ratgeber') {
      if (isPlainObject(page.hero)) {
        addString(page.hero, 'h1', `${base}.hero`);
        addString(page.hero, 'lead', `${base}.hero`);
      }
      if (Array.isArray(page.sections)) {
        page.sections.forEach((section, i) => {
          if (!isPlainObject(section)) return;
          addString(section, 'heading', `${base}.sections[${i}]`);
          addString(section, 'lead', `${base}.sections[${i}]`);
          if (isPlainObject(section.cta))
            addString(section.cta, 'text', `${base}.sections[${i}].cta`);
        });
      }
      if (isPlainObject(page.labels)) {
        addString(page.labels, 'readingTime', `${base}.labels`);
        addString(page.labels, 'noArticles', `${base}.labels`);
        addString(page.labels, 'noCategory', `${base}.labels`);
      }
    }

    if (pageName === 'faq') {
      if (isPlainObject(page.hero)) {
        addString(page.hero, 'h1', `${base}.hero`);
        addString(page.hero, 'lead', `${base}.hero`);
      }
    }

    if (pageName === 'ueber-uns') {
      addString(page as JsonRecord, 'h1', `${base}`, 'h1', {
        allowTechnical: true,
      });
    }

    if (
      pageName === 'impressum' ||
      pageName === 'datenschutz' ||
      pageName === 'ueber-uns'
    ) {
      collectLegalBlockCandidates(page.blocks, pageName, pageIdx, addString);
    }
  });

  return candidates;
}

function extractPlaceholders(input: string): string[] {
  const matches = input.match(/\{[a-zA-Z0-9_]+\}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

function validateAndNormalizeText(
  original: string,
  next: string
): string | null {
  const normalized = next.trim();
  if (!normalized) return null;
  if (looksLikeUrl(normalized) || looksLikeEmail(normalized)) return null;
  const placeholders = extractPlaceholders(original);
  const missingPlaceholder = placeholders.find(
    (token) => !normalized.includes(token)
  );
  if (missingPlaceholder) return null;
  return normalized;
}

function extractJsonFromResponse(content: string): string {
  const trimmed = content.trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(trimmed);
  if (codeBlock) return codeBlock[1].trim();
  return trimmed;
}

async function optimizeWithOpenRouter(
  apiKey: string,
  model: string,
  websiteId: string,
  items: OptimizationItem[],
  stylePromptContext?: string
): Promise<{ response: OptimizationResponse; usage: ImproveCopyAiUsage }> {
  const systemPrompt = [
    'You are an expert German website copy editor focused on local SEO and conversion.',
    'You optimize provided text fields while preserving structure and factual correctness.',
    '',
    'Hard rules:',
    '- Return ONLY JSON: {"items":[{"path":"...","text":"..."}]}',
    '- Keep exactly the same set of paths that you receive. Do not add/remove paths.',
    '- Keep placeholders exactly unchanged (e.g. {name}, {location}, {address}, {postalCode}, {city}).',
    '- Keep language informal German ("Du").',
    '- Do not invent facts, addresses, legal claims, certificates, prices, or medical promises.',
    '- Do not change URLs, email addresses, phone numbers, or machine identifiers.',
    '- For metadata fields, optimize for SEO and CTR with natural language.',
    '- Keep legal content precise and cautious, improve clarity only.',
    '',
    'Title-class paths (e.g. *.metadata.title, *.pageTitle, *.openGraph.title, *.twitter.title, *.hero.h1, *.trust.H2, section title fields): output must include the site primary SEO keyword (from briefing/topics) or an obvious German variant — except pure UI labels and legal boilerplate paths.',
    '',
    'Trust block headings (paths ending with ".trust.H2" or ".trust.partners"):',
    '- These render as the main section h2 above the logo row — must read as a short title (about 35-70 characters when reasonable, max ~90), one line, not a paragraph.',
    '- Move richer sentences or a second thought into ".trust.qualityPartners" (subline), not into H2/partners.',
  ].join('\n');

  const userPayload: Record<string, unknown> = {
    task: 'Optimize website copy for one website entry',
    websiteId,
    items,
  };
  if (stylePromptContext) {
    userPayload.styleGuide = stylePromptContext;
  }
  const userPrompt = JSON.stringify(userPayload, null, 2);

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 32000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${text}`);
  }

  const json = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: Record<string, unknown>;
  };
  logOpenRouterChatResponse({
    script: 'improve-copy',
    operation: 'optimize-copy',
    model,
    usage: json.usage ?? null,
    generationId: json.id ?? null,
    extra: { websiteId },
  });
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response missing choices[0].message.content');
  }

  const usage = extractUsageFromOpenRouterResponse(
    'Copy optimization (single pass)',
    json.usage
  );

  const parsed = JSON.parse(
    extractJsonFromResponse(content)
  ) as OptimizationResponse;
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('Model response missing items array');
  }
  return { response: parsed, usage };
}

function selectWebsite(
  websites: WebsiteEntry[],
  args: OptimizeArgs
): { website: WebsiteEntry; index: number } {
  if (args.websiteId) {
    const idx = websites.findIndex(
      (w) => String(w.id || '') === args.websiteId
    );
    if (idx === -1) {
      throw new Error(`Website id "${args.websiteId}" not found`);
    }
    return { website: websites[idx], index: idx };
  }

  const idx = args.siteIndex ?? 0;
  if (!Number.isInteger(idx) || idx < 0 || idx >= websites.length) {
    throw new Error(
      `Invalid --site-index=${idx}. Expected 0..${Math.max(0, websites.length - 1)}`
    );
  }
  return { website: websites[idx], index: idx };
}

function readOptionalFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  return content.length > 0 ? content : null;
}

function toSiteFolderFromDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\./g, '-');
}

function resolveStylePromptContext(
  dataDir: string,
  website: WebsiteEntry,
  overridePath?: string
): { source: string; content: string } | null {
  if (overridePath) {
    const absolute = path.isAbsolute(overridePath)
      ? overridePath
      : path.resolve(process.cwd(), overridePath);
    const content = readOptionalFile(absolute);
    if (content) return { source: absolute, content };
    throw new Error(`--style-prompt file not found or empty: ${absolute}`);
  }

  const websiteId = typeof website.id === 'string' ? website.id : '';
  const deployDomain =
    typeof website.deployDomain === 'string' ? website.deployDomain : '';
  const folderCandidates = Array.from(
    new Set(
      [
        websiteId,
        deployDomain ? toSiteFolderFromDomain(deployDomain) : '',
      ].filter(Boolean)
    )
  );

  for (const folder of folderCandidates) {
    const mdPath = path.join(dataDir, folder, 'prompt.md');
    const txtPath = path.join(dataDir, folder, 'prompt.txt');
    const md = readOptionalFile(mdPath);
    if (md) return { source: mdPath, content: md };
    const txt = readOptionalFile(txtPath);
    if (txt) return { source: txtPath, content: txt };
  }

  return null;
}

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.join(process.cwd(), 'src', 'data', args.client);
  const websitesPath = path.join(dataDir, 'websites.json');
  const languageConfigPath = path.join(dataDir, 'language.config.json');
  const allowlistPath = path.join(
    dataDir,
    'content-optimization.allowlist.json'
  );

  if (!fs.existsSync(websitesPath)) {
    throw new Error(`Missing websites.json: ${websitesPath}`);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY in .env.local');
  }

  const langConfig = loadLanguageConfig(languageConfigPath);
  const allowlist = loadAllowlistConfig(allowlistPath);
  const model = resolveModel(args.model, langConfig);

  const raw = loadWebsitesFile(websitesPath);
  const websites = getWebsitesArray(raw);
  const selected = selectWebsite(websites, args);
  const website = selected.website;
  const websiteId = String(website.id || `site-${selected.index}`);
  const stylePrompt = resolveStylePromptContext(
    dataDir,
    website,
    args.stylePrompt
  );
  if (stylePrompt) {
    console.log(`Using style prompt: ${stylePrompt.source}`);
  } else {
    console.log(
      'No prompt.md/prompt.txt found for this website. Continuing without style prompt context.'
    );
  }

  const rawCandidates = collectCandidatesFromAllowlist(website, allowlist);
  const blocked = rawCandidates.filter((c) => !isAiFillablePath(c.path));
  const candidates = rawCandidates.filter((c) => isAiFillablePath(c.path));

  if (blocked.length > 0) {
    const preview = blocked.slice(0, 12).map((c) => c.path);
    const suffix =
      blocked.length > 12 ? ` … (+${blocked.length - 12} more)` : '';
    console.log(
      `Skipping ${blocked.length} AI-protected path(s) (see scripts/lib/ai-protected-paths.ts): ${preview.join(', ')}${suffix}`
    );
  }

  if (candidates.length === 0) {
    if (rawCandidates.length > 0) {
      console.log(
        'No copy-bearing fields left after removing AI-protected paths.'
      );
    } else {
      console.log('No copy-bearing fields found for optimization.');
    }
    return;
  }

  const requestItems: OptimizationItem[] = candidates.map((c) => ({
    path: c.path,
    text: c.original,
  }));
  console.log(
    `Optimizing ${requestItems.length} fields for website "${websiteId}" with model "${model}"...`
  );

  const { response: optimized, usage: optimizationUsage } =
    await optimizeWithOpenRouter(
      apiKey,
      model,
      websiteId,
      requestItems,
      stylePrompt?.content
    );
  const aiUsageSteps: ImproveCopyAiUsage[] = [optimizationUsage];
  const byPath = new Map(optimized.items.map((item) => [item.path, item.text]));

  let changed = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const proposed = byPath.get(candidate.path);
    if (typeof proposed !== 'string') {
      skipped++;
      continue;
    }
    const safeText = validateAndNormalizeText(candidate.original, proposed);
    if (!safeText || safeText === candidate.original) continue;
    candidate.setValue(safeText);
    changed++;
  }

  console.log(
    `Applied ${changed} optimized fields (${skipped} skipped due to missing model paths).`
  );

  if (args.dryRun) {
    const previewPayload = {
      websiteId,
      changedFields: changed,
      preview: candidates
        .filter((c) => byPath.has(c.path))
        .map((c) => ({
          path: c.path,
          before: c.original,
          after: byPath.get(c.path),
        })),
    };
    const out = args.outFile ? path.resolve(process.cwd(), args.outFile) : '';
    if (out) {
      fs.writeFileSync(out, JSON.stringify(previewPayload, null, 2) + '\n');
      console.log(`Dry-run preview written to ${out}`);
    } else {
      console.log(JSON.stringify(previewPayload, null, 2));
    }
    logImproveCopyAiCostSummary(aiUsageSteps);
    return;
  }

  const backupPath = createBackup(websitesPath);
  console.log(`Backup created: ${backupPath}`);

  writeWebsitesFile(websitesPath, raw, websites);
  console.log(`Updated: ${websitesPath}`);
  logImproveCopyAiCostSummary(aiUsageSteps);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
