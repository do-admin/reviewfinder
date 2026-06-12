/**
 * 08-refine-website-data
 *
 * Post-import pipeline for websites.json: fills missing copy, validates data, and improves content.
 *  1. Empty-field detection & generation (06-generate-website fill-blanks)
 *  2. AI fallback for remaining empty text fields
 *  3. Header/hero link validation (internal routes, external reachability, AI CTA review)
 *  4. Image path validation (files under public/ only; no HTTP fetch to deploy domain)
 *     report under tmp/content-quality-reviews/ for tuning generation prompts
 *  6. AI hero copy review (H1, subtitle, card lines vs prompt.md, topics.json, websites[0].websiteBriefing)
 *  6b. Hero H1 uniqueness: if home H1 matches another site for the client (normalized), rewrite via AI (hero-h1-dedupe)
 *
 * Usage:
 *   pnpm run 08-refine-website-data
 *   pnpm run 08-refine-website-data -- --client-id=nicezeit
 *   pnpm run 08-refine-website-data -- --client-id=nicezeit --website-id=eisdiele-linden
 *   pnpm run 08-refine-website-data -- --client-id=nicezeit --all-websites
 *     (refine every site; use from scripts/CI — avoids the interactive site prompt in a TTY)
 *   pnpm run 08-refine-website-data -- --client-id=nicezeit --dry-run
 *   pnpm run 08-refine-website-data -- --client-id=nicezeit --no-ai
 *   pnpm run 08-refine-website-data -- --client-id=nicezeit --skip-http-checks
 *   pnpm run 08-refine-website-data -- --client-id=nicezeit --website-id=eisdiele-linden --hero-copy-only
 *     (only step 6: AI hero copy review; still writes websites.json when not --dry-run;
 *      then syncs changed hero strings to websites-{lang}.json via OpenRouter using
 *      translation.openRouter.model from language.config.json)
 *
 * When --website-id is omitted: non-interactive runs refine all sites; in a TTY you are
 * prompted to pick one site (or “All websites”), except a single-site client is auto-selected.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import * as dotenv from 'dotenv';
import { jsonrepair } from 'jsonrepair';
import {
  buildAiPrompt,
  buildProtectedPathsBlockForAi,
  getAiPromptSection,
} from './lib/ai-prompts';
import {
  augmentSystemPromptForBlock,
  loadAiBlockRegistry,
  partitionFillablePaths,
} from './lib/ai-block-registry';
import {
  AI_PROTECTED_PATHS,
  isAiFillablePath,
} from './lib/ai-protected-paths';
import { logOpenRouterChatResponse } from './lib/log-ai-cost.mjs';

const ROOT = process.cwd();
const DATA_ROOT = path.join(ROOT, 'src', 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
/** JSON reports from step 5 (AI content quality review) for tuning generation prompts. */
const CONTENT_QUALITY_REPORTS_DIR = path.join(
  ROOT,
  'tmp',
  'content-quality-reviews'
);
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const HTTP_TIMEOUT_MS = 10_000;

// Set to true at runtime via --verbose / -v
let VERBOSE = false;

type JsonObject = Record<string, unknown>;

type WebsiteFileShape =
  | JsonObject[]
  | (JsonObject & { websites?: JsonObject[] });

type HeaderLinkType = 'link' | 'button' | 'whatsapp';

interface ValidationArgs {
  clientId?: string;
  websiteId?: string;
  /** Refine every website for the client (skips interactive site selection in a TTY). */
  allWebsites: boolean;
  /** Run only the AI hero copy review step (skips steps 1–5). */
  heroCopyOnly: boolean;
  dryRun: boolean;
  verbose: boolean;
  noAi: boolean;
  skipHttpChecks: boolean;
}

interface LanguagesConfig {
  defaultLanguage: string;
  supportedLanguages: string[];
}

interface LinkCheckResult {
  valid: boolean;
  kind: 'internal' | 'external' | 'mailto' | 'tel' | 'anchor' | 'unknown';
  reason?: string;
  suggested?: string;
  httpUrl?: string;
}

interface HttpCheckResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface ValidationIssue {
  websiteId: string;
  level: 'info' | 'warning' | 'error';
  category:
    | 'empty-fields'
    | 'header-links'
    | 'hero-buttons'
    | 'images'
    | 'external-links'
    | 'ai'
    | 'content-quality'
    | 'hero-h1';
  message: string;
}

interface AvailableImages {
  siteId: string;
  all: string[];
  byCategory: Record<string, string[]>;
}

interface CollectedStringLocation {
  jsonPath: string;
  value: string;
  setValue: (next: string) => void;
}

interface HeroButtonAiSuggestion {
  index: number;
  verdict: 'ok' | 'improve' | 'replace' | 'remove';
  reason: string;
  text?: string;
  link?: string;
}

interface HeroButtonAiResponse {
  buttons: HeroButtonAiSuggestion[];
}

/** Source-language hero strings applied (or that would apply in dry-run). */
interface HeroCopyRewrite {
  path: string;
  value: string;
}

interface HeroCopyReviewResult {
  changed: boolean;
  rewrites: HeroCopyRewrite[];
}

interface TranslationFileConfig {
  model: string;
  chatUrl: string;
  sourceLanguage: string;
  targetLanguages: string[];
}

interface EmptyTextFillItem {
  path: string;
  value: string;
}

interface EmptyTextAiResponse {
  fills: EmptyTextFillItem[];
}

interface ExternalUrlReference {
  websiteId: string;
  source: string;
  url: string;
}

function parseArgs(): ValidationArgs {
  const args = process.argv.slice(2);
  let clientId: string | undefined;
  let websiteId: string | undefined;
  let allWebsites = false;
  let heroCopyOnly = false;
  let dryRun = false;
  let verbose = false;
  let noAi = false;
  let skipHttpChecks = false;

  for (const arg of args) {
    if (arg.startsWith('--client-id=')) {
      clientId = arg.replace('--client-id=', '').trim() || undefined;
    } else if (arg.startsWith('--website-id=')) {
      websiteId = arg.replace('--website-id=', '').trim() || undefined;
    } else if (arg === '--all-websites') {
      allWebsites = true;
    } else if (arg === '--hero-copy-only') {
      heroCopyOnly = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--no-ai') {
      noAi = true;
    } else if (arg === '--skip-http-checks') {
      skipHttpChecks = true;
    }
  }

  return {
    clientId,
    websiteId,
    allWebsites,
    heroCopyOnly,
    dryRun,
    verbose: verbose || dryRun,
    noAi,
    skipHttpChecks,
  };
}

function getAvailableClients(): string[] {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs
    .readdirSync(DATA_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'current' &&
        entry.name !== '_template' &&
        !entry.name.startsWith('.')
    )
    .map((entry) => entry.name)
    .filter((name) =>
      fs.existsSync(path.join(DATA_ROOT, name, 'websites.json'))
    )
    .sort();
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptClientId(): Promise<string> {
  const clients = getAvailableClients();
  if (clients.length === 0) {
    console.error('No client folders found in src/data/.');
    process.exit(1);
  }

  try {
    const { default: enquirer } = await import('enquirer');
    const answer = await enquirer.prompt<{ clientId: string }>({
      type: 'select',
      name: 'clientId',
      message: 'Which client should be validated?',
      choices: clients,
    });
    return answer.clientId;
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (
      e?.name === 'ExitPromptError' ||
      e?.message?.includes('User force closed')
    ) {
      process.exit(0);
    }
    throw err;
  }
}

function resolveClientId(cliClientId?: string): Promise<string> | string {
  if (cliClientId) return cliClientId;
  const envClientId = process.env.CLIENT_ID?.trim();
  if (envClientId) return envClientId;
  if (isInteractiveTerminal()) return promptClientId();
  console.error(
    'Non-interactive run: pass --client-id=<id> or set CLIENT_ID in environment.'
  );
  process.exit(1);
}

const ALL_WEBSITES_CHOICE = '__all_websites__';

async function promptWebsiteId(
  websites: JsonObject[]
): Promise<string | undefined> {
  if (websites.length === 0) {
    console.error('No websites found in websites.json.');
    process.exit(1);
  }

  const rows = websites.map((website, index) => {
    const id = getWebsiteId(website, index);
    const business = website.business as { name?: string } | undefined;
    const label = business?.name ? `${id} — ${business.name}` : id;
    return { id, label };
  });

  try {
    const { default: enquirer } = await import('enquirer');
    const answer = await enquirer.prompt<{ websiteId: string }>({
      type: 'select',
      name: 'websiteId',
      message: 'Which website should be refined?',
      choices: [
        ...rows.map((row) => ({
          name: row.id,
          message: row.label,
          hint: '',
        })),
        {
          name: ALL_WEBSITES_CHOICE,
          message: '— All websites (entire client)',
          hint: '',
        },
      ],
    });
    if (answer.websiteId === ALL_WEBSITES_CHOICE) return undefined;
    return answer.websiteId;
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (
      e?.name === 'ExitPromptError' ||
      e?.message?.includes('User force closed')
    ) {
      process.exit(0);
    }
    throw err;
  }
}

/**
 * @returns A specific website id, or `undefined` to refine every website in the client.
 */
async function resolveTargetWebsiteId(
  websites: JsonObject[],
  opts: { cliWebsiteId?: string; allWebsites: boolean }
): Promise<string | undefined> {
  const idFromCli = opts.cliWebsiteId?.trim();
  if (idFromCli) return idFromCli;
  if (opts.allWebsites) return undefined;
  if (websites.length === 0) {
    console.error('No websites found in websites.json.');
    process.exit(1);
  }
  if (websites.length === 1) {
    return getWebsiteId(websites[0], 0);
  }
  if (!isInteractiveTerminal()) return undefined;
  return promptWebsiteId(websites);
}

function normalizeDomain(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .replace(/\.$/, '');
}

function normalizePathname(pathname: string): string {
  if (!pathname) return '/';
  const out = pathname.trim();
  if (!out.startsWith('/')) return `/${out}`;
  if (out.length > 1 && out.endsWith('/')) return out.slice(0, -1);
  return out;
}

function parseWebsiteFile(filePath: string): {
  original: WebsiteFileShape;
  websites: JsonObject[];
} {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as WebsiteFileShape;
  if (Array.isArray(parsed)) {
    return { original: parsed, websites: parsed as JsonObject[] };
  }
  if (
    parsed &&
    Array.isArray((parsed as { websites?: JsonObject[] }).websites)
  ) {
    return {
      original: parsed,
      websites: (parsed as { websites: JsonObject[] }).websites,
    };
  }
  throw new Error('websites.json must be an array or { ..., websites: [] }');
}

function writeWebsiteFile(
  filePath: string,
  original: WebsiteFileShape,
  websites: JsonObject[]
): void {
  const payload = Array.isArray(original)
    ? websites
    : { ...(original as JsonObject), websites };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function loadLanguagesConfig(clientDataDir: string): LanguagesConfig {
  const configPath = path.join(clientDataDir, 'language.config.json');
  if (!fs.existsSync(configPath)) {
    return { defaultLanguage: 'de', supportedLanguages: ['de'] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      defaultLanguage?: string;
      supportedLanguages?: string[];
    };
    const supported = Array.isArray(parsed.supportedLanguages)
      ? parsed.supportedLanguages.filter(
          (lang): lang is string => typeof lang === 'string' && lang.length > 0
        )
      : ['de'];
    const defaultLanguage =
      typeof parsed.defaultLanguage === 'string' &&
      supported.includes(parsed.defaultLanguage)
        ? parsed.defaultLanguage
        : (supported[0] ?? 'de');
    return {
      defaultLanguage,
      supportedLanguages: supported.length > 0 ? supported : ['de'],
    };
  } catch {
    return { defaultLanguage: 'de', supportedLanguages: ['de'] };
  }
}

/** OpenRouter chat/completions URL; honors `translation.openRouter.baseUrl` shape from language.config.json. */
function resolveOpenRouterChatUrl(baseFromConfig?: string): string {
  if (!baseFromConfig?.trim()) return OPENROUTER_URL;
  const b = baseFromConfig.trim().replace(/\/$/, '');
  if (/\/chat\/completions$/i.test(b)) return b;
  return `${b}/chat/completions`;
}

/**
 * Translation settings for syncing hero edits into `websites-{lang}.json`.
 * Requires `translation.openRouter.model` and at least one target language.
 */
function loadTranslationFileConfig(
  clientDataDir: string,
  languages: LanguagesConfig
): TranslationFileConfig | null {
  const configPath = path.join(clientDataDir, 'language.config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      translation?: {
        sourceFile?: string;
        targetLanguages?: string[];
        openRouter?: { model?: string; baseUrl?: string };
      };
    };
    const model = parsed.translation?.openRouter?.model?.trim();
    if (!model) return null;

    const sourceLanguage = languages.defaultLanguage;
    const supported = languages.supportedLanguages;
    const fromConfig = parsed.translation?.targetLanguages;
    const targetLanguages =
      Array.isArray(fromConfig) && fromConfig.length > 0
        ? fromConfig.filter(
            (l): l is string =>
              typeof l === 'string' && l.length > 0 && l !== sourceLanguage
          )
        : supported.filter((l) => l !== sourceLanguage);

    if (targetLanguages.length === 0) return null;

    return {
      model,
      chatUrl: resolveOpenRouterChatUrl(
        parsed.translation?.openRouter?.baseUrl
      ),
      sourceLanguage,
      targetLanguages,
    };
  } catch {
    return null;
  }
}

/** Path to translated websites JSON for `targetLang` (same rules as `translate-data`). */
function resolveTranslatedWebsitesPath(
  clientDataDir: string,
  sourceFile: string,
  sourceLanguage: string,
  targetLang: string
): string {
  if (targetLang === sourceLanguage) {
    return path.join(clientDataDir, sourceFile);
  }
  const ext = path.extname(sourceFile);
  const base = path.basename(sourceFile, ext);
  if (base === 'websites') {
    return path.join(clientDataDir, `websites-${targetLang}.json`);
  }
  return path.join(clientDataDir, `${base}-${targetLang}.json`);
}

function getAiModel(clientDataDir: string): string {
  if (process.env.OPENROUTER_MODEL_DATA_VALIDATION?.trim()) {
    return process.env.OPENROUTER_MODEL_DATA_VALIDATION.trim();
  }
  if (process.env.OPENROUTER_MODEL_WEBSITE_GEN?.trim()) {
    return process.env.OPENROUTER_MODEL_WEBSITE_GEN.trim();
  }

  const configPath = path.join(clientDataDir, 'language.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        translation?: { openRouter?: { model?: string } };
      };
      const model = parsed.translation?.openRouter?.model?.trim();
      if (model) return model;
    } catch {
      // ignore
    }
  }

  return 'google/gemini-3-pro-preview';
}

function getWebsiteId(website: JsonObject, fallbackIndex: number): string {
  const rawId = website.id;
  if (typeof rawId === 'string' && rawId.trim()) return rawId.trim();
  return `website-${fallbackIndex}`;
}

