/**
 * Translate website JSON to target languages via OpenRouter/Gemini, section-chunked to avoid max_tokens overflow.
 * Config: src/data/language.config.json. Requires OPENROUTER_API_KEY in .env.local.
 * Usage: pnpm translate-data [--lang=en] [--lang=uk,tr] [--concurrency=3] [--sites=id1,id2|--sites=all]
 * With no --sites=, an interactive prompt runs when stdin is a TTY: choose "All websites" or "Specific sites only" (then multi-select); set TRANSLATE_SKIP_SITE_PICK=1 to skip.
 * Partial --sites=… updates only those entries in websites-*.json. If the output file already exists, untouched sites keep their previous translation. If it does not, untouched sites fall back to source content so an initial websites-<lang>.json is still produced.
 * Env: TRANSLATE_CONCURRENCY (1–32, default 3) caps concurrent OpenRouter requests.
 * Env: TRANSLATE_SKIP_SITE_PICK=1 skips the interactive website picker when --sites= is omitted (non-TTY and CI also skip).
 */

import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import {
  groupPathsBySections,
  normalizePathForAiProtection,
} from '../lib/ai-protected-paths';
import { logOpenRouterChatResponse } from '../lib/log-ai-cost.mjs';
import enquirer from 'enquirer';

/**
 * Translation policy is OPT-OUT, not opt-in: by default every string in
 * websites.json is translated. The two lists below carve out the exceptions.
 *
 * - {@link TRANSLATION_BLOCKED_LEAF_PATTERNS} — leaf-name patterns whose value
 *   is NEVER human copy (URLs, emails, phone numbers, geo coords, IDs, file
 *   refs, image dimensions, schema.org canonical enum values, …).
 * - {@link TRANSLATION_BLOCKED_PATHS} — full paths/prefixes that hold
 *   identifiers, brand names, or routing values that must stay verbatim across
 *   languages (page slugs, brand `name`/`legalName`, dayOfWeek arrays, …).
 *
 * If a string matches neither list and isn't filtered out by the value-level
 * {@link looksUntranslatable} heuristic, it gets translated.
 */
const TRANSLATION_BLOCKED_LEAF_PATTERNS: RegExp[] = [
  // URLs, file refs, links
  /\.url$/,
  /\.link$/,
  /\.href$/,
  /\.src$/,
  /\.imageUrl$/,
  /\.logoUrl$/,
  /\.backgroundImage$/,
  /\.mapEmbedUrl$/,
  /\.faqDataFile$/,
  // Contact details (factual)
  /\.email$/,
  /\.phone$/,
  /\.telephone$/,
  /\.whatsappNumber$/,
  // Postal address pieces (factual)
  /\.postalCode$/,
  /\.street$/,
  /\.streetAddress$/,
  /\.city$/,
  /\.addressLocality$/,
  /\.addressCountry$/,
  /\.addressRegion$/,
  // Geo coordinates / region codes
  /\.latitude$/,
  /\.longitude$/,
  /\.icbm$/,
  /\.position$/,
  /\.region$/,
  // Numeric / structural metadata
  /\.width$/,
  /\.height$/,
  /\.logoWidth$/,
  /\.minimumRating$/,
  // External / business identifiers
  /\.hrbNummer$/,
  /\.ustId$/,
  /\.registergericht$/,
  /\.googlePlacesId$/,
  // Schema.org canonical strings (must stay English / @type vocab)
  /\.@type$/,
  /\.@id$/,
  /\.schemaType$/,
  /\.inLanguage$/,
  /\.priceRange$/,
  /\.areaServed$/,
  /\.contactType$/,
  /\.dayOfWeek(\[\d+\])?$/,
  /\.availableLanguage(\[\d+\])?$/,
  /\.opens$/,
  /\.closes$/,
  // Top-level tooling / config IDs
  /^id$/,
  /^deployDomain$/,
  /^clientDomain$/,
  /^clientName$/,
  /^googleTagId$/,
  /^driveFolderId$/,
  /^websiteBriefing$/,
  /^sectionIds(\.|$)/,
  /^languages(\[\d+\]|\.|$)/,
];

const TRANSLATION_BLOCKED_PATHS: RegExp[] = [
  // Page identifiers (used for routing, not display)
  /^pages\[\d+\]\.name$/,
  // Header link types are enums ("internal" / "external"), not copy
  /^header\.links\[\d+\]\.type$/,
  // Hero button variants ("primary" / "outline" …)
  /^pages\[\d+\]\.hero\.buttons\[\d+\]\.variant$/,
  // Brand / legal identifiers inside schema.org blocks — keep verbatim
  /^pages\[\d+\]\.metadata\.schema\[\d+\]\.data\.(name|legalName)$/,
  /^pages\[\d+\]\.metadata\.schema\[\d+\]\.data\.founder\[\d+\]\.name$/,
  /^pages\[\d+\]\.metadata\.schema\[\d+\]\.data\.address\.name$/,
  /^pages\[\d+\]\.metadata\.schema\[\d+\]\.data\.publisher\./,
];

function isTranslatableWebsiteStringPath(pathValue: string): boolean {
  if (!pathValue) return false;
  const canonical = normalizePathForAiProtection(pathValue);
  if (!canonical) return false;
  if (TRANSLATION_BLOCKED_LEAF_PATTERNS.some((rx) => rx.test(canonical))) {
    return false;
  }
  if (TRANSLATION_BLOCKED_PATHS.some((rx) => rx.test(canonical))) {
    return false;
  }
  return true;
}

// Load .env.local at module level — must happen BEFORE any process.env reads in module-scope constants.
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_MODEL = process.env.OPENROUTER_MODEL_WEBSITE_GEN;

