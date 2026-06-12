/**
 * AI Website Cloner: Creates a new location variant of an existing website entry.
 *
 * Takes an existing entry from websites.json and produces a new one with
 * location-specific fields updated (address, district, image paths, SEO text,
 * map description, metadata, geo coordinates, etc.). Brand-level fields
 * (name, tone, navigation, legal boilerplate, etc.) are preserved as-is.
 *
 * Token-efficient: string fields are regenerated in block-sized OpenRouter calls
 * (home.hero, home.info, home.metadata, …) — same output shape as 06 fill-blanks
 * (Different blockPath subtrees may be filled concurrently, default 2; batches within
 * a subtree, e.g. ueberUns.blocks, stay sequential. Set CLONE_SUBTREE_CONCURRENCY=1 to
 * disable, or 3–4 to scale up cautiously rate limits.
 * ({ fills: [{ path, value }] }). Source copy is never sent to the model; briefing +
 * topics.json + prompt.md drive originality. Static fields (business, header, footer,
 * cookie, notFound, translationsMetadata, index, ratgeber page, impressum/datenschutz
 * blocks) are deep-cloned and merged back without going through the AI.
 * After the AI response: stripProtectedPaths, merge with source for tooling-owned
 * fields, applyFaqDataFilesForClone, applyDiskImagePathsToEntry (same as 06/08).
 *
 * Uses a fast, cost-efficient model (gemini-2.5-flash by default).
 *
 * Requires: OPENROUTER_API_KEY in .env.local
 *
 * Usage:
 *   pnpm clone-website
 *     (interactive: client → pnpm use-client --activate-only → pick source site
 *      (websites[].id) → new site id from googleDrive/<client>/ folders with labels
 *      from websites.json; run pnpm organize-assets first if that folder is empty)
 *   pnpm clone-website --source=<existing-id> --id=<new-id> --prompt=<file>
 *   pnpm clone-website --source=<existing-id> --id=<new-id> --stdin
 *   pnpm clone-website --source-index=0 --id=<new-id> --prompt=<file> --dry-run
 *
 * Options:
 *   --client=<id>         Client folder under src/data (interactive: skip client prompt;
 *                         otherwise you are always asked which client to activate)
 *   --source=<id>         ID of the existing website entry to clone
 *   --source-index=<n>    Index (0-based) of the entry to clone (alternative to --source)
 *   --id=<new-id>         New kebab-case ID for the cloned entry (required)
 *   --prompt=<file>       Path to the new location description (default: src/data/<client>/
 *                         <new-id>/prompt.md when that file exists; fallback: prompt.txt)
 *   --stdin               Read the location prompt from stdin
 *   --model=<model>       Override the AI model (default: anthropic/claude-opus-4.1)
 *   --dry-run             Print generated JSON to stdout; no per-block or final websites.json write
 *   --out=<file>          Write the finished JSON only to this file; no per-block or final websites.json
 *
 * Env:
 *   CLONE_SUBTREE_CONCURRENCY  Optional, 1–4 (default 2). In-flight OpenRouter calls across
 *                              *different* blockPath subtrees; 1 = fully sequential. Same subtree
 *                              (including multi-batch pages) is never parallelized.
 *
 * Pipeline:
 *   Runs `pnpm 04-process-excel-data` once the client is known (before clone AI) so
 *   websites.json reflects Excel briefings and fields. While the AI runs block-by-block,
 *   the merged in-progress website entry is written to websites.json after every block
 *   (and after stale-block retries) so a crash does not lose already-generated copy.
 *   The final run upserts the complete entry (hero H1 unique vs other client sites, FAQ paths, disk images), then
 *   when `business.googlePlacesId` and GOOGLE_PLACES_API_KEY are set, fetches
 *   `formattedAddress` from Google Places (New) and writes `home.hero.card2Line1/2`
 *   (address card). After saving, runs `pnpm fetch-place-hero-address` for the new id
 *   (all websites*.json rows for that site), then `pnpm 07-fetch-google-reviews` (requires
 *   GOOGLE_PLACES_API_KEY and a Place ID on the entry when reviews can be fetched),
 *   then `pnpm 08-refine-website-data` for that client and new website id (link checks,
 *   copy validation; warns on failure without undoing the clone write).
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import * as dotenv from 'dotenv';
import enquirer from 'enquirer';
import { buildAiPrompt, buildProtectedPathsBlockForAi } from './lib/ai-prompts';
import {
  type CloneBlockSpec,
  getCloneBlockSpecsWithFallback,
} from './lib/ai-block-registry';
import { AI_PROTECTED_PATHS } from './lib/ai-protected-paths';
import { stripProtectedPaths } from './lib/strip-protected-paths';
import {
  applyDiskImagePathsToEntry,
  scanAvailableImages,
} from './lib/website-disk-images';
import { logAiCost, logOpenRouterChatResponse } from './lib/log-ai-cost.mjs';
import { applyGooglePlaceAddressToWebsiteEntry } from './lib/apply-google-place-hero-address';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// const DEFAULT_MODEL = 'anthropic/claude-opus-4.1';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/** Pause between the two clone sections (rate limits), aligned with 06-generate-website waves. */
const CLONE_SECTION_DELAY_MS = 10_000;
const CLONE_FILL_MAX_RETRIES = 2;

/**
 * How many different clone block subtrees (`blockPath`) may call OpenRouter at the same time.
 * Batches within one subtree (e.g. `ueberUns.blocks[0..3]`, `[4..7]`, …) are always serialized.
 * Env `CLONE_SUBTREE_CONCURRENCY=1` disables across-subtree parallelism. Max clamp: 4.
 */
const CLONE_SUBTREE_CONCURRENCY = ((): number => {
  const raw = process.env.CLONE_SUBTREE_CONCURRENCY;
  const n = raw !== undefined && raw !== '' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(4, n);
})();

type CloneFillItem = { path: string; value: string };
type CloneAiUsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  hasAnyCostData: boolean;
};
type CloneTopicsContext = {
  topics?: Record<string, string[]>;
  keywords?: string[];
  h1Suggestions?: string[];
  subtitleSuggestions?: string[];
  mustCover?: string[];
  avoidAngles?: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run independent async jobs with a max concurrency. Each `task` should fully finish one
 * unit of work (here: all batches for one `blockPath`) before the slot is released.
 */
async function runAsyncPool(
  tasks: Array<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  if (tasks.length === 0) return;
  const c = Math.max(1, Math.min(concurrency, tasks.length));
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    const kick = () => {
      while (active < c && next < tasks.length) {
        const idx = next++;
        active += 1;
        tasks[idx]!()
          .then(() => {
            active -= 1;
            if (active === 0 && next >= tasks.length) {
              resolve();
            } else {
              kick();
            }
          })
          .catch(reject);
      }
    };
    kick();
  });
}

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) return '$0.000000';
  return `$${cost.toFixed(6)}`;
}

/** Path segment parser — same rules as scripts/06-generate-website.ts (expandPath). */
function expandPath(pathStr: string): Array<string | number> {
  const parts: Array<string | number> = [];
  for (const segment of pathStr.split('.')) {
    const m = /^(\w+)(\[(\d+)\])?$/.exec(segment);
    if (!m) throw new Error(`Invalid path segment in "${pathStr}": ${segment}`);
    parts.push(m[1]);
    if (m[3] !== undefined) parts.push(Number(m[3]));
  }
  return parts;
}

function getValueAtPath(obj: unknown, parts: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof p === 'number') {
      cur = Array.isArray(cur) ? cur[p] : undefined;
    } else {
      cur = (cur as Record<string, unknown>)[p];
    }
  }
  return cur;
}

function setValueAtPath(
  target: Record<string, unknown>,
  parts: Array<string | number>,
  value: unknown
): void {
  if (parts.length === 0) return;
  let cur: unknown = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const follow = parts[i + 1];
    if (typeof p === 'string') {
      const obj = cur as Record<string, unknown>;
      if (obj[p] === undefined) {
        obj[p] = (typeof follow === 'number' ? [] : {}) as unknown;
      }
      cur = obj[p];
    } else {
      const arr = cur as unknown[];
      while (arr.length <= p) arr.push(undefined);
      if (arr[p] === undefined) {
        arr[p] = (typeof follow === 'number' ? [] : {}) as unknown;
      }
      cur = arr[p];
    }
  }
  const last = parts[parts.length - 1];
  if (typeof last === 'string') {
    (cur as Record<string, unknown>)[last] = value as unknown;
  } else {
    const arr = cur as unknown[];
    while (arr.length <= last) arr.push(undefined);
    arr[last] = value;
  }
}

const SLIM_PAGE_NAME_PATHS = new Set([
  'home.name',
  'faq.name',
  'impressum.name',
  'datenschutz.name',
  'ueberUns.name',
]);

const CLONE_ADAPT_PATH_DENY: RegExp[] = [
  /\.src$/,
  /\.backgroundImage$/,
  /\.imageUrl$/,
  /\.mapEmbedUrl$/,
  /\.faqDataFile$/,
  /hero\.buttons/,
  /trust\.logos/,
  /\.faqs(\.|$)/,
  /metadata\.openGraph\.images\[\d+\]\.url$/,
  /metadata\.twitter\.images\[\d+\]\.url$/,
  /metadata\.schema\[\d+\]\.data\.logo$/,
  /** Entire JSON-LD schema blocks stay on the source; do not send to AI. */
  /\.metadata\.schema(\.|$)/,
  /** Geo icbm/region etc. are tooling/Excel-owned for clones. */
  /\.metadata\.geo(\.|$)/,
];

function shouldSkipCloneAdaptPath(path: string): boolean {
  if (SLIM_PAGE_NAME_PATHS.has(path)) return true;
  return CLONE_ADAPT_PATH_DENY.some((rx) => rx.test(path));
}

function collectStringLeavesForClone(
  obj: unknown,
  prefix: string,
  out: Array<{ path: string; value: string }>
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (prefix && !shouldSkipCloneAdaptPath(prefix)) {
      out.push({ path: prefix, value: obj });
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      collectStringLeavesForClone(item, `${prefix}[${i}]`, out);
    });
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      collectStringLeavesForClone(v, next, out);
    }
  }
}

function collectCloneAdaptPaths(
  slim: SlimPayload
): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  collectStringLeavesForClone(
    slim as unknown as Record<string, unknown>,
    '',
    out
  );
  return out;
}

function pickBusinessContextForClone(
  entry: Record<string, unknown>
): Record<string, unknown> {
  const b = entry.business as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object') return {};
  const keys = [
    'name',
    'brandName',
    'legalName',
    'location',
    'openingHours',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in b) out[k] = b[k];
  }
  return out;
}

/**
 * Derive the cloned site's `deployDomain` (raw) and `clientDomain` (canonical, www-prefixed).
 * Precedence: CLI overrides > TLD inferred from source > `.de` fallback.
 */
function deriveClonedDomains(
  newId: string,
  source: Record<string, unknown> | undefined,
  overrides: { deployDomain?: string | null; clientDomain?: string | null }
): { deployDomain: string; clientDomain: string } {
  const sourceDeploy =
    typeof source?.deployDomain === 'string' ? source.deployDomain.trim() : '';
  const firstDotIdx = sourceDeploy.indexOf('.');
  const inferredTld = firstDotIdx > 0 ? sourceDeploy.slice(firstDotIdx) : '.de';

  const deployDomain =
    overrides.deployDomain?.trim() || `${newId}${inferredTld}`;
  const clientDomain = overrides.clientDomain?.trim() || `www.${deployDomain}`;

  return { deployDomain, clientDomain };
}

function applyCloneFills(
  working: Record<string, unknown>,
  fills: CloneFillItem[],
  allowedPaths: Set<string>
): number {
  let applied = 0;
  for (const item of fills) {
    if (
      !item ||
      typeof item.path !== 'string' ||
      typeof item.value !== 'string'
    )
      continue;
    const p = item.path.trim();
    const v = item.value;
    if (!p || !allowedPaths.has(p)) continue;
    try {
      const parts = expandPath(p);
      const current = getValueAtPath(working, parts);
      if (typeof current !== 'string') continue;
      setValueAtPath(working, parts, v);
      applied++;
    } catch {
      /* invalid path segment */
    }
  }
  return applied;
}