function getWebsiteHosts(
  website: JsonObject,
  topLevelClientDomain = ''
): Set<string> {
  const hosts = new Set<string>();
  const deploy = normalizeDomain(
    typeof website.deployDomain === 'string' ? website.deployDomain : ''
  );
  const client = normalizeDomain(
    typeof website.clientDomain === 'string'
      ? website.clientDomain
      : topLevelClientDomain
  );
  if (deploy) hosts.add(deploy);
  if (client) hosts.add(client);
  return hosts;
}

function getPagesArray(website: JsonObject): JsonObject[] {
  if (!Array.isArray(website.pages)) return [];
  return website.pages.filter(
    (page): page is JsonObject =>
      typeof page === 'object' && page !== null && !Array.isArray(page)
  );
}

function getPageName(page: JsonObject): string {
  const value = page.name;
  return typeof value === 'string' ? value : '';
}

function buildValidInternalRoutes(
  website: JsonObject,
  supportedLanguages: string[]
): Set<string> {
  const routes = new Set<string>();
  const pageNames = getPagesArray(website)
    .map((page) => getPageName(page))
    .filter((name) => name.length > 0);

  for (const lang of supportedLanguages) {
    routes.add(normalizePathname(`/${lang}`));
    for (const pageName of pageNames) {
      if (pageName === 'home') continue;
      routes.add(normalizePathname(`/${lang}/${pageName}`));
    }
  }

  return routes;
}

function stripQueryAndHash(target: string): {
  pathname: string;
  search: string;
  hash: string;
} {
  const parsed = new URL(target, 'https://placeholder.local');
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

function withSearchAndHash(
  pathname: string,
  search: string,
  hash: string
): string {
  return `${pathname}${search}${hash}`;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizePhoneToE164(rawPhone: string): string {
  const trimmed = String(rawPhone ?? '').trim();
  if (!trimmed) return '';
  let digits = trimmed.replace(/[\s\-()\/]/g, '');
  if (digits.startsWith('00')) {
    digits = `+${digits.slice(2)}`;
  } else if (!digits.startsWith('+') && digits.startsWith('0')) {
    digits = `+49${digits.slice(1)}`;
  } else if (
    !digits.startsWith('+') &&
    digits.startsWith('49') &&
    digits.length >= 11
  ) {
    digits = `+${digits}`;
  } else if (!digits.startsWith('+')) {
    digits = `+49${digits}`;
  }
  return digits.replace(/[^\d+]/g, '');
}

function suggestLangPrefixedPath(
  pathname: string,
  search: string,
  hash: string,
  defaultLanguage: string,
  supportedLanguages: string[],
  validRoutes: Set<string>
): string | undefined {
  const normalized = normalizePathname(pathname);
  if (normalized === '/') {
    const candidate = normalizePathname(`/${defaultLanguage}`);
    if (validRoutes.has(candidate))
      return withSearchAndHash(candidate, search, hash);
    return undefined;
  }

  const firstSegment = normalized.split('/').filter(Boolean)[0];
  if (firstSegment && supportedLanguages.includes(firstSegment)) {
    return undefined;
  }

  const candidate = normalizePathname(`/${defaultLanguage}${normalized}`);
  if (validRoutes.has(candidate)) {
    return withSearchAndHash(candidate, search, hash);
  }

  return undefined;
}

/** Section keys that map to a stable `id="…"` on the home page layout (see PageContent + components). */
type LayoutSectionId =
  | 'hero'
  | 'info'
  | 'gallery'
  | 'team'
  | 'faq'
  | 'reviews'
  | 'map'
  | 'contact';

const SECTION_DOM_ID: Record<LayoutSectionId, string> = {
  hero: 'hero',
  info: 'info',
  gallery: 'gallery',
  team: 'team',
  faq: 'faq',
  reviews: 'reviews',
  map: 'map',
  contact: 'contact',
};

/** Lowercase fragment (without #) → layout section; matches FAQ accordion slugs separately. */
const FRAGMENT_TO_SECTION: Record<string, LayoutSectionId> = {
  hero: 'hero',
  info: 'info',
  leistungen: 'info',
  angebot: 'info',
  services: 'info',
  kontakt: 'contact',
  kontakte: 'contact',
  contact: 'contact',
  map: 'map',
  standort: 'map',
  anfahrt: 'map',
  lage: 'map',
  team: 'team',
  mitarbeiter: 'team',
  faq: 'faq',
  gallery: 'gallery',
  galerie: 'gallery',
  fotos: 'gallery',
  bilder: 'gallery',
  reviews: 'reviews',
  bewertungen: 'reviews',
  rezensionen: 'reviews',
};

interface LinkTargetContext {
  website: JsonObject;
  homePage: JsonObject;
}

function mergeHashIntoTarget(target: string, newHash: string): string {
  const h = newHash.startsWith('#') ? newHash : `#${newHash}`;
  const i = target.indexOf('#');
  if (i === -1) return `${target}${h}`;
  return target.slice(0, i) + h;
}

function isHomeLanguagePath(
  pathname: string,
  supportedLanguages: string[]
): boolean {
  const n = normalizePathname(pathname);
  if (!/^\/[a-z]{2}$/i.test(n)) return false;
  const lang = n.slice(1).toLowerCase();
  return supportedLanguages.some((l) => l.toLowerCase() === lang);
}

function isLayoutSectionVisible(
  website: JsonObject,
  section: LayoutSectionId
): boolean {
  const vis = website.sectionVisibility;
  if (!vis || typeof vis !== 'object' || Array.isArray(vis)) return true;
  const v = (vis as JsonObject)[section];
  return v !== false;
}

/** Same rules as `createSlug` in src/lib/utils (FAQ accordion item ids). */
function faqQuestionToSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[äöüß]/g, (match) => {
      const r: Record<string, string> = {
        ä: 'ae',
        ö: 'oe',
        ü: 'ue',
        ß: 'ss',
      };
      return r[match] || match;
    })
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function collectFaqItemSlugs(homePage: JsonObject): Set<string> {
  const faq = homePage.faq;
  if (!faq || typeof faq !== 'object' || Array.isArray(faq)) return new Set();
  const faqs = (faq as JsonObject).faqs;
  if (!Array.isArray(faqs)) return new Set();
  const out = new Set<string>();
  for (const item of faqs) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as JsonObject).question !== 'string'
    ) {
      continue;
    }
    out.add(faqQuestionToSlug((item as JsonObject).question as string));
  }
  return out;
}

/**
 * Validates a hash for same-page / home links: must match a visible section id or an FAQ item slug.
 */
function validateHomePageHash(
  hash: string,
  website: JsonObject,
  homePage: JsonObject,
  defaultLanguage: string
): { valid: boolean; reason?: string; normalizedHash?: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const id = raw.trim().toLowerCase();
  if (!id) {
    return { valid: false, reason: 'Empty hash fragment.' };
  }

  const section = FRAGMENT_TO_SECTION[id];
  if (section) {
    if (!isLayoutSectionVisible(website, section)) {
      return {
        valid: false,
        reason: `Section "${section}" is hidden; #${id} has no target on this site.`,
      };
    }
    const domId = SECTION_DOM_ID[section];
    if (id !== domId) {
      return {
        valid: false,
        reason: `Non-canonical anchor "#${id}"; the layout exposes "#${domId}".`,
        normalizedHash: `#${domId}`,
      };
    }
    return { valid: true };
  }

  if (isLayoutSectionVisible(website, 'faq')) {
    const slugs = collectFaqItemSlugs(homePage);
    if (slugs.has(id)) return { valid: true };
  }

  const contactOk = isLayoutSectionVisible(website, 'contact');
  return {
    valid: false,
    reason: `Unknown in-page anchor "#${id}".`,
    normalizedHash: contactOk ? '#contact' : `/${defaultLanguage}`,
  };
}

function checkLinkTarget(
  target: string,
  websiteHosts: Set<string>,
  defaultLanguage: string,
  supportedLanguages: string[],
  validRoutes: Set<string>,
  pageContext?: LinkTargetContext | null
): LinkCheckResult {
  const value = target.trim();
  if (!value) {
    return { valid: false, kind: 'unknown', reason: 'Link is empty.' };
  }

  if (value.startsWith('#')) {
    if (!pageContext) {
      return {
        valid: false,
        kind: 'anchor',
        reason:
          'Hash-only link cannot be validated without home page context (internal pipeline error).',
      };
    }
    const frag = validateHomePageHash(
      value,
      pageContext.website,
      pageContext.homePage,
      defaultLanguage
    );
    if (frag.valid) return { valid: true, kind: 'anchor' };
    if (frag.normalizedHash) {
      const suggested =
        frag.normalizedHash.startsWith('/') &&
        !frag.normalizedHash.startsWith('//')
          ? frag.normalizedHash
          : mergeHashIntoTarget(value, frag.normalizedHash);
      return {
        valid: false,
        kind: 'anchor',
        reason: frag.reason,
        suggested,
      };
    }
    return { valid: false, kind: 'anchor', reason: frag.reason };
  }

  if (/^mailto:/i.test(value)) {
    const email = value.replace(/^mailto:/i, '').trim();
    if (!looksLikeEmail(email)) {
      return {
        valid: false,
        kind: 'mailto',
        reason: 'Invalid mailto email format.',
      };
    }
    return { valid: true, kind: 'mailto' };
  }

  if (/^tel:/i.test(value)) {
    const phone = value.replace(/^tel:/i, '').trim();
    const digits = phone.replace(/[^\d]/g, '');
    if (digits.length < 6) {
      return {
        valid: false,
        kind: 'tel',
        reason: 'Phone link has too few digits.',
      };
    }
    return { valid: true, kind: 'tel' };
  }

  if (value.startsWith('/')) {
    const { pathname, search, hash } = stripQueryAndHash(value);
    const normalized = normalizePathname(pathname);
    if (validRoutes.has(normalized)) {
      if (
        hash &&
        pageContext &&
        isHomeLanguagePath(normalized, supportedLanguages)
      ) {
        const frag = validateHomePageHash(
          hash,
          pageContext.website,
          pageContext.homePage,
          defaultLanguage
        );
        if (!frag.valid) {
          if (frag.normalizedHash) {
            const merged = mergeHashIntoTarget(value, frag.normalizedHash);
            return {
              valid: false,
              kind: 'internal',
              reason: frag.reason,
              suggested: merged,
            };
          }
          return {
            valid: false,
            kind: 'internal',
            reason: frag.reason,
          };
        }
      }
      return { valid: true, kind: 'internal' };
    }
    const suggested = suggestLangPrefixedPath(
      normalized,
      search,
      hash,
      defaultLanguage,
      supportedLanguages,
      validRoutes
    );
    return {
      valid: false,
      kind: 'internal',
      reason: `Internal route "${normalized}" does not exist for this website.`,
      suggested,
    };
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const host = normalizeDomain(url.host);
      if (websiteHosts.has(host)) {
        const normalized = normalizePathname(url.pathname);
        if (validRoutes.has(normalized)) {
          if (
            url.hash &&
            pageContext &&
            isHomeLanguagePath(normalized, supportedLanguages)
          ) {
            const frag = validateHomePageHash(
              url.hash,
              pageContext.website,
              pageContext.homePage,
              defaultLanguage
            );
            if (!frag.valid) {
              if (frag.normalizedHash) {
                const nh = frag.normalizedHash;
                const suggested =
                  nh.startsWith('/') && !nh.startsWith('//')
                    ? `${url.origin}${nh}`
                    : mergeHashIntoTarget(
                        `${url.origin}${url.pathname}${url.search}`,
                        nh
                      );
                return {
                  valid: false,
                  kind: 'internal',
                  reason: frag.reason,
                  suggested,
                };
              }
              return {
                valid: false,
                kind: 'internal',
                reason: frag.reason,
              };
            }
          }
          return { valid: true, kind: 'internal' };
        }
        const suggested = suggestLangPrefixedPath(
          normalized,
          url.search,
          url.hash,
          defaultLanguage,
          supportedLanguages,
          validRoutes
        );
        return {
          valid: false,
          kind: 'internal',
          reason: `Absolute internal route "${normalized}" does not exist for this website.`,
          suggested,
        };
      }
      return { valid: true, kind: 'external', httpUrl: value };
    } catch {
      return {
        valid: false,
        kind: 'external',
        reason: 'External URL is malformed.',
      };
    }
  }

  const { pathname, search, hash } = stripQueryAndHash(`/${value}`);
  const normalized = normalizePathname(pathname);
  if (validRoutes.has(normalized)) {
    if (
      hash &&
      pageContext &&
      isHomeLanguagePath(normalized, supportedLanguages)
    ) {
      const frag = validateHomePageHash(
        hash,
        pageContext.website,
        pageContext.homePage,
        defaultLanguage
      );
      if (!frag.valid) {
        if (frag.normalizedHash) {
          const pathPart = withSearchAndHash(normalized, search, '');
          const merged = mergeHashIntoTarget(pathPart, frag.normalizedHash);
          return {
            valid: false,
            kind: 'internal',
            reason: frag.reason,
            suggested: merged,
          };
        }
        return { valid: false, kind: 'internal', reason: frag.reason };
      }
    }
    return {
      valid: true,
      kind: 'internal',
      suggested: withSearchAndHash(normalized, search, hash),
    };
  }
  const suggested = suggestLangPrefixedPath(
    normalized,
    search,
    hash,
    defaultLanguage,
    supportedLanguages,
    validRoutes
  );
  return {
    valid: false,
    kind: 'unknown',
    reason: `Link "${value}" is not a valid URL or known internal route.`,
    suggested,
  };
}

function getHeaderLinks(website: JsonObject): JsonObject[] {
  const header = website.header;
  if (!header || typeof header !== 'object' || Array.isArray(header)) return [];
  const links = (header as JsonObject).links;
  if (!Array.isArray(links)) return [];
  return links.filter(
    (item): item is JsonObject =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
  );
}
// High-level: This function validates and normalizes all links in a website's "header.links" array.
// It checks that each link is present, well-formed, and matches expected URL or internal route formats.
// Invalid or missing links are reported to the `issues` array with appropriate severity,
// and external links are recorded in `externalRefs`. The function may also auto-correct
// certain problems (unless in dryRun mode), and reports if any changes were made.