/** HTTP statuses where OpenRouter / upstream may recover after a wait. */
const RETRIABLE_HTTP = new Set([429, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCliConcurrency(): number {
  const arg = process.argv.find((a) => a.startsWith('--concurrency='));
  if (arg) {
    const n = Number(arg.slice('--concurrency='.length).trim());
    if (Number.isFinite(n) && n >= 1 && n <= 32) return Math.floor(n);
  }
  const env = process.env.TRANSLATE_CONCURRENCY;
  if (env) {
    const n = Number(env.trim());
    if (Number.isFinite(n) && n >= 1 && n <= 32) return Math.floor(n);
  }
  return 3;
}

/** No `--sites=` → may prompt interactively. `--sites=all` → every website. Otherwise comma-separated ids. */
function parseCliSitesFlag():
  | { mode: 'all' }
  | { mode: 'subset'; ids: string[] } {
  const arg = process.argv.find((a) => a.startsWith('--sites='));
  if (!arg) return { mode: 'all' };
  const rest = arg.slice('--sites='.length).trim();
  if (!rest) {
    console.error(
      '--sites= requires a value: comma-separated website ids, or "all".'
    );
    process.exit(1);
  }
  if (rest.toLowerCase() === 'all') return { mode: 'all' };
  const ids = rest
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    console.error(
      '--sites= requires at least one website id (comma-separated), or "all".'
    );
    process.exit(1);
  }
  return { mode: 'subset', ids };
}

/** Select value: translate every website in source JSON. */
const SCOPE_ALL_WEBSITES = '__translate_scope_all__';
/** Select value: next step is multi-select of site ids. */
const SCOPE_SPECIFIC_SITES = '__translate_scope_subset__';

async function promptSiteScopeIfNeeded(
  parsed: { mode: 'all' } | { mode: 'subset'; ids: string[] },
  sortedSiteIds: string[]
): Promise<{ mode: 'all' } | { mode: 'subset'; ids: string[] }> {
  if (parsed.mode === 'subset') return parsed;
  if (sortedSiteIds.length <= 1) return parsed;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return parsed;
  if (process.env.CI === 'true' || process.env.CI === '1') return parsed;
  if (process.env.TRANSLATE_SKIP_SITE_PICK === '1') return parsed;

  const { Select, MultiSelect } = enquirer as unknown as {
    Select: new (opts: {
      name: string;
      message: string;
      hint?: string;
      choices: Array<{ name: string; message: string; hint?: string }>;
    }) => { run: () => Promise<string> };
    MultiSelect: new (opts: {
      name: string;
      message: string;
      hint?: string;
      choices: Array<{ name: string; message: string; hint?: string }>;
    }) => { run: () => Promise<string[]> };
  };

  const scope = await new Select({
    name: 'scope',
    message: 'Which website(s) should be translated?',
    choices: [
      {
        name: SCOPE_ALL_WEBSITES,
        message: 'All websites',
        hint: `${sortedSiteIds.length} sites (full run)`,
      },
      {
        name: SCOPE_SPECIFIC_SITES,
        message: 'Specific sites only',
        hint: 'Pick one or more in the next step',
      },
    ],
  }).run();

  if (scope === SCOPE_ALL_WEBSITES) return { mode: 'all' };

  const selected = await new MultiSelect({
    name: 'sites',
    message: 'Which sites?',
    hint: '(space toggles, enter to confirm)',
    choices: sortedSiteIds.map((id) => ({ name: id, message: id, hint: '' })),
  }).run();

  if (!Array.isArray(selected) || selected.length === 0) {
    console.error('Select at least one site.');
    process.exit(1);
  }
  return { mode: 'subset', ids: selected };
}

function parseWebsiteId(w: unknown): string | null {
  if (!w || typeof w !== 'object') return null;
  const id = (w as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function parseRetryAfterSeconds(res: Response): number | null {
  const ra = res.headers.get('retry-after');
  if (!ra) return null;
  const sec = parseInt(ra, 10);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

async function fetchOpenRouterWithRetry(
  url: string,
  init: RequestInit,
  logLabel: string,
  maxAttempts = 6
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(
        60_000,
        1000 * 2 ** (attempt - 1) + Math.random() * 400
      );
      console.warn(
        `  [${logLabel}] network error (attempt ${attempt}/${maxAttempts}), waiting ${Math.round(delay)}ms`
      );
      await sleep(delay);
      continue;
    }
    if (res.ok) return res;
    const text = await res.text();
    if (attempt >= maxAttempts || !RETRIABLE_HTTP.has(res.status)) {
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }
    const fromHeader = parseRetryAfterSeconds(res);
    const delayMs = Math.min(
      60_000,
      (fromHeader ?? Math.min(30, 2 ** attempt)) * 1000 + Math.random() * 400
    );
    console.warn(
      `  [${logLabel}] HTTP ${res.status} (attempt ${attempt}/${maxAttempts}), waiting ${Math.round(delayMs)}ms`
    );
    await sleep(delayMs);
  }
}

/** Caps concurrent in-flight OpenRouter calls (shared across pages, sections, files). */
class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const DEFAULT_CLIENT = 'current';

function getClientDataDir(): string {
  return path.join(
    process.cwd(),
    'src',
    'data',
    process.env.CLIENT_ID || DEFAULT_CLIENT
  );
}

type LanguageConfig = {
  defaultLanguage?: string;
  supportedLanguages?: string[];
  translation?: {
    sourceFile?: string;
    /** Optional explicit source language override (e.g. "de"). */
    sourceLanguage?: string;
    targetLanguages?: string[];
    openRouter?: { model?: string; baseUrl?: string };
    skipKeys?: string[];
    /** Optional override. Default: ['faq.json', 'faq-xxl.json', 'partners.json']. */
    perSiteFiles?: string[];
  };
};

function loadConfig(clientDataDir: string): {
  sourceFile: string;
  sourceLanguage: string;
  targetLanguages: string[];
  openRouter?: { model?: string; baseUrl?: string };
  skipKeys?: string[];
  perSiteFiles?: string[];
} {
  const languageConfigPath = path.join(clientDataDir, 'language.config.json');
  const raw = fs.readFileSync(languageConfigPath, 'utf-8');
  const config = JSON.parse(raw) as LanguageConfig;
  const defaultLanguage = config.defaultLanguage ?? 'de';
  const explicitSourceLanguage = config.translation?.sourceLanguage;
  const supportedLanguages = Array.isArray(config.supportedLanguages)
    ? config.supportedLanguages
    : [defaultLanguage];
  const translation = config.translation ?? {};

  const sourceFile = translation.sourceFile ?? 'websites.json';
  const configuredSourceLanguage =
    typeof explicitSourceLanguage === 'string' && explicitSourceLanguage.trim()
      ? explicitSourceLanguage.trim()
      : defaultLanguage;
  // Heuristic safety net: many clients set `defaultLanguage: "en"` for routing,
  // but keep German copy in `websites.json`. If EN is default and DE is supported,
  // treat DE as the translation source unless explicitly overridden.
  const sourceLanguage =
    !explicitSourceLanguage &&
    configuredSourceLanguage === 'en' &&
    supportedLanguages.includes('de') &&
    path.basename(sourceFile) === 'websites.json'
      ? 'de'
      : configuredSourceLanguage;
  const targetLanguages =
    Array.isArray(translation.targetLanguages) &&
    translation.targetLanguages.length > 0
      ? translation.targetLanguages
      : supportedLanguages.filter((l) => l !== defaultLanguage);

  if (!sourceFile) {
    throw new Error(
      'language.config.json must have translation.sourceFile (or default websites.json)'
    );
  }

  return {
    sourceFile,
    sourceLanguage,
    targetLanguages,
    openRouter: translation.openRouter,
    skipKeys: translation.skipKeys,
    perSiteFiles: Array.isArray(translation.perSiteFiles)
      ? translation.perSiteFiles
      : undefined,
  };
}

function loadSourcePages(
  clientDataDir: string,
  config: { sourceFile: string }
): {
  websites: Record<string, unknown>[];
  shared?: Record<string, unknown>;
} {
  const filePath = path.join(clientDataDir, config.sourceFile);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as
    | Record<string, unknown>[]
    | { shared?: Record<string, unknown>; websites: Record<string, unknown>[] };
  if (Array.isArray(data))
    return { websites: data as Record<string, unknown>[] };
  if (data && Array.isArray((data as { websites?: unknown[] }).websites))
    return {
      websites: (data as { websites: Record<string, unknown>[] }).websites,
      shared: (data as { shared?: Record<string, unknown> }).shared,
    };
  throw new Error(
    'Source JSON must be an array of website objects or { shared, websites }'
  );
}

function extractJsonFromResponse(content: string): string {
  const trimmed = content.trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(trimmed);
  if (codeBlock) return codeBlock[1].trim();
  return trimmed;
}

/** Walk JSON and emit dot-notation paths for every non-empty string leaf (ai-protected-paths convention). */
function collectStringPaths(
  value: unknown,
  pathPrefix: string,
  out: Array<{ path: string; value: string }>
): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.push({ path: pathPrefix, value });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectStringPaths(value[i], `${pathPrefix}[${i}]`, out);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = pathPrefix ? `${pathPrefix}.${k}` : k;
      collectStringPaths(v, next, out);
    }
  }
}