/** Normalize hero H1 for duplicate detection (trim + collapse whitespace). */
function normalizeHeroH1ForUniqueness(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Home hero H1 strings from every other website in the client's websites.json
 * (same normalization target as 08-refine duplicate checks).
 */
function collectOtherSitesHomeHeroH1s(
  websites: Record<string, unknown>[],
  excludeSiteId: string
): string[] {
  const out: string[] = [];
  for (const w of websites) {
    const id = String((w as Record<string, unknown>).id ?? '').trim();
    if (!id || id === excludeSiteId) continue;
    const pages = (w as Record<string, unknown>).pages;
    if (!Array.isArray(pages)) continue;
    const home =
      pages.find(
        (p) =>
          p &&
          typeof p === 'object' &&
          (p as Record<string, unknown>).name === 'home'
      ) ?? pages[0];
    if (!home || typeof home !== 'object') continue;
    const hero = (home as Record<string, unknown>).hero;
    if (!hero || typeof hero !== 'object' || Array.isArray(hero)) continue;
    const h1 = (hero as Record<string, unknown>).h1;
    if (typeof h1 === 'string' && normalizeHeroH1ForUniqueness(h1))
      out.push(h1);
  }
  return out;
}

/**
 * Dedicated AI step to generate ONE perfect SEO-optimized hero H1 for the new location.
 * Uses prompt.md (locationPrompt) + topics.json (topicsContext) + briefings + business as input.
 * Returns the generated H1 (trimmed) or null on failure.
 */
async function generateHeroH1ForClone(
  apiKey: string,
  model: string,
  newSiteId: string,
  deployDomain: string,
  businessSubset: Record<string, unknown>,
  currentH1: string,
  locationPrompt: string,
  topicsContext: CloneTopicsContext | null,
  sourceWebsiteBriefing: string,
  newWebsiteBriefing: string,
  otherSitesHeroH1s: string[],
  totals: CloneAiUsageTotals
): Promise<string | null> {
  const systemPrompt = buildAiPrompt('clone-hero-h1', {});

  const forbiddenNormalized = new Set(
    otherSitesHeroH1s
      .map((h) => normalizeHeroH1ForUniqueness(h))
      .filter((h) => h.length > 0)
  );

  const context: Record<string, unknown> = {
    newSiteId,
    deployDomain,
    business: businessSubset,
    currentH1: currentH1 || '',
  };
  if (topicsContext) context.topicsContext = topicsContext;
  if (sourceWebsiteBriefing)
    context.sourceWebsiteBriefing = sourceWebsiteBriefing;
  if (newWebsiteBriefing) context.newWebsiteBriefing = newWebsiteBriefing;
  if (otherSitesHeroH1s.length > 0) {
    context.otherSitesHeroH1 = otherSitesHeroH1s;
  }

  const briefingHeader = newWebsiteBriefing
    ? `WEBSITE BRIEFING for the NEW location (Excel "Content Briefing" — AUTHORITATIVE, overrides source where conflicting):\n${newWebsiteBriefing}\n\n---\n\n`
    : sourceWebsiteBriefing
      ? `WEBSITE BRIEFING from the SOURCE website (Excel "Content Briefing" — background context for brand voice / positioning; adapt to the new location):\n${sourceWebsiteBriefing}\n\n---\n\n`
      : '';

  const forbiddenBlock =
    otherSitesHeroH1s.length > 0
      ? [
          ``,
          `OTHER LOCATIONS — FORBIDDEN H1 STRINGS`,
          `These hero H1s already exist on other websites for this client. Your output MUST NOT match any of them after trimming and collapsing whitespace (case-sensitive). Write a distinct headline for THIS location only:`,
          ...otherSitesHeroH1s.map((h) => `- ${h}`),
          ``,
        ].join('\n')
      : '';

  let duplicateRetryHint = '';

  for (let attempt = 0; attempt <= CLONE_FILL_MAX_RETRIES; attempt++) {
    const userContent =
      briefingHeader +
      [
        `Generate ONE perfect, SEO-optimized hero H1 for the new location.`,
        `Use the location prompt (prompt.md) and topics/keywords (topics.json) as your primary input.`,
        forbiddenBlock,
        `---`,
        ``,
        `LOCATION PROMPT (prompt.md):`,
        locationPrompt || '(none provided)',
        ``,
        `---`,
        ``,
        `CONTEXT:`,
        JSON.stringify(context, null, 2),
        duplicateRetryHint,
      ].join('\n');

    try {
      console.log(
        `  [hero-h1] Generating SEO-optimized hero H1 with dedicated AI step...`
      );
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: buildHeroH1ResponseFormat(),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: 0.4,
          max_tokens: 512,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter API error ${res.status}: ${text}`);
      }

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

      if (data.usage) {
        const promptTokens = Number(data.usage.prompt_tokens ?? 0);
        const completionTokens = Number(data.usage.completion_tokens ?? 0);
        const totalTokens = Number(
          data.usage.total_tokens ?? promptTokens + completionTokens
        );
        const promptCost = Number(data.usage.prompt_tokens_cost ?? 0);
        const completionCost = Number(data.usage.completion_tokens_cost ?? 0);
        const totalCostCandidate = Number(data.usage.cost);
        const sectionCost = Number.isFinite(totalCostCandidate)
          ? totalCostCandidate
          : promptCost + completionCost;

        totals.promptTokens += Number.isFinite(promptTokens) ? promptTokens : 0;
        totals.completionTokens += Number.isFinite(completionTokens)
          ? completionTokens
          : 0;
        totals.totalTokens += Number.isFinite(totalTokens) ? totalTokens : 0;
        if (Number.isFinite(sectionCost) && sectionCost > 0) {
          totals.totalCostUsd += sectionCost;
          totals.hasAnyCostData = true;
        }

        console.log(
          `  [hero-h1] Tokens: ${data.usage.prompt_tokens ?? '?'} prompt + ${data.usage.completion_tokens ?? '?'} completion = ${data.usage.total_tokens ?? '?'} total`
        );
        if (Number.isFinite(sectionCost) && sectionCost > 0) {
          console.log(`  [hero-h1] AI cost: ${formatUsd(sectionCost)}`);
        }
      }

      logOpenRouterChatResponse({
        script: 'clone-website',
        operation: 'hero-h1',
        model,
        usage: data.usage ?? null,
        generationId: data.id ?? null,
      });

      const content = data.choices?.[0]?.message?.content;
      if (!content)
        throw new Error(
          'OpenRouter response missing choices[0].message.content'
        );

      const parsed = JSON.parse(extractJsonFromResponse(content)) as {
        h1?: unknown;
      };
      const raw = typeof parsed?.h1 === 'string' ? parsed.h1.trim() : '';
      if (!raw) throw new Error('Response missing non-empty "h1" string');

      // Sanitize: collapse whitespace, strip surrounding quotes / trailing punctuation.
      const cleaned = raw
        .replace(/\s+/g, ' ')
        .replace(/^["'„“”«»]+|["'„“”«»]+$/g, '')
        .replace(/[.!?]+$/g, '')
        .trim();

      if (cleaned.length < 10) {
        throw new Error(
          `Generated H1 too short (${cleaned.length} chars): "${cleaned}"`
        );
      }
      if (cleaned.length > 90) {
        console.warn(
          `  [hero-h1] Warning: generated H1 is ${cleaned.length} chars (>90), keeping anyway: "${cleaned}"`
        );
      }

      const cleanedKey = normalizeHeroH1ForUniqueness(cleaned);
      if (forbiddenNormalized.has(cleanedKey)) {
        const bulletList = otherSitesHeroH1s
          .map((h) => `- ${h}`)
          .join('\n');
        duplicateRetryHint = `\n\n⚠️ DUPLICATE (attempt ${attempt + 1}): The headline "${cleaned}" matches another site for this client after trimming/collapsing whitespace.\nYou MUST output a different headline. Do not copy or lightly rephrase any forbidden line.\nForbidden H1s:\n${bulletList}\n`;
        console.warn(
          `  [hero-h1] Generated H1 collides with another site — retrying with stricter uniqueness instructions...`
        );
        throw new Error('DUPLICATE_H1');
      }

      return cleaned;
    } catch (err) {
      if (attempt < CLONE_FILL_MAX_RETRIES) {
        const isDup =
          err instanceof Error && err.message === 'DUPLICATE_H1';
        const delay = isDup ? 1500 : 5000 * (attempt + 1);
        console.warn(
          `  [hero-h1] failed (attempt ${attempt + 1}/${CLONE_FILL_MAX_RETRIES + 1}) — retrying in ${delay / 1000}s...`,
          err instanceof Error ? err.message : err
        );
        await sleep(delay);
      } else {
        console.error(
          `  [hero-h1] failed after ${CLONE_FILL_MAX_RETRIES + 1} attempts:`,
          err instanceof Error ? err.message : err
        );
        return null;
      }
    }
  }
  return null;
}

const DEFAULT_CLIENT = 'current';
const ROOT = process.cwd();

function getDataDir(clientId: string): string {
  return path.join(ROOT, 'src', 'data', clientId);
}

function getWebsitesPath(clientId: string): string {
  return path.join(getDataDir(clientId), 'websites.json');
}

/** Per-site prompt next to 06-generate-website / onboard-client: prefer prompt.md, fallback prompt.txt. */
function getSitePromptPath(clientId: string, siteId: string): string {
  const siteDir = path.join(getDataDir(clientId), siteId);
  const promptMd = path.join(siteDir, 'prompt.md');
  const promptTxt = path.join(siteDir, 'prompt.txt');
  return fs.existsSync(promptMd) ? promptMd : promptTxt;
}

function getSiteTopicsPath(clientId: string, siteId: string): string {
  return path.join(getDataDir(clientId), siteId, 'topics.json');
}

function runExtractClientPrompt(clientId: string, siteId: string): boolean {
  const r = spawnSync(
    'pnpm',
    [
      '05-extract-website:client-prompt',
      '--',
      `--client=${clientId}`,
      `--site=${siteId}`,
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.error) {
    console.error(
      '[clone-website] Failed to run 05-extract-website:client-prompt:',
      r.error.message
    );
    return false;
  }
  if (r.status !== 0) {
    console.error('[clone-website] 05-extract-website:client-prompt failed.');
    return false;
  }
  return true;
}

function ensureClonePromptAndTopicsFiles(
  clientId: string,
  targetSiteId: string,
  sourceSiteId: string | null
): string | null {
  const targetPromptPath = getSitePromptPath(clientId, targetSiteId);
  if (fs.existsSync(targetPromptPath)) return targetPromptPath;

  const promptSeedSiteId = sourceSiteId ?? targetSiteId;
  console.log(
    `[clone-website] Missing prompt for "${targetSiteId}" — generating client prompt via 05-extract-client-data.`
  );

  const generated = runExtractClientPrompt(clientId, promptSeedSiteId);

  const refreshedTargetPromptPath = getSitePromptPath(clientId, targetSiteId);
  if (fs.existsSync(refreshedTargetPromptPath)) {
    const targetTopicsPath = getSiteTopicsPath(clientId, targetSiteId);
    if (!fs.existsSync(targetTopicsPath)) {
      const seedTopicsPath = getSiteTopicsPath(clientId, promptSeedSiteId);
      if (fs.existsSync(seedTopicsPath)) {
        fs.copyFileSync(seedTopicsPath, targetTopicsPath);
        // Normalize metadata inside the copied topics file so it matches the new site.
        try {
          const raw = JSON.parse(
            fs.readFileSync(targetTopicsPath, 'utf-8')
          ) as Record<string, unknown>;
          raw.siteId = targetSiteId;
          fs.writeFileSync(
            targetTopicsPath,
            JSON.stringify(raw, null, 2) + '\n'
          );
        } catch {
          // If parsing fails, keep the copied file as-is.
        }
        console.log(
          `[clone-website] Reused generated topics from "${promptSeedSiteId}" for "${targetSiteId}": ${targetTopicsPath}`
        );
      }
    }
    return refreshedTargetPromptPath;
  }

  if (!generated || promptSeedSiteId === targetSiteId) return null;

  const sourcePromptPath = getSitePromptPath(clientId, promptSeedSiteId);
  if (!fs.existsSync(sourcePromptPath)) return null;

  const targetDir = path.join(getDataDir(clientId), targetSiteId);
  fs.mkdirSync(targetDir, { recursive: true });

  const copiedPromptPath = path.join(
    targetDir,
    path.basename(sourcePromptPath)
  );
  fs.copyFileSync(sourcePromptPath, copiedPromptPath);
  console.log(
    `[clone-website] Reused generated prompt from "${promptSeedSiteId}" for "${targetSiteId}": ${copiedPromptPath}`
  );

  const sourceTopicsPath = getSiteTopicsPath(clientId, promptSeedSiteId);
  const targetTopicsPath = getSiteTopicsPath(clientId, targetSiteId);
  if (fs.existsSync(sourceTopicsPath) && !fs.existsSync(targetTopicsPath)) {
    fs.copyFileSync(sourceTopicsPath, targetTopicsPath);
    // Normalize metadata inside the copied topics file so it matches the new site.
    try {
      const raw = JSON.parse(
        fs.readFileSync(targetTopicsPath, 'utf-8')
      ) as Record<string, unknown>;
      raw.siteId = targetSiteId;
      fs.writeFileSync(targetTopicsPath, JSON.stringify(raw, null, 2) + '\n');
    } catch {
      // If parsing fails, keep the copied file as-is.
    }
    console.log(
      `[clone-website] Reused generated topics from "${promptSeedSiteId}" for "${targetSiteId}": ${targetTopicsPath}`
    );
  }

  return copiedPromptPath;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

function loadCloneTopicsContext(
  clientId: string,
  siteId: string
): CloneTopicsContext | null {
  const topicsPath = getSiteTopicsPath(clientId, siteId);
  if (!fs.existsSync(topicsPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(topicsPath, 'utf-8')) as Record<
      string,
      unknown
    >;

    const topicsContext: CloneTopicsContext = {
      keywords: toStringList(raw.keywords),
      h1Suggestions: toStringList(raw.h1Suggestions),
      subtitleSuggestions: toStringList(raw.subtitleSuggestions),
      mustCover: toStringList(raw.mustCover),
      avoidAngles: toStringList(raw.avoidAngles),
    };

    const topicsRaw = raw.topics;
    if (
      topicsRaw &&
      typeof topicsRaw === 'object' &&
      !Array.isArray(topicsRaw)
    ) {
      const normalizedTopics: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(
        topicsRaw as Record<string, unknown>
      )) {
        const list = toStringList(value);
        if (list.length > 0) normalizedTopics[key] = list;
      }
      if (Object.keys(normalizedTopics).length > 0) {
        topicsContext.topics = normalizedTopics;
      }
    }

    const hasData =
      (topicsContext.topics && Object.keys(topicsContext.topics).length > 0) ||
      (topicsContext.keywords?.length ?? 0) > 0 ||
      (topicsContext.h1Suggestions?.length ?? 0) > 0 ||
      (topicsContext.subtitleSuggestions?.length ?? 0) > 0 ||
      (topicsContext.mustCover?.length ?? 0) > 0 ||
      (topicsContext.avoidAngles?.length ?? 0) > 0;

    return hasData ? topicsContext : null;
  } catch (err) {
    console.warn(
      `[clone-website] Failed to parse topics.json for "${siteId}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function loadWebsites(websitesPath: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(websitesPath, 'utf-8');
  const data = JSON.parse(raw) as
    | Record<string, unknown>[]
    | { websites: Record<string, unknown>[] };
  if (Array.isArray(data)) return data;
  if (data && Array.isArray((data as { websites?: unknown[] }).websites))
    return (data as { websites: Record<string, unknown>[] }).websites;
  throw new Error('websites.json must be an array or { ..., websites: [...] }');
}

function loadWebsitesFile(
  websitesPath: string
):
  | Record<string, unknown>[]
  | { shared?: unknown; websites: Record<string, unknown>[] } {
  const raw = fs.readFileSync(websitesPath, 'utf-8');
  return JSON.parse(raw) as
    | Record<string, unknown>[]
    | { shared?: unknown; websites: Record<string, unknown>[] };
}

function writeWebsites(
  websitesPath: string,
  websites: Record<string, unknown>[]
): void {
  const current = loadWebsitesFile(websitesPath);
  if (Array.isArray(current)) {
    fs.writeFileSync(websitesPath, JSON.stringify(websites, null, 2) + '\n');
  } else {
    const updated = { ...current, websites };
    fs.writeFileSync(websitesPath, JSON.stringify(updated, null, 2) + '\n');
  }
}

/** Top-level websites.json shape for labels (matches use-client site list). */
function loadWebsitesJsonMeta(clientId: string): {
  clientDomain?: string;
  websites: Record<string, unknown>[];
} {
  const file = getWebsitesPath(clientId);
  const raw = loadWebsitesFile(file);
  if (Array.isArray(raw)) {
    return { websites: raw };
  }
  const o = raw as {
    clientDomain?: string;
    websites?: Record<string, unknown>[];
  };
  return {
    clientDomain: o.clientDomain,
    websites: o.websites ?? [],
  };
}

/** One line for select prompts: id + optional business + domain (matches websites.json). */
function buildWebsiteRowLabel(
  wrec: Record<string, unknown>,
  topLevelDomain?: string
): string {
  const wid = String(wrec.id ?? '');
  const business = wrec.business as { name?: string } | undefined;
  const deployDomain = wrec.deployDomain as string | undefined;
  const wClientDomain = wrec.clientDomain as string | undefined;
  const domain = deployDomain ?? wClientDomain ?? topLevelDomain;
  return `${wid}${business?.name ? `  (${business.name})` : ''}${domain ? `  → ${domain}` : ''}`;
}

function runUseClientActivateOnly(clientId: string): void {
  const r = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/use-client.ts', '--activate-only', clientId],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.error) {
    console.error('[clone-website] Failed to run use-client:', r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[clone-website] use-client --activate-only failed.');
    process.exit(r.status ?? 1);
  }
}

function runProcessExcelData(clientId: string): void {
  console.log(
    '\n[clone-website] Processing Excel data (04-process-excel-data)...\n'
  );
  const r = spawnSync(
    'pnpm',
    ['run', '04-process-excel-data', '--', `--client=${clientId}`],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.error) {
    console.error(
      '[clone-website] Failed to run 04-process-excel-data:',
      r.error.message
    );
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[clone-website] 04-process-excel-data failed.');
    process.exit(r.status ?? 1);
  }
}

type ExcelSeedRow = Record<string, unknown>;
type ProcessExcelModule = {
  findExcelRowForSiteId: (
    clientId: string,
    siteId: string
  ) => ExcelSeedRow | null;
  listExcelDomainsForClient: (
    clientId: string
  ) => Array<{ domain: string; siteId: string }>;
  applyRowToWebsite: (
    row: ExcelSeedRow,
    site: Record<string, unknown>,
    websites?: Record<string, unknown>[],
    clientNameFallback?: string
  ) => void;
};

async function loadProcessExcelModule(): Promise<ProcessExcelModule> {
  const mod = (await import(
    './04-process-excel-data.mjs'
  )) as Partial<ProcessExcelModule>;
  if (
    typeof mod.findExcelRowForSiteId !== 'function' ||
    typeof mod.listExcelDomainsForClient !== 'function' ||
    typeof mod.applyRowToWebsite !== 'function'
  ) {
    throw new Error(
      'scripts/04-process-excel-data.mjs does not export required Excel helpers'
    );
  }
  return mod as ProcessExcelModule;
}

/** In-progress clone: merge slim → full entry, upsert by new site id, write websites.json. */
type CloneCheckpointContext = {
  websitesPath: string;
  websites: Record<string, unknown>[];
  newId: string;
  sourceId: string;
  sourceEntry: Record<string, unknown>;
  newDeployDomain: string;
  newClientDomain: string;
  processExcel: ProcessExcelModule;
  excelSeedRow: ExcelSeedRow | null;
  availableImages: ReturnType<typeof scanAvailableImages>;
};

function normalizeDomainHost(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.$/, '');
}

function siteIdFromDomainHost(domain: string): string {
  const host = normalizeDomainHost(domain);
  if (!host) return '';
  return slugify(host.replace(/\.[^.]+$/, ''));
}

/**
 * Fetches Google reviews for one website. Also re-runs process-excel inside 07 (same as standalone fetch).
 * Does not exit the process on failure so a successful clone is preserved if API keys or Place IDs are missing.
 */
/**
 * Reconciles hero address (and any split websites-*.json files) from Places for one site.
 * No-op if GOOGLE_PLACES_API_KEY is missing; does not exit on failure so a successful
 * clone write is preserved.
 */
function runFetchPlaceHeroAddressForSite(
  clientId: string,
  websiteId: string
): void {
  if (!process.env.GOOGLE_PLACES_API_KEY?.trim()) {
    console.warn(
      '\n[clone-website] Skipping fetch-place-hero-address: GOOGLE_PLACES_API_KEY not set in .env.local'
    );
    return;
  }
  console.log(
    '\n[clone-website] fetch-place-hero-address (all websites*.json for this site)...\n'
  );
  const r = spawnSync(
    'pnpm',
    [
      'run',
      'fetch-place-hero-address',
      '--',
      `--client-id=${clientId}`,
      `--site-id=${websiteId}`,
      '--quiet',
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.error) {
    console.warn(
      '[clone-website] Could not run fetch-place-hero-address:',
      r.error.message
    );
    return;
  }
  if (r.status !== 0) {
    console.warn(
      '[clone-website] fetch-place-hero-address exited with a non-zero status. Re-run:\n' +
        `  pnpm run fetch-place-hero-address -- --client-id=${clientId} --site-id=${websiteId}`
    );
  }
}

function runFetchGoogleReviewsForSite(
  clientId: string,
  websiteId: string
): void {
  console.log(
    '\n[clone-website] Fetching Google reviews (07-fetch-google-reviews)...\n'
  );
  const r = spawnSync(
    'pnpm',
    [
      'run',
      '07-fetch-google-reviews',
      '--',
      `--client-id=${clientId}`,
      `--site-id=${websiteId}`,
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.error) {
    console.warn(
      '[clone-website] Could not run 07-fetch-google-reviews:',
      r.error.message
    );
    return;
  }
  if (r.status !== 0) {
    console.warn(
      '[clone-website] 07-fetch-google-reviews exited with a non-zero status. Fix GOOGLE_PLACES_API_KEY / business.googlePlacesId if needed, then run:\n' +
        `  pnpm run 07-fetch-google-reviews -- --client-id=${clientId} --site-id=${websiteId}`
    );
  }
}

/**
 * Runs 08-refine-website-data for one website (full client JSON on disk).
 * Does not exit on failure so a successful clone write is preserved.
 */
function runRefineWebsiteDataForSite(
  clientId: string,
  websiteId: string
): void {
  console.log(
    '\n[clone-website] Refining website data (08-refine-website-data)...\n'
  );
  const r = spawnSync(
    'pnpm',
    [
      'run',
      '08-refine-website-data',
      '--',
      `--client-id=${clientId}`,
      `--website-id=${websiteId}`,
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.error) {
    console.warn(
      '[clone-website] Could not run 08-refine-website-data:',
      r.error.message
    );
    return;
  }
  if (r.status !== 0) {
    console.warn(
      '[clone-website] 08-refine-website-data exited with a non-zero status. Re-run:\n' +
        `  pnpm run 08-refine-website-data -- --client-id=${clientId} --website-id=${websiteId}`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJsonFromResponse(content: string): string {
  const trimmed = content.trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(trimmed);
  if (codeBlock) return codeBlock[1].trim();
  return trimmed;
}

/**
 * OpenRouter `response_format` for the per-block fill call. Forces the model to return
 * `{ fills: [{ path, value }] }` where each `path` is one of `allowedPaths` (enum) and
 * each `value` is a string. The array length must equal `allowedPaths.length`, and
 * `additionalProperties: false` blocks any extra keys. Models that support structured
 * outputs (Gemini 2.5, Claude 4+, GPT-4o+, …) will refuse to emit anything else, which
 * eliminates the "AI returned malformed JSON" failure mode.
 */
function buildBlockFillsResponseFormat(allowedPaths: string[]): {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
} {
  const itemSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Dot/bracket path of the field being filled.',
        ...(allowedPaths.length > 0 ? { enum: allowedPaths } : {}),
      },
      value: {
        type: 'string',
        description: 'New German copy for this path (informal "Du"). Plain text.',
      },
    },
    required: ['path', 'value'],
    additionalProperties: false,
  };

  const schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      fills: {
        type: 'array',
        description:
          'One fill per requested path. Length and paths must match fieldsToWrite exactly.',
        items: itemSchema,
        ...(allowedPaths.length > 0
          ? { minItems: allowedPaths.length, maxItems: allowedPaths.length }
          : {}),
      },
    },
    required: ['fills'],
    additionalProperties: false,
  };

  return {
    type: 'json_schema',
    json_schema: {
      name: 'clone_block_fills',
      strict: true,
      schema,
    },
  };
}

/**
 * OpenRouter `response_format` for the dedicated hero-H1 step. Forces the model to
 * return `{ h1: string }`.
 */
function buildHeroH1ResponseFormat(): {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
} {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'clone_hero_h1',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          h1: {
            type: 'string',
            description:
              'One SEO-optimized German hero headline for the new location (informal "Du", no surrounding quotes).',
          },
        },
        required: ['h1'],
        additionalProperties: false,
      },
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

function findPage(
  pages: Array<Record<string, unknown>>,
  name: string
): Record<string, unknown> | undefined {
  return pages.find((p) => p.name === name);
}

// ---------------------------------------------------------------------------
// Slim payload — only the parts the AI needs to adapt
// ---------------------------------------------------------------------------

type SlimPayload = {
  home: Record<string, unknown>;
  faq: {
    name: string;
    pageTitle: unknown;
    metadata: unknown;
    hero?: unknown;
  };
  impressum: { name: string; pageTitle: unknown; metadata: unknown };
  datenschutz: { name: string; pageTitle: unknown; metadata: unknown };
  ueberUns: Record<string, unknown>;
};

/** Ordered blocks from scripts/ai-block-registry.json (fallback: built-in list). */
const CLONE_BLOCK_REGISTRY: CloneBlockSpec[] = getCloneBlockSpecsWithFallback(
  (msg) => console.warn(msg)
);

function jaccardTokens(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[\s.,;:!?\-—()"']+/)
        .filter((t) => t.length > 2)
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

function inferClonePathHint(path: string): string {
  return (
    path.match(/\.(\w+)$/)?.[1] ?? path.match(/\[\d+\]\.(\w+)$/)?.[1] ?? 'text'
  );
}

function pathBelongsToCloneBlock(path: string, block: CloneBlockSpec): boolean {
  if (block.isArrayOfBlocks) {
    return path.startsWith(`${block.blockPath}[`);
  }
  return path === block.blockPath || path.startsWith(`${block.blockPath}.`);
}

function buildCloneBlockSystemPrompt(
  newId: string,
  deployDomain: string,
  promptSection: string
): string {
  const absoluteBase = deployDomain.startsWith('http')
    ? deployDomain.replace(/\/$/, '')
    : `https://www.${deployDomain.replace(/\/$/, '')}`;
  const protectedBlock = buildProtectedPathsBlockForAi([
    'pages[*].hero.buttons',
    'pages[*].hero.backgroundImage',
    'pages[*].info.imageUrl',
    'pages[*].gallery.images[*].src',
    'pages[*].trust.logos',
    'pages[*].reviews.reviewData (slim may only include formattedAddress)',
    'pages[*].faq.faqs',
    'pages[*].map.mapEmbedUrl',
    'pages[*].metadata.openGraph.images[*].url',
    'pages[*].metadata.twitter.images[*].url',
    'pages[*].metadata.schema[*].data.logo',
    'pages[*].faq.faqDataFile',
    'header.logoUrl',
    'business.contactPerson.imageUrl',
  ]);
  const vars = {
    NEW_SITE_ID: newId,
    DEPLOY_DOMAIN: deployDomain,
    ABSOLUTE_BASE: absoluteBase,
    PROTECTED_PATHS_BLOCK: protectedBlock,
  };
  return (
    buildAiPrompt('clone-block-shared', vars) +
    '\n\n' +
    buildAiPrompt(promptSection, vars)
  );
}

function getSlimSubtreeAtBlockPath(
  slim: SlimPayload,
  blockPath: string
): unknown {
  const parts = blockPath.split('.');
  let cur: unknown = slim as unknown as Record<string, unknown>;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function collectWritableFieldSpecsUnderValue(
  obj: unknown,
  prefix: string,
  out: Array<{ path: string; hint: string }>
): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (prefix && !shouldSkipCloneAdaptPath(prefix)) {
      out.push({ path: prefix, hint: inferClonePathHint(prefix) });
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      collectWritableFieldSpecsUnderValue(item, `${prefix}[${i}]`, out);
    });
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      collectWritableFieldSpecsUnderValue(v, next, out);
    }
  }
}

/**
 * Batches of fields to regenerate per block. Skips missing blocks on the source slim.
 */
function collectWritableStringPathBatches(
  slim: SlimPayload,
  block: CloneBlockSpec
): Array<Array<{ path: string; hint: string }>> {
  const subtree = getSlimSubtreeAtBlockPath(slim, block.blockPath);
  if (subtree === undefined || subtree === null) return [];

  if (typeof subtree === 'string') {
    if (shouldSkipCloneAdaptPath(block.blockPath)) return [];
    return [
      [{ path: block.blockPath, hint: inferClonePathHint(block.blockPath) }],
    ];
  }

  if (block.isArrayOfBlocks && Array.isArray(subtree)) {
    const batchSize = block.batchSize ?? 4;
    const batches: Array<Array<{ path: string; hint: string }>> = [];
    for (let i = 0; i < subtree.length; i += batchSize) {
      const batch: Array<{ path: string; hint: string }> = [];
      for (let j = i; j < Math.min(i + batchSize, subtree.length); j++) {
        collectWritableFieldSpecsUnderValue(
          subtree[j],
          `${block.blockPath}[${j}]`,
          batch
        );
      }
      if (batch.length > 0) batches.push(batch);
    }
    return batches;
  }

  const all: Array<{ path: string; hint: string }> = [];
  collectWritableFieldSpecsUnderValue(subtree, block.blockPath, all);
  if (all.length === 0) return [];
  return [all];
}

function findStaleCopyPaths(
  before: SlimPayload,
  after: Record<string, unknown>,
  pathsToCheck: string[]
): string[] {
  const stale: string[] = [];
  const beforeRec = before as unknown as Record<string, unknown>;
  for (const path of pathsToCheck) {
    let parts: Array<string | number>;
    try {
      parts = expandPath(path);
    } catch {
      continue;
    }
    const bv = getValueAtPath(beforeRec, parts);
    const av = getValueAtPath(after, parts);
    if (typeof bv !== 'string' || typeof av !== 'string') continue;
    if (bv.length === 0) continue;
    if (bv.length <= 30) continue;
    if (av === bv || jaccardTokens(bv, av) > 0.7) {
      stale.push(path);
    }
  }
  return stale;
}

async function generateBlockFills(
  apiKey: string,
  model: string,
  sectionLabel: string,
  blockPath: string,
  promptSection: string,
  fieldsToWrite: Array<{ path: string; hint: string }>,
  businessSubset: Record<string, unknown>,
  newSiteId: string,
  deployDomain: string,
  locationPrompt: string,
  sourceWebsiteBriefing: string,
  newWebsiteBriefing: string,
  topicsContext: CloneTopicsContext | null,
  totals: CloneAiUsageTotals,
  extraUserAppendix?: string,
  maxTokens?: number
): Promise<CloneFillItem[]> {
  const systemPrompt = buildCloneBlockSystemPrompt(
    newSiteId,
    deployDomain,
    promptSection
  );
  const allowedPaths = new Set(fieldsToWrite.map((f) => f.path));

  const context: Record<string, unknown> = {
    blockPath,
    operation: 'clone-block',
    newSiteId,
    deployDomain,
    business: businessSubset,
    fieldsToWrite,
  };
  if (sourceWebsiteBriefing)
    context.sourceWebsiteBriefing = sourceWebsiteBriefing;
  if (newWebsiteBriefing) context.newWebsiteBriefing = newWebsiteBriefing;
  if (topicsContext) context.topicsContext = topicsContext;

  const briefingHeader = newWebsiteBriefing
    ? `WEBSITE BRIEFING for the NEW location (Excel "Content Briefing" — AUTHORITATIVE, overrides source where conflicting):\n${newWebsiteBriefing}\n\n---\n\n`
    : sourceWebsiteBriefing
      ? `WEBSITE BRIEFING from the SOURCE website (Excel "Content Briefing" — background context for brand voice / positioning only; do NOT reuse source phrasing):\n${sourceWebsiteBriefing}\n\n---\n\n`
      : '';

  const userContent =
    briefingHeader +
    [
      `Write ORIGINAL German website copy for the block "${blockPath}".`,
      `You receive only the list of JSON paths to fill (fieldsToWrite) — no source text. Use briefing, topics, and the location prompt.`,
      ...(topicsContext
        ? [
            '',
            'Use TOPICS / KEYWORDS from topicsContext (topics.json) for services, differentiators, and angles.',
          ]
        : []),
      ``,
      `---`,
      ``,
      locationPrompt,
      ``,
      `---`,
      ``,
      `CONTEXT:`,
      JSON.stringify(context, null, 2),
      ...(extraUserAppendix ? ['', extraUserAppendix] : []),
    ].join('\n');

  for (let attempt = 0; attempt <= CLONE_FILL_MAX_RETRIES; attempt++) {
    try {
      console.log(
        `  [block] "${sectionLabel}" — ${fieldsToWrite.length} field(s), calling OpenRouter...`
      );
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: buildBlockFillsResponseFormat(
            fieldsToWrite.map((f) => f.path)
          ),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: extraUserAppendix ? 0.55 : 0.75,
          max_tokens: maxTokens ?? 4096,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter API error ${res.status}: ${text}`);
      }

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

      if (data.usage) {
        const promptTokens = Number(data.usage.prompt_tokens ?? 0);
        const completionTokens = Number(data.usage.completion_tokens ?? 0);
        const totalTokens = Number(
          data.usage.total_tokens ?? promptTokens + completionTokens
        );
        const promptCost = Number(data.usage.prompt_tokens_cost ?? 0);
        const completionCost = Number(data.usage.completion_tokens_cost ?? 0);
        const totalCostCandidate = Number(data.usage.cost);
        const sectionCost = Number.isFinite(totalCostCandidate)
          ? totalCostCandidate
          : promptCost + completionCost;

        totals.promptTokens += Number.isFinite(promptTokens) ? promptTokens : 0;
        totals.completionTokens += Number.isFinite(completionTokens)
          ? completionTokens
          : 0;
        totals.totalTokens += Number.isFinite(totalTokens) ? totalTokens : 0;
        if (Number.isFinite(sectionCost) && sectionCost > 0) {
          totals.totalCostUsd += sectionCost;
          totals.hasAnyCostData = true;
        }

        console.log(
          `  [block] "${sectionLabel}" — tokens: ${data.usage.prompt_tokens ?? '?'} + ${data.usage.completion_tokens ?? '?'} = ${data.usage.total_tokens ?? '?'}`
        );
        if (Number.isFinite(sectionCost) && sectionCost > 0) {
          console.log(
            `  [block] "${sectionLabel}" — AI cost: ${formatUsd(sectionCost)}`
          );
        }
      }

      logOpenRouterChatResponse({
        script: 'clone-website',
        operation: `block:${blockPath}`,
        model,
        usage: data.usage ?? null,
        generationId: data.id ?? null,
        extra: { sectionLabel },
      });

      const content = data.choices?.[0]?.message?.content;
      if (!content)
        throw new Error(
          'OpenRouter response missing choices[0].message.content'
        );

      const parsed = JSON.parse(extractJsonFromResponse(content)) as {
        fills?: CloneFillItem[];
      };
      if (!parsed || !Array.isArray(parsed.fills)) {
        throw new Error('Response missing "fills" array');
      }
      return parsed.fills;
    } catch (err) {
      if (attempt < CLONE_FILL_MAX_RETRIES) {
        const delay = 5000 * (attempt + 1);
        console.warn(
          `  [block] "${sectionLabel}" failed (attempt ${attempt + 1}/${CLONE_FILL_MAX_RETRIES + 1}) — retrying in ${delay / 1000}s...`,
          err instanceof Error ? err.message : err
        );
        await sleep(delay);
      } else {
        console.error(
          `  [block] "${sectionLabel}" failed after ${CLONE_FILL_MAX_RETRIES + 1} attempts:`,
          err instanceof Error ? err.message : err
        );
        return [];
      }
    }
  }
  return [];
}

async function runStaleBlockRetries(
  apiKey: string,
  model: string,
  stalePaths: string[],
  working: Record<string, unknown>,
  businessSubset: Record<string, unknown>,
  newSiteId: string,
  deployDomain: string,
  locationPrompt: string,
  sourceWebsiteBriefing: string,
  newWebsiteBriefing: string,
  topicsContext: CloneTopicsContext | null,
  totals: CloneAiUsageTotals,
  checkpoint: CloneCheckpointContext | null
): Promise<void> {
  const retried = new Set<string>();
  for (const block of CLONE_BLOCK_REGISTRY) {
    const staleHere = stalePaths.filter((p) =>
      pathBelongsToCloneBlock(p, block)
    );
    if (staleHere.length === 0) continue;
    if (retried.has(block.blockPath)) continue;
    retried.add(block.blockPath);

    const fields = staleHere.map((path) => ({
      path,
      hint: inferClonePathHint(path),
    }));
    const appendix =
      `RETRY (mandatory): These paths are still too similar to the SOURCE site's German text (verbatim or >70% token overlap). ` +
      `Rewrite from newWebsiteBriefing + topicsContext + location prompt only. Informal "Du". ` +
      `Paths: ${staleHere.join(', ')}`;

    const maxTok = block.blockPath === 'ueberUns.blocks' ? 8192 : 4096;
    const fills = await generateBlockFills(
      apiKey,
      model,
      `${block.blockPath} (stale retry)`,
      block.blockPath,
      block.promptSection,
      fields,
      businessSubset,
      newSiteId,
      deployDomain,
      locationPrompt,
      sourceWebsiteBriefing,
      newWebsiteBriefing,
      topicsContext,
      totals,
      appendix,
      maxTok
    );
    const allowed = new Set(fields.map((f) => f.path));
    const applied = applyCloneFills(working, fills, allowed);
    console.log(
      `  [block] stale retry "${block.blockPath}" — applied ${applied} fill(s)\n`
    );
    if (checkpoint) {
      persistCloneCheckpoint(working, checkpoint);
    }
  }
}

async function runCloneBlockRegistryPass(
  apiKey: string,
  model: string,
  slim: SlimPayload,
  newSiteId: string,
  deployDomain: string,
  locationPrompt: string,
  businessSubset: Record<string, unknown>,
  sourceWebsiteBriefing: string,
  newWebsiteBriefing: string,
  topicsContext: CloneTopicsContext | null,
  checkpoint: CloneCheckpointContext | null
): Promise<{ slim: SlimPayload; usage: CloneAiUsageTotals }> {
  const staleBaselineSlim = deepClone(slim) as SlimPayload;
  const working = deepClone(slim) as unknown as Record<string, unknown>;
  const usageTotals: CloneAiUsageTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    hasAnyCostData: false,
  };
  const allRegeneratedPaths: string[] = [];

  const subtreeRunners: Array<() => Promise<void>> = [];
  for (const block of CLONE_BLOCK_REGISTRY) {
    const batches = collectWritableStringPathBatches(slim, block);
    if (batches.length === 0) {
      console.log(
        `  [clone] skip ${block.blockPath} (not present or no writable strings)`
      );
      continue;
    }
    subtreeRunners.push(async () => {
      for (let bi = 0; bi < batches.length; bi++) {
        const fields = batches[bi]!;
        const label =
          batches.length > 1
            ? `${block.blockPath} (batch ${bi + 1}/${batches.length})`
            : block.blockPath;
        const maxTok = block.blockPath === 'ueberUns.blocks' ? 8192 : 4096;
        const fills = await generateBlockFills(
          apiKey,
          model,
          label,
          block.blockPath,
          block.promptSection,
          fields,
          businessSubset,
          newSiteId,
          deployDomain,
          locationPrompt,
          sourceWebsiteBriefing,
          newWebsiteBriefing,
          topicsContext,
          usageTotals,
          undefined,
          maxTok
        );
        const allowed = new Set(fields.map((f) => f.path));
        const applied = applyCloneFills(working, fills, allowed);
        for (const f of fields) allRegeneratedPaths.push(f.path);
        console.log(
          `  [block] "${label}" — applied ${applied} fill(s) from ${fills.length} candidate(s)\n`
        );
        if (checkpoint) {
          persistCloneCheckpoint(working, checkpoint);
        }
        await sleep(Math.floor(CLONE_SECTION_DELAY_MS / 4));
      }
    });
  }

  if (subtreeRunners.length > 0 && CLONE_SUBTREE_CONCURRENCY > 1) {
    const cap = Math.min(CLONE_SUBTREE_CONCURRENCY, subtreeRunners.length);
    console.log(
      `  [clone] ${subtreeRunners.length} subtree run(s) — up to ${cap} OpenRouter call(s) in flight; ` +
        `batches of the same subtree stay sequential.`
    );
  }
  await runAsyncPool(subtreeRunners, CLONE_SUBTREE_CONCURRENCY);

  const stale = findStaleCopyPaths(
    staleBaselineSlim,
    working,
    allRegeneratedPaths
  );
  if (stale.length > 0) {
    console.warn(
      `  [clone] ${stale.length} path(s) still too similar to source — stale retry per block.\n` +
        `    Paths: ${stale.slice(0, 20).join(', ')}${stale.length > 20 ? '…' : ''}`
    );
    await runStaleBlockRetries(
      apiKey,
      model,
      stale,
      working,
      businessSubset,
      newSiteId,
      deployDomain,
      locationPrompt,
      sourceWebsiteBriefing,
      newWebsiteBriefing,
      topicsContext,
      usageTotals,
      checkpoint
    );
  }

  return { slim: working as unknown as SlimPayload, usage: usageTotals };
}

/**
 * Remove tooling-managed / protected fields from the home page before sending to the AI.
 * Matches scripts/lib/ai-protected-paths.ts and 06/08 prompts (images, CTAs, reviews body, FAQ items).
 */
function stripHomeForAiPayload(home: Record<string, unknown>): void {
  const hero = home.hero as Record<string, unknown> | undefined;
  if (hero) delete hero.buttons;

  const gallery = home.gallery as Record<string, unknown> | undefined;
  const imgs = gallery?.images as Array<Record<string, unknown>> | undefined;
  if (imgs) {
    for (const img of imgs) {
      delete img.src;
    }
  }

  const trust = home.trust as Record<string, unknown> | undefined;
  if (trust) delete trust.logos;

  const reviews = home.reviews as Record<string, unknown> | undefined;
  if (reviews?.reviewData) {
    const rd = reviews.reviewData as Record<string, unknown>;
    const fd = rd.formattedAddress;
    reviews.reviewData = {
      formattedAddress: typeof fd === 'string' ? fd : '',
    };
  }

  const homeFaq = home.faq as Record<string, unknown> | undefined;
  if (homeFaq) delete homeFaq.faqs;

  const map = home.map as Record<string, unknown> | undefined;
  if (map) delete map.mapEmbedUrl;
}

/** Remove page-level keys the AI must not generate (tooling / merge). */
function stripUeberUnsForAiPayload(page: Record<string, unknown>): void {
  if ('schema' in page) delete page.schema;
}

/**
 * Extract only the location-specific parts from a website entry.
 * Everything else (business, header, footer, static pages, legal blocks) is
 * excluded here and will be copied verbatim during the merge step.
 */
function buildSlimPayload(source: Record<string, unknown>): SlimPayload {
  const pages = (source.pages as Array<Record<string, unknown>>) ?? [];

  const homePage = findPage(pages, 'home') ?? {};
  const faqPage = findPage(pages, 'faq') ?? {};
  const impressumPage = findPage(pages, 'impressum') ?? {};
  const datenschutzPage = findPage(pages, 'datenschutz') ?? {};
  const ueberUnsPage = findPage(pages, 'ueber-uns') ?? {};

  const home = deepClone(homePage);
  stripHomeForAiPayload(home);

  const ueberUns = deepClone(ueberUnsPage);
  stripUeberUnsForAiPayload(ueberUns);

  return {
    home,

    // FAQ page — metadata + hero; faqDataFile / schema come from source + tooling
    faq: {
      name: 'faq',
      pageTitle: faqPage.pageTitle,
      metadata: deepClone(faqPage.metadata),
      ...(faqPage.hero !== undefined ? { hero: deepClone(faqPage.hero) } : {}),
    },

    // Impressum — metadata only (title/description reference the location name)
    // Blocks contain legal boilerplate and are copied verbatim in the merge step
    impressum: {
      name: 'impressum',
      pageTitle: impressumPage.pageTitle,
      metadata: deepClone(impressumPage.metadata),
    },

    // Datenschutz — metadata only, blocks are legal boilerplate never changed
    datenschutz: {
      name: 'datenschutz',
      pageTitle: datenschutzPage.pageTitle,
      metadata: deepClone(datenschutzPage.metadata),
    },

    // Über uns — full page, blocks may reference the location name
    ueberUns,
  };
}

/**
 * Merge AI home content with source page, restoring protected fields (06/08 tooling).
 */
function mergeHomeFromAiAndSource(
  aiHome: Record<string, unknown>,
  sourceHome: Record<string, unknown>
): Record<string, unknown> {
  const out = deepClone(aiHome);
  const srcHero = sourceHome.hero as Record<string, unknown> | undefined;
  const outHero = out.hero as Record<string, unknown> | undefined;
  if (srcHero?.buttons && outHero) {
    outHero.buttons = deepClone(srcHero.buttons);
  }
  if (outHero && typeof outHero.backgroundImage !== 'string') {
    outHero.backgroundImage = '';
  }

  const outInfo = out.info as Record<string, unknown> | undefined;
  if (outInfo && typeof outInfo.imageUrl !== 'string') {
    outInfo.imageUrl = '';
  }

  const srcTrust = sourceHome.trust as Record<string, unknown> | undefined;
  const outTrust = out.trust as Record<string, unknown> | undefined;
  if (srcTrust?.logos && outTrust) {
    outTrust.logos = deepClone(srcTrust.logos);
  }

  // Full `pages[*].reviews` used to be stripped, which dropped `title` / `subtitle`. Merge
  // from source (template) first, then AI overlay; `reviewData` is always re-based on source
  // with optional formattedAddress from the slim/AI pass.
  const srcRev = sourceHome.reviews as Record<string, unknown> | undefined;
  const outRev = out.reviews as Record<string, unknown> | undefined;
  if (srcRev) {
    out.reviews = {
      ...deepClone(srcRev),
      ...(outRev || {}),
    } as Record<string, unknown>;
  }
  const outRevMerged = out.reviews as Record<string, unknown> | undefined;
  if (srcRev?.reviewData && outRevMerged) {
    const aiRd = outRev?.reviewData as Record<string, unknown> | undefined;
    const srcRd = srcRev.reviewData as Record<string, unknown>;
    outRevMerged.reviewData = deepClone(srcRd);
    if (
      aiRd &&
      typeof aiRd.formattedAddress === 'string' &&
      aiRd.formattedAddress.trim()
    ) {
      (outRevMerged.reviewData as Record<string, unknown>).formattedAddress =
        aiRd.formattedAddress;
    }
  }

  const srcFaq = sourceHome.faq as Record<string, unknown> | undefined;
  const outFaq = out.faq as Record<string, unknown> | undefined;
  if (srcFaq?.faqs && outFaq) {
    outFaq.faqs = deepClone(srcFaq.faqs);
  }

  const srcMap = sourceHome.map as Record<string, unknown> | undefined;
  const outMap = out.map as Record<string, unknown> | undefined;
  if (srcMap && outMap && 'mapEmbedUrl' in srcMap) {
    outMap.mapEmbedUrl = srcMap.mapEmbedUrl;
  }

  // `pages[*].name` is stripped with AI output; restore from source (same as faq/impressum in stripSlimAiResult)
  if (typeof sourceHome.name === 'string' && sourceHome.name) {
    out.name = sourceHome.name;
  } else {
    out.name = 'home';
  }

  return out;
}

/** Paths to skip when stripping clone AI output — slim may carry reviews.reviewData.formattedAddress only. */
const CLONE_STRIP_PROTECTED_PATHS = AI_PROTECTED_PATHS.filter(
  (p) => p !== 'pages[*].reviews.reviewData'
);

/**
 * Run stripProtectedPaths on a synthetic pages array so AI output matches websites.json paths.
 */
function stripSlimAiResult(aiResult: SlimPayload): void {
  const wrap = {
    pages: [
      aiResult.home,
      {
        name: 'faq',
        pageTitle: aiResult.faq.pageTitle,
        metadata: aiResult.faq.metadata,
        ...(aiResult.faq.hero !== undefined ? { hero: aiResult.faq.hero } : {}),
      },
      aiResult.impressum,
      aiResult.datenschutz,
      aiResult.ueberUns,
    ],
  } as Record<string, unknown>;
  stripProtectedPaths(wrap, CLONE_STRIP_PROTECTED_PATHS);
  const pages = wrap.pages as Record<string, unknown>[];
  aiResult.home = {
    name: 'home',
    ...pages[0],
  } as Record<string, unknown>;
  aiResult.faq = {
    name: 'faq',
    pageTitle: pages[1].pageTitle,
    metadata: pages[1].metadata,
    ...(pages[1].hero !== undefined ? { hero: pages[1].hero } : {}),
  };
  aiResult.impressum = {
    name: 'impressum',
    pageTitle: pages[2].pageTitle,
    metadata: pages[2].metadata,
  };
  aiResult.datenschutz = {
    name: 'datenschutz',
    pageTitle: pages[3].pageTitle,
    metadata: pages[3].metadata,
  };
  aiResult.ueberUns = pages[4];
}

/**
 * Derive FAQ JSON filenames for the new site id (same pattern as 06 template / translate-data).
 */
function applyFaqDataFilesForClone(
  entry: Record<string, unknown>,
  sourceId: string,
  newId: string
): void {
  const mapName = (old: string | undefined): string => {
    if (!old || typeof old !== 'string') return old ?? '';
    let s = old;
    if (sourceId && s.includes(sourceId)) {
      s = s.split(sourceId).join(newId);
    }
    return s;
  };

  const pages = entry.pages as Record<string, unknown>[] | undefined;
  if (!Array.isArray(pages)) return;

  for (const p of pages) {
    if (typeof p.faqDataFile === 'string') {
      p.faqDataFile = mapName(p.faqDataFile);
    }
    const fq = p.faq;
    if (
      fq &&
      typeof fq === 'object' &&
      typeof (fq as Record<string, unknown>).faqDataFile === 'string'
    ) {
      (fq as Record<string, unknown>).faqDataFile = mapName(
        (fq as Record<string, unknown>).faqDataFile as string
      );
    }
  }
}

function validateCloneEntry(
  entry: Record<string, unknown>,
  _source: Record<string, unknown>
): string[] {
  const warnings: string[] = [];
  const requiredTop = [
    'id',
    'business',
    'header',
    'footer',
    'cookie',
    'notFound',
    'translationsMetadata',
    'index',
    'pages',
  ];
  for (const key of requiredTop) {
    if (!(key in entry)) warnings.push(`Missing top-level key: "${key}"`);
  }

  const pages = entry.pages as Record<string, unknown>[] | undefined;
  const srcPages = _source.pages as Record<string, unknown>[] | undefined;
  if (Array.isArray(pages) && pages.length > 0 && Array.isArray(srcPages)) {
    const home = pages.find((p) => p.name === 'home');
    const srcHome = srcPages.find((p) => p.name === 'home');
    if (home && srcHome) {
      for (const key of Object.keys(srcHome)) {
        if (!(key in home)) warnings.push(`Missing pages[home].${key}`);
      }
    }
    const expected = ['home', 'faq', 'impressum', 'datenschutz', 'ueber-uns'];
    const names = pages.map((p) => p.name);
    for (const n of expected) {
      if (!names.includes(n)) warnings.push(`Missing page: "${n}"`);
    }
  } else {
    warnings.push('"pages" missing or empty');
  }
  return warnings;
}

/**
 * Merge the AI-adapted slim payload back into a deep-cloned source entry,
 * restoring all the verbatim fields the AI never saw.
 */
function mergeIntoClone(
  source: Record<string, unknown>,
  newId: string,
  newDeployDomain: string,
  newClientDomain: string,
  aiResult: SlimPayload
): Record<string, unknown> {
  const cloned = deepClone(source);
  cloned.id = newId;
  cloned.deployDomain = newDeployDomain;
  cloned.clientDomain = newClientDomain;

  const sourcePagesRaw = (source.pages as Array<Record<string, unknown>>) ?? [];
  const sourcePages = deepClone(sourcePagesRaw);

  const sourceByName = new Map(
    sourcePagesRaw.map((p) => [String(p.name), p] as const)
  );

  const merged = sourcePages.map((page: Record<string, unknown>) => {
    switch (page.name) {
      case 'home': {
        const srcHome = sourceByName.get('home') ?? page;
        return mergeHomeFromAiAndSource(aiResult.home, srcHome);
      }

      case 'ratgeber':
        // Never changes — same blog listing for all locations
        return page;

      case 'faq':
        // Merge metadata + hero; faqDataFile / schema from source + applyFaqDataFilesForClone
        return {
          ...page,
          metadata: aiResult.faq.metadata ?? page.metadata,
          ...(aiResult.faq.hero !== undefined
            ? { hero: aiResult.faq.hero }
            : {}),
        };

      case 'impressum':
        // Only metadata updated; blocks (legal text) kept verbatim from source
        return {
          ...page,
          metadata: aiResult.impressum.metadata ?? page.metadata,
        };

      case 'datenschutz':
        // Only metadata updated; blocks kept verbatim from source
        return {
          ...page,
          metadata: aiResult.datenschutz.metadata ?? page.metadata,
        };

      case 'ueber-uns': {
        const srcUeber = sourceByName.get('ueber-uns') ?? page;
        const src = srcUeber as Record<string, unknown>;
        const mergedUeber = {
          ...deepClone(srcUeber),
          ...aiResult.ueberUns,
        } as Record<string, unknown>;
        if ('schema' in src) mergedUeber.schema = src.schema;
        return mergedUeber;
      }

      default:
        return page;
    }
  });

  cloned.pages = merged;
  return cloned;
}

function upsertWebsiteById(
  websites: Record<string, unknown>[],
  siteId: string,
  entry: Record<string, unknown>
): void {
  const i = websites.findIndex(
    (w) => String((w as Record<string, string>).id) === siteId
  );
  if (i === -1) {
    websites.push(entry);
  } else {
    websites[i] = entry;
  }
}

/**
 * Merges the current block-wise slim `working` copy (same shape as a SlimPayload) into
 * a full site entry, applies Excel/FAQ/disk image helpers, then upserts to websites.json.
 * Does not mutate `working` (clones before strip/merge).
 */
function persistCloneCheckpoint(
  working: Record<string, unknown>,
  ctx: CloneCheckpointContext
): void {
  const slimForDisk = deepClone(working) as SlimPayload;
  stripSlimAiResult(slimForDisk);
  const merged = mergeIntoClone(
    ctx.sourceEntry,
    ctx.newId,
    ctx.newDeployDomain,
    ctx.newClientDomain,
    slimForDisk
  ) as Record<string, unknown>;
  if (ctx.excelSeedRow) {
    ctx.processExcel.applyRowToWebsite(
      ctx.excelSeedRow,
      merged,
      ctx.websites,
      ''
    );
    merged.id = ctx.newId;
  }
  applyFaqDataFilesForClone(merged, ctx.sourceId, ctx.newId);
  if (ctx.availableImages && ctx.availableImages.all.length > 0) {
    applyDiskImagePathsToEntry(merged, ctx.availableImages);
  }
  upsertWebsiteById(ctx.websites, ctx.newId, merged);
  writeWebsites(ctx.websitesPath, ctx.websites);
  console.log(
    `  [clone] checkpoint: saved in-progress copy for id "${ctx.newId}" to websites.json`
  );
}

// ---------------------------------------------------------------------------
// Image path collector
// ---------------------------------------------------------------------------

function collectImagePaths(
  obj: unknown,
  jsonPath = ''
): Array<{ jsonPath: string; value: string }> {
  const out: Array<{ jsonPath: string; value: string }> = [];
  if (obj === null || obj === undefined) return out;

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      if (typeof item === 'string' && item.startsWith('/images/')) {
        out.push({ jsonPath: `${jsonPath}[${i}]`, value: item });
      } else if (typeof item === 'object' && item !== null) {
        out.push(...collectImagePaths(item, `${jsonPath}[${i}]`));
      }
    });
    return out;
  }

  if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (typeof val === 'string') {
        if (val.startsWith('/images/'))
          out.push({ jsonPath: keyPath, value: val });
      } else if (typeof val === 'object' && val !== null) {
        out.push(...collectImagePaths(val, keyPath));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google Drive site folders (same layout as 03-organize-drive-assets.mjs)
// ---------------------------------------------------------------------------

function stripSitePrefix(slug: string): string {
  return slug.replace(/^site-/, '');
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /[äöü]/g,
      (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c as 'ä' | 'ö' | 'ü']
    )
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function clientFolderSlug(clientId: string): string {
  const websitesPath = getWebsitesPath(clientId);
  try {
    const data = JSON.parse(fs.readFileSync(websitesPath, 'utf-8')) as {
      clientName?: string;
    };
    return data.clientName ? slugify(data.clientName) : clientId;
  } catch {
    return clientId;
  }
}

function getClientGoogleDriveOutputDir(clientId: string): string {
  const baseDir = 'googleDrive';
  const configuredDir = `${baseDir}/${clientFolderSlug(clientId)}`;
  return path.isAbsolute(configuredDir)
    ? configuredDir
    : path.join(ROOT, configuredDir);
}

/**
 * Discover site folders under the Drive output dir (01-content / 02-images / or top-level files).
 * Mirrors 03-organize-drive-assets.mjs discoverSiteFolders.
 */
function discoverSiteFolders(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });

  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .filter((e) => {
      const siteDir = path.join(baseDir, e.name);
      const hasContent = fs.existsSync(path.join(siteDir, '01-content'));
      const hasImages = fs.existsSync(path.join(siteDir, '02-images'));
      const hasFiles = fs
        .readdirSync(siteDir)
        .some(
          (f) =>
            !f.startsWith('.') && fs.statSync(path.join(siteDir, f)).isFile()
        );
      return hasContent || hasImages || hasFiles;
    })
    .map((e) => e.name);

  return folders;
}