function checkHeaderLinksForWebsite(
  website: JsonObject,
  websiteId: string,
  websiteHosts: Set<string>,
  defaultLanguage: string,
  supportedLanguages: string[],
  validRoutes: Set<string>,
  issues: ValidationIssue[],
  externalRefs: ExternalUrlReference[],
  dryRun: boolean
): boolean {
  // Collect links from website header. Return false if nothing to do.
  const links = getHeaderLinks(website);
  const home = getHomePage(website);
  const pageCtx: LinkTargetContext | null = home
    ? { website, homePage: home }
    : null;
  let changed = false;

  for (let index = 0; index < links.length; index++) {
    const link = links[index];
    // Determine the type for reporting, default to 'link' if missing.
    const type =
      typeof link.type === 'string'
        ? (link.type as HeaderLinkType)
        : ('link' as HeaderLinkType);

    // Skip WhatsApp links from URL validation.
    if (type === 'whatsapp') {
      continue;
    }

    // Migrate legacy 'url' property to 'href' if present and needed.
    if (typeof link.href !== 'string' && typeof link.url === 'string') {
      if (!dryRun) link.href = link.url;
      changed = true;
      issues.push({
        websiteId,
        level: 'info',
        category: 'header-links',
        message: `header.links[${index}] normalized from "url" to "href".`,
      });
    }

    // Get the link target to validate: prefer 'href', fallback to 'url' or ''.
    const target =
      typeof link.href === 'string'
        ? link.href
        : typeof link.url === 'string'
          ? link.url
          : '';

    if (!target.trim()) {
      // Empty link: warn user.
      issues.push({
        websiteId,
        level: 'warning',
        category: 'header-links',
        message: `header.links[${index}] (${type}) has an empty link target.`,
      });
      continue;
    }

    // Validate the link: check syntax and if it's a recognized route or external URL.
    const check = checkLinkTarget(
      target,
      websiteHosts,
      defaultLanguage,
      supportedLanguages,
      validRoutes,
      pageCtx
    );

    if (!check.valid) {
      // If a suggested fix exists, apply it (if not dryRun) and warn.
      if (check.suggested) {
        if (!dryRun) {
          link.href = check.suggested;
        }
        changed = true;
        issues.push({
          websiteId,
          level: 'warning',
          category: 'header-links',
          message: `header.links[${index}] had invalid target "${target}" → corrected to "${check.suggested}".`,
        });
      } else {
        // No suggested fix: report error.
        issues.push({
          websiteId,
          level: 'error',
          category: 'header-links',
          message: `header.links[${index}] invalid: ${check.reason ?? 'unknown reason'} (${target})`,
        });
      }
    } else if (check.kind === 'external' && check.httpUrl) {
      // Valid external link: record it for cross-reference checking.
      externalRefs.push({
        websiteId,
        source: `header.links[${index}]`,
        url: check.httpUrl,
      });
    }
  }

  // Return whether automatic changes (normalizations/fixes) were performed.
  return changed;
}

function getHomePage(website: JsonObject): JsonObject | null {
  const pages = getPagesArray(website);
  const explicitHome = pages.find((page) => getPageName(page) === 'home');
  return explicitHome ?? pages[0] ?? null;
}

function getHomePageIndex(website: JsonObject): number {
  const pages = getPagesArray(website);
  const idx = pages.findIndex((page) => getPageName(page) === 'home');
  if (idx >= 0) return idx;
  return 0;
}

/** Same normalization as clone-website hero H1 uniqueness checks. */
function normalizeHeroH1ForUniqueness(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function getHomeHeroH1Raw(website: JsonObject): string {
  const home = getHomePage(website);
  if (
    !home?.hero ||
    typeof home.hero !== 'object' ||
    Array.isArray(home.hero)
  ) {
    return '';
  }
  const h1 = (home.hero as JsonObject).h1;
  return typeof h1 === 'string' ? h1 : '';
}

function listConflictingSiteIdsForHeroH1(
  currentId: string,
  h1: string,
  allWebsites: JsonObject[]
): string[] {
  const key = normalizeHeroH1ForUniqueness(h1);
  if (!key) return [];
  const out: string[] = [];
  for (const w of allWebsites) {
    const wid = getWebsiteId(w, -1);
    if (wid === currentId) continue;
    const other = normalizeHeroH1ForUniqueness(getHomeHeroH1Raw(w));
    if (other && other === key) out.push(wid);
  }
  return out;
}

function collectForbiddenHeroH1sFromOtherSites(
  allWebsites: JsonObject[],
  currentId: string
): string[] {
  const out: string[] = [];
  for (const w of allWebsites) {
    const wid = getWebsiteId(w, -1);
    if (wid === currentId) continue;
    const raw = getHomeHeroH1Raw(w);
    if (normalizeHeroH1ForUniqueness(raw)) out.push(raw);
  }
  return out;
}

interface HeroH1DedupeAiResponse {
  h1?: unknown;
}

/**
 * If this site's home hero H1 matches another site's (trim + collapse whitespace),
 * rewrite via AI or warn when AI is unavailable.
 */
async function ensureUniqueHeroH1ForClientSite(
  website: JsonObject,
  websiteId: string,
  clientId: string,
  allClientWebsites: JsonObject[],
  apiKey: string,
  model: string,
  issues: ValidationIssue[],
  dryRun: boolean,
  aiEnabled: boolean
): Promise<{ changed: boolean; rewrites: HeroCopyRewrite[] }> {
  const currentH1 = getHomeHeroH1Raw(website);
  if (!normalizeHeroH1ForUniqueness(currentH1)) {
    return { changed: false, rewrites: [] };
  }

  const conflicts = listConflictingSiteIdsForHeroH1(
    websiteId,
    currentH1,
    allClientWebsites
  );
  if (conflicts.length === 0) {
    return { changed: false, rewrites: [] };
  }

  issues.push({
    websiteId,
    level: 'warning',
    category: 'hero-h1',
    message: `Hero H1 duplicates other site(s) (${conflicts.join(', ')}) — same text as another location after normalizing whitespace.`,
  });

  if (!aiEnabled || !apiKey.trim()) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'hero-h1',
      message:
        'Set OPENROUTER_API_KEY and run without --no-ai to auto-generate a unique hero H1.',
    });
    return { changed: false, rewrites: [] };
  }

  const homeIdx = getHomePageIndex(website);
  const forbiddenH1s = collectForbiddenHeroH1sFromOtherSites(
    allClientWebsites,
    websiteId
  );
  const forbiddenKeys = new Set(
    forbiddenH1s.map((h) => normalizeHeroH1ForUniqueness(h))
  );

  const promptMarkdown = loadPromptForSite(clientId, websiteId);
  const topicsContent = loadTopicsForSite(clientId, websiteId);
  const websites0WebsiteBriefing =
    getPrimaryWebsiteBriefingFromWebsitesJson(allClientWebsites);

  const business = getBusinessObject(website);
  const businessContext = {
    name: business.name ?? '',
    brandName: business.brandName ?? '',
    legalName: business.legalName ?? '',
    location: business.location ?? {},
    openingHours: business.openingHours ?? {},
  };

  const systemPrompt = buildAiPrompt('hero-h1-dedupe', {});

  let newH1: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const userPayload: Record<string, unknown> = {
      websiteId,
      conflictingSiteIds: conflicts,
      currentH1,
      forbiddenH1s,
      business: businessContext,
      ...(promptMarkdown.trim() ? { promptMarkdown } : {}),
      ...(topicsContent.trim() ? { topicsContent } : {}),
      ...(websites0WebsiteBriefing
        ? { websites0WebsiteBriefing }
        : {}),
    };
    if (attempt > 0) {
      userPayload.retryNote =
        'The previous headline still matched a forbidden string or was too similar. Output a clearly different wording.';
    }

    try {
      const response = await callOpenRouterJson<HeroH1DedupeAiResponse>(
        apiKey,
        model,
        systemPrompt,
        JSON.stringify(userPayload, null, 2),
        512,
        attempt === 0 ? 'hero-h1-dedupe' : 'hero-h1-dedupe-retry'
      );
      const raw =
        typeof response?.h1 === 'string' ? response.h1.trim() : '';
      if (!raw) continue;
      const cleaned = raw
        .replace(/\s+/g, ' ')
        .replace(/^["'„“”«»]+|["'„“”«»]+$/g, '')
        .replace(/[.!?]+$/g, '')
        .trim();
      if (cleaned.length < 10) continue;
      const key = normalizeHeroH1ForUniqueness(cleaned);
      if (!forbiddenKeys.has(key)) {
        newH1 = cleaned;
        break;
      }
    } catch {
      /* try retry */
    }
  }

  if (!newH1) {
    issues.push({
      websiteId,
      level: 'error',
      category: 'hero-h1',
      message:
        'Could not generate a unique hero H1 — duplicate headline may remain. Edit manually.',
    });
    return { changed: false, rewrites: [] };
  }

  const path = `pages[${homeIdx}].hero.h1`;
  if (!dryRun) {
    setValueAtPath(website, path, newH1);
  }

  issues.push({
    websiteId,
    level: 'info',
    category: 'hero-h1',
    message: `Hero H1 rewritten for uniqueness (${dryRun ? 'dry-run' : 'saved'}): "${newH1.length > 90 ? `${newH1.slice(0, 90)}…` : newH1}"`,
  });

  return {
    changed: true,
    rewrites: [{ path, value: newH1 }],
  };
}

function getPrimaryWebsiteBriefingFromWebsitesJson(
  allWebsites: JsonObject[]
): string {
  const first = allWebsites[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '';
  const raw = first.websiteBriefing;
  return typeof raw === 'string' ? raw.trim() : '';
}

function getHeroButtons(homePage: JsonObject): JsonObject[] {
  const hero = homePage.hero;
  if (!hero || typeof hero !== 'object' || Array.isArray(hero)) return [];
  const buttons = (hero as JsonObject).buttons;
  if (!Array.isArray(buttons)) return [];
  return buttons.filter(
    (item): item is JsonObject =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
  );
}

function guessButtonLinkFromContext(
  text: string,
  business: JsonObject,
  defaultLanguage: string
): string | undefined {
  const lower = text.toLowerCase();
  const bookingUrl =
    typeof business.bookingUrl === 'string' ? business.bookingUrl.trim() : '';
  const email = typeof business.email === 'string' ? business.email.trim() : '';
  const phone = typeof business.phone === 'string' ? business.phone.trim() : '';

  if (
    /(buchen|buchung|termin|anfrage|anfragen|reservieren|verfugbarkeit|verfügbarkeit)/i.test(
      lower
    ) &&
    bookingUrl
  ) {
    return bookingUrl;
  }
  if (/(mail|email|e-mail|kontakt|anfrage)/i.test(lower) && email) {
    return `mailto:${email}`;
  }
  if (/(anrufen|telefon|call|jetzt anrufen|rufen)/i.test(lower) && phone) {
    const normalizedPhone = normalizePhoneToE164(phone);
    if (normalizedPhone) return `tel:${normalizedPhone}`;
  }
  if (bookingUrl) return bookingUrl;
  if (email) return `mailto:${email}`;
  if (phone) {
    const normalizedPhone = normalizePhoneToE164(phone);
    if (normalizedPhone) return `tel:${normalizedPhone}`;
  }
  return `/${defaultLanguage}#contact`;
}

function guessButtonTextFromLink(link: string): string | undefined {
  if (/^mailto:/i.test(link)) return 'Jetzt anfragen';
  if (/^tel:/i.test(link)) return 'Jetzt anrufen';
  if (/^https?:\/\//i.test(link)) return 'Jetzt informieren';
  if (link.startsWith('/')) return 'Mehr erfahren';
  return undefined;
}

function checkHeroButtonsForWebsite(
  website: JsonObject,
  websiteId: string,
  websiteHosts: Set<string>,
  defaultLanguage: string,
  supportedLanguages: string[],
  validRoutes: Set<string>,
  issues: ValidationIssue[],
  externalRefs: ExternalUrlReference[],
  dryRun: boolean
): boolean {
  const home = getHomePage(website);
  if (!home) return false;
  const pageCtx: LinkTargetContext = { website, homePage: home };
  const buttons = getHeroButtons(home);
  const business =
    website.business &&
    typeof website.business === 'object' &&
    !Array.isArray(website.business)
      ? (website.business as JsonObject)
      : {};

  let changed = false;
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index];
    const text = typeof button.text === 'string' ? button.text.trim() : '';
    const link = typeof button.link === 'string' ? button.link.trim() : '';

    if (!text && link) {
      const suggestedText = guessButtonTextFromLink(link);
      if (suggestedText) {
        if (!dryRun) button.text = suggestedText;
        changed = true;
        issues.push({
          websiteId,
          level: 'warning',
          category: 'hero-buttons',
          message: `hero.buttons[${index}] missing text → set to "${suggestedText}".`,
        });
      } else {
        issues.push({
          websiteId,
          level: 'warning',
          category: 'hero-buttons',
          message: `hero.buttons[${index}] has no text.`,
        });
      }
    }

    if (!link) {
      const fallbackLink = guessButtonLinkFromContext(
        text,
        business,
        defaultLanguage
      );
      if (fallbackLink) {
        if (!dryRun) button.link = fallbackLink;
        changed = true;
        issues.push({
          websiteId,
          level: 'warning',
          category: 'hero-buttons',
          message: `hero.buttons[${index}] missing link → set to "${fallbackLink}".`,
        });
      } else {
        issues.push({
          websiteId,
          level: 'error',
          category: 'hero-buttons',
          message: `hero.buttons[${index}] has empty link and no fallback could be derived.`,
        });
      }
      continue;
    }

    const check = checkLinkTarget(
      link,
      websiteHosts,
      defaultLanguage,
      supportedLanguages,
      validRoutes,
      pageCtx
    );
    if (!check.valid) {
      if (check.suggested) {
        if (!dryRun) button.link = check.suggested;
        changed = true;
        issues.push({
          websiteId,
          level: 'warning',
          category: 'hero-buttons',
          message: `hero.buttons[${index}] invalid link "${link}" → corrected to "${check.suggested}".`,
        });
      } else {
        const fallbackLink = guessButtonLinkFromContext(
          text,
          business,
          defaultLanguage
        );
        if (fallbackLink) {
          if (!dryRun) button.link = fallbackLink;
          changed = true;
          issues.push({
            websiteId,
            level: 'warning',
            category: 'hero-buttons',
            message: `hero.buttons[${index}] invalid link "${link}" → fallback "${fallbackLink}".`,
          });
        } else {
          issues.push({
            websiteId,
            level: 'error',
            category: 'hero-buttons',
            message: `hero.buttons[${index}] invalid link "${link}" (${check.reason ?? 'unknown reason'}).`,
          });
        }
      }
    } else if (check.kind === 'external' && check.httpUrl) {
      externalRefs.push({
        websiteId,
        source: `hero.buttons[${index}]`,
        url: check.httpUrl,
      });
    }
  }

  return changed;
}

function getFirstLanguagelessInternalRoute(
  validRoutes: Set<string>
): string | undefined {
  const candidates = Array.from(validRoutes)
    .filter((route) => route !== '/' && /^\/[a-z]{2}(\/|$)/i.test(route))
    .sort();
  if (candidates.length === 0) return undefined;
  const first = candidates[0];
  return first.replace(/^\/[a-z]{2}(?=\/|$)/i, '') || '/';
}