/** Does the string literal look like something we should NEVER translate (URL, phone, email, image path)? */
function looksUntranslatable(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^tel:|^mailto:/i.test(v)) return true;
  // Asset/image/font path.
  if (
    /^\/[^ ]*\.(webp|png|jpe?g|svg|gif|avif|woff2?|ttf|ico|css|js|mjs|json|pdf)$/i.test(
      v
    )
  )
    return true;
  // Pure numeric / identifier (currency code, rating, etc.)
  if (/^[0-9.,+\-]+$/.test(v) && v.length <= 20) return true;
  // BCP 47 locale / language code (e.g. "de-DE", "en")
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/i.test(v) && v.length <= 8) return true;
  // HSL color component or hex (e.g. "328 85% 46%", "#ffffff")
  if (/^#?[0-9a-f]{3,8}$/i.test(v)) return true;
  return false;
}

/** Split dot-and-bracket path into segments: "pages[0].hero.h1" → ["pages", 0, "hero", "h1"]. */
function parseJsonPath(p: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

function setValueByPath(root: unknown, p: string, value: string): void {
  const segs = parseJsonPath(p);
  if (segs.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string | number, unknown>)[seg as never];
    } else {
      return; // path doesn't exist in target — give up silently
    }
  }
  const last = segs[segs.length - 1];
  if (cur && typeof cur === 'object') {
    (cur as Record<string | number, unknown>)[last as never] = value;
  }
}