function getAvailableClients(): string[] {
  const dataDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== 'current' &&
        e.name !== '_template' &&
        !e.name.startsWith('.')
    )
    .filter((e) => fs.existsSync(path.join(dataDir, e.name, 'websites.json')))
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

function parseArgs(): {
  clientId: string | null;
  sourceId: string | null;
  sourceIndex: number | null;
  newId: string | null;
  promptFile: string | null;
  useStdin: boolean;
  modelOverride: string | null;
  dryRun: boolean;
  outFile: string | null;
  /** Optional raw host for the new site's `deployDomain`. Overrides TLD-inference. */
  deployDomainOverride: string | null;
  /** Optional canonical host for the new site's `clientDomain`. Overrides the default `www.<deployDomain>`. */
  clientDomainOverride: string | null;
} {
  const args = process.argv.slice(2);
  let clientId: string | null = null;
  let sourceId: string | null = null;
  let sourceIndex: number | null = null;
  let newId: string | null = null;
  let promptFile: string | null = null;
  let useStdin = false;
  let modelOverride: string | null = null;
  let dryRun = false;
  let outFile: string | null = null;
  let deployDomainOverride: string | null = null;
  let clientDomainOverride: string | null = null;

  for (const arg of args) {
    if (arg.startsWith('--client=')) clientId = arg.replace('--client=', '');
    else if (arg.startsWith('--source='))
      sourceId = arg.replace('--source=', '');
    else if (arg.startsWith('--source-index='))
      sourceIndex = parseInt(arg.replace('--source-index=', ''), 10);
    else if (arg.startsWith('--id=')) newId = arg.replace('--id=', '');
    else if (arg.startsWith('--prompt='))
      promptFile = arg.replace('--prompt=', '');
    else if (arg === '--stdin') useStdin = true;
    else if (arg.startsWith('--model='))
      modelOverride = arg.replace('--model=', '');
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--out=')) outFile = arg.replace('--out=', '');
    else if (arg.startsWith('--deploy-domain='))
      deployDomainOverride = arg.replace('--deploy-domain=', '');
    else if (arg.startsWith('--client-domain='))
      clientDomainOverride = arg.replace('--client-domain=', '');
  }

  return {
    clientId,
    sourceId,
    sourceIndex,
    newId,
    promptFile,
    useStdin,
    modelOverride,
    dryRun,
    outFile,
    deployDomainOverride,
    clientDomainOverride,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  dotenv.config({
    path: path.resolve(process.cwd(), '.env.local'),
    quiet: true,
  });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY in .env.local');
    process.exit(1);
  }

  let {
    clientId: clientIdArg,
    sourceId,
    sourceIndex,
    newId,
    promptFile,
    useStdin,
    modelOverride,
    dryRun,
    outFile,
    deployDomainOverride,
    clientDomainOverride,
  } = parseArgs();

  const needsFolderPrompts =
    (sourceId === null && sourceIndex === null) || newId === null;

  if (needsFolderPrompts) {
    // Only skip the prompt when --client= is passed; do not use CLIENT_ID from .env
    // so the user always explicitly chooses who to activate before use-client runs.
    let clientId = clientIdArg ?? null;
    if (!clientId) {
      const clients = getAvailableClients();
      if (clients.length === 0) {
        console.error(
          '[clone-website] No client folders with websites.json found under src/data/.'
        );
        process.exit(1);
      }
      const picked = await enquirer.prompt<{ client: string }>({
        type: 'select',
        name: 'client',
        message: 'Which client do you want to activate?',
        choices: clients,
      });
      clientId = picked.client;
    }

    if (!clientId) {
      console.error('[clone-website] Could not resolve client.');
      process.exit(1);
    }

    console.log('\n[clone-website] Activating client (use-client)...\n');
    runUseClientActivateOnly(clientId);
    dotenv.config({
      path: path.join(ROOT, '.env.local'),
      override: true,
      quiet: true,
    });
    process.env.CLIENT_ID = clientId;

    const websitesPathEarly = getWebsitesPath(clientId);
    if (sourceId === null && sourceIndex !== null) {
      const w = loadWebsites(websitesPathEarly);
      if (sourceIndex < 0 || sourceIndex >= w.length) {
        console.error(
          `[clone-website] source-index ${sourceIndex} out of range (0–${w.length - 1})`
        );
        process.exit(1);
      }
      const raw = w[sourceIndex] as Record<string, string>;
      if (!raw.id) {
        console.error('[clone-website] website entry has no id');
        process.exit(1);
      }
      sourceId = raw.id;
    }

    if (sourceId === null && sourceIndex === null) {
      const meta = loadWebsitesJsonMeta(clientId);
      const topLevelDomain = meta.clientDomain;
      const websiteEntries = meta.websites
        .map((w) => w as Record<string, unknown>)
        .filter((wrec) => String(wrec.id ?? '').trim().length > 0)
        .sort((a, b) =>
          String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en')
        );
      if (websiteEntries.length === 0) {
        console.error(`[clone-website] No websites in ${websitesPathEarly}`);
        process.exit(1);
      }
      // Enquirer Select returns `name` — must be websites[].id (not Drive folder names)
      const choices = websiteEntries.map((wrec) => ({
        name: String(wrec.id),
        message: buildWebsiteRowLabel(wrec, topLevelDomain),
      }));
      const src = await enquirer.prompt<{ site: string }>({
        type: 'select',
        name: 'site',
        message: 'Which site do you want to clone from?',
        choices,
        // @ts-expect-error enquirer SelectOptions supports limit (types incomplete)
        limit: 20,
      });
      sourceId = src.site;
    }

    if (newId === null) {
      const processExcel = await loadProcessExcelModule();
      const excelDomains = processExcel.listExcelDomainsForClient(clientId);
      const sourceKey = sourceId ?? '';
      const sourceIdSlug = sourceKey ? slugify(String(sourceKey).trim()) : '';

      const existingSiteIds = new Set<string>();
      if (fs.existsSync(websitesPathEarly)) {
        try {
          for (const site of loadWebsites(websitesPathEarly)) {
            const id = slugify(
              String((site as Record<string, string>).id ?? '').trim()
            );
            if (id) existingSiteIds.add(id);
          }
        } catch {
          /* ignore: treat as unknown existing set */
        }
      }

      const domainChoices = excelDomains
        .filter((entry) => !sourceIdSlug || entry.siteId !== sourceIdSlug)
        .filter((entry) => !existingSiteIds.has(entry.siteId))
        .sort((a, b) => a.domain.localeCompare(b.domain, 'en'));

      if (domainChoices.length === 0) {
        const typed = await enquirer.prompt<{ newIdInput: string }>({
          type: 'input',
          name: 'newIdInput',
          message:
            excelDomains.length > 0
              ? 'No new Excel locations left (all site IDs already exist in websites.json, or only the clone source is left). Enter new site id (kebab-case) for the new location'
              : 'No usable domains found in Excel. Enter new site id (kebab-case) for the new location',
          validate: (v: string) =>
            (v && v.trim().length > 0) || 'Enter a non-empty id',
        });
        newId = typed.newIdInput.trim();
      } else {
        const dest = await enquirer.prompt<{ targetDomain: string }>({
          type: 'select',
          name: 'targetDomain',
          message: 'New location: pick the target domain from Excel',
          choices: domainChoices.map((entry) => ({
            name: entry.domain,
            message: `${entry.domain}  →  ${entry.siteId}`,
          })),
          // @ts-expect-error enquirer SelectOptions supports limit (types incomplete)
          limit: 20,
        });

        const selectedDomain = normalizeDomainHost(dest.targetDomain);
        const selected = domainChoices.find(
          (entry) => entry.domain === selectedDomain
        );
        const derivedSiteId =
          selected?.siteId || siteIdFromDomainHost(selectedDomain);
        if (!derivedSiteId) {
          console.error(
            `[clone-website] Could not derive site id from selected domain "${selectedDomain}".`
          );
          process.exit(1);
        }
        newId = derivedSiteId;

        if (!deployDomainOverride) {
          deployDomainOverride = selectedDomain;
        }
        if (!clientDomainOverride && selectedDomain) {
          clientDomainOverride = `www.${selectedDomain}`;
        }
      }
    }

    clientIdArg = clientId;
  }

  const resolvedClientId =
    clientIdArg ?? process.env.CLIENT_ID ?? DEFAULT_CLIENT;
  const websitesPath = getWebsitesPath(resolvedClientId);

  if (!fs.existsSync(websitesPath)) {
    console.error(
      `[clone-website] websites.json not found for client "${resolvedClientId}": ${websitesPath}`
    );
    process.exit(1);
  }

  runProcessExcelData(resolvedClientId);

  let websites: Record<string, unknown>[] | null = null;
  if (sourceId === null && sourceIndex !== null) {
    websites = loadWebsites(websitesPath);
    if (sourceIndex < 0 || sourceIndex >= websites.length) {
      console.error(
        `Error: source-index ${sourceIndex} out of range (0–${websites.length - 1})`
      );
      process.exit(1);
    }
    const raw = websites[sourceIndex] as Record<string, string>;
    if (!raw.id) {
      console.error('[clone-website] website entry has no id');
      process.exit(1);
    }
    sourceId = raw.id;
  }

  if (!newId) {
    console.error(
      'Error: --id=<new-id> is required (or pick from the prompts).'
    );
    console.error('');
    console.error(
      'Usage: pnpm clone-website --source=<id> --id=<new-id> --prompt=<file>'
    );
    console.error(
      '       pnpm clone-website --source-index=0 --id=<new-id> --stdin'
    );
    process.exit(1);
  }

  if (!promptFile && !useStdin) {
    const sitePrompt = ensureClonePromptAndTopicsFiles(
      resolvedClientId,
      newId,
      sourceId
    );
    if (sitePrompt && fs.existsSync(sitePrompt)) {
      promptFile = sitePrompt;
      // console.log(`[clone-website] Using prompt from: ${sitePrompt}`);
    }
  }

  if (!promptFile && !useStdin) {
    console.error(
      'Error: add `prompt.md` for the new site (e.g. ' +
        path.join('src', 'data', resolvedClientId, newId, 'prompt.md') +
        '), or pass --prompt=<file> or --stdin.'
    );
    process.exit(1);
  }

  if (sourceId === null && sourceIndex === null) {
    console.error(
      'Error: provide --source=<id> or --source-index=<n> to select the source entry.'
    );
    process.exit(1);
  }

  websites ??= loadWebsites(websitesPath);

  let sourceEntry: Record<string, unknown> | undefined;
  if (sourceId !== null) {
    sourceEntry = websites.find(
      (w) => (w as Record<string, string>).id === sourceId
    );
    if (!sourceEntry) {
      console.error(
        `Error: no website with id "${sourceId}" found in websites.json`
      );
      console.error(
        `Available ids: ${websites.map((w) => (w as Record<string, string>).id).join(', ')}`
      );
      process.exit(1);
    }
  } else {
    const idx = sourceIndex!;
    if (idx < 0 || idx >= websites.length) {
      console.error(
        `Error: source-index ${idx} out of range (0–${websites.length - 1})`
      );
      process.exit(1);
    }
    sourceEntry = websites[idx];
  }

  const existingNew = websites.find(
    (w) => (w as Record<string, string>).id === newId
  );
  if (existingNew) {
    console.warn(
      `Warning: a website with id "${newId}" already exists in websites.json.`
    );
    console.warn(
      'The entry will still be appended. You may want to remove the duplicate manually.'
    );
  }

  let locationPrompt: string;
  if (useStdin) {
    console.log('Reading location description from stdin...');
    locationPrompt = await readStdin();
  } else {
    const promptPath = path.resolve(process.cwd(), promptFile!);
    if (!fs.existsSync(promptPath)) {
      console.error(`Prompt file not found: ${promptPath}`);
      process.exit(1);
    }
    locationPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
    // console.log(
    //   `Read prompt from: ${promptPath} (${locationPrompt.length} chars)`
    // );
  }

  if (!locationPrompt) {
    console.error('Location prompt is empty.');
    process.exit(1);
  }

  const model = modelOverride ?? DEFAULT_MODEL;
  const topicsContext = loadCloneTopicsContext(resolvedClientId, newId);
  const processExcel = await loadProcessExcelModule();
  const excelSeedRow = processExcel.findExcelRowForSiteId(
    resolvedClientId,
    newId
  );
  if (excelSeedRow) {
    console.log(
      `[clone-website] Found Excel seed row for "${newId}" via scripts/04-process-excel-data.mjs.`
    );
  } else {
    console.log(
      `[clone-website] No Excel seed row found for "${newId}" — clone will use source/default values.`
    );
  }

  // Slim payload: structural skeleton; each block is regenerated via OpenRouter (no source copy in prompts).
  const slim = buildSlimPayload(sourceEntry);
  const fullSourceJson = JSON.stringify(sourceEntry, null, 2);
  const adaptPaths = collectCloneAdaptPaths(slim);

  console.log(`\nSource:      "${(sourceEntry as Record<string, string>).id}"`);
  console.log(`New id:      "${newId}"`);
  console.log(`Full source: ${fullSourceJson.length} chars`);
  console.log(
    `Slim writable paths: ${adaptPaths.length} string field(s) (sanity check; clone uses block-wise generation)`
  );
  console.log(`Prompt:      ${locationPrompt.length} chars`);
  if (topicsContext) {
    const topicsCount = Object.values(topicsContext.topics ?? {}).reduce(
      (sum, items) => sum + items.length,
      0
    );
    const keywordsCount = topicsContext.keywords?.length ?? 0;
    console.log(
      `Topics:      ${topicsCount} topic point(s), ${keywordsCount} keyword(s) from topics.json`
    );
  } else {
    console.log('Topics:      none (topics.json missing or empty)');
  }
  console.log('');

  if (adaptPaths.length === 0) {
    console.error(
      '[clone-website] No adaptable string paths in slim payload — aborting.'
    );
    process.exit(1);
  }

  const excelDeployDomain = normalizeDomainHost(excelSeedRow?.domain ?? '');
  const { deployDomain: newDeployDomain, clientDomain: newClientDomain } =
    deriveClonedDomains(newId, sourceEntry, {
      deployDomain: deployDomainOverride ?? (excelDeployDomain || null),
      clientDomain:
        clientDomainOverride ??
        (excelDeployDomain ? `www.${excelDeployDomain}` : null),
    });
  const businessSubset = pickBusinessContextForClone(sourceEntry);

  const sourceWebsiteBriefing =
    typeof sourceEntry.websiteBriefing === 'string'
      ? sourceEntry.websiteBriefing.trim()
      : '';
  const newWebsiteBriefing =
    (existingNew && typeof existingNew.websiteBriefing === 'string'
      ? existingNew.websiteBriefing.trim()
      : '') || String(excelSeedRow?.websiteBriefing ?? '').trim();

  if (!newWebsiteBriefing && !topicsContext) {
    console.warn(
      `[clone-website] WARNING: no newWebsiteBriefing in Excel/entry and no topics.json for "${newId}".\n` +
        `  Generated copy may be generic — add the Excel "Content Briefing" for this row, then run:\n` +
        `  pnpm 04-process-excel-data && pnpm 05-extract-website:client-prompt -- --client=${resolvedClientId} --site=${newId}`
    );
  }

  if (existingNew && newWebsiteBriefing) {
    console.log(
      `Using "Content Briefing" from existing "${newId}" entry (${newWebsiteBriefing.length} chars) — authoritative for adaptation.`
    );
  } else if (newWebsiteBriefing) {
    console.log(
      `Using "Content Briefing" from Excel row for "${newId}" (${newWebsiteBriefing.length} chars) — authoritative for adaptation.`
    );
  } else if (sourceWebsiteBriefing) {
    console.log(
      `Using "Content Briefing" from source "${(sourceEntry as Record<string, string>).id}" entry (${sourceWebsiteBriefing.length} chars) — background context.`
    );
  }

  console.log(`Using model: ${model}`);
  console.log(
    'Cloning website entry with AI (block-wise regeneration from briefing + topics)...\n'
  );

  const availableImages = scanAvailableImages(newId);
  const cloneCheckpoint: CloneCheckpointContext | null =
    !dryRun && !outFile
      ? {
          websitesPath,
          websites,
          newId,
          sourceId: String((sourceEntry as Record<string, string>).id),
          sourceEntry,
          newDeployDomain,
          newClientDomain,
          processExcel,
          excelSeedRow,
          availableImages,
        }
      : null;

  let aiResult: SlimPayload;
  let aiUsageTotals: CloneAiUsageTotals | null = null;
  try {
    const cloneResult = await runCloneBlockRegistryPass(
      apiKey,
      model,
      slim,
      newId,
      newDeployDomain,
      locationPrompt,
      businessSubset,
      sourceWebsiteBriefing,
      newWebsiteBriefing,
      topicsContext,
      cloneCheckpoint
    );
    aiResult = cloneResult.slim;
    aiUsageTotals = cloneResult.usage;
  } catch (err) {
    console.error('\nFailed to run clone AI block passes:', err);
    process.exit(1);
  }

  stripSlimAiResult(aiResult);

  // Merge AI result back into a full cloned entry
  const finalEntry = mergeIntoClone(
    sourceEntry,
    newId,
    newDeployDomain,
    newClientDomain,
    aiResult
  );
  if (excelSeedRow) {
    processExcel.applyRowToWebsite(excelSeedRow, finalEntry, websites, '');
    // Keep the selected destination id even if Excel "Site ID" differs in formatting.
    finalEntry.id = newId;
  }

  // Dedicated AI step: regenerate the hero H1 using prompt.md + topics.json,
  // optimised specifically for a perfect, SEO-driven hero headline.
  try {
    const finalPages =
      (finalEntry.pages as Array<Record<string, unknown>> | undefined) ?? [];
    const homePage = finalPages.find((p) => p?.name === 'home');
    const homeHero =
      (homePage?.hero as Record<string, unknown> | undefined) ?? undefined;
    if (homeHero) {
      const currentH1 =
        typeof homeHero.h1 === 'string' ? (homeHero.h1 as string) : '';
      const newH1 = await generateHeroH1ForClone(
        apiKey,
        model,
        newId,
        newDeployDomain,
        businessSubset,
        currentH1,
        locationPrompt,
        topicsContext,
        sourceWebsiteBriefing,
        newWebsiteBriefing,
        collectOtherSitesHomeHeroH1s(websites, newId),
        aiUsageTotals ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          hasAnyCostData: false,
        }
      );
      if (newH1) {
        homeHero.h1 = newH1;
        console.log(
          `\n[clone-website] Hero H1 (SEO-optimised, ${newH1.length} chars):\n  "${newH1}"`
        );
      } else {
        console.warn(
          '\n[clone-website] Hero H1 dedicated step did not return a usable headline — keeping the H1 from the main clone pass.'
        );
      }
    } else {
      console.warn(
        '\n[clone-website] Skipping dedicated hero H1 step: home page hero not found on cloned entry.'
      );
    }
  } catch (err) {
    console.warn(
      '\n[clone-website] Dedicated hero H1 step failed — keeping the H1 from the main clone pass.',
      err instanceof Error ? err.message : err
    );
  }

  if (aiUsageTotals) {
    console.log('\n[clone-website] AI usage totals:');
    console.log(
      `  Tokens: ${aiUsageTotals.promptTokens.toLocaleString()} prompt + ${aiUsageTotals.completionTokens.toLocaleString()} completion = ${aiUsageTotals.totalTokens.toLocaleString()} total`
    );
    if (aiUsageTotals.hasAnyCostData) {
      console.log(`  Total AI cost: ${formatUsd(aiUsageTotals.totalCostUsd)}`);
    } else {
      console.log(
        '  Total AI cost: n/a (cost not provided by API usage fields)'
      );
    }
    logAiCost({
      script: 'clone-website',
      operation: 'run-totals',
      model,
      promptTokens: aiUsageTotals.promptTokens,
      completionTokens: aiUsageTotals.completionTokens,
      totalTokens: aiUsageTotals.totalTokens,
      costUsd: aiUsageTotals.hasAnyCostData ? aiUsageTotals.totalCostUsd : null,
      costSource: aiUsageTotals.hasAnyCostData ? 'aggregated' : 'tokens_only',
    });
  }

  applyFaqDataFilesForClone(
    finalEntry,
    String((sourceEntry as Record<string, string>).id),
    newId
  );

  if (availableImages && availableImages.all.length > 0) {
    applyDiskImagePathsToEntry(finalEntry, availableImages);
    console.log(
      `\n[clone-website] Applied image paths from public/images/${newId}/ (${availableImages.all.length} file(s)).`
    );
  } else {
    console.warn(
      `\n[clone-website] No images under public/images/${newId}/ — run \`pnpm organize-assets\` after adding assets, then \`pnpm 08-refine-website-data\` or re-clone.`
    );
  }

  const structureWarnings = validateCloneEntry(finalEntry, sourceEntry);
  if (structureWarnings.length > 0) {
    console.warn('\n[clone-website] Structure warnings:');
    for (const w of structureWarnings) console.warn(`  - ${w}`);
  }

  const imageList = collectImagePaths(finalEntry);
  if (imageList.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('IMAGE PATHS IN GENERATED ENTRY');
    console.log(
      'Verify these paths exist or replace placeholders with real files.'
    );
    console.log('═══════════════════════════════════════════════════════\n');
    for (const { value } of imageList) {
      console.log(`  ${value}`);
    }
    console.log('\n═══════════════════════════════════════════════════════\n');
  }

  try {
    await applyGooglePlaceAddressToWebsiteEntry(
      finalEntry as Record<string, unknown>
    );
  } catch (e) {
    console.warn(
      '  [place-address] Unexpected error — hero address unchanged.',
      e instanceof Error ? e.message : e
    );
  }

  const outputJson = JSON.stringify(finalEntry, null, 2);

  if (dryRun) {
    console.log('\n--- DRY RUN: Cloned website JSON ---\n');
    console.log(outputJson);
    console.log('\n--- End of dry run ---');
    return;
  }

  if (outFile) {
    const outPath = path.resolve(process.cwd(), outFile);
    fs.writeFileSync(outPath, outputJson + '\n');
    console.log(`\nWrote cloned website to: ${outPath}`);
  } else {
    upsertWebsiteById(websites, newId, finalEntry);
    writeWebsites(websitesPath, websites);
    console.log(`\nSaved final clone to ${websitesPath} (id: "${newId}").`);
    console.log(`websites.json now contains ${websites.length} website(s).`);

    runFetchPlaceHeroAddressForSite(resolvedClientId, newId);
    runFetchGoogleReviewsForSite(resolvedClientId, newId);
    runRefineWebsiteDataForSite(resolvedClientId, newId);
  }

  console.log('\nNext steps:');
  console.log('  1. Review the new entry in websites.json');
  console.log(
    '  2. If public/images/<site-id>/ was empty, run `pnpm organize-assets` then re-run refine or adjust paths'
  );
  console.log(
    '  3. Fill in map.mapEmbedUrl if needed; with business.googlePlacesId + GOOGLE_PLACES_API_KEY the hero address card is filled from Places (reviews also need a Place ID)'
  );
  console.log(
    '  4. If Google reviews did not run or failed, run: pnpm run 07-fetch-google-reviews -- --client-id=<client> --site-id=<new-id>'
  );
  console.log('  5. Run: pnpm translate-data to generate translations');
  if (!outFile) {
    console.log(
      '  6. (Done) Ran 08-refine-website-data for this site — re-run if it warned above'
    );
  } else {
    console.log(
      '  6. Run: pnpm run 08-refine-website-data -- --client-id=<client> --website-id=<new-id> after merging into websites.json'
    );
  }
  console.log('  7. Run: pnpm dev to verify the new location page');
}

main();