function validateHeaderStructure(
  website: JsonObject,
  websiteId: string,
  validRoutes: Set<string>,
  issues: ValidationIssue[],
  dryRun: boolean
): boolean {
  const links = getHeaderLinks(website);
  let changed = false;
  if (links.length === 0) return false;

  // Validate first two navigation links based on project convention.
  const expected = [
    { index: 0, expectedLabel: 'Über uns', fallbackRoute: '/ueber-uns' },
    { index: 1, expectedLabel: 'FAQ', fallbackRoute: '/faq' },
  ];

  const hasRoute = (route: string): boolean => {
    const normalized = normalizePathname(route);
    if (validRoutes.has(normalized)) return true;
    return Array.from(validRoutes).some((entry) => entry.endsWith(normalized));
  };

  for (const cfg of expected) {
    const link = links[cfg.index];
    if (!link) continue;
    const label = typeof link.label === 'string' ? link.label.trim() : '';
    const href = typeof link.href === 'string' ? link.href.trim() : '';
    const routeIsExpected = hasRoute(cfg.fallbackRoute);
    if (!routeIsExpected) continue;
    if (!label) {
      if (!dryRun) link.label = cfg.expectedLabel;
      changed = true;
      issues.push({
        websiteId,
        level: 'warning',
        category: 'header-links',
        message: `header.links[${cfg.index}] label was empty → set to "${cfg.expectedLabel}".`,
      });
    } else if (
      cfg.index === 0 &&
      !/(über uns|ueber uns|über\s?uns|ueber\s?uns)/i.test(label)
    ) {
      issues.push({
        websiteId,
        level: 'warning',
        category: 'header-links',
        message: `header.links[0] label "${label}" should typically reference "Über uns".`,
      });
    } else if (cfg.index === 1 && !/faq/i.test(label)) {
      issues.push({
        websiteId,
        level: 'warning',
        category: 'header-links',
        message: `header.links[1] label "${label}" should typically reference "FAQ".`,
      });
    }

    if (!href) {
      const preferred = getFirstLanguagelessInternalRoute(
        new Set(
          Array.from(validRoutes).filter((route) =>
            route.endsWith(cfg.fallbackRoute)
          )
        )
      );
      const fallback = preferred ?? cfg.fallbackRoute;
      if (!dryRun) link.href = fallback;
      changed = true;
      issues.push({
        websiteId,
        level: 'warning',
        category: 'header-links',
        message: `header.links[${cfg.index}] href was empty → set to "${fallback}".`,
      });
    }
  }

  // Ensure CTA and WhatsApp slots exist and are semantically typed.
  const ensureTypeAtIndex = (
    index: number,
    type: HeaderLinkType,
    defaultLabel: string
  ): void => {
    const existing = links[index];
    if (!existing) return;
    const before = typeof existing.type === 'string' ? existing.type : 'link';
    if (before !== type) {
      if (!dryRun) existing.type = type;
      changed = true;
      issues.push({
        websiteId,
        level: 'warning',
        category: 'header-links',
        message: `header.links[${index}] type "${before}" → "${type}" to match expected header structure.`,
      });
    }
    if (typeof existing.label !== 'string' || !existing.label.trim()) {
      if (!dryRun) existing.label = defaultLabel;
      changed = true;
      issues.push({
        websiteId,
        level: 'warning',
        category: 'header-links',
        message: `header.links[${index}] label was empty → "${defaultLabel}".`,
      });
    }
  };

  ensureTypeAtIndex(2, 'button', 'Kontakt');
  ensureTypeAtIndex(3, 'whatsapp', 'WhatsApp');

  return changed;
}

function extractJsonFromResponse(content: string): string {
  const trimmed = content.trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(trimmed);
  if (codeBlock) return codeBlock[1].trim();
  return trimmed;
}

/**
 * First balanced `{ ... }` slice (ignores braces inside strings). Helps when the
 * model appends text after valid JSON.
 */
function extractFirstJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  if (start === -1) return raw;
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '\\' && inString) {
      i++;
      continue;
    }
    if (raw[i] === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (raw[i] === '{') depth++;
    if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}

/** Same pipeline as 06-generate-website: parse → balanced slice → jsonrepair. */
function parseAiResponseJson<T>(rawContent: string): T {
  const extracted = extractJsonFromResponse(rawContent);

  const tryParse = (s: string): T => JSON.parse(s) as T;

  try {
    return tryParse(extracted);
  } catch (firstErr) {
    const firstObj = extractFirstJsonObject(extracted);
    try {
      return tryParse(firstObj);
    } catch {
      try {
        const repaired = jsonrepair(firstObj);
        return tryParse(repaired);
      } catch (repairErr) {
        const hint =
          repairErr instanceof Error ? repairErr.message : String(repairErr);
        const orig =
          firstErr instanceof Error ? firstErr.message : String(firstErr);
        throw new Error(
          `AI JSON parse failed (${orig}; repair: ${hint}). Snippet: ${extracted.slice(0, 280)}${extracted.length > 280 ? '…' : ''}`
        );
      }
    }
  }
}

async function callOpenRouterJson<T>(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 32000,
  operation = 'openRouter-json',
  chatCompletionsUrl: string | undefined = undefined
): Promise<T> {
  const url = chatCompletionsUrl ?? OPENROUTER_URL;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: maxTokens,
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

  const parsed = (await response.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
      prompt_tokens_cost?: number;
      completion_tokens_cost?: number;
    };
  };
  logOpenRouterChatResponse({
    script: '08-refine-website-data',
    operation,
    model,
    usage: parsed.usage ?? null,
    generationId: parsed.id ?? null,
  });
  const content = parsed.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response missing choices[0].message.content');
  }

  return parseAiResponseJson<T>(content);
}

function getBusinessObject(website: JsonObject): JsonObject {
  return website.business &&
    typeof website.business === 'object' &&
    !Array.isArray(website.business)
    ? (website.business as JsonObject)
    : {};
}

function getHeroSubtitle(homePage: JsonObject): string {
  const hero =
    homePage.hero &&
    typeof homePage.hero === 'object' &&
    !Array.isArray(homePage.hero)
      ? (homePage.hero as JsonObject)
      : {};
  return typeof hero.subtitle === 'string' ? hero.subtitle : '';
}

async function aiReviewHeroButtons(
  website: JsonObject,
  websiteId: string,
  defaultLanguage: string,
  apiKey: string,
  model: string
): Promise<HeroButtonAiSuggestion[]> {
  const homePage = getHomePage(website);
  if (!homePage) return [];
  const buttons = getHeroButtons(homePage).map((button, index) => ({
    index,
    text: typeof button.text === 'string' ? button.text : '',
    link: typeof button.link === 'string' ? button.link : '',
    variant: typeof button.variant === 'string' ? button.variant : '',
  }));
  if (buttons.length === 0) return [];

  const business = getBusinessObject(website);

  const systemPrompt = buildAiPrompt('hero-buttons', {
    DEFAULT_LANGUAGE: defaultLanguage,
  });

  const userPrompt = JSON.stringify(
    {
      websiteId,
      business: {
        name: business.name ?? '',
        brandName: business.brandName ?? '',
        location: business.location ?? {},
        bookingUrl: business.bookingUrl ?? '',
        email: business.email ?? '',
        phone: business.phone ?? '',
      },
      heroSubtitle: getHeroSubtitle(homePage),
      buttons,
    },
    null,
    2
  );

  const response = await callOpenRouterJson<HeroButtonAiResponse>(
    apiKey,
    model,
    systemPrompt,
    userPrompt,
    2048,
    'hero-buttons'
  );

  if (!response || !Array.isArray(response.buttons)) return [];
  return response.buttons.filter(
    (item): item is HeroButtonAiSuggestion =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.index === 'number' &&
      typeof item.verdict === 'string' &&
      typeof item.reason === 'string'
  );
}

function applyHeroButtonAiSuggestions(
  website: JsonObject,
  websiteId: string,
  suggestions: HeroButtonAiSuggestion[],
  issues: ValidationIssue[],
  dryRun: boolean
): boolean {
  const homePage = getHomePage(website);
  if (!homePage) return false;
  const buttons = getHeroButtons(homePage);
  if (buttons.length === 0) return false;
  let changed = false;

  for (const suggestion of suggestions) {
    const target = buttons[suggestion.index];
    if (!target) continue;
    if (suggestion.verdict === 'ok' || suggestion.verdict === 'remove') {
      continue;
    }
    const hasText =
      typeof suggestion.text === 'string' && suggestion.text.trim().length > 0;
    const hasLink =
      typeof suggestion.link === 'string' && suggestion.link.trim().length > 0;
    if (!hasText && !hasLink) continue;

    const beforeText = typeof target.text === 'string' ? target.text : '';
    const beforeLink = typeof target.link === 'string' ? target.link : '';

    if (hasText && suggestion.text!.trim() !== beforeText.trim()) {
      if (!dryRun) target.text = suggestion.text!.trim();
      changed = true;
    }
    if (hasLink && suggestion.link!.trim() !== beforeLink.trim()) {
      if (!dryRun) target.link = suggestion.link!.trim();
      changed = true;
    }

    if (changed) {
      issues.push({
        websiteId,
        level: 'info',
        category: 'ai',
        message: `AI refined hero.buttons[${suggestion.index}] (${suggestion.verdict}): ${suggestion.reason}`,
      });
    }
  }

  return changed;
}

function findEmptyFields(obj: unknown, jsonPath = ''): string[] {
  const emptyPaths: string[] = [];
  if (obj === null || obj === undefined) return emptyPaths;

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      emptyPaths.push(jsonPath);
      return emptyPaths;
    }
    obj.forEach((item, index) => {
      if (typeof item === 'object' && item !== null) {
        emptyPaths.push(...findEmptyFields(item, `${jsonPath}[${index}]`));
      }
    });
    return emptyPaths;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as JsonObject)) {
      const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (typeof value === 'string' && value === '') {
        if (key === 'faqDataFile') continue;
        emptyPaths.push(keyPath);
      } else if (Array.isArray(value) && value.length === 0) {
        emptyPaths.push(keyPath);
      } else if (typeof value === 'number' && value === 0) {
        emptyPaths.push(keyPath);
      } else if (typeof value === 'object' && value !== null) {
        emptyPaths.push(...findEmptyFields(value, keyPath));
      }
    }
  }

  return emptyPaths;
}

function collectEmptyTextPaths(obj: unknown, jsonPath = ''): string[] {
  const out: string[] = [];
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      if (typeof item === 'object' && item !== null) {
        out.push(...collectEmptyTextPaths(item, `${jsonPath}[${index}]`));
      }
    });
    return out;
  }
  if (typeof obj !== 'object') return out;

  for (const [key, value] of Object.entries(obj as JsonObject)) {
    const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
    if (
      typeof value === 'string' &&
      value.trim() === '' &&
      isAiFillablePath(keyPath)
    ) {
      out.push(keyPath);
    } else if (typeof value === 'object' && value !== null) {
      out.push(...collectEmptyTextPaths(value, keyPath));
    }
  }
  return out;
}

function parsePathSegments(pathValue: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const parts = pathValue.split('.');
  for (const part of parts) {
    const regex = /([^[\]]+)|\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(part)) !== null) {
      if (match[1]) {
        segments.push(match[1]);
      } else if (match[2]) {
        segments.push(Number(match[2]));
      }
    }
  }
  return segments;
}

function getValueAtPath(root: unknown, pathValue: string): unknown {
  const segments = parsePathSegments(pathValue);
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current))
        return undefined;
      current = (current as JsonObject)[segment];
    }
  }
  return current;
}

function setValueAtPath(
  root: unknown,
  pathValue: string,
  nextValue: unknown
): boolean {
  const segments = parsePathSegments(pathValue);
  if (segments.length === 0) return false;
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return false;
      if (current[segment] === undefined) current[segment] = {};
      current = current[segment];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current))
        return false;
      const record = current as JsonObject;
      if (record[segment] === undefined) record[segment] = {};
      current = record[segment];
    }
  }
  const last = segments[segments.length - 1];
  if (typeof last === 'number') {
    if (!Array.isArray(current)) return false;
    current[last] = nextValue;
    return true;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current))
    return false;
  (current as JsonObject)[last] = nextValue;
  return true;
}

const AI_FILL_BATCH_SIZE = 40;
const AI_FILL_CONCURRENCY = 5;

async function aiFillBatch(
  batchPaths: string[],
  systemPrompt: string,
  sharedContext: {
    websiteId: string;
    defaultLanguage: string;
    business: Record<string, unknown>;
    pages: { name: string; pageTitle: string }[];
    homeHero: Record<string, unknown>;
    promptMarkdown: string;
    websiteBriefing?: string;
  },
  apiKey: string,
  model: string
): Promise<EmptyTextAiResponse['fills']> {
  const context = { ...sharedContext, emptyPaths: batchPaths };
  const response = await callOpenRouterJson<EmptyTextAiResponse>(
    apiKey,
    model,
    systemPrompt,
    JSON.stringify(context, null, 2),
    32000,
    `empty-text-fill:${batchPaths.length}-paths`
  );
  if (!response || !Array.isArray(response.fills)) return [];
  return response.fills;
}