function getValueByPath(root: unknown, p: string): unknown {
  const segs = parseJsonPath(p);
  if (segs.length === 0) return undefined;
  let cur: unknown = root;
  for (const seg of segs) {
    if (cur == null) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function hasStrongGermanSignals(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Umlauts/ß strongly indicate German copy in this project.
  if (/[äöüßÄÖÜ]/.test(t)) return true;
  // Common German function words and UI copy fragments; keep list small and strong.
  const lower = ` ${t.toLowerCase()} `;
  const germanNeedles = [
    ' der ',
    ' die ',
    ' das ',
    ' und ',
    ' nicht ',
    ' für ',
    ' über ',
    ' zurück',
    ' gäste',
    ' öffnungszeiten',
    ' buchung',
    ' seite ',
    ' kontakt',
    ' häufig',
    ' willkommen',
    ' jetzt ',
    ' dein ',
    ' deine ',
    ' dich ',
  ];
  let hits = 0;
  for (const n of germanNeedles) {
    if (lower.includes(n)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function shouldPreserveExistingTargetString(params: {
  targetLang: string;
  value: string;
}): boolean {
  // Only do language-aware preservation for English right now (per requirements).
  if (params.targetLang !== 'en') return false;
  const v = params.value;
  if (looksUntranslatable(v)) return true;
  // Preserve strings that don't look like German.
  return !hasStrongGermanSignals(v);
}

function needsEnglishFixForWebsiteJson(params: {
  existing: unknown;
  skipKeys: string[] | undefined;
}): boolean {
  const allStrings: Array<{ path: string; value: string }> = [];
  collectStringPaths(params.existing, '', allStrings);
  for (const { path: p, value } of allStrings) {
    if (!isTranslatableWebsiteStringPath(p)) continue;
    if (looksUntranslatable(value)) continue;
    if (isSkippedByUserConfig(p, params.skipKeys)) continue;
    if (hasStrongGermanSignals(value)) return true;
  }
  return false;
}

function needsEnglishFixForGenericJson(params: {
  existing: unknown;
  skipKeys: string[] | undefined;
}): boolean {
  const allStrings: Array<{ path: string; value: string }> = [];
  collectStringPaths(params.existing, '', allStrings);
  for (const { path: p, value } of allStrings) {
    if (looksUntranslatable(value)) continue;
    if (isSkippedByUserConfig(p, params.skipKeys)) continue;
    if (hasStrongGermanSignals(value)) return true;
  }
  return false;
}

/** Translate a flat {path: value} map via one AI call. Missing keys = untranslated (caller keeps source). */
async function translateStringMap(
  apiKey: string,
  model: string,
  sourceLang: string,
  targetLang: string,
  payload: Record<string, string>,
  sectionLabel: string
): Promise<Record<string, string>> {
  const systemPrompt = `You are a professional translator. You receive a JSON object whose keys are dot-notation paths and whose values are source-language strings. Translate every value from ${sourceLang} to ${targetLang}.

Rules:
- Return ONLY a JSON object with the SAME keys, values translated. No markdown fence, no extra keys, no explanation.
- Preserve the exact string semantics; keep German "Du"/"Sie" tone consistent with the source.
- Do NOT translate URLs, email addresses, phone numbers, postal codes, numeric IDs, file paths, or image paths. If a value is such a literal, return it unchanged.
- Do NOT translate path-like values starting with "/" (e.g. "/ueber-uns"). These are routing slugs — translating them would 404.
- If a value is already in the target language, return it unchanged.
- Keep placeholders in braces (e.g. {LEGAL_NAME}, {ADDRESS_CITY}) exactly as-is.
- Keep HTML tags exactly as-is; translate only their text content.

Section context: ${sectionLabel}`;

  const userPrompt = `Translate these values from ${sourceLang} to ${targetLang}. Return the translated JSON object only.\n\n${JSON.stringify(
    payload,
    null,
    2
  )}`;

  const res = await fetchOpenRouterWithRetry(
    OPENROUTER_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || GEMINI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        // Chunked payloads are small — 8K is plenty per section.
        max_tokens: 8000,
      }),
    },
    `string-map:${sectionLabel}`
  );

  const data = (await res.json()) as {
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
    script: 'translate-data',
    operation: `string-map:${sectionLabel}`,
    model: model || GEMINI_MODEL || null,
    usage: data.usage ?? null,
    generationId: data.id ?? null,
    extra: { sourceLang, targetLang },
  });
  const content = data.choices?.[0]?.message?.content;
  if (!content)
    throw new Error('OpenRouter response missing choices[0].message.content');

  const jsonText = extractJsonFromResponse(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse AI response as JSON (section="${sectionLabel}"): ${(err as Error).message}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `AI response for section "${sectionLabel}" was not an object`
    );
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

function isSkippedByUserConfig(
  fullPath: string,
  skipKeys: string[] | undefined
): boolean {
  if (!skipKeys || skipKeys.length === 0) return false;
  for (const key of skipKeys) {
    if (!key) continue;
    if (fullPath === key) return true;
    if (fullPath.endsWith(`.${key}`)) return true;
    // Also match by leaf segment (skipKeys historically includes leaves like "url", "src")
    const segs = parseJsonPath(fullPath);
    if (segs.length > 0 && segs[segs.length - 1] === key) return true;
  }
  return false;
}

async function translatePageChunked(
  apiKey: string,
  model: string,
  sourceLang: string,
  targetLang: string,
  source: Record<string, unknown>,
  existingTarget: Record<string, unknown> | null,
  skipKeys: string[] | undefined,
  limiter: ConcurrencyLimiter
): Promise<Record<string, unknown>> {
  // Start from source shape (keeps JSON schema current), then selectively preserve existing target strings.
  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;

  const allStrings: Array<{ path: string; value: string }> = [];
  collectStringPaths(source, '', allStrings);

  const translatable = allStrings.filter(({ path: p, value }) => {
    if (!isTranslatableWebsiteStringPath(p)) return false;
    if (looksUntranslatable(value)) return false;
    if (isSkippedByUserConfig(p, skipKeys)) return false;
    return true;
  });

  if (translatable.length === 0) return clone;

  const existingPreservedPaths = new Set<string>();
  if (existingTarget) {
    const sourceByPath = new Map(translatable.map((x) => [x.path, x.value]));
    for (const { path: p } of translatable) {
      const existing = getValueByPath(existingTarget, p);
      if (typeof existing !== 'string') continue;
      // Existing == source means the previous run filled this site from source
      // as a partial-translation fallback; never treat that as "already translated".
      if (existing === sourceByPath.get(p)) continue;
      if (shouldPreserveExistingTargetString({ targetLang, value: existing })) {
        setValueByPath(clone, p, existing);
        existingPreservedPaths.add(p);
      }
    }
  }

  const pathOnly = translatable
    .map((x) => x.path)
    .filter((p) => !existingPreservedPaths.has(p));
  if (pathOnly.length === 0) {
    console.log('    ✓ existing target content looks English — no changes needed');
    return clone;
  }
  const batches = groupPathsBySections(pathOnly);
  const valueByPath = new Map(translatable.map((x) => [x.path, x.value]));

  type SectionJob = {
    batch: (typeof batches)[0];
    payload: Record<string, string>;
  };
  const jobs: SectionJob[] = [];
  for (const batch of batches) {
    const payload: Record<string, string> = {};
    for (const p of batch.paths) {
      const v = valueByPath.get(p);
      if (typeof v === 'string') payload[p] = v;
    }
    if (Object.keys(payload).length > 0) jobs.push({ batch, payload });
  }

  const sectionResults = await Promise.all(
    jobs.map(({ batch, payload }) =>
      limiter.run(async () => {
        const label = `section "${batch.section}" (${Object.keys(payload).length} strings)`;
        process.stdout.write(`    ${label}... `);
        try {
          const translated = await translateStringMap(
            apiKey,
            model,
            sourceLang,
            targetLang,
            payload,
            batch.section
          );
          console.log('OK');
          return { batch, translated };
        } catch (err) {
          console.log('FAIL');
          throw err;
        }
      })
    )
  );

  let translatedCount = 0;
  for (const { batch, translated } of sectionResults) {
    for (const p of batch.paths) {
      const t = translated[p];
      if (typeof t === 'string' && t.length > 0) {
        setValueByPath(clone, p, t);
        translatedCount++;
      }
    }
  }

  console.log(
    `    ✓ translated ${translatedCount}/${pathOnly.length} string(s) across ${batches.length} section(s)`
  );
  return clone;
}

function writeTranslatedFile(targetPath: string, data: unknown): void {
  // Preserve canonical Schema.org `@type`/`@id` keys verbatim. (A previous
  // regex here wrapped them as `[@type]`/`[@id]` and broke JSON-LD parsers.)
  fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
}

function loadExistingWebsitesOutput(outputPath: string): {
  websites: Record<string, unknown>[];
  shared?: Record<string, unknown>;
} | null {
  if (!fs.existsSync(outputPath)) return null;
  try {
    const raw = fs.readFileSync(outputPath, 'utf-8');
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data))
      return { websites: data as Record<string, unknown>[] };
    if (
      data &&
      typeof data === 'object' &&
      Array.isArray((data as { websites?: unknown }).websites)
    ) {
      return {
        websites: (data as { websites: Record<string, unknown>[] }).websites,
        shared: (data as { shared?: Record<string, unknown> }).shared,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function toWebsiteMapById(
  list: Record<string, unknown>[]
): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const w of list) {
    const id = parseWebsiteId(w);
    if (id) m.set(id, w);
  }
  return m;
}

/** Merge newly translated sites into an existing target-language JSON (order follows source websites.json). */
function mergePartialWebsiteTranslation(params: {
  shared: Record<string, unknown> | undefined;
  sourceWebsites: Record<string, unknown>[];
  translatedSubset: Record<string, unknown>[];
  selectedIds: Set<string>;
  outputPath: string;
}):
  | Record<string, unknown>[]
  | { shared?: Record<string, unknown>; websites: Record<string, unknown>[] } {
  const existing = loadExistingWebsitesOutput(params.outputPath);
  const translatedById = toWebsiteMapById(params.translatedSubset);
  const existingById = existing
    ? toWebsiteMapById(existing.websites)
    : new Map<string, Record<string, unknown>>();
  if (!existing) {
    console.log(
      `  ${path.basename(params.outputPath)}: no existing file — creating initial output (selected sites translated; others copied from source until you run a full translate)`
    );
  }

  const merged: Record<string, unknown>[] = params.sourceWebsites.map(
    (src) => {
      const id = parseWebsiteId(src);
      if (!id) return src;
      if (params.selectedIds.has(id)) {
        const t = translatedById.get(id);
        if (!t) {
          throw new Error(
            `Internal error: missing translated block for website id "${id}"`
          );
        }
        return t;
      }
      const prev = existingById.get(id);
      if (prev) return prev;
      // No existing translation for this non-selected site — fall back to source.
      // Keeps the output schema complete so the runtime can load it.
      return src;
    }
  );

  if (params.shared !== undefined) {
    return { shared: params.shared, websites: merged };
  }
  return merged;
}

function getOutputFileName(sourceFile: string, lang: string): string {
  const base = path.basename(sourceFile, path.extname(sourceFile));
  if (base === 'websites')
    return lang === 'de' ? 'websites.json' : `websites-${lang}.json`;
  return lang === 'de' ? `${base}.json` : `${base}-${lang}.json`;
}

// ---------------------------------------------------------------------------
// Per-site file translation (faq.json, faq-xxl.json, partners.json, …)
// ---------------------------------------------------------------------------

/** Translatable per-site files. Overridable via language.config.json → translation.perSiteFiles. */
const DEFAULT_PER_SITE_FILES: readonly string[] = [
  'faq.json',
  'faq-xxl.json',
  'partners.json',
  'grounding.md',
];

/** File-name prefixes skipped during translation (metadata, scratch, backups). */
const PER_SITE_SKIP_NAMES: readonly string[] = [
  'client-prompt-ai-input.json',
  'topics.json',
  'prompt.md', // not JSON but could live here
];

/** True when `filename` looks like an already-translated variant (e.g. faq-en.json) of a base name. */
function isLanguageSuffixedVariant(
  filename: string,
  baseNames: readonly string[]
): boolean {
  for (const base of baseNames) {
    const noExt = base.replace(/\.json$/, '');
    // Matches "<base>-<2-3 letter code>(-<region>)?.json".
    const rx = new RegExp(
      `^${noExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z]{2,3}(-[A-Za-z0-9]{2,4})?\\.json$`,
      'i'
    );
    if (rx.test(filename)) return true;
  }
  return false;
}

/** Batch paths into fixed-size groups (for non-website files with no section dimension). */
function chunkBySize<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Translate one per-site JSON file (array or object root) in fixed-size batches. */
async function translatePerSiteFile(
  apiKey: string,
  model: string,
  sourceLang: string,
  targetLang: string,
  srcPath: string,
  dstPath: string,
  skipKeys: string[] | undefined,
  fileLabel: string,
  limiter: ConcurrencyLimiter
): Promise<void> {
  const raw = fs.readFileSync(srcPath, 'utf-8');
  const source = JSON.parse(raw);
  const clone = JSON.parse(JSON.stringify(source));
  let existingTarget: unknown = null;
  if (fs.existsSync(dstPath)) {
    try {
      existingTarget = JSON.parse(fs.readFileSync(dstPath, 'utf-8'));
    } catch {
      existingTarget = null;
    }
  }

  const allStrings: Array<{ path: string; value: string }> = [];
  collectStringPaths(source, '', allStrings);
  const translatable = allStrings.filter(({ path: p, value }) => {
    // Per-site files bypass isAiFillablePath (which is websites.json-shaped); filter non-translatable strings only.
    if (looksUntranslatable(value)) return false;
    if (isSkippedByUserConfig(p, skipKeys)) return false;
    return true;
  });

  if (translatable.length === 0) {
    console.log(`  ${fileLabel}: nothing to translate, copying as-is`);
    if (!fs.existsSync(dstPath)) {
      fs.writeFileSync(dstPath, JSON.stringify(clone, null, 2));
    }
    return;
  }

  const preserved = new Set<string>();
  if (existingTarget) {
    // If the whole existing EN file looks clean, don't regenerate or rewrite it.
    if (
      targetLang === 'en' &&
      !needsEnglishFixForGenericJson({ existing: existingTarget, skipKeys })
    ) {
      console.log(`  ${fileLabel}: ✓ already English — skipping`);
      return;
    }
    const sourceByPath = new Map(translatable.map((x) => [x.path, x.value]));
    for (const { path: p } of translatable) {
      const ex = getValueByPath(existingTarget, p);
      if (typeof ex !== 'string') continue;
      // Existing == source means it was never actually translated — retranslate it.
      if (ex === sourceByPath.get(p)) continue;
      if (shouldPreserveExistingTargetString({ targetLang, value: ex })) {
        setValueByPath(clone, p, ex);
        preserved.add(p);
      }
    }
  }

  const translatablePaths = translatable
    .map((x) => x.path)
    .filter((p) => !preserved.has(p));
  if (translatablePaths.length === 0) {
    console.log(`  ${fileLabel}: ✓ existing target content looks English — no changes needed`);
    // Do not rewrite existing EN output.
    if (!fs.existsSync(dstPath)) {
      fs.writeFileSync(dstPath, JSON.stringify(clone, null, 2));
    }
    return;
  }

  console.log(
    `  ${fileLabel}: ${translatablePaths.length} string(s) need translation`
  );
  const valueByPath = new Map(translatable.map((x) => [x.path, x.value]));
  const pathBatches = chunkBySize(translatablePaths, 30);

  const batchResults = await Promise.all(
    pathBatches.map((paths, b) =>
      limiter.run(async () => {
        const payload: Record<string, string> = {};
        for (const p of paths) {
          const v = valueByPath.get(p);
          if (typeof v === 'string') payload[p] = v;
        }
        const label = `${fileLabel} batch ${b + 1}/${pathBatches.length} (${paths.length} strings)`;
        process.stdout.write(`    ${label}... `);
        try {
          const translated = await translateStringMap(
            apiKey,
            model,
            sourceLang,
            targetLang,
            payload,
            label
          );
          console.log('OK');
          return { paths, translated };
        } catch (err) {
          console.log('FAIL');
          throw err;
        }
      })
    )
  );

  let translatedCount = 0;
  for (const { paths, translated } of batchResults) {
    for (const p of paths) {
      const t = translated[p];
      if (typeof t === 'string' && t.length > 0) {
        setValueByPath(clone, p, t);
        translatedCount++;
      }
    }
  }

  fs.writeFileSync(dstPath, JSON.stringify(clone, null, 2));
  console.log(
    `  ${fileLabel}: ✓ translated ${translatedCount}/${translatablePaths.length} → ${path.relative(process.cwd(), dstPath)}`
  );
}

/** Translate every eligible per-site file under src/data/<client>/. Output: `<base>-<lang>.json` alongside source.
 * @param restrictSiteIds when set, only folders whose name is in this set are processed (matches website `id`).
 */
async function translatePerSiteFilesForLang(
  clientDataDir: string,
  apiKey: string,
  model: string,
  sourceLang: string,
  targetLang: string,
  perSiteFiles: string[],
  skipKeys: string[] | undefined,
  limiter: ConcurrencyLimiter,
  restrictSiteIds: Set<string> | null
): Promise<void> {
  // Discover site folders (sibling dirs under clientDataDir that contain JSON files).
  let siteFolders: string[] = [];
  try {
    siteFolders = fs
      .readdirSync(clientDataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith('.') && !name.startsWith('_'));
  } catch {
    return;
  }
  if (siteFolders.length === 0) return;

  // Client-level grounding.md (one file shared by all sites — see generate-grounding.mjs)
  if (perSiteFiles.includes('grounding.md')) {
    const clientGrounding = path.join(clientDataDir, 'grounding.md');
    if (fs.existsSync(clientGrounding)) {
      const base = 'grounding';
      const ext = '.md';
      const outName =
        targetLang === sourceLang
          ? `${base}${ext}`
          : `${base}-${targetLang}${ext}`;
      const dstFilePath = path.join(clientDataDir, outName);
      console.log(`\n[client] grounding.md (shared)`);
      try {
        await translateMarkdownFile(
          apiKey,
          model,
          sourceLang,
          targetLang,
          clientGrounding,
          dstFilePath,
          'grounding.md',
          limiter
        );
      } catch (err) {
        console.error(
          `  [client] grounding.md FAILED: ${(err as Error).message}`
        );
      }
    }
  }

  for (const siteId of siteFolders) {
    if (restrictSiteIds && !restrictSiteIds.has(siteId)) continue;
    const siteDir = path.join(clientDataDir, siteId);
    let entries: string[] = [];
    try {
      entries = fs
        .readdirSync(siteDir)
        .filter(
          (f) =>
            (f.endsWith('.json') || f.endsWith('.md')) && !f.startsWith('.')
        );
    } catch {
      continue;
    }
    if (entries.length === 0) continue;

    // IMPORTANT: check perSiteFiles.includes FIRST — e.g. `faq-xxl.json` would otherwise be flagged as a variant.
    const eligible = entries.filter((f) => {
      if (PER_SITE_SKIP_NAMES.includes(f)) return false;
      if (perSiteFiles.includes(f)) return true;
      if (isLanguageSuffixedVariant(f, perSiteFiles)) return false;
      return false;
    });
    // Also check for .md files in the directory (not caught by entries which filters .json)
    try {
      const mdEntries = fs
        .readdirSync(siteDir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'));
      for (const md of mdEntries) {
        if (perSiteFiles.includes(md) && !eligible.includes(md)) {
          if (!isLanguageSuffixedMd(md, perSiteFiles)) {
            eligible.push(md);
          }
        }
      }
    } catch {
      /* ignore */
    }
    if (eligible.length === 0) continue;

    console.log(`\n[${siteId}] ${eligible.length} file(s) to translate`);
    await Promise.all(
      eligible.map((fileName) =>
        (async () => {
          const isMd = fileName.endsWith('.md');
          const ext = isMd ? '.md' : '.json';
          const base = fileName.replace(new RegExp(`\\${ext}$`), '');
          const outName =
            targetLang === sourceLang
              ? `${base}${ext}`
              : `${base}-${targetLang}${ext}`;
          const srcFilePath = path.join(siteDir, fileName);
          const dstFilePath = path.join(siteDir, outName);
          try {
            if (isMd) {
              await translateMarkdownFile(
                apiKey,
                model,
                sourceLang,
                targetLang,
                srcFilePath,
                dstFilePath,
                fileName,
                limiter
              );
            } else {
              await translatePerSiteFile(
                apiKey,
                model,
                sourceLang,
                targetLang,
                srcFilePath,
                dstFilePath,
                skipKeys,
                fileName,
                limiter
              );
            }
          } catch (err) {
            console.error(
              `  [${siteId}] ${fileName} FAILED: ${(err as Error).message}`
            );
          }
        })()
      )
    );
  }
}

/** Check if a .md filename is an already-translated variant (e.g. grounding-en.md). */
function isLanguageSuffixedMd(
  filename: string,
  baseNames: readonly string[]
): boolean {
  for (const base of baseNames) {
    if (!base.endsWith('.md')) continue;
    const noExt = base.replace(/\.md$/, '');
    const rx = new RegExp(
      `^${noExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z]{2,3}(-[A-Za-z0-9]{2,4})?\\.md$`,
      'i'
    );
    if (rx.test(filename)) return true;
  }
  return false;
}

/** Translate a small markdown file in one AI call (grounding.md etc. — typically <15 KB, no chunking needed). */
async function translateMarkdownFile(
  apiKey: string,
  model: string,
  sourceLang: string,
  targetLang: string,
  srcFilePath: string,
  dstFilePath: string,
  fileLabel: string,
  limiter: ConcurrencyLimiter
): Promise<void> {
  const srcMarkdown = fs.readFileSync(srcFilePath, 'utf-8');
  if (!srcMarkdown.trim()) {
    console.log(`  ${fileLabel}: empty — skipping`);
    return;
  }
  const hasExistingTarget = fs.existsSync(dstFilePath);
  const existingTargetMarkdown =
    hasExistingTarget && targetLang === 'en'
      ? (() => {
          try {
            return fs.readFileSync(dstFilePath, 'utf-8');
          } catch {
            return '';
          }
        })()
      : '';

  if (hasExistingTarget && targetLang === 'en') {
    // If it's already English (no strong German signals), don't rewrite it.
    if (!hasStrongGermanSignals(existingTargetMarkdown)) {
      console.log(`  ${fileLabel}: ✓ already English — skipping`);
      return;
    }
  }

  console.log(
    `  ${fileLabel}: ${(srcMarkdown.length / 1024).toFixed(1)} KB markdown`
  );
  process.stdout.write(
    hasExistingTarget && targetLang === 'en'
      ? `    reviewing existing ${targetLang} and fixing non-English parts... `
      : `    translating ${sourceLang} → ${targetLang}... `
  );

  const systemPrompt =
    hasExistingTarget && targetLang === 'en'
      ? `You are a professional translator and editor. You receive a Markdown document that SHOULD be fully English but may contain leftover non-English parts (e.g. German).

Task:
- Convert ONLY the non-English parts into natural, correct English.
- DO NOT rewrite or paraphrase text that is already correct English.

Rules:
- Preserve ALL Markdown formatting exactly (headings, tables, lists, bold, italic, links, code blocks).
- Do NOT translate URLs, email addresses, phone numbers, or file paths.
- Keep proper nouns (brand names, place names, person names) unchanged unless they have an established English form.
- Return ONLY the corrected Markdown. No explanation, no surrounding code fences.`
      : `You are a professional translator. Translate the following Markdown document from ${sourceLang} to ${targetLang}.

Rules:
- Preserve ALL Markdown formatting exactly (headings, tables, lists, bold, italic, links, code blocks).
- Translate only the human-readable text content.
- Do NOT translate URLs, email addresses, phone numbers, or file paths.
- Keep proper nouns (brand names, place names, person names) unchanged unless they have an established translation.
- Return ONLY the translated Markdown. No explanation, no code fences wrapping the output.`;

  const data = await limiter.run(async () => {
    const res = await fetchOpenRouterWithRetry(
      OPENROUTER_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content:
                hasExistingTarget && targetLang === 'en'
                  ? existingTargetMarkdown || srcMarkdown
                  : srcMarkdown,
            },
          ],
          temperature: 0.2,
          max_tokens: 16000,
        }),
      },
      `markdown:${fileLabel}`
    );

    return (await res.json()) as {
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
  });

  logOpenRouterChatResponse({
    script: 'translate-data',
    operation: `markdown:${fileLabel}`,
    model,
    usage: data.usage ?? null,
    generationId: data.id ?? null,
    extra: { sourceLang, targetLang, srcFilePath },
  });
  const translated = data.choices?.[0]?.message?.content;
  if (!translated) {
    throw new Error('Empty response from API');
  }

  // Strip accidental markdown code fences the model sometimes wraps around the output.
  const cleaned = translated
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/, '');

  fs.writeFileSync(dstFilePath, cleaned);
  console.log('OK');
  console.log(
    `  ${fileLabel}: ✓ → ${path.relative(process.cwd(), dstFilePath)}`
  );
}