async function aiFillEmptyTextFields(
  website: JsonObject,
  websiteId: string,
  clientId: string,
  defaultLanguage: string,
  apiKey: string,
  model: string,
  issues: ValidationIssue[],
  dryRun: boolean
): Promise<boolean> {
  const emptyPaths = collectEmptyTextPaths(website);
  if (emptyPaths.length === 0) return false;

  const promptPath = getPromptPathForSite(clientId, websiteId);
  let promptMarkdown = '';
  if (promptPath) {
    try {
      promptMarkdown = fs.readFileSync(promptPath, 'utf8');
    } catch {
      // ignore read errors; AI still runs with other context
    }
  }

  const pages = getPagesArray(website).map((page) => ({
    name: getPageName(page),
    pageTitle:
      typeof page.pageTitle === 'string'
        ? page.pageTitle
        : typeof (page.metadata as JsonObject | undefined)?.title === 'string'
          ? ((page.metadata as JsonObject).title as string)
          : '',
  }));
  const business = getBusinessObject(website);
  const home = getHomePage(website);

  const websiteBriefing =
    typeof website.websiteBriefing === 'string'
      ? website.websiteBriefing.trim()
      : '';

  const sharedContext = {
    websiteId,
    defaultLanguage,
    business: {
      name: business.name ?? '',
      brandName: business.brandName ?? '',
      legalName: business.legalName ?? '',
      location: business.location ?? {},
      openingHours: business.openingHours ?? {},
    },
    pages,
    homeHero:
      home &&
      home.hero &&
      typeof home.hero === 'object' &&
      !Array.isArray(home.hero)
        ? {
            h1: (home.hero as JsonObject).h1 ?? '',
            subtitle: (home.hero as JsonObject).subtitle ?? '',
          }
        : {},
    promptMarkdown,
    ...(websiteBriefing ? { websiteBriefing } : {}),
  };

  const systemPrompt = getAiPromptSection('empty-text-fill');

  const batches: string[][] = [];
  for (let i = 0; i < emptyPaths.length; i += AI_FILL_BATCH_SIZE) {
    batches.push(emptyPaths.slice(i, i + AI_FILL_BATCH_SIZE));
  }

  const allFills: EmptyTextAiResponse['fills'] = [];
  const errors: string[] = [];

  for (let i = 0; i < batches.length; i += AI_FILL_CONCURRENCY) {
    const window = batches.slice(i, i + AI_FILL_CONCURRENCY);
    const results = await Promise.allSettled(
      window.map((batch) =>
        aiFillBatch(batch, systemPrompt, sharedContext, apiKey, model)
      )
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allFills.push(...result.value);
      } else {
        errors.push(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        );
      }
    }
  }

  if (errors.length > 0) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'ai',
      message: `AI empty-field fill: ${errors.length}/${batches.length} batch(es) failed: ${errors[0]}`,
    });
  }

  if (allFills.length === 0) return false;

  const emptyPathSet = new Set(emptyPaths);
  let changed = false;
  for (const item of allFills) {
    if (
      !item ||
      typeof item.path !== 'string' ||
      typeof item.value !== 'string'
    )
      continue;
    const pathValue = item.path.trim();
    const value = item.value.trim();
    if (!pathValue || !value) continue;
    if (!emptyPathSet.has(pathValue)) continue;
    const current = getValueAtPath(website, pathValue);
    if (typeof current !== 'string' || current.trim() !== '') continue;
    if (!dryRun) {
      const applied = setValueAtPath(website, pathValue, value);
      if (!applied) continue;
    }
    changed = true;
  }

  if (changed) {
    issues.push({
      websiteId,
      level: 'info',
      category: 'ai',
      message: `AI filled empty text fields (${allFills.length} candidates across ${batches.length} batch(es)).`,
    });
  }

  return changed;
}

interface ContentPathEntry {
  path: string;
  value: string;
}

interface ContentQualityRewrite {
  path: string;
  value: string;
  reason: string;
}

interface ContentQualityAiResponse {
  rewrites: ContentQualityRewrite[];
}

const CONTENT_QUALITY_REPORT_SCHEMA_VERSION = 1 as const;

type ContentQualityReviewOutcome =
  | 'skipped_no_content'
  | 'skipped_no_context'
  | 'completed'
  | 'failed';

type ContentQualitySuggestionOutcome =
  | 'applied'
  | 'would_apply_dry_run'
  | 'dropped';

type ContentQualitySuggestionDropReason =
  | 'malformed_rewrite'
  | 'empty_path_or_value'
  | 'unknown_field_path'
  | 'protected_or_non_fillable_path'
  | 'target_not_string'
  | 'no_change_needed'
  | 'set_value_failed';

interface ContentQualityReviewSuggestion {
  path: string;
  aiReason: string;
  previousValue: string;
  suggestedValue: string;
  outcome: ContentQualitySuggestionOutcome;
  droppedReason?: ContentQualitySuggestionDropReason;
}

interface ContentQualityReviewStats {
  contentFieldCount: number;
  sectionCount: number;
  sectionAiFailures: number;
  rawSuggestionsFromAi: number;
  appliedOrWouldApply: number;
  droppedCount: number;
}

interface ContentQualityReviewSiteReport {
  schemaVersion: typeof CONTENT_QUALITY_REPORT_SCHEMA_VERSION;
  websiteId: string;
  clientId: string;
  defaultLanguage: string;
  dryRun: boolean;
  generatedAt: string;
  outcome: ContentQualityReviewOutcome;
  /** When outcome is `failed` (uncaught) or skip paths need explanation */
  message?: string;
  stats: ContentQualityReviewStats;
  sectionErrors: string[];
  suggestions: ContentQualityReviewSuggestion[];
}

interface ContentQualityReviewRunFile {
  schemaVersion: typeof CONTENT_QUALITY_REPORT_SCHEMA_VERSION;
  tool: '08-refine-website-data';
  generatedAt: string;
  clientId: string;
  dryRun: boolean;
  reports: ContentQualityReviewSiteReport[];
}

function emptyContentQualityStats(): ContentQualityReviewStats {
  return {
    contentFieldCount: 0,
    sectionCount: 0,
    sectionAiFailures: 0,
    rawSuggestionsFromAi: 0,
    appliedOrWouldApply: 0,
    droppedCount: 0,
  };
}

function writeContentQualityReviewRunFile(
  clientId: string,
  dryRun: boolean,
  reports: ContentQualityReviewSiteReport[]
): string | null {
  if (reports.length === 0) return null;
  if (!fs.existsSync(CONTENT_QUALITY_REPORTS_DIR)) {
    fs.mkdirSync(CONTENT_QUALITY_REPORTS_DIR, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(
    CONTENT_QUALITY_REPORTS_DIR,
    `${clientId}-content-quality-${stamp}.json`
  );
  const payload: ContentQualityReviewRunFile = {
    schemaVersion: CONTENT_QUALITY_REPORT_SCHEMA_VERSION,
    tool: '08-refine-website-data',
    generatedAt: new Date().toISOString(),
    clientId,
    dryRun,
    reports,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  return filePath;
}

function collectContentPaths(obj: unknown, jsonPath = ''): ContentPathEntry[] {
  const out: ContentPathEntry[] = [];
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      if (typeof item === 'object' && item !== null) {
        out.push(...collectContentPaths(item, `${jsonPath}[${index}]`));
      }
    });
    return out;
  }
  if (typeof obj !== 'object') return out;

  for (const [key, value] of Object.entries(obj as JsonObject)) {
    const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
    if (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      isAiFillablePath(keyPath)
    ) {
      out.push({ path: keyPath, value: value as string });
    } else if (typeof value === 'object' && value !== null) {
      out.push(...collectContentPaths(value, keyPath));
    }
  }
  return out;
}

/** Home hero marketing strings reviewed in the dedicated hero-copy AI step. */
const HERO_COPY_TEXT_KEYS = [
  'h1',
  'subtitle',
  'pullQuote',
  'card1Line1',
  'card1Line2',
  'card2Line1',
  'card2Line2',
  'card3Line1',
  'card3Line2',
] as const;

function collectHeroCopyEntries(website: JsonObject): ContentPathEntry[] {
  const pages = getPagesArray(website);
  if (pages.length === 0) return [];
  const homeIdx = getHomePageIndex(website);
  const home = pages[homeIdx];
  if (
    !home ||
    typeof home.hero !== 'object' ||
    home.hero === null ||
    Array.isArray(home.hero)
  ) {
    return [];
  }
  const hero = home.hero as JsonObject;
  const base = `pages[${homeIdx}].hero`;
  const out: ContentPathEntry[] = [];
  for (const key of HERO_COPY_TEXT_KEYS) {
    const v = hero[key];
    if (typeof v !== 'string') continue;
    const jsonPath = `${base}.${key}`;
    if (!isAiFillablePath(jsonPath)) continue;
    if (v.trim().length === 0) continue;
    out.push({ path: jsonPath, value: v });
  }
  return out;
}

const QUALITY_REVIEW_CONCURRENCY = 3;

function loadTopicsForSite(clientId: string, siteId: string): string {
  const topicsPath = path.join(DATA_ROOT, clientId, siteId, 'topics.json');
  if (!fs.existsSync(topicsPath)) return '';
  try {
    return fs.readFileSync(topicsPath, 'utf8');
  } catch {
    return '';
  }
}

function loadPromptForSite(clientId: string, siteId: string): string {
  const base = path.join(DATA_ROOT, clientId, siteId);
  for (const name of ['prompt.md', 'prompt.txt']) {
    const p = path.join(base, name);
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
    }
  }
  return '';
}

const OPENROUTER_RETRIABLE_HTTP = new Set([429, 502, 503, 504]);

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Translate a flat { jsonPath: sourceText } map via OpenRouter using
 * `translation.openRouter.model` (same prompt rules as `translate-data`).
 */
async function translateHeroFieldMap(
  apiKey: string,
  cfg: TranslationFileConfig,
  targetLang: string,
  payload: Record<string, string>,
  operationSuffix: string
): Promise<Record<string, string>> {
  if (Object.keys(payload).length === 0) return {};

  const sourceLang = cfg.sourceLanguage;
  const systemPrompt = `You are a professional translator. You receive a JSON object whose keys are dot-notation paths and whose values are source-language strings. Translate every value from ${sourceLang} to ${targetLang}.

Rules:
- Return ONLY a JSON object with the SAME keys, values translated. No markdown fence, no extra keys, no explanation.
- Preserve the exact string semantics; keep informal "Du" vs formal "Sie" tone consistent with the source.
- Do NOT translate URLs, email addresses, phone numbers, postal codes, numeric IDs, file paths, or image paths. If a value is such a literal, return it unchanged.
- Do NOT translate path-like values starting with "/" (e.g. "/ueber-uns"). These are routing slugs — translating them would 404.
- If a value is already in the target language, return it unchanged.
- Keep placeholders in braces (e.g. {LEGAL_NAME}, {ADDRESS_CITY}) exactly as-is.
- Keep HTML tags exactly as-is; translate only their text content.

Section context: hero copy sync after refine (H1, subtitle, card lines)`;

  const userPrompt = `Translate these values from ${sourceLang} to ${targetLang}. Return the translated JSON object only.\n\n${JSON.stringify(
    payload,
    null,
    2
  )}`;

  let attempt = 0;
  const maxAttempts = 6;
  while (true) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetch(cfg.chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 8000,
        }),
      });
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(
        60_000,
        1000 * 2 ** (attempt - 1) + Math.random() * 400
      );
      await sleepMs(delay);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      if (
        attempt >= maxAttempts ||
        !OPENROUTER_RETRIABLE_HTTP.has(response.status)
      ) {
        throw new Error(`OpenRouter API error ${response.status}: ${text}`);
      }
      const delayMs = Math.min(
        60_000,
        Math.min(30, 2 ** attempt) * 1000 + Math.random() * 400
      );
      await sleepMs(delayMs);
      continue;
    }

    const parsed = (await response.json()) as {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
        prompt_tokens_cost?: number;
        completion_tokens_cost?: number;
      };
    };
    logOpenRouterChatResponse({
      script: '08-refine-website-data',
      operation: `hero-copy-translate:${operationSuffix}`,
      model: cfg.model,
      usage: parsed.usage ?? null,
      generationId: parsed.id ?? null,
      extra: { sourceLang, targetLang },
    });
    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter response missing choices[0].message.content');
    }
    const obj = parseAiResponseJson<Record<string, unknown>>(content);
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') result[k] = v;
    }
    return result;
  }
}

/**
 * Writes updated strings into each `websites-{lang}.json` for the given website
 * indices and hero JSON paths (same paths as in the default-language file).
 * @param sourceWebsitesBasename e.g. `websites.json` — must match the file refined in this run
 */
async function translateHeroRewritesToLanguageFiles(
  clientDataDir: string,
  sourceWebsitesBasename: string,
  languages: LanguagesConfig,
  apiKey: string,
  rewritesByWebsiteIndex: Map<number, HeroCopyRewrite[]>,
  issues: ValidationIssue[],
  verbose: boolean
): Promise<boolean> {
  const tcfg = loadTranslationFileConfig(clientDataDir, languages);
  if (!tcfg) {
    issues.push({
      websiteId: '_sync',
      level: 'info',
      category: 'ai',
      message:
        'Hero copy translation skipped — language.config.json needs translation.openRouter.model and at least one target language.',
    });
    return false;
  }

  if (rewritesByWebsiteIndex.size === 0) return false;

  let anyLangFileWritten = false;

  for (const targetLang of tcfg.targetLanguages) {
    const targetPath = resolveTranslatedWebsitesPath(
      clientDataDir,
      sourceWebsitesBasename,
      tcfg.sourceLanguage,
      targetLang
    );
    if (!fs.existsSync(targetPath)) {
      issues.push({
        websiteId: '_sync',
        level: 'warning',
        category: 'ai',
        message: `Hero copy translation: missing file for ${targetLang} — ${targetPath}`,
      });
      continue;
    }

    let parsedTarget: ReturnType<typeof parseWebsiteFile>;
    try {
      parsedTarget = parseWebsiteFile(targetPath);
    } catch (err) {
      issues.push({
        websiteId: '_sync',
        level: 'warning',
        category: 'ai',
        message: `Hero copy translation: could not parse ${targetPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }

    const targetWebsites = parsedTarget.websites;
    let targetDirty = false;

    for (const [siteIndex, rewrites] of rewritesByWebsiteIndex.entries()) {
      const tw = targetWebsites[siteIndex];
      if (!tw) {
        issues.push({
          websiteId: `_sync[${siteIndex}]`,
          level: 'warning',
          category: 'ai',
          message: `Hero copy translation (${targetLang}): no website at index ${siteIndex} in target file.`,
        });
        continue;
      }

      const payload: Record<string, string> = {};
      for (const { path: p, value } of rewrites) {
        if (p && value) payload[p] = value;
      }
      if (Object.keys(payload).length === 0) continue;

      const websiteId = getWebsiteId(tw, siteIndex);
      try {
        const translated = await translateHeroFieldMap(
          apiKey,
          tcfg,
          targetLang,
          payload,
          `${targetLang}:${websiteId}`
        );
        for (const p of Object.keys(payload)) {
          const t = translated[p];
          if (typeof t === 'string' && t.length > 0) {
            setValueAtPath(tw, p, t);
            targetDirty = true;
          }
        }
        if (verbose) {
          console.log(
            `  translated hero fields → ${targetLang} for ${websiteId} (${Object.keys(payload).length} path(s))`
          );
        }
      } catch (err) {
        issues.push({
          websiteId,
          level: 'warning',
          category: 'ai',
          message: `Hero copy translation to ${targetLang} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }

    if (targetDirty) {
      writeWebsiteFile(targetPath, parsedTarget.original, targetWebsites);
      console.log(`\nSaved hero copy translations to ${targetPath}`);
      anyLangFileWritten = true;
    }
  }

  return anyLangFileWritten;
}

async function aiReviewHeroCopy(
  website: JsonObject,
  websiteId: string,
  clientId: string,
  allClientWebsites: JsonObject[],
  defaultLanguage: string,
  apiKey: string,
  model: string,
  issues: ValidationIssue[],
  dryRun: boolean
): Promise<HeroCopyReviewResult> {
  const heroEntries = collectHeroCopyEntries(website);
  if (heroEntries.length === 0) {
    issues.push({
      websiteId,
      level: 'info',
      category: 'ai',
      message:
        'Hero copy review skipped — no non-empty hero text fields (h1, subtitle, cards) on the home page.',
    });
    return { changed: false, rewrites: [] };
  }

  const promptMarkdown = loadPromptForSite(clientId, websiteId);
  const topicsContent = loadTopicsForSite(clientId, websiteId);

  if (!promptMarkdown.trim() || !topicsContent.trim()) {
    issues.push({
      websiteId,
      level: 'info',
      category: 'ai',
      message:
        'Hero copy review skipped — requires both prompt.md (or prompt.txt) and topics.json with non-empty content for this website.',
    });
    return { changed: false, rewrites: [] };
  }

  const websites0WebsiteBriefing =
    getPrimaryWebsiteBriefingFromWebsitesJson(allClientWebsites);

  if (!websites0WebsiteBriefing) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'ai',
      message:
        'Hero copy review: `websites[0].websiteBriefing` is empty in websites.json — main keyword brief is missing; hero review runs with prompt/topics only.',
    });
  }

  const protectedPathsBlock = buildProtectedPathsBlockForAi(AI_PROTECTED_PATHS);
  const systemPrompt = buildAiPrompt('hero-copy-review', {
    PROTECTED_PATHS_BLOCK: protectedPathsBlock,
  });

  const business = getBusinessObject(website);
  const businessContext = {
    name: business.name ?? '',
    brandName: business.brandName ?? '',
    legalName: business.legalName ?? '',
    location: business.location ?? {},
    openingHours: business.openingHours ?? {},
  };

  const contentPaths = heroEntries.map((e) => e.path);
  const validPathSet = new Set(contentPaths);

  const otherSitesHeroH1 = allClientWebsites
    .map((w) => ({
      websiteId: getWebsiteId(w, -1),
      h1: getHomeHeroH1Raw(w),
    }))
    .filter(
      (row) =>
        row.websiteId !== websiteId &&
        normalizeHeroH1ForUniqueness(row.h1).length > 0
    );

  const context = {
    websiteId,
    defaultLanguage,
    business: businessContext,
    websites0WebsiteBriefing,
    promptMarkdown,
    topicsContent,
    otherSitesHeroH1,
    contentPaths: heroEntries.map((e) => ({
      path: e.path,
      currentValue: e.value,
    })),
  };

  let response: ContentQualityAiResponse | null = null;
  try {
    response = await callOpenRouterJson<ContentQualityAiResponse>(
      apiKey,
      model,
      systemPrompt,
      JSON.stringify(context, null, 2),
      32000,
      'hero-copy-review'
    );
  } catch (error) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'ai',
      message: `Hero copy review failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return { changed: false, rewrites: [] };
  }

  if (!response || !Array.isArray(response.rewrites)) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'ai',
      message:
        'Hero copy review: invalid AI response (missing rewrites array).',
    });
    return { changed: false, rewrites: [] };
  }

  if (response.rewrites.length === 0) {
    issues.push({
      websiteId,
      level: 'info',
      category: 'ai',
      message: 'Hero copy review: hero text passed — no rewrites needed.',
    });
    return { changed: false, rewrites: [] };
  }

  let changed = false;
  let appliedCount = 0;
  const rewrites: HeroCopyRewrite[] = [];

  for (const rewrite of response.rewrites) {
    if (
      !rewrite ||
      typeof rewrite.path !== 'string' ||
      typeof rewrite.value !== 'string'
    )
      continue;
    const p = rewrite.path.trim();
    const v = rewrite.value.trim();
    if (!p || !v) continue;
    if (!validPathSet.has(p)) continue;
    if (!isAiFillablePath(p)) continue;

    const current = getValueAtPath(website, p);
    if (typeof current !== 'string') continue;
    if (current.trim() === v) continue;

    if (!dryRun) {
      const applied = setValueAtPath(website, p, v);
      if (!applied) continue;
    }
    changed = true;
    appliedCount++;
    rewrites.push({ path: p, value: v });
  }

  issues.push({
    websiteId,
    level: 'info',
    category: 'ai',
    message: `Hero copy review: ${appliedCount} field(s) rewritten out of ${response.rewrites.length} suggestion(s).`,
  });

  return { changed, rewrites };
}

async function aiReviewContentQuality(
  website: JsonObject,
  websiteId: string,
  clientId: string,
  defaultLanguage: string,
  apiKey: string,
  model: string,
  issues: ValidationIssue[],
  dryRun: boolean
): Promise<{ changed: boolean; report: ContentQualityReviewSiteReport }> {
  const generatedAt = new Date().toISOString();
  const baseReport = (): Omit<
    ContentQualityReviewSiteReport,
    'stats' | 'sectionErrors' | 'suggestions' | 'outcome' | 'message'
  > => ({
    schemaVersion: CONTENT_QUALITY_REPORT_SCHEMA_VERSION,
    websiteId,
    clientId,
    defaultLanguage,
    dryRun,
    generatedAt,
  });

  const allContent = collectContentPaths(website);
  if (allContent.length === 0) {
    return {
      changed: false,
      report: {
        ...baseReport(),
        outcome: 'skipped_no_content',
        message: 'No fillable string fields with content to review.',
        stats: emptyContentQualityStats(),
        sectionErrors: [],
        suggestions: [],
      },
    };
  }

  const promptMarkdown = loadPromptForSite(clientId, websiteId);
  const topicsContent = loadTopicsForSite(clientId, websiteId);

  if (!promptMarkdown && !topicsContent) {
    issues.push({
      websiteId,
      level: 'info',
      category: 'ai',
      message:
        'Content quality review skipped — no prompt.md or topics.json found for context.',
    });
    return {
      changed: false,
      report: {
        ...baseReport(),
        outcome: 'skipped_no_context',
        message:
          'Skipped — no prompt.md / prompt.txt or topics.json for this site.',
        stats: {
          ...emptyContentQualityStats(),
          contentFieldCount: allContent.length,
        },
        sectionErrors: [],
        suggestions: [],
      },
    };
  }

  const protectedPathsBlock = buildProtectedPathsBlockForAi(AI_PROTECTED_PATHS);

  const business = getBusinessObject(website);
  const businessContext = {
    name: business.name ?? '',
    brandName: business.brandName ?? '',
    legalName: business.legalName ?? '',
    location: business.location ?? {},
    openingHours: business.openingHours ?? {},
  };

  const websiteBriefing =
    typeof website.websiteBriefing === 'string'
      ? website.websiteBriefing.trim()
      : '';

  const contentPaths = allContent.map((entry) => entry.path);
  const registryLoad = loadAiBlockRegistry();
  const batches = partitionFillablePaths(
    contentPaths,
    website,
    registryLoad?.registry ?? null
  );
  if (VERBOSE && registryLoad) {
    console.log(
      `    content-quality batches from ${registryLoad.resolvedPath} (${batches.length} batch(es))`
    );
  }

  const sectionContentMap = new Map<string, ContentPathEntry[]>();
  for (const entry of allContent) {
    for (const batch of batches) {
      if (batch.paths.includes(entry.path)) {
        let list = sectionContentMap.get(batch.section);
        if (!list) {
          list = [];
          sectionContentMap.set(batch.section, list);
        }
        list.push(entry);
        break;
      }
    }
  }

  const allRewrites: ContentQualityRewrite[] = [];
  const errors: string[] = [];

  console.log(
    `    ${allContent.length} content field(s) across ${batches.length} batch(es)`
  );

  for (let w = 0; w < batches.length; w += QUALITY_REVIEW_CONCURRENCY) {
    const window = batches.slice(w, w + QUALITY_REVIEW_CONCURRENCY);
    const results = await Promise.allSettled(
      window.map((batch) => {
        const sectionContent = sectionContentMap.get(batch.section) ?? [];
        const context = {
          websiteId,
          defaultLanguage,
          business: businessContext,
          ...(websiteBriefing ? { websiteBriefing } : {}),
          section: batch.section,
          promptMarkdown,
          topicsContent: topicsContent || undefined,
          contentPaths: sectionContent.map((e) => ({
            path: e.path,
            currentValue: e.value,
          })),
        };

        const systemPrompt = augmentSystemPromptForBlock(
          'content-quality-review',
          protectedPathsBlock,
          website,
          batch.promptSection
        );

        return callOpenRouterJson<ContentQualityAiResponse>(
          apiKey,
          model,
          systemPrompt,
          JSON.stringify(context, null, 2),
          32000,
          `content-quality:${batch.section}`
        );
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (
        result.status === 'fulfilled' &&
        result.value &&
        Array.isArray(result.value.rewrites)
      ) {
        allRewrites.push(...result.value.rewrites);
      } else if (result.status === 'rejected') {
        errors.push(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        );
      }
    }
  }

  if (errors.length > 0) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'ai',
      message: `Content quality review: ${errors.length}/${batches.length} batch(es) failed: ${errors[0]}`,
    });
  }

  const validPathSet = new Set(contentPaths);
  const suggestions: ContentQualityReviewSuggestion[] = [];
  let changed = false;
  let appliedCount = 0;

  const aiReasonOf = (r: ContentQualityRewrite): string =>
    typeof r.reason === 'string' ? r.reason : '';

  for (const rewrite of allRewrites) {
    if (
      !rewrite ||
      typeof rewrite.path !== 'string' ||
      typeof rewrite.value !== 'string'
    ) {
      suggestions.push({
        path: '',
        aiReason:
          rewrite && typeof rewrite === 'object' && 'reason' in rewrite
            ? aiReasonOf(rewrite as ContentQualityRewrite)
            : '',
        previousValue: '',
        suggestedValue: '',
        outcome: 'dropped',
        droppedReason: 'malformed_rewrite',
      });
      continue;
    }
    const p = rewrite.path.trim();
    const v = rewrite.value.trim();
    const aiReason = aiReasonOf(rewrite);
    if (!p || !v) {
      suggestions.push({
        path: p,
        aiReason,
        previousValue: '',
        suggestedValue: v,
        outcome: 'dropped',
        droppedReason: 'empty_path_or_value',
      });
      continue;
    }
    if (!validPathSet.has(p)) {
      suggestions.push({
        path: p,
        aiReason,
        previousValue: '',
        suggestedValue: v,
        outcome: 'dropped',
        droppedReason: 'unknown_field_path',
      });
      continue;
    }
    if (!isAiFillablePath(p)) {
      const cur = getValueAtPath(website, p);
      suggestions.push({
        path: p,
        aiReason,
        previousValue: typeof cur === 'string' ? cur : '',
        suggestedValue: v,
        outcome: 'dropped',
        droppedReason: 'protected_or_non_fillable_path',
      });
      continue;
    }

    const current = getValueAtPath(website, p);
    if (typeof current !== 'string') {
      suggestions.push({
        path: p,
        aiReason,
        previousValue: '',
        suggestedValue: v,
        outcome: 'dropped',
        droppedReason: 'target_not_string',
      });
      continue;
    }
    if (current.trim() === v) {
      suggestions.push({
        path: p,
        aiReason,
        previousValue: current,
        suggestedValue: v,
        outcome: 'dropped',
        droppedReason: 'no_change_needed',
      });
      continue;
    }

    if (!dryRun) {
      const applied = setValueAtPath(website, p, v);
      if (!applied) {
        suggestions.push({
          path: p,
          aiReason,
          previousValue: current,
          suggestedValue: v,
          outcome: 'dropped',
          droppedReason: 'set_value_failed',
        });
        continue;
      }
    }

    changed = true;
    appliedCount++;
    suggestions.push({
      path: p,
      aiReason,
      previousValue: current,
      suggestedValue: v,
      outcome: dryRun ? 'would_apply_dry_run' : 'applied',
    });
  }

  const droppedCount = suggestions.filter(
    (s) => s.outcome === 'dropped'
  ).length;
  const appliedOrWouldApply = suggestions.filter(
    (s) => s.outcome === 'applied' || s.outcome === 'would_apply_dry_run'
  ).length;

  if (allRewrites.length === 0) {
    if (errors.length > 0) {
      issues.push({
        websiteId,
        level: 'info',
        category: 'ai',
        message:
          'Content quality review: no rewrite suggestions returned (some section request(s) failed).',
      });
    } else {
      issues.push({
        websiteId,
        level: 'info',
        category: 'ai',
        message:
          'Content quality review: all content passed — no rewrites needed.',
      });
    }
  } else {
    issues.push({
      websiteId,
      level: 'info',
      category: 'ai',
      message: `Content quality review: ${appliedCount} field(s) rewritten out of ${allRewrites.length} suggestion(s).`,
    });
  }

  return {
    changed,
    report: {
      ...baseReport(),
      outcome: 'completed',
      stats: {
        contentFieldCount: allContent.length,
        sectionCount: batches.length,
        sectionAiFailures: errors.length,
        rawSuggestionsFromAi: allRewrites.length,
        appliedOrWouldApply,
        droppedCount,
      },
      sectionErrors: [...errors],
      suggestions,
    },
  };
}

function getPromptPathForSite(clientId: string, siteId: string): string | null {
  const base = path.join(DATA_ROOT, clientId, siteId);
  const promptMd = path.join(base, 'prompt.md');
  if (fs.existsSync(promptMd)) return promptMd;
  const promptTxt = path.join(base, 'prompt.txt');
  if (fs.existsSync(promptTxt)) return promptTxt;
  return null;
}

function hasTopicsFileForSite(clientId: string, siteId: string): boolean {
  const topicsPath = path.join(DATA_ROOT, clientId, siteId, 'topics.json');
  return fs.existsSync(topicsPath);
}

function runGenerateWebsiteFillBlanks(
  clientId: string,
  promptPath: string
): boolean {
  const result = spawnSync(
    'pnpm',
    [
      'run',
      '06-generate-website',
      '--',
      `--client=${clientId}`,
      `--prompt=${promptPath}`,
      '--skip-excel',
      '--skip-clone-check',
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    }
  );
  return result.status === 0;
}

function scanAvailableImages(siteId: string): AvailableImages | null {
  const imageDir = path.join(PUBLIC_DIR, 'images', siteId);
  if (!fs.existsSync(imageDir)) return null;

  const all: string[] = [];
  const byCategory: Record<string, string[]> = {};

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!/\.(webp|jpg|jpeg|png|gif|svg|avif)$/i.test(entry.name)) {
        continue;
      }
      const relativePath = `/${path.relative(PUBLIC_DIR, fullPath).replace(/\\/g, '/')}`;
      all.push(relativePath);
      const parentFolder = path.basename(path.dirname(fullPath));
      const category = parentFolder === siteId ? 'root' : parentFolder;
      if (!byCategory[category]) byCategory[category] = [];
      byCategory[category].push(relativePath);
    }
  }

  walk(imageDir);
  all.sort();
  for (const values of Object.values(byCategory)) values.sort();
  return { siteId, all, byCategory };
}

function sortedCategoryPaths(
  byCategory: Record<string, string[]>,
  key: string
): string[] {
  return [...(byCategory[key] ?? [])].sort();
}

function firstPathInCategories(
  byCategory: Record<string, string[]>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const values = sortedCategoryPaths(byCategory, key);
    if (values.length > 0) return values[0];
  }
  return undefined;
}

function pickLogoRelativePath(available: AvailableImages): string | undefined {
  const byCategory = available.byCategory;
  const fromLogoDir = firstPathInCategories(byCategory, 'logo');
  if (fromLogoDir) return fromLogoDir;
  const root = sortedCategoryPaths(byCategory, 'root');
  const named = root.find((value) => /logo/i.test(path.basename(value)));
  return named ?? root[0];
}

function publicSiteHost(website: JsonObject): string {
  const deploy =
    typeof website.deployDomain === 'string' ? website.deployDomain.trim() : '';
  const client =
    typeof website.clientDomain === 'string' ? website.clientDomain.trim() : '';
  const host = deploy || client;
  return normalizeDomain(host);
}

function toAbsoluteSiteImageUrl(relativePath: string, host: string): string {
  if (!relativePath.trim()) return relativePath;
  if (/^https?:\/\//i.test(relativePath)) return relativePath;
  const normalizedHost = normalizeDomain(host);
  if (!normalizedHost) return relativePath;
  const normalizedPath = relativePath.startsWith('/')
    ? relativePath
    : `/${relativePath}`;
  return `https://www.${normalizedHost}${normalizedPath}`;
}