async function translateTemplateLegalJsonIfNeeded(params: {
  apiKey: string;
  model: string;
  sourceLang: string;
  targetLang: string;
  srcPath: string;
  dstPath: string;
  limiter: ConcurrencyLimiter;
}): Promise<void> {
  if (!fs.existsSync(params.srcPath)) return;
  const fileLabel = path.basename(params.srcPath);
  // Reuse the per-site JSON logic (structure-first, preserve existing EN if valid).
  await translatePerSiteFile(
    params.apiKey,
    params.model,
    params.sourceLang,
    params.targetLang,
    params.srcPath,
    params.dstPath,
    undefined,
    fileLabel,
    params.limiter
  );
}

async function main(): Promise<void> {
  // (dotenv.config already loaded at module level — see top of file.)
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY in .env.local');
    process.exit(1);
  }

  const clientDataDir = getClientDataDir();
  const config = loadConfig(clientDataDir);
  const model = config.openRouter?.model ?? GEMINI_MODEL ?? '';
  if (!model) {
    console.error(
      'Missing translation model. Set OPENROUTER_MODEL_WEBSITE_GEN in .env.local or translation.openRouter.model in language.config.json'
    );
    process.exit(1);
  }

  const langArg = process.argv.find((a) => a.startsWith('--lang='));
  const targetLangs = langArg
    ? langArg
        .replace('--lang=', '')
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean)
    : config.targetLanguages;

  if (targetLangs.length === 0) {
    console.error(
      'No target languages (language.config.json translation.targetLanguages or supportedLanguages)'
    );
    process.exit(1);
  }

  let siteScope = parseCliSitesFlag();
  const { websites: allPages, shared } = loadSourcePages(
    clientDataDir,
    config
  );

  const sortedSiteIds = allPages
    .map((p) => parseWebsiteId(p))
    .filter((id): id is string => id !== null);

  siteScope = await promptSiteScopeIfNeeded(siteScope, sortedSiteIds);

  let pages: Record<string, unknown>[];
  if (siteScope.mode === 'subset') {
    const want = new Set(siteScope.ids);
    for (const id of siteScope.ids) {
      if (!allPages.some((p) => parseWebsiteId(p) === id)) {
        console.error(
          `Unknown website id in --sites: "${id}" (not found in ${config.sourceFile})`
        );
        process.exit(1);
      }
    }
    pages = allPages.filter((p) => {
      const id = parseWebsiteId(p);
      return id !== null && want.has(id);
    });
  } else {
    pages = allPages;
  }

  const isPartialSites =
    siteScope.mode === 'subset' && pages.length < allPages.length;
  const restrictSiteIdsForPerSite =
    siteScope.mode === 'subset' ? new Set(siteScope.ids) : null;
  const selectedIdSet =
    siteScope.mode === 'subset' ? new Set(siteScope.ids) : new Set<string>();

  const concurrency = parseCliConcurrency();
  console.log(
    isPartialSites
      ? `Translating ${pages.length} of ${allPages.length} website(s) (partial --sites=) from ${config.sourceLanguage} → ${targetLangs.join(', ')}`
      : `Translating ${pages.length} website(s) from ${config.sourceLanguage} → ${targetLangs.join(', ')}`
  );
  console.log(
    `OpenRouter max concurrent requests: ${concurrency} (--concurrency=N or TRANSLATE_CONCURRENCY)`
  );
  console.log('');

  for (const targetLang of targetLangs) {
    const limiter = new ConcurrencyLimiter(concurrency);
    const outputFile = getOutputFileName(config.sourceFile, targetLang);
    const outputPath = path.join(clientDataDir, outputFile);

    console.log(`  → ${targetLang}`);

    // Ensure EN legal templates exist and are fully English (required by runtime imports).
    if (targetLang === 'en') {
      const legalDir = path.join(
        process.cwd(),
        'src',
        'data',
        '_template',
        'legal'
      );
      const datenschutzSrc = path.join(legalDir, 'datenschutz-content.json');
      const datenschutzDst = path.join(legalDir, 'datenschutz-content-en.json');
      const impressumSrc = path.join(legalDir, 'impressum-content.json');
      const impressumDst = path.join(legalDir, 'impressum-content-en.json');
      console.log('  Ensuring legal template EN files');
      try {
        await translateTemplateLegalJsonIfNeeded({
          apiKey,
          model,
          sourceLang: config.sourceLanguage,
          targetLang,
          srcPath: datenschutzSrc,
          dstPath: datenschutzDst,
          limiter,
        });
        await translateTemplateLegalJsonIfNeeded({
          apiKey,
          model,
          sourceLang: config.sourceLanguage,
          targetLang,
          srcPath: impressumSrc,
          dstPath: impressumDst,
          limiter,
        });
      } catch (err) {
        console.error(
          `  ⚠️  Legal template translation failed: ${(err as Error).message}`
        );
      }
    }

    // If websites-en.json already exists and looks fully English, do not regenerate it.
    // This keeps translation as a one-time process unless we detect mixed-language content.
    if (targetLang === 'en') {
      const existing = loadExistingWebsitesOutput(outputPath);
      if (existing) {
        const needsFix = needsEnglishFixForWebsiteJson({
          existing: existing.websites,
          skipKeys: config.skipKeys,
        });
        if (!needsFix) {
          console.log('  websites-en.json: ✓ already English — skipping regeneration');
          // Still run per-site generation for missing EN files (but those functions are also idempotent now).
          if (targetLang !== config.sourceLanguage) {
            const perSiteFiles =
              (config as { perSiteFiles?: string[] }).perSiteFiles &&
              Array.isArray((config as { perSiteFiles?: string[] }).perSiteFiles)
                ? ((config as { perSiteFiles?: string[] }).perSiteFiles as string[])
                : [...DEFAULT_PER_SITE_FILES];
            console.log(
              `  Translating per-site files (${perSiteFiles.join(', ')})`
            );
            try {
              await translatePerSiteFilesForLang(
                clientDataDir,
                apiKey,
                model,
                config.sourceLanguage,
                targetLang,
                perSiteFiles,
                config.skipKeys,
                limiter,
                restrictSiteIdsForPerSite
              );
            } catch (err) {
              console.error(
                `  ⚠️  Per-site translation aborted: ${(err as Error).message}`
              );
            }
          }
          continue;
        }
      }
    }

    let translatedPages: unknown[];
    try {
      const existingWebsitesOutput =
        targetLang === 'en' ? loadExistingWebsitesOutput(outputPath) : null;
      const existingById = existingWebsitesOutput
        ? toWebsiteMapById(existingWebsitesOutput.websites)
        : new Map<string, Record<string, unknown>>();
      translatedPages = await Promise.all(
        pages.map((page, i) =>
          (async () => {
            console.log(`  Website ${i + 1}/${pages.length}`);
            const id = parseWebsiteId(page);
            const existingTarget =
              id && existingById.has(id) ? existingById.get(id)! : null;
            return translatePageChunked(
              apiKey,
              model,
              config.sourceLanguage,
              targetLang,
              page as Record<string, unknown>,
              existingTarget,
              config.skipKeys,
              limiter
            );
          })()
        )
      );
    } catch (err) {
      console.error('  FAIL translating websites:', err);
      process.exit(1);
    }

    let payload: unknown;
    try {
      if (isPartialSites) {
        payload = mergePartialWebsiteTranslation({
          shared,
          sourceWebsites: allPages,
          translatedSubset: translatedPages as Record<string, unknown>[],
          selectedIds: selectedIdSet,
          outputPath,
        });
      } else {
        payload =
          shared != null ? { shared, websites: translatedPages } : translatedPages;
      }
    } catch (err) {
      console.error(
        `  FAIL building output for ${outputFile}:`,
        (err as Error).message
      );
      process.exit(1);
    }
    writeTranslatedFile(outputPath, payload);

    // Per-site files live under src/data/<client>/<siteId>/; skip when target equals default (would overwrite source).
    if (targetLang !== config.sourceLanguage) {
      const perSiteFiles =
        (config as { perSiteFiles?: string[] }).perSiteFiles &&
        Array.isArray((config as { perSiteFiles?: string[] }).perSiteFiles)
          ? ((config as { perSiteFiles?: string[] }).perSiteFiles as string[])
          : [...DEFAULT_PER_SITE_FILES];
      console.log(
        `  Translating per-site files (${perSiteFiles.join(', ')})`
      );
      try {
        await translatePerSiteFilesForLang(
          clientDataDir,
          apiKey,
          model,
          config.sourceLanguage,
          targetLang,
          perSiteFiles,
          config.skipKeys,
          limiter,
          restrictSiteIdsForPerSite
        );
      } catch (err) {
        console.error(
          `  ⚠️  Per-site translation aborted: ${(err as Error).message}`
        );
      }
    }
  }

  console.log('\nTranslation done.');
}

main();