function applyDiskImagePathsToEntry(
  website: JsonObject,
  availableImages: AvailableImages | null
): void {
  if (!availableImages || availableImages.all.length === 0) return;

  const byCategory = availableImages.byCategory;
  const host = publicSiteHost(website);
  const abs = (relativePath: string | undefined): string =>
    relativePath ? toAbsoluteSiteImageUrl(relativePath, host) : '';

  const heroRel = firstPathInCategories(byCategory, 'hero');
  const infoRel = firstPathInCategories(byCategory, 'info', 'info-section');
  const teamRel = firstPathInCategories(byCategory, 'team');
  const logoRel = pickLogoRelativePath(availableImages);
  const galleryRel = sortedCategoryPaths(byCategory, 'gallerie');
  const aboutRel = sortedCategoryPaths(byCategory, 'about');

  if (
    website.business &&
    typeof website.business === 'object' &&
    !Array.isArray(website.business)
  ) {
    const business = website.business as JsonObject;
    if (
      business.contactPerson &&
      typeof business.contactPerson === 'object' &&
      !Array.isArray(business.contactPerson) &&
      teamRel
    ) {
      (business.contactPerson as JsonObject).imageUrl = teamRel;
    }
  }

  if (
    website.header &&
    typeof website.header === 'object' &&
    !Array.isArray(website.header)
  ) {
    const header = website.header as JsonObject;
    if (logoRel) header.logoUrl = logoRel;
  }

  const pages = getPagesArray(website);
  if (pages.length === 0) return;

  const home = pages[0];
  if (
    home.hero &&
    typeof home.hero === 'object' &&
    !Array.isArray(home.hero) &&
    heroRel
  ) {
    (home.hero as JsonObject).backgroundImage = heroRel;
  }
  if (
    home.info &&
    typeof home.info === 'object' &&
    !Array.isArray(home.info) &&
    infoRel
  ) {
    (home.info as JsonObject).imageUrl = infoRel;
  }
  if (
    home.gallery &&
    typeof home.gallery === 'object' &&
    !Array.isArray(home.gallery) &&
    galleryRel.length > 0
  ) {
    const gallery = home.gallery as JsonObject;
    const existing = Array.isArray(gallery.images) ? gallery.images : [];
    const next = galleryRel.map((src, index) => {
      const existingItem =
        typeof existing[index] === 'object' &&
        existing[index] !== null &&
        !Array.isArray(existing[index])
          ? (existing[index] as JsonObject)
          : {};
      return {
        src,
        alt: typeof existingItem.alt === 'string' ? existingItem.alt : '',
      };
    });
    gallery.images = next;
  }
  // pages[*].trust.logos is AI_PROTECTED_PATHS — do not overwrite from disk scan
  // (trust badges come from Excel / manual data, not auto-filled from trustblock/).

  for (const page of pages) {
    const pageName = getPageName(page);
    const ogRelative =
      pageName === 'ueber-uns' && aboutRel[0]
        ? aboutRel[0]
        : (heroRel ?? aboutRel[0]);

    if (Array.isArray(page.blocks) && aboutRel.length > 0) {
      let aboutIndex = 0;
      for (const block of page.blocks) {
        if (!block || typeof block !== 'object' || Array.isArray(block))
          continue;
        const blockObj = block as JsonObject;
        if (blockObj.type === 'image' && 'src' in blockObj) {
          blockObj.src = aboutRel[aboutIndex % aboutRel.length];
          aboutIndex++;
        }
      }
    }

    if (
      page.metadata &&
      typeof page.metadata === 'object' &&
      !Array.isArray(page.metadata) &&
      ogRelative
    ) {
      const metadata = page.metadata as JsonObject;
      if (
        metadata.openGraph &&
        typeof metadata.openGraph === 'object' &&
        !Array.isArray(metadata.openGraph)
      ) {
        const openGraph = metadata.openGraph as JsonObject;
        if (Array.isArray(openGraph.images) && openGraph.images.length > 0) {
          const first = openGraph.images[0];
          if (typeof first === 'string') {
            openGraph.images[0] = abs(ogRelative);
          } else if (
            first &&
            typeof first === 'object' &&
            !Array.isArray(first)
          ) {
            (first as JsonObject).url = abs(ogRelative);
          }
        }
      }
      if (
        metadata.twitter &&
        typeof metadata.twitter === 'object' &&
        !Array.isArray(metadata.twitter)
      ) {
        const twitter = metadata.twitter as JsonObject;
        if (Array.isArray(twitter.images) && twitter.images.length > 0) {
          const first = twitter.images[0];
          if (typeof first === 'string') {
            twitter.images[0] = abs(ogRelative);
          } else if (
            first &&
            typeof first === 'object' &&
            !Array.isArray(first)
          ) {
            (first as JsonObject).url = abs(ogRelative);
          }
        }
      }

      if (Array.isArray(metadata.schema) && logoRel) {
        for (const schemaEntry of metadata.schema) {
          if (
            !schemaEntry ||
            typeof schemaEntry !== 'object' ||
            Array.isArray(schemaEntry)
          ) {
            continue;
          }
          const schemaObj = schemaEntry as JsonObject;
          if (schemaObj.id !== 'organization') continue;
          if (
            schemaObj.data &&
            typeof schemaObj.data === 'object' &&
            !Array.isArray(schemaObj.data)
          ) {
            (schemaObj.data as JsonObject).logo = abs(logoRel);
          }
        }
      }
    }
  }
}

function isImagePath(value: string): boolean {
  if (!value.trim()) return false;
  return (
    value.startsWith('/images/') ||
    /\.(webp|jpg|jpeg|png|gif|svg|avif)$/i.test(value)
  );
}

function collectImagePathLocations(
  obj: unknown,
  jsonPath = ''
): CollectedStringLocation[] {
  const out: CollectedStringLocation[] = [];
  if (obj === null || obj === undefined) return out;

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      const currentPath = `${jsonPath}[${index}]`;
      if (typeof item === 'string' && isImagePath(item)) {
        out.push({
          jsonPath: currentPath,
          value: item,
          setValue: (next) => {
            obj[index] = next;
          },
        });
      } else if (typeof item === 'object' && item !== null) {
        out.push(...collectImagePathLocations(item, currentPath));
      }
    });
    return out;
  }

  if (typeof obj === 'object') {
    const record = obj as JsonObject;
    for (const [key, value] of Object.entries(record)) {
      const currentPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (typeof value === 'string' && isImagePath(value)) {
        out.push({
          jsonPath: currentPath,
          value,
          setValue: (next) => {
            record[key] = next;
          },
        });
      } else if (typeof value === 'object' && value !== null) {
        out.push(...collectImagePathLocations(value, currentPath));
      }
    }
  }

  return out;
}

function findBestImageMatch(
  generated: string,
  available: AvailableImages
): string | null {
  if (available.all.includes(generated)) return generated;

  const generatedBase = path.basename(generated).toLowerCase();
  const generatedDir = path.basename(path.dirname(generated)).toLowerCase();

  let bestMatch: string | null = null;
  let bestScore = 0;

  const dirAliases: Record<string, string[]> = {
    gallerie: ['gallery', 'gallerie', 'galerie'],
    hero: ['hero', 'header'],
    info: ['info', 'info-section'],
    team: ['team'],
    about: ['about', 'ueber-uns', 'ueber uns'],
    trustblock: ['trustblock', 'partnerlogos', 'partner-logos', 'trust'],
  };

  for (const candidate of available.all) {
    const candidateBase = path.basename(candidate).toLowerCase();
    const candidateDir = path.basename(path.dirname(candidate)).toLowerCase();
    if (generatedBase === candidateBase) return candidate;

    let score = 0;
    if (generatedDir === candidateDir) score += 5;

    for (const aliases of Object.values(dirAliases)) {
      if (aliases.includes(generatedDir) && aliases.includes(candidateDir)) {
        score += 4;
        break;
      }
    }

    const generatedNumber = generatedBase.match(/(\d+)/)?.[1];
    const candidateNumber = candidateBase.match(/(\d+)/)?.[1];
    if (
      generatedNumber &&
      candidateNumber &&
      generatedNumber === candidateNumber
    ) {
      score += 3;
    }

    const generatedStem = generatedBase.replace(/\.[^.]+$/, '');
    const candidateStem = candidateBase.replace(/\.[^.]+$/, '');
    if (
      candidateStem.includes(generatedStem) ||
      generatedStem.includes(candidateStem)
    ) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestScore >= 5 ? bestMatch : null;
}

async function checkHttpUrl(
  url: string,
  cache: Map<string, HttpCheckResult>
): Promise<HttpCheckResult> {
  const cached = cache.get(url);
  if (cached) return cached;

  async function doRequest(method: 'HEAD' | 'GET'): Promise<HttpCheckResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
      });
      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  let result = await doRequest('HEAD');
  if (!result.ok && result.status && [405, 501].includes(result.status)) {
    result = await doRequest('GET');
  }

  cache.set(url, result);
  return result;
}

function validateImagesForWebsite(
  website: JsonObject,
  websiteId: string,
  issues: ValidationIssue[],
  dryRun: boolean
): boolean {
  const available = scanAvailableImages(websiteId);
  const beforeImageNormalization = JSON.stringify(website);
  applyDiskImagePathsToEntry(website, available);

  let changed = JSON.stringify(website) !== beforeImageNormalization;
  if (changed) {
    issues.push({
      websiteId,
      level: 'info',
      category: 'images',
      message:
        'Image fields were normalized from available files on disk (logo/hero/info/gallery/schema; trust.logos left unchanged).',
    });
  }
  const locations = collectImagePathLocations(website);

  for (const location of locations) {
    const value = location.value.trim();
    if (!value) continue;

    if (value.startsWith('/images/')) {
      const absoluteFile = path.join(PUBLIC_DIR, value.replace(/^\//, ''));
      if (fs.existsSync(absoluteFile)) continue;

      if (available) {
        const bestMatch = findBestImageMatch(value, available);
        if (bestMatch) {
          if (!dryRun) location.setValue(bestMatch);
          changed = true;
          issues.push({
            websiteId,
            level: 'warning',
            category: 'images',
            message: `${location.jsonPath} image path "${value}" not found on disk → corrected to "${bestMatch}".`,
          });
          continue;
        }
      }

      issues.push({
        websiteId,
        level: 'error',
        category: 'images',
        message: `${location.jsonPath} image path "${value}" does not exist in public/.`,
      });
      continue;
    }

    if (/^https?:\/\//i.test(value)) {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        issues.push({
          websiteId,
          level: 'error',
          category: 'images',
          message: `${location.jsonPath} has malformed image URL "${value}".`,
        });
        continue;
      }

      // Same as relative `/images/...`: map to public/ on disk. Do not fetch the
      // deploy URL — the site is often not live yet during this pipeline.
      if (parsed.pathname.startsWith('/images/')) {
        const relativePath = parsed.pathname;
        const localFile = path.join(
          PUBLIC_DIR,
          relativePath.replace(/^\//, '')
        );
        if (fs.existsSync(localFile)) continue;

        if (available) {
          const bestMatch = findBestImageMatch(relativePath, available);
          if (bestMatch) {
            if (!dryRun) location.setValue(bestMatch);
            changed = true;
            issues.push({
              websiteId,
              level: 'warning',
              category: 'images',
              message: `${location.jsonPath} deploy-style URL missing file under public/${relativePath.replace(/^\//, '')} → corrected to "${bestMatch}".`,
            });
            continue;
          }
        }

        issues.push({
          websiteId,
          level: 'error',
          category: 'images',
          message: `${location.jsonPath} image URL "${value}" maps to missing file in public/ (${relativePath}).`,
        });
        continue;
      }

      // External / non-public image URLs — not validated here (no remote fetch).
    }
  }

  return changed;
}

async function maybeAutofillWebsiteWithGenerateWebsite(
  clientId: string,
  websiteId: string,
  issues: ValidationIssue[],
  dryRun: boolean,
  aiEnabled: boolean
): Promise<boolean> {
  const promptPath = getPromptPathForSite(clientId, websiteId);
  const hasTopics = hasTopicsFileForSite(clientId, websiteId);

  if (!promptPath || !hasTopics) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'empty-fields',
      message:
        'Cannot run fill-blanks through 06-generate-website (missing prompt.md/prompt.txt or topics.json).',
    });
    return false;
  }

  if (!aiEnabled) {
    issues.push({
      websiteId,
      level: 'warning',
      category: 'empty-fields',
      message:
        'AI is disabled; remaining empty fields could not be auto-generated for this website.',
    });
    return false;
  }

  if (dryRun) {
    issues.push({
      websiteId,
      level: 'info',
      category: 'empty-fields',
      message: `Dry-run: would run 06-generate-website fill-blanks with ${promptPath}.`,
    });
    return false;
  }

  // if (VERBOSE)
  //   console.log(
  //     `    Running 06-generate-website fill-blanks for "${websiteId}"…`
  //   );
  // const ok = runGenerateWebsiteFillBlanks(clientId, promptPath);
  // issues.push({
  //   websiteId,
  //   level: ok ? 'info' : 'warning',
  //   category: 'empty-fields',
  //   message: ok
  //     ? '06-generate-website fill-blanks completed.'
  //     : '06-generate-website fill-blanks failed.',
  // });
  // return ok;
  return true;
}

function summarizeIssues(issues: ValidationIssue[]): void {
  const totals = {
    info: issues.filter((issue) => issue.level === 'info').length,
    warning: issues.filter((issue) => issue.level === 'warning').length,
    error: issues.filter((issue) => issue.level === 'error').length,
  };

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Website Data Summary');
  console.log('═══════════════════════════════════════════════════════');
  console.log(
    `Issues: ${totals.error} error(s), ${totals.warning} warning(s), ${totals.info} info note(s)`
  );

  const grouped = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const key = issue.websiteId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(issue);
  }

  for (const [websiteId, websiteIssues] of grouped.entries()) {
    const errorCount = websiteIssues.filter(
      (issue) => issue.level === 'error'
    ).length;
    const warningCount = websiteIssues.filter(
      (issue) => issue.level === 'warning'
    ).length;
    const infoCount = websiteIssues.filter(
      (issue) => issue.level === 'info'
    ).length;
    console.log(
      `\n• ${websiteId}: ${errorCount} error(s), ${warningCount} warning(s), ${infoCount} info`
    );
    for (const issue of websiteIssues.slice(0, 12)) {
      const marker =
        issue.level === 'error' ? '✗' : issue.level === 'warning' ? '⚠' : '•';
      console.log(`  ${marker} [${issue.category}] ${issue.message}`);
    }
    if (websiteIssues.length > 12) {
      console.log(`  … and ${websiteIssues.length - 12} more`);
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(ROOT, '.env.local') });
  const args = parseArgs();
  const clientId = await resolveClientId(args.clientId);
  const { verbose } = args;
  VERBOSE = verbose;
  const clientDataDir = path.join(DATA_ROOT, clientId);
  const websitesPath = path.join(clientDataDir, 'websites.json');

  if (!fs.existsSync(websitesPath)) {
    console.error(
      `websites.json not found for client "${clientId}": ${websitesPath}`
    );
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? '';
  const aiEnabled = !args.noAi && apiKey.length > 0;
  const aiModel = getAiModel(clientDataDir);
  const languages = loadLanguagesConfig(clientDataDir);

  const heroCopyOnly = args.heroCopyOnly;
  const TOTAL_STEPS = 6;
  const step = (n: number, label: string) =>
    console.log(`\n[${n}/${TOTAL_STEPS}] ${label}`);

  const issues: ValidationIssue[] = [];
  let fileChanged = false;
  const httpCache = new Map<string, HttpCheckResult>();

  let parsedFile = parseWebsiteFile(websitesPath);
  let websites = parsedFile.websites;

  const targetWebsiteId = await resolveTargetWebsiteId(websites, {
    cliWebsiteId: args.websiteId,
    allWebsites: args.allWebsites,
  });

  console.log('\n[08-reine-website-data] Refining website data');
  console.log(`  client: ${clientId}`);
  if (targetWebsiteId) console.log(`  website: ${targetWebsiteId}`);
  else console.log('  website: all');
  if (args.dryRun) console.log(`  mode: dry-run`);
  if (heroCopyOnly) console.log('  scope: hero-copy-only (step 6 only)');
  console.log(`  AI: ${aiEnabled ? 'on' : 'off'}`);

  let selected = websites
    .map((website, index) => ({ website, index }))
    .filter(({ website }) => {
      if (!targetWebsiteId) return true;
      return getWebsiteId(website, -1) === targetWebsiteId;
    });

  if (selected.length === 0) {
    console.error(
      targetWebsiteId
        ? `No website with id "${targetWebsiteId}" found in ${websitesPath}.`
        : 'No websites found in websites.json.'
    );
    process.exit(1);
  }

  if (heroCopyOnly) {
    // ── Hero copy only: step 6 ────────────────────────────────────
    console.log('\n[Hero copy only] AI hero copy review (H1, subtitle, cards)');
    const heroRewritesByIndex = new Map<number, HeroCopyRewrite[]>();
    if (aiEnabled) {
      for (const { website, index } of selected) {
        const websiteId = getWebsiteId(website, index);
        if (verbose) console.log(`  • ${websiteId}`);
        try {
          const result = await aiReviewHeroCopy(
            website,
            websiteId,
            clientId,
            websites,
            languages.defaultLanguage,
            apiKey,
            aiModel,
            issues,
            args.dryRun
          );
          if (result.changed) fileChanged = true;
          if (result.rewrites.length > 0) {
            heroRewritesByIndex.set(index, result.rewrites);
          }
        } catch (error) {
          issues.push({
            websiteId,
            level: 'warning',
            category: 'ai',
            message: `AI hero copy review failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
    } else {
      if (verbose) console.log('  skipped (AI unavailable)');
    }

    console.log('\n[Hero copy only] Hero H1 uniqueness (vs other client sites)');
    for (const { website, index } of selected) {
      const websiteId = getWebsiteId(website, index);
      if (verbose) console.log(`  • ${websiteId}`);
      try {
        const uniq = await ensureUniqueHeroH1ForClientSite(
          website,
          websiteId,
          clientId,
          websites,
          apiKey,
          aiModel,
          issues,
          args.dryRun,
          aiEnabled
        );
        if (uniq.changed) fileChanged = true;
        if (uniq.rewrites.length > 0) {
          const prev = heroRewritesByIndex.get(index) ?? [];
          heroRewritesByIndex.set(index, [...prev, ...uniq.rewrites]);
        }
      } catch (error) {
        issues.push({
          websiteId,
          level: 'warning',
          category: 'ai',
          message: `Hero H1 uniqueness pass failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    if (fileChanged && !args.dryRun) {
      writeWebsiteFile(websitesPath, parsedFile.original, websites);
      console.log(`\nSaved updates to ${websitesPath}`);

      if (heroRewritesByIndex.size > 0 && aiEnabled) {
        console.log(
          '\n[Hero copy only] Translating updated hero fields to language files (translation.openRouter.model)…'
        );
        await translateHeroRewritesToLanguageFiles(
          clientDataDir,
          path.basename(websitesPath),
          languages,
          apiKey,
          heroRewritesByIndex,
          issues,
          verbose
        );
      }
    } else if (fileChanged && args.dryRun) {
      console.log('\nDry-run: changes detected, no file written.');
    } else {
      console.log('\nNo data changes were necessary.');
    }

    summarizeIssues(issues);
    return;
  }

  // ── Step 1: Fill empty fields ──────────────────────────────────
  step(1, 'Empty-field detection & generation');
  for (const { website, index } of selected) {
    const websiteId = getWebsiteId(website, index);
    const emptyBefore = findEmptyFields(website).length;
    if (emptyBefore === 0) {
      console.log(`  ✓ ${websiteId} — no empty fields`);
      continue;
    }

    console.log(`  • ${websiteId} — ${emptyBefore} empty field(s)`);
    issues.push({
      websiteId,
      level: 'info',
      category: 'empty-fields',
      message: `${emptyBefore} empty placeholder field(s) detected.`,
    });

    const generated = await maybeAutofillWebsiteWithGenerateWebsite(
      clientId,
      websiteId,
      issues,
      args.dryRun,
      aiEnabled
    );
    if (generated) {
      parsedFile = parseWebsiteFile(websitesPath);
      websites = parsedFile.websites;
      selected = websites
        .map((entry, idx) => ({ website: entry, index: idx }))
        .filter(({ website: entry }) => {
          if (!targetWebsiteId) return true;
          return getWebsiteId(entry, -1) === targetWebsiteId;
        });
    }
  }

  // ── Step 2: AI fallback for remaining empty text ───────────────
  step(2, 'AI fallback for remaining empty text fields');
  if (aiEnabled) {
    for (const { website, index } of selected) {
      const websiteId = getWebsiteId(website, index);
      const changed = await aiFillEmptyTextFields(
        website,
        websiteId,
        clientId,
        languages.defaultLanguage,
        apiKey,
        aiModel,
        issues,
        args.dryRun
      );
      if (changed) fileChanged = true;
    }
  } else {
    if (verbose) console.log('  skipped (AI unavailable)');
  }

  // ── Step 3: Link validation ────────────────────────────────────
  step(3, 'Header & hero link validation');
  const externalRefs: ExternalUrlReference[] = [];
  for (const { website, index } of selected) {
    const websiteId = getWebsiteId(website, index);
    const validRoutes = buildValidInternalRoutes(
      website,
      languages.supportedLanguages
    );
    const topLevelClientDomain =
      !Array.isArray(parsedFile.original) &&
      typeof (parsedFile.original as JsonObject).clientDomain === 'string'
        ? ((parsedFile.original as JsonObject).clientDomain as string)
        : '';
    const hosts = getWebsiteHosts(website, topLevelClientDomain);

    const headerChanged = checkHeaderLinksForWebsite(
      website,
      websiteId,
      hosts,
      languages.defaultLanguage,
      languages.supportedLanguages,
      validRoutes,
      issues,
      externalRefs,
      args.dryRun
    );

    const heroChanged = checkHeroButtonsForWebsite(
      website,
      websiteId,
      hosts,
      languages.defaultLanguage,
      languages.supportedLanguages,
      validRoutes,
      issues,
      externalRefs,
      args.dryRun
    );

    if (headerChanged || heroChanged) fileChanged = true;
  }

  if (aiEnabled) {
    if (verbose) console.log('  AI hero CTA sanity check…');
    for (const { website, index } of selected) {
      const websiteId = getWebsiteId(website, index);
      try {
        const suggestions = await aiReviewHeroButtons(
          website,
          websiteId,
          languages.defaultLanguage,
          apiKey,
          aiModel
        );
        if (suggestions.length === 0) continue;
        const changed = applyHeroButtonAiSuggestions(
          website,
          websiteId,
          suggestions,
          issues,
          args.dryRun
        );
        if (changed) fileChanged = true;
      } catch (error) {
        issues.push({
          websiteId,
          level: 'warning',
          category: 'ai',
          message: `AI hero CTA review failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  }

  if (!args.skipHttpChecks && externalRefs.length > 0) {
    if (verbose)
      console.log(`  Checking ${externalRefs.length} external link(s)…`);
    for (const ref of externalRefs) {
      const result = await checkHttpUrl(ref.url, httpCache);
      if (!result.ok) {
        issues.push({
          websiteId: ref.websiteId,
          level: 'warning',
          category: 'external-links',
          message: `${ref.source} external link check failed for ${ref.url}${
            result.status ? ` [status ${result.status}]` : ''
          }${result.error ? `: ${result.error}` : ''}`,
        });
      }
    }
  }

  // ── Step 4: Image validation ───────────────────────────────────
  step(4, 'Image path validation (public/)');
  for (const { website, index } of selected) {
    const websiteId = getWebsiteId(website, index);
    const changed = validateImagesForWebsite(
      website,
      websiteId,
      issues,
      args.dryRun
    );
    if (changed) fileChanged = true;
  }

  // ── Step 5: AI content quality review ──────────────────────────
  step(5, 'AI content quality review');
  const contentQualityReports: ContentQualityReviewSiteReport[] = [];
  if (aiEnabled) {
    for (const { website, index } of selected) {
      const websiteId = getWebsiteId(website, index);
      if (verbose) console.log(`  • ${websiteId}`);
      try {
        const { changed, report } = await aiReviewContentQuality(
          website,
          websiteId,
          clientId,
          languages.defaultLanguage,
          apiKey,
          aiModel,
          issues,
          args.dryRun
        );
        contentQualityReports.push(report);
        if (changed) fileChanged = true;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        issues.push({
          websiteId,
          level: 'warning',
          category: 'ai',
          message: `AI content quality review failed: ${errMsg}`,
        });
        contentQualityReports.push({
          schemaVersion: CONTENT_QUALITY_REPORT_SCHEMA_VERSION,
          websiteId,
          clientId,
          defaultLanguage: languages.defaultLanguage,
          dryRun: args.dryRun,
          generatedAt: new Date().toISOString(),
          outcome: 'failed',
          message: errMsg,
          stats: emptyContentQualityStats(),
          sectionErrors: [],
          suggestions: [],
        });
      }
    }
    const reportPath = writeContentQualityReviewRunFile(
      clientId,
      args.dryRun,
      contentQualityReports
    );
    if (reportPath) {
      console.log(
        `  Content quality review report: ${path.relative(ROOT, reportPath)}`
      );
    }
  } else {
    if (verbose) console.log('  skipped (AI unavailable)');
  }

  // ── Step 6: AI hero copy review ───────────────────────────────
  step(6, 'AI hero copy review (H1, subtitle, cards)');
  const heroRewritesByIndexFull = new Map<number, HeroCopyRewrite[]>();
  if (aiEnabled) {
    for (const { website, index } of selected) {
      const websiteId = getWebsiteId(website, index);
      if (verbose) console.log(`  • ${websiteId}`);
      try {
        const result = await aiReviewHeroCopy(
          website,
          websiteId,
          clientId,
          websites,
          languages.defaultLanguage,
          apiKey,
          aiModel,
          issues,
          args.dryRun
        );
        if (result.changed) fileChanged = true;
        if (result.rewrites.length > 0) {
          heroRewritesByIndexFull.set(index, result.rewrites);
        }
      } catch (error) {
        issues.push({
          websiteId,
          level: 'warning',
          category: 'ai',
          message: `AI hero copy review failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  } else {
    if (verbose) console.log('  skipped (AI unavailable)');
  }

  console.log('\n[6b] Hero H1 uniqueness (vs other client sites)');
  for (const { website, index } of selected) {
    const websiteId = getWebsiteId(website, index);
    if (verbose) console.log(`  • ${websiteId}`);
    try {
      const uniq = await ensureUniqueHeroH1ForClientSite(
        website,
        websiteId,
        clientId,
        websites,
        apiKey,
        aiModel,
        issues,
        args.dryRun,
        aiEnabled
      );
      if (uniq.changed) fileChanged = true;
      if (uniq.rewrites.length > 0) {
        const prev = heroRewritesByIndexFull.get(index) ?? [];
        heroRewritesByIndexFull.set(index, [...prev, ...uniq.rewrites]);
      }
    } catch (error) {
      issues.push({
        websiteId,
        level: 'warning',
        category: 'ai',
        message: `Hero H1 uniqueness pass failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  // ── Save & summarize ──────────────────────────────────────────
  if (fileChanged && !args.dryRun) {
    writeWebsiteFile(websitesPath, parsedFile.original, websites);
    console.log(`\nSaved updates to ${websitesPath}`);

    if (heroRewritesByIndexFull.size > 0 && aiEnabled) {
      console.log(
        '\nTranslating updated hero fields to language files (translation.openRouter.model)…'
      );
      await translateHeroRewritesToLanguageFiles(
        clientDataDir,
        path.basename(websitesPath),
        languages,
        apiKey,
        heroRewritesByIndexFull,
        issues,
        verbose
      );
    }
  } else if (fileChanged && args.dryRun) {
    console.log('\nDry-run: changes detected, no file written.');
  } else {
    console.log('\nNo data changes were necessary.');
  }

  for (const { website, index } of selected) {
    const websiteId = getWebsiteId(website, index);
    const emptyAfter = findEmptyFields(website).length;
    if (emptyAfter > 0) {
      issues.push({
        websiteId,
        level: 'warning',
        category: 'empty-fields',
        message: `${emptyAfter} empty field(s) remain after validation.`,
      });
    }
  }

  summarizeIssues(issues);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
