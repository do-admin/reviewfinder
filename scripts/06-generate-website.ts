/**
 * AI Website Generator: Creates a new website entry for websites.json
 * using OpenRouter + Gemini, based on a user-provided prompt describing
 * the new business or website.
 *
 * The script uses an existing website entry as the structural template
 * and asks the AI to fill in all text fields according to the prompt.
 * Works for any industry; the prompt file supplies brand and business context.
 *
 * Requires: OPENROUTER_API_KEY in .env.local
 *
 * Usage:
 *   pnpm generate-website                    # Interactive: select client, then website (prompt from folder)
 *   pnpm generate-website --client=haus-zum-wald  # Interactive: select website from client folder
 *   pnpm generate-website --prompt="path/to/prompt.md" --client=haus-zum-wald
 *   pnpm generate-website --prompt="path/to/prompt.md" --template=0
 *   pnpm generate-website --prompt="path/to/prompt.md" --dry-run
 *   echo "prompt text" | pnpm generate-website --stdin --client=haus-zum-wald
 *
 * Options:
 *   --client=<id>    Client folder (e.g. haus-zum-wald, nicezeit). Required for output path.
 *   --prompt=<file>  Path to a text file containing the website description
 *   --stdin          Read the prompt from stdin instead of a file
 *   --template=<idx> Index of the website in websites.json to use as structure template (default: 0)
 *   --dry-run        Print the generated JSON to stdout without writing to websites.json
 *   --out=<file>     Write to a separate file instead of appending to websites.json
 *   --skip-clone-check  Skip AI verification; always use full generation (never delegate to clone-website)
 *
 * When the client already has website entries, a quick AI step verifies whether any
 * clearly belongs to the same business as the prompt. If so, clone-website.ts is
 * invoked instead (token-efficient location variant).
 *
 * After writing websites.json, runs `pnpm fetch-place-hero-address` for that site (when
 * GOOGLE_PLACES_API_KEY is set), same as clone-website, so all websites*.json rows are
 * reconciled from Google Places. Then runs `pnpm 08-refine-website-data` for link checks
 * and refinements (same order as clone-website).
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import * as dotenv from 'dotenv';
import inquirer from 'inquirer';
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
import { stripProtectedPaths } from './lib/strip-protected-paths';
import {
  type AvailableImages,
  scanAvailableImages,
  applyDiskImagePathsToEntry,
} from './lib/website-disk-images';
import { jsonrepair } from 'jsonrepair';
import { footerContactLinkDisplayLabel } from '../src/lib/footer-contact-display-label';
import { logOpenRouterChatResponse } from './lib/log-ai-cost.mjs';
import { applyGooglePlaceAddressToWebsiteEntry } from './lib/apply-google-place-hero-address';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DATA_ROOT = path.join(process.cwd(), 'src', 'data');
const ROOT = process.cwd();

/**
 * Reconciles hero address (and any split websites-*.json files) from Places for one site.
 * Skips if GOOGLE_PLACES_API_KEY is missing; does not exit on failure so a successful write
 * to websites.json is preserved.
 */
function runFetchPlaceHeroAddressForSite(
  clientId: string,
  websiteId: string
): void {
  if (!process.env.GOOGLE_PLACES_API_KEY?.trim()) {
    console.warn(
      '\n[06-generate-website] Skipping fetch-place-hero-address: GOOGLE_PLACES_API_KEY not set in .env.local'
    );
    return;
  }
  console.log(
    '\n[06-generate-website] fetch-place-hero-address (all websites*.json for this site)...\n'
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
      '[06-generate-website] Could not run fetch-place-hero-address:',
      r.error.message
    );
    return;
  }
  if (r.status !== 0) {
    console.warn(
      '[06-generate-website] fetch-place-hero-address exited with a non-zero status. Re-run:\n' +
        `  pnpm run fetch-place-hero-address -- --client-id=${clientId} --site-id=${websiteId}`
    );
  }
}

/**
 * Runs 08-refine-website-data for one website (full client JSON on disk).
 * Does not exit on failure so a successful write to websites.json is preserved.
 */
function runRefineWebsiteDataForSite(
  clientId: string,
  websiteId: string
): void {
  console.log(
    '\n[06-generate-website] Refining website data (08-refine-website-data)...\n'
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
      '[06-generate-website] Could not run 08-refine-website-data:',
      r.error.message
    );
    return;
  }
  if (r.status !== 0) {
    console.warn(
      '[06-generate-website] 08-refine-website-data exited with a non-zero status. Re-run:\n' +
        `  pnpm run 08-refine-website-data -- --client-id=${clientId} --website-id=${websiteId}`
    );
  }
}

function getDataDir(clientId: string): string {
  return path.join(DATA_ROOT, clientId);
}

function getAvailableClients(): string[] {
  return fs.readdirSync(DATA_ROOT).filter((f) => {
    const p = path.join(DATA_ROOT, f);
    return fs.statSync(p).isDirectory() && f !== 'current' && f !== '_template';
  });
}

/** Returns subfolders of the client that contain a prompt.md file (fallback: prompt.txt). */
function getWebsiteFoldersWithPrompt(
  clientId: string
): Array<{ folder: string; promptPath: string; hasTopics: boolean }> {
  const clientDir = getDataDir(clientId);
  if (!fs.existsSync(clientDir)) return [];
  const entries = fs.readdirSync(clientDir, { withFileTypes: true });
  const result: Array<{
    folder: string;
    promptPath: string;
    hasTopics: boolean;
  }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const promptMdPath = path.join(clientDir, e.name, 'prompt.md');
    const promptTxtPath = path.join(clientDir, e.name, 'prompt.txt');
    const topicsPath = path.join(clientDir, e.name, 'topics.json');
    const hasTopics = fs.existsSync(topicsPath);
    if (fs.existsSync(promptMdPath)) {
      result.push({ folder: e.name, promptPath: promptMdPath, hasTopics });
    } else if (fs.existsSync(promptTxtPath)) {
      result.push({ folder: e.name, promptPath: promptTxtPath, hasTopics });
    }
  }
  return result.sort((a, b) => a.folder.localeCompare(b.folder));
}

const TEMPLATE_CLIENT_ID = '_template';

/** Returns clients that have at least one website in their websites.json. Includes _template when present. */
function getClientsWithWebsites(): Array<{ clientId: string; count: number }> {
  const clients = getAvailableClients();
  const result: Array<{ clientId: string; count: number }> = [];

  // Prefer _template when it exists (empty template in main data folder)
  const templatePath = path.join(
    getDataDir(TEMPLATE_CLIENT_ID),
    'websites.json'
  );
  if (fs.existsSync(templatePath)) {
    try {
      const websites = loadWebsites(templatePath);
      if (websites.length > 0) {
        result.push({ clientId: TEMPLATE_CLIENT_ID, count: websites.length });
        return result; // Use template first when available
      }
    } catch {
      // fall through to other clients
    }
  }

  for (const c of clients) {
    const wp = path.join(getDataDir(c), 'websites.json');
    if (!fs.existsSync(wp)) continue;
    try {
      const websites = loadWebsites(wp);
      if (websites.length > 0) {
        result.push({ clientId: c, count: websites.length });
      }
    } catch {
      // skip invalid files
    }
  }
  return result;
}

type LanguageConfig = {
  translation?: {
    openRouter?: { model?: string };
  };
};

function loadModel(languageConfigPath: string): string {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  const envModel = process.env.OPENROUTER_MODEL_WEBSITE_GEN;
  if (envModel) return envModel;

  try {
    const raw = fs.readFileSync(languageConfigPath, 'utf-8');
    const config = JSON.parse(raw) as LanguageConfig;
    return (
      config.translation?.openRouter?.model ?? 'google/gemini-2.5-pro-preview'
    );
  } catch {
    return 'google/gemini-2.5-pro-preview';
  }
}

function loadWebsites(websitesPath: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(websitesPath, 'utf-8');
  const data = JSON.parse(raw) as
    | Record<string, unknown>[]
    | { shared?: unknown; websites: Record<string, unknown>[] };
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && Array.isArray((data as { websites?: unknown[] }).websites))
    return (data as { websites: Record<string, unknown>[] }).websites;
  throw new Error(
    'websites.json must be an array of website objects or { shared, websites }'
  );
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

function extractJsonFromResponse(content: string): string {
  const trimmed = content.trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/m.exec(trimmed);
  if (codeBlock) return codeBlock[1].trim();
  return trimmed;
}

/**
 * Extract the first balanced JSON object from a string that may contain
 * trailing garbage after valid JSON (e.g. "Unexpected non-whitespace character
 * after JSON" errors).
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

/**
 * Multi-stage JSON repair pipeline for AI responses:
 * 1. extractFirstJsonObject (handles trailing garbage)
 * 2. jsonrepair (handles truncation, missing commas, unclosed strings, etc.)
 */
function robustJsonParse(raw: string): Record<string, unknown> {
  const extracted = extractJsonFromResponse(raw);

  try {
    return JSON.parse(extracted) as Record<string, unknown>;
  } catch {
    // Stage 1: try extracting the first balanced JSON object
    const firstObj = extractFirstJsonObject(extracted);
    try {
      return JSON.parse(firstObj) as Record<string, unknown>;
    } catch {
      // Stage 2: use jsonrepair on the extracted content
      const repaired = jsonrepair(firstObj);
      return JSON.parse(repaired) as Record<string, unknown>;
    }
  }
}

/** Extract a compact summary of key identifying properties for AI verification. */
function extractWebsiteSummary(
  w: Record<string, unknown>
): Record<string, string> {
  const biz = (w.business as Record<string, unknown>) ?? {};
  const loc = (biz.location as Record<string, unknown>) ?? {};
  const locAddr = (biz.locationAddress as Record<string, unknown>) ?? {};
  const legalAddr = (biz.legalAddress as Record<string, unknown>) ?? {};

  if (!w.deployDomain) {
    throw new Error('deployDomain is required');
  }
  return {
    id: String(w.id ?? ''),
    name: String(biz.name ?? ''),
    brandName: String(biz.brandName ?? ''),
    legalName: String(biz.legalName ?? ''),
    city: String(loc.city ?? locAddr.city ?? legalAddr.city ?? ''),
    district: String(loc.district ?? ''),
    deployDomain: String(w.deployDomain),
  };
}

/**
 * Quick AI verification: does any existing website clearly belong to the same
 * client/business as described in the prompt?
 */
async function findMatchingClientWebsite(
  apiKey: string,
  userPrompt: string,
  websites: Record<string, unknown>[],
  model: string
): Promise<{ matched: true; sourceId: string } | { matched: false }> {
  const summaries = websites.map((w, i) => {
    const s = extractWebsiteSummary(w);
    return `[${i}] id="${s.id}" name="${s.name}" brandName="${s.brandName}" legalName="${s.legalName}" city="${s.city}" district="${s.district}" domain="${s.deployDomain}"`;
  });

  const systemPrompt = getAiPromptSection('clone-classifier');

  const userContent = [
    'PROMPT (new website to generate):',
    userPrompt.slice(0, 3000),
    '',
    'EXISTING WEBSITE ENTRIES (key properties):',
    summaries.join('\n'),
  ].join('\n\n');

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 256,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clone verification API error ${res.status}: ${text}`);
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
  logOpenRouterChatResponse({
    script: '06-generate-website',
    operation: 'clone-classifier',
    model,
    usage: data.usage ?? null,
    generationId: data.id ?? null,
  });
  const content = data.choices?.[0]?.message?.content;
  if (!content) return { matched: false };

  try {
    const parsed = JSON.parse(extractJsonFromResponse(content)) as {
      match?: boolean;
      sourceId?: string;
    };
    if (parsed.match === true && typeof parsed.sourceId === 'string') {
      const valid = websites.some(
        (w) => (w as Record<string, string>).id === parsed.sourceId
      );
      return valid
        ? { matched: true, sourceId: parsed.sourceId }
        : { matched: false };
    }
  } catch {
    // ignore parse errors
  }
  return { matched: false };
}

function invokeCloneWebsite(
  clientId: string,
  sourceId: string,
  newId: string,
  promptPath: string | null,
  promptContent: string | null,
  dryRun: boolean,
  outFile: string | null
): number {
  const args = [
    'exec',
    'tsx',
    'scripts/clone-website.ts',
    `--source=${sourceId}`,
    `--id=${newId}`,
  ];
  if (promptPath) {
    args.push(`--prompt=${promptPath}`);
  } else {
    args.push('--stdin');
  }
  if (dryRun) args.push('--dry-run');
  if (outFile) args.push(`--out=${outFile}`);

  const result = spawnSync('pnpm', args, {
    cwd: process.cwd(),
    stdio: promptContent ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    env: { ...process.env, CLIENT_ID: clientId },
    input: promptContent ?? undefined,
    encoding: 'utf-8',
  });

  return result.status ?? 1;
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

function parseArgs(): {
  clientId: string | null;
  promptFile: string | null;
  useStdin: boolean;
  templateIndex: number;
  dryRun: boolean;
  verbose: boolean;
  outFile: string | null;
  skipCloneCheck: boolean;
  skipExcel: boolean;
  ueberUns: boolean;
} {
  const args = process.argv.slice(2);
  let clientId: string | null = null;
  let promptFile: string | null = null;
  let useStdin = false;
  let templateIndex = 0;
  let dryRun = false;
  let verbose = false;
  let outFile: string | null = null;
  let skipCloneCheck = false;
  let skipExcel = false;
  let ueberUns = false;

  for (const arg of args) {
    if (arg.startsWith('--client=')) {
      clientId = arg.replace('--client=', '');
    } else if (arg.startsWith('--prompt=')) {
      promptFile = arg.replace('--prompt=', '');
    } else if (arg === '--stdin') {
      useStdin = true;
    } else if (arg.startsWith('--template=')) {
      templateIndex = parseInt(arg.replace('--template=', ''), 10);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg.startsWith('--out=')) {
      outFile = arg.replace('--out=', '');
    } else if (arg === '--skip-clone-check') {
      skipCloneCheck = true;
    } else if (arg === '--skip-excel') {
      skipExcel = true;
    } else if (arg === '--ueber-uns') {
      ueberUns = true;
    }
  }

  return {
    clientId,
    promptFile,
    useStdin,
    templateIndex,
    dryRun,
    verbose: verbose || dryRun,
    outFile,
    skipCloneCheck,
    skipExcel,
    ueberUns,
  };
}

function buildImageInstructions(images: AvailableImages): string {
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════',
    'AVAILABLE IMAGES ON DISK (reference only)',
    '═══════════════════════════════════════════════════════',
    '',
    `The following ${images.all.length} image files exist under public/images/${images.siteId}/.`,
    'The generator assigns ALL file paths programmatically from this list — you MUST NOT invent or output image paths, URLs, or filenames.',
    'Write alt text, titles, and copy only. Leave any remaining image path fields empty if unsure; tooling fills them after generation.',
    '',
  ];

  for (const [category, paths] of Object.entries(images.byCategory).sort()) {
    lines.push(`  [${category}]`);
    for (const p of paths) {
      lines.push(`    ${p}`);
    }
    lines.push('');
  }

  lines.push(
    'TOOLING OWNS THESE (do not generate):',
    '  • header.logoUrl, business.contactPerson.imageUrl',
    '  • pages[0].hero.backgroundImage, pages[0].info.imageUrl',
    '  • pages[0].gallery.images[].src, pages[0].trust.logos[].src',
    '  • Block images (type "image" → src) under pages that use the "about" folder',
    '  • metadata.openGraph.images[].url, metadata.twitter.images (absolute URLs from deployDomain/clientDomain)',
    '  • metadata.schema organization logo URL where applicable',
    '',
    'YOU WRITE: hero/info/gallery alt texts, metadata titles/descriptions (not image URLs), and all non-image copy.',
    ''
  );

  return lines.join('\n');
}

/** Max parallel OpenRouter calls per wave; pause between waves to avoid rate limits. */
const CHUNK_CONCURRENCY = 5;
const CHUNK_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** Write the current website entry into websites.json (used after fill-blanks). */
function persistEntryToWebsitesFile(
  websitesPath: string,
  targetWebsites: Record<string, unknown>[],
  existingEntryIndex: number,
  working: Record<string, unknown>
): void {
  targetWebsites[existingEntryIndex] = working;
  writeWebsites(websitesPath, targetWebsites);
}

function buildProtectedPathsBlock(): string {
  return buildProtectedPathsBlockForAi(AI_PROTECTED_PATHS);
}

/** When set, the filled entry is written to websites.json after all batches complete. Omit for dry-run or --out. */
type ChunkPersistContext = {
  websitesPath: string;
  targetWebsites: Record<string, unknown>[];
  existingEntryIndex: number;
};

type FillBatchResult = Array<{ path: string; value: string }>;

async function runFillBatch(
  batchPaths: string[],
  sectionName: string,
  batchIndex: number,
  totalBatches: number,
  systemPrompt: string,
  userMessageContent: string,
  apiKey: string,
  model: string,
  verbose = false
): Promise<FillBatchResult> {
  if (verbose)
    console.log(
      `  [${batchIndex + 1}/${totalBatches}] "${sectionName}" — ${batchPaths.length} path(s)`
    );

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await openRouterCall(
        apiKey,
        model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessageContent },
        ],
        32000,
        `fill-batch:${sectionName}:${batchIndex + 1}/${totalBatches}`
      );

      const parsed = JSON.parse(extractJsonFromResponse(res.content)) as {
        fills?: FillBatchResult;
      };

      if (!parsed || !Array.isArray(parsed.fills)) {
        throw new Error('Response missing "fills" array');
      }

      if (verbose)
        console.log(
          `  [${batchIndex + 1}/${totalBatches}] "${sectionName}" done (${parsed.fills.length} fill(s), ${res.promptTokens + res.completionTokens} tokens)`
        );
      return parsed.fills;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = 5000 * (attempt + 1);
        console.warn(
          `  [${batchIndex + 1}/${totalBatches}] "${sectionName}" failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying in ${delay / 1000}s...`
        );
        await sleep(delay);
      } else {
        console.error(
          `  [${batchIndex + 1}/${totalBatches}] "${sectionName}" failed after ${MAX_RETRIES + 1} attempts:`,
          err instanceof Error ? err.message : err
        );
        return [];
      }
    }
  }
  return [];
}

async function generateChunkedFillBlanks(
  apiKey: string,
  model: string,
  entry: Record<string, unknown>,
  userPrompt: string,
  topicsContent: string | null,
  siteId: string,
  availableImages: AvailableImages | null,
  persist?: ChunkPersistContext | null,
  verbose = false
): Promise<Record<string, unknown>> {
  const working = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
  applyDiskImagePathsToEntry(working, availableImages);

  const emptyPaths = collectFillablePaths(working);
  if (emptyPaths.length === 0) {
    console.log('\n  No empty fillable fields found — nothing to generate.');
    return working;
  }

  const business = working.business;
  const businessJson = JSON.stringify(business ?? {}, null, 2);
  const topicsSection = topicsContent
    ? `\n\nTOPICS / KEYWORDS (topics.json):\n${topicsContent}`
    : '';
  const websiteBriefing =
    typeof working.websiteBriefing === 'string'
      ? working.websiteBriefing.trim()
      : '';

  console.log('websiteBriefing', working.websiteBriefing);
  const briefingSection = websiteBriefing
    ? `\n\nWEBSITE BRIEFING (Excel "Content Briefing" — AUTHORITATIVE, overrides template where conflicting):\n${websiteBriefing}`
    : '';

  const protectedPathsBlock = buildProtectedPathsBlock();

  const registryLoad = loadAiBlockRegistry();
  const batches = partitionFillablePaths(
    emptyPaths,
    working,
    registryLoad?.registry ?? null
  );
  const totalSections = batches.length;

  if (verbose && registryLoad) {
    console.log(
      `\n  Using ai-block-registry: ${registryLoad.resolvedPath} (${totalSections} batch(es))\n`
    );
  }

  console.log(
    `\n  Filling ${emptyPaths.length} empty field(s) across ${totalSections} batch(es)...\n`
  );
  if (verbose) {
    for (const b of batches) {
      console.log(`    • ${b.section} (${b.paths.length} field(s))`);
    }
    console.log('');
  }

  const allFills: FillBatchResult = [];
  const failedSections: string[] = [];

  for (let w = 0; w < batches.length; w += CHUNK_CONCURRENCY) {
    if (w > 0) {
      if (verbose)
        console.log(`  Waiting ${CHUNK_DELAY_MS / 1000}s before next wave...`);
      await sleep(CHUNK_DELAY_MS);
    }
    const window = batches.slice(w, w + CHUNK_CONCURRENCY);
    const results = await Promise.allSettled(
      window.map((batch, i) => {
        const batchIndex = w + i;
        const systemPrompt = augmentSystemPromptForBlock(
          'fill-blanks-flat',
          protectedPathsBlock,
          working,
          batch.promptSection
        );
        const context = {
          websiteId: siteId,
          business: JSON.parse(businessJson),
          ...(websiteBriefing ? { websiteBriefing } : {}),
          section: batch.section,
          emptyPaths: batch.paths,
        };
        const userContent = `Fill empty fields for the "${batch.section}" section using the business information below.${briefingSection}${topicsSection}\n\n---\n\n${userPrompt}\n\n---\n\nCONTEXT:\n${JSON.stringify(context, null, 2)}`;
        return runFillBatch(
          batch.paths,
          batch.section,
          batchIndex,
          totalSections,
          systemPrompt,
          userContent,
          apiKey,
          model,
          verbose
        );
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value.length > 0) {
        allFills.push(...result.value);
      } else if (result.status === 'rejected') {
        failedSections.push(window[i].section);
      }
    }
  }

  if (failedSections.length > 0) {
    console.warn(
      `\n  ⚠ ${failedSections.length}/${totalSections} batch(es) failed: [${failedSections.join(', ')}]`
    );
  }

  const emptyPathSet = new Set(emptyPaths);
  let appliedCount = 0;
  for (const item of allFills) {
    if (
      !item ||
      typeof item.path !== 'string' ||
      typeof item.value !== 'string'
    )
      continue;
    const p = item.path.trim();
    const v = item.value.trim();
    if (!p || !v) continue;
    if (!emptyPathSet.has(p)) continue;

    const parts = expandPath(p);
    const current = getValueAtPath(working, parts);
    if (typeof current !== 'string' || current.trim() !== '') continue;

    setValueAtPath(working, parts, v);
    appliedCount++;
  }

  console.log(
    `\n  Applied ${appliedCount} fill(s) from ${allFills.length} candidate(s) across ${totalSections} section(s).`
  );

  if (persist && appliedCount > 0) {
    persistEntryToWebsitesFile(
      persist.websitesPath,
      persist.targetWebsites,
      persist.existingEntryIndex,
      working
    );
    console.log(`  Saved ${persist.websitesPath} after fill-blanks.`);
  }

  return working;
}

/**
 * Recursively find all empty fields in a website JSON object.
 * Empty means: empty string "", empty array [], or numeric 0 (likely a placeholder).
 */
function findEmptyFields(obj: unknown, jsonPath = ''): string[] {
  const emptyPaths: string[] = [];
  if (obj === null || obj === undefined) return emptyPaths;

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      emptyPaths.push(jsonPath);
    } else {
      obj.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) {
          emptyPaths.push(...findEmptyFields(item, `${jsonPath}[${i}]`));
        }
      });
    }
    return emptyPaths;
  }

  if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (typeof val === 'string' && val === '') {
        if (key === 'faqDataFile') continue;
        emptyPaths.push(keyPath);
      } else if (Array.isArray(val) && val.length === 0) {
        emptyPaths.push(keyPath);
      } else if (typeof val === 'number' && val === 0) {
        emptyPaths.push(keyPath);
      } else if (typeof val === 'object' && val !== null) {
        emptyPaths.push(...findEmptyFields(val, keyPath));
      }
    }
  }
  return emptyPaths;
}

/**
 * Recursively collect all empty text fields as flat dot-notation paths,
 * filtering out protected/non-fillable paths.
 */
function collectFillablePaths(obj: unknown, jsonPath = ''): string[] {
  const out: string[] = [];
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      if (typeof item === 'object' && item !== null) {
        out.push(...collectFillablePaths(item, `${jsonPath}[${i}]`));
      }
    });
    return out;
  }
  if (typeof obj !== 'object') return out;

  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
    if (typeof val === 'string' && val === '' && isAiFillablePath(keyPath)) {
      out.push(keyPath);
    } else if (typeof val === 'object' && val !== null) {
      out.push(...collectFillablePaths(val, keyPath));
    }
  }
  return out;
}

/**
 * Populate empty `metadata.openGraph.url` on every page with the site's base
 * URL (`https://{deployDomain}`). All pages share the same fixed OG URL.
 */
function applyOpenGraphUrls(generated: Record<string, unknown>): void {
  const deployDomain = generated.deployDomain as string | undefined;
  if (!deployDomain) return;

  const siteUrl = `https://${deployDomain}`;
  const pages = generated.pages;
  if (!Array.isArray(pages)) return;

  for (const page of pages) {
    const p = page as Record<string, unknown>;
    const metadata = p.metadata as Record<string, unknown> | undefined;
    if (!metadata) continue;
    const og = metadata.openGraph as Record<string, unknown> | undefined;
    if (!og || (og.url as string)) continue; // skip if already set
    og.url = siteUrl;
  }
}

/**
 * Populate empty schema fields (telephone, email, url, postalCode, sameAs)
 * from the business object. These are factual fields that the AI is blocked
 * from filling (protected paths) but whose values already exist in `business.*`.
 */
function applyBusinessDataToSchema(generated: Record<string, unknown>): void {
  const business = generated.business as Record<string, unknown> | undefined;
  if (!business) return;

  const phone = (business.phone as string) ?? '';
  const email = (business.email as string) ?? '';
  const deployDomain = (generated.deployDomain as string) ?? '';
  const siteUrl = deployDomain ? `https://${deployDomain}` : '';
  const legalAddress = business.legalAddress as
    | Record<string, unknown>
    | undefined;
  const locationAddress = business.locationAddress as
    | Record<string, unknown>
    | undefined;
  // LocalBusiness-style schemas use locationAddress. Organization/legal: fill gaps from legalAddress.
  const locationStreet = String(locationAddress?.street ?? '').trim();
  const locationPostal = String(locationAddress?.postalCode ?? '').trim();
  const locationCity = String(locationAddress?.city ?? '').trim();
  const hasLocationAddress =
    locationStreet.length > 0 &&
    locationPostal.length > 0 &&
    locationCity.length > 0;
  const postalCode =
    String(locationAddress?.postalCode ?? '') ||
    String(legalAddress?.postalCode ?? '');
  const social = business.social as Record<string, unknown> | undefined;
  const sameAs = [social?.instagram, social?.facebook].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  );

  const pages = generated.pages;
  if (!Array.isArray(pages) || pages.length === 0) return;

  const home = pages[0] as Record<string, unknown>;
  const metadata = home.metadata as Record<string, unknown> | undefined;
  const schemas = metadata?.schema;
  if (!Array.isArray(schemas)) return;

  for (const schema of schemas as Record<string, unknown>[]) {
    const data = schema.data as Record<string, unknown> | undefined;
    if (!data) continue;

    if (phone && !(data.telephone as string)) data.telephone = phone;
    if (email && !(data.email as string)) data.email = email;
    if (siteUrl && !(data.url as string)) data.url = siteUrl;

    if (
      sameAs.length > 0 &&
      Array.isArray(data.sameAs) &&
      data.sameAs.length === 0
    ) {
      data.sameAs = sameAs;
    }

    // legalName — keep schema in sync with business data
    const legalName = (business.legalName as string) ?? '';
    if (legalName && !(data.legalName as string)) {
      data.legalName = legalName;
    }

    // openingHoursSpecification — auto-generate from business.openingHours
    const oh = business.openingHours as Record<string, unknown> | undefined;
    if (oh && !data.openingHoursSpecification) {
      const detailed = (oh.detailed as string) ?? (oh.display as string) ?? '';
      // Try to parse "HH:MM – HH:MM" pattern from detailed/display text
      const timeMatch = detailed.match(
        /(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/
      );
      if (timeMatch) {
        data.openingHoursSpecification = {
          '@type': 'OpeningHoursSpecification',
          dayOfWeek: [
            'Monday',
            'Tuesday',
            'Wednesday',
            'Thursday',
            'Friday',
            'Saturday',
            'Sunday',
          ],
          opens: timeMatch[1],
          closes: timeMatch[2],
        };
      }
    }

    // postalCode — handle both array and flat address in schema
    if (postalCode) {
      const schemaAddr = data.address;
      if (Array.isArray(schemaAddr)) {
        for (const a of schemaAddr as Record<string, unknown>[]) {
          if (!(a.postalCode as string)) a.postalCode = postalCode;
        }
      } else if (schemaAddr && typeof schemaAddr === 'object') {
        const a = schemaAddr as Record<string, unknown>;
        if (!(a.postalCode as string)) a.postalCode = postalCode;
      }
    }

    // Match LocalBusiness/Restaurant/Hotel/… and overwrite their address with locationAddress when set.
    const schemaTypeRaw =
      typeof schema.schemaType === 'string' ? schema.schemaType : '';
    const innerType =
      typeof data['@type'] === 'string' ? (data['@type'] as string) : '';
    const typeLower = `${schemaTypeRaw} ${innerType}`.toLowerCase();
    const isPlaceSchema =
      /localbusiness|icecreamshop|restaurant|hotel|lodgingbusiness|foodestablishment|healthandbeauty|sportsactivity|store|touristattraction/.test(
        typeLower
      );
    if (isPlaceSchema && hasLocationAddress) {
      const applyLoc = (target: Record<string, unknown>) => {
        target.streetAddress = locationStreet;
        target.postalCode = locationPostal;
        target.addressLocality = locationCity;
      };
      const schemaAddr = data.address;
      if (Array.isArray(schemaAddr) && schemaAddr.length > 0) {
        applyLoc(schemaAddr[0] as Record<string, unknown>);
      } else if (schemaAddr && typeof schemaAddr === 'object') {
        applyLoc(schemaAddr as Record<string, unknown>);
      }
    }
  }
}

/**
 * Copy `faqDataFile` paths from the template / existing entry onto generated
 * output. These filenames are tooling-managed, not AI-generated.
 */
function applyTemplateFaqDataFiles(
  generated: Record<string, unknown>,
  template: Record<string, unknown>
): void {
  const genPages = generated.pages;
  const tmplPages = template.pages;
  if (!Array.isArray(genPages) || !Array.isArray(tmplPages)) return;

  const n = Math.min(genPages.length, tmplPages.length);
  for (let i = 0; i < n; i++) {
    const gp = genPages[i] as Record<string, unknown>;
    const tp = tmplPages[i] as Record<string, unknown>;
    const genFaqFile = gp.faqDataFile;
    const hasGenFaqFile =
      typeof genFaqFile === 'string' && genFaqFile.trim().length > 0;
    if (!hasGenFaqFile && typeof tp.faqDataFile === 'string') {
      gp.faqDataFile = tp.faqDataFile;
    }
    const tf = tp.faq;
    const gf = gp.faq;
    if (
      tf &&
      typeof tf === 'object' &&
      typeof (tf as Record<string, unknown>).faqDataFile === 'string' &&
      gf &&
      typeof gf === 'object'
    ) {
      const genNestedFaqFile = (gf as Record<string, unknown>).faqDataFile;
      const hasGenNestedFaqFile =
        typeof genNestedFaqFile === 'string' &&
        genNestedFaqFile.trim().length > 0;
      if (!hasGenNestedFaqFile) {
        (gf as Record<string, unknown>).faqDataFile = (
          tf as Record<string, unknown>
        ).faqDataFile;
      }
    }
  }
}

/**
 * Re-apply `reviews` from the template (title, subtitle, reviewData shape) after
 * `stripProtectedPaths` removes `pages[*].reviews.reviewData` only — without this,
 * template `reviews.title` / `reviews.subtitle` could be missing when the AI omits them.
 * Generated keys overlay the template; `reviewData` is re-based on the template with
 * optional `formattedAddress` from the model output.
 */
function applyTemplateReviewsFromTemplate(
  generated: Record<string, unknown>,
  template: Record<string, unknown>
): void {
  const genPages = generated.pages;
  const tmplPages = template.pages;
  if (!Array.isArray(genPages) || !Array.isArray(tmplPages)) return;

  const n = Math.min(genPages.length, tmplPages.length);
  for (let i = 0; i < n; i++) {
    const tr = (tmplPages[i] as Record<string, unknown>).reviews;
    if (!tr || typeof tr !== 'object') continue;

    const gPage = genPages[i] as Record<string, unknown>;
    const gr = gPage.reviews as Record<string, unknown> | undefined;
    gPage.reviews = {
      ...(JSON.parse(JSON.stringify(tr)) as Record<string, unknown>),
      ...(gr || {}),
    };
    const merged = gPage.reviews as Record<string, unknown>;
    if ((tr as Record<string, unknown>).reviewData) {
      const srcRd = (tr as Record<string, unknown>).reviewData as Record<
        string,
        unknown
      >;
      const aiRd = gr?.reviewData as Record<string, unknown> | undefined;
      merged.reviewData = JSON.parse(
        JSON.stringify(srcRd)
      ) as Record<string, unknown>;
      if (
        aiRd &&
        typeof aiRd.formattedAddress === 'string' &&
        aiRd.formattedAddress.trim()
      ) {
        (merged.reviewData as Record<string, unknown>).formattedAddress =
          aiRd.formattedAddress;
      }
    }
  }
}

function normalizeGeneratedTextFields(
  generated: Record<string, unknown>
): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const value = node[i];
        if (typeof value === 'string') {
          node[i] = value
            .replace(/\[@id\]/g, '@id')
            .replace(/\[@type\]/g, '@type')
            .replace(/\bUeber\b/g, 'Über');
        } else if (value && typeof value === 'object') {
          walk(value);
        }
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>
    )) {
      if (typeof value === 'string') {
        (node as Record<string, unknown>)[key] = value
          .replace(/\[@id\]/g, '@id')
          .replace(/\[@type\]/g, '@type')
          .replace(/\bUeber\b/g, 'Über');
      } else if (value && typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(generated);
}

function normalizeSchemaAtKeys(node: unknown): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item) => normalizeSchemaAtKeys(item));
    return;
  }
  if (typeof node !== 'object') return;

  const rec = node as Record<string, unknown>;
  for (const bracketKey of ['[@id]', '[@type]'] as const) {
    const cleanKey = bracketKey.slice(1, -1); // '@id' or '@type'
    if (Object.prototype.hasOwnProperty.call(rec, bracketKey)) {
      if (!Object.prototype.hasOwnProperty.call(rec, cleanKey)) {
        rec[cleanKey] = rec[bracketKey];
      }
      delete rec[bracketKey];
    }
  }

  for (const value of Object.values(rec)) {
    normalizeSchemaAtKeys(value);
  }
}

function normalizeKnownGermanLabels(generated: Record<string, unknown>): void {
  const header = generated.header as Record<string, unknown> | undefined;
  const links = header?.links;
  if (!Array.isArray(links)) return;
  for (const link of links) {
    if (!link || typeof link !== 'object') continue;
    const rec = link as Record<string, unknown>;
    if (
      typeof rec.label === 'string' &&
      rec.label.trim().toLowerCase() === 'ueber uns'
    ) {
      rec.label = 'Über uns';
    }
  }
}

/** Strip redundant "Telefon:" / "E-Mail:" style prefixes from footer.contact.links[].linkLabel. */
function normalizeFooterContactLinkLabels(
  generated: Record<string, unknown>
): void {
  const footer = generated.footer as Record<string, unknown> | undefined;
  const contact = footer?.contact as
    | { links?: Array<Record<string, unknown>> }
    | undefined;
  const contactLinks = contact?.links;
  if (!Array.isArray(contactLinks)) return;
  for (const item of contactLinks) {
    if (!item || typeof item !== 'object') continue;
    const link = typeof item.link === 'string' ? item.link : '';
    const linkLabel = typeof item.linkLabel === 'string' ? item.linkLabel : '';
    if (!link || !linkLabel) continue;
    item.linkLabel = footerContactLinkDisplayLabel(link, linkLabel);
  }
}

/**
 * Convert plain-text phone/email in legal page blocks (impressum, datenschutz)
 * to clickable link parts (tel:, mailto:).
 */
function normalizeLegalBlockContactLinks(
  generated: Record<string, unknown>
): void {
  const pages = generated.pages;
  if (!Array.isArray(pages)) return;

  const legalPageNames = ['impressum', 'datenschutz'];
  for (const page of pages) {
    const p = page as Record<string, unknown>;
    if (!legalPageNames.includes(p.name as string)) continue;
    const blocks = p.blocks;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type !== 'paragraph') continue;
      const parts = b.parts;
      if (!Array.isArray(parts)) continue;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] as Record<string, unknown>;
        if (part.type !== 'text' || typeof part.value !== 'string') continue;
        const val = part.value as string;

        // "Telefon: <number>" → text "Telefon: " + link tel:<number>
        const phoneMatch = val.match(/^Telefon:\s*(.+)$/);
        if (phoneMatch) {
          const num = phoneMatch[1].trim();
          const telNum = num.replace(/[\s.\-/()]/g, '');
          parts.splice(
            i,
            1,
            { type: 'text', value: 'Telefon: ' },
            { type: 'link', href: `tel:${telNum}`, value: num }
          );
          i++; // skip the newly inserted link part
          continue;
        }

        // "E-Mail: <addr>" → text "E-Mail: " + link mailto:<addr>
        const emailMatch = val.match(/^E-Mail:\s*(.+)$/);
        if (emailMatch) {
          const addr = emailMatch[1].trim();
          parts.splice(
            i,
            1,
            { type: 'text', value: 'E-Mail: ' },
            { type: 'link', href: `mailto:${addr}`, value: addr }
          );
          i++;
          continue;
        }
      }
    }
  }
}

function normalizeGeneratedWebsiteData(
  generated: Record<string, unknown>
): void {
  normalizeSchemaAtKeys(generated);
  normalizeKnownGermanLabels(generated);
  normalizeLegalBlockContactLinks(generated);
  normalizeFooterContactLinkLabels(generated);
}

/** Empty link-slot targets (footer nav, header CTA, business.bookingUrl) to be filled from the scraped candidate list — blocked from normal AI fill to prevent URL hallucination. */
interface LinkSlot {
  jsonPath: string;
  currentLabel: string;
  parent: Record<string, unknown>;
  urlKey: string;
  labelKey: string;
}

function collectExternalLinkSlots(
  generated: Record<string, unknown>
): LinkSlot[] {
  const slots: LinkSlot[] = [];

  // 1. Footer navigation — { link, linkLabel }
  const footer = generated.footer as Record<string, unknown> | undefined;
  const footerNav = footer?.navigation as
    | { links?: Array<Record<string, unknown>> }
    | undefined;
  const footerNavLinks = footerNav?.links;
  if (Array.isArray(footerNavLinks)) {
    for (let i = 0; i < footerNavLinks.length; i++) {
      const item = footerNavLinks[i];
      if (!item || typeof item !== 'object') continue;
      const link = typeof item.link === 'string' ? item.link.trim() : '';
      const label =
        typeof item.linkLabel === 'string' ? item.linkLabel.trim() : '';
      // Only fill empty, labelled slots; leave existing URLs untouched.
      if (!link && label) {
        slots.push({
          jsonPath: `footer.navigation.links[${i}].link`,
          currentLabel: label,
          parent: item,
          urlKey: 'link',
          labelKey: 'linkLabel',
        });
      }
    }
  }

  // 2. Header CTA buttons — { label, href, type: "button" }
  const header = generated.header as Record<string, unknown> | undefined;
  const headerLinks = header?.links as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(headerLinks)) {
    for (let i = 0; i < headerLinks.length; i++) {
      const item = headerLinks[i];
      if (!item || typeof item !== 'object') continue;
      const type = typeof item.type === 'string' ? item.type : '';
      if (type !== 'button') continue;
      const href = typeof item.href === 'string' ? item.href.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      if (!href && label) {
        slots.push({
          jsonPath: `header.links[${i}].href`,
          currentLabel: label,
          parent: item,
          urlKey: 'href',
          labelKey: 'label',
        });
      }
    }
  }

  // 3. business.bookingUrl — per-website; without this the "Jetzt buchen" button falls back to mailto.
  const business = generated.business as Record<string, unknown> | undefined;
  if (business && typeof business === 'object') {
    const bookingUrl =
      typeof business.bookingUrl === 'string' ? business.bookingUrl.trim() : '';
    // Only fill when empty OR mailto:/tel: — leave any existing http(s) URL untouched.
    const isExistingRealUrl = /^https?:\/\//i.test(bookingUrl);
    if (!isExistingRealUrl) {
      slots.push({
        jsonPath: 'business.bookingUrl',
        currentLabel: 'booking / buchen / reservieren',
        parent: business,
        urlKey: 'bookingUrl',
        labelKey: '__no_label__', // bookingUrl has no companion label field.
      });
    }
  }

  return slots;
}

/** Fill empty footer/header-CTA/bookingUrl slots from clientDomainLinks; AI must pick verbatim, hallucinated URLs dropped. */
async function applyExternalFooterNavAndHeaderCtaLinks(
  apiKey: string,
  model: string,
  generated: Record<string, unknown>,
  clientId: string,
  siteId: string | null
): Promise<void> {
  if (!siteId) return;

  const inputPath = path.join(
    process.cwd(),
    'src',
    'data',
    clientId,
    siteId,
    'client-prompt-ai-input.json'
  );
  if (!fs.existsSync(inputPath)) {
    console.log(
      `    No client-prompt-ai-input.json at ${path.relative(process.cwd(), inputPath)} — skipping link assignment.`
    );
    return;
  }

  let candidates: Array<{ url: string; label: string }> = [];
  try {
    const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as {
      clientDomainLinks?: Array<{ url?: string; label?: string }>;
    };
    candidates = (raw.clientDomainLinks ?? [])
      .filter(
        (x): x is { url: string; label: string } =>
          !!x && typeof x.url === 'string' && typeof x.label === 'string'
      )
      .map((x) => ({ url: x.url.trim(), label: x.label.trim() }))
      .filter((x) => x.url.length > 0);
  } catch (err) {
    console.log(
      `    Failed to parse ${path.relative(process.cwd(), inputPath)}: ${(err as Error).message}`
    );
    return;
  }
  if (candidates.length === 0) {
    console.log(
      '    clientDomainLinks is empty — skipping (re-run `05-extract-client-data --client-prompt` to populate).'
    );
    return;
  }

  const slots = collectExternalLinkSlots(generated);
  if (slots.length === 0) {
    console.log('    No empty link slots — nothing to assign.');
    return;
  }

  console.log(
    `    ${slots.length} empty slot(s), ${candidates.length} candidate URL(s)`
  );

  const allowedUrls = new Set(candidates.map((c) => c.url));
  const candidateList = candidates
    .slice(0, 60) // cap prompt size; homepages rarely surface more than ~60 nav links
    .map((c, i) => `${i + 1}. ${c.url}  — label: "${c.label}"`)
    .join('\n');

  const slotsList = slots
    .map((s) => `- "${s.jsonPath}" (current label: "${s.currentLabel}")`)
    .join('\n');

  const systemPrompt = `You assign navigation URLs by matching each slot's German label to the single most relevant URL from a fixed candidate list. Hard rules:
- The URL you return for each slot MUST be exactly one URL string from the CANDIDATES list, verbatim. No rewriting, no trailing slashes added, no URL not in the list.
- Return a JSON object keyed by the exact slot path given (e.g. "footer.navigation.links[0].link", "business.bookingUrl"). Do NOT include any other keys.
- If no candidate is a good fit for a slot, OMIT that slot's key entirely (do not invent a URL).
- "business.bookingUrl" must point to the page where a guest can book / reserve / inquire about the offer (e.g. a page whose URL or label contains "buchen", "reservieren", "booking", "anfrage", "apartments"). If no such candidate exists, omit the key — do NOT fall back to homepage or contact.
- You may also return an updated "label" for footer / header slots if the label should be tightened (max 20 German characters); to do so, use the key ending in ".linkLabel" or ".label" matching the slot's JSON path. Returning a label is optional. business.bookingUrl has no label twin — do not emit a label key for it.
- Never include tracking parameters, hashes, or query strings not present in the candidate URL.`;

  const userPrompt = `CANDIDATES (choose links ONLY from these URLs):
${candidateList}

SLOTS to assign:
${slotsList}

Return a single JSON object. Example shape:
{
  "footer.navigation.links[0].link": "https://example.com/apartments",
  "header.links[2].href": "https://example.com/coworking"
}`;

  let response: OpenRouterResult;
  try {
    response = await openRouterCall(
      apiKey,
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      1500,
      'footer-url-slots'
    );
  } catch (err) {
    console.log(
      `    AI call failed: ${(err as Error).message} — slots remain empty.`
    );
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response.content) as Record<string, unknown>;
  } catch {
    // Response_format json_object should guarantee parseable JSON, but be defensive.
    console.log('    AI returned unparseable JSON — slots remain empty.');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return;
  }

  let assigned = 0;
  let rejected = 0;
  for (const slot of slots) {
    const picked = parsed[slot.jsonPath];
    if (typeof picked !== 'string') continue;
    const trimmed = picked.trim();
    if (!allowedUrls.has(trimmed)) {
      rejected++;
      console.log(
        `    ✗ rejected for ${slot.jsonPath}: "${trimmed}" not in candidate list`
      );
      continue;
    }
    slot.parent[slot.urlKey] = trimmed;
    assigned++;

    // Optional label tightening.
    const labelPath = slot.jsonPath.replace(
      new RegExp(`\\.${slot.urlKey}$`),
      `.${slot.labelKey}`
    );
    const tightened = parsed[labelPath];
    if (typeof tightened === 'string' && tightened.trim().length > 0) {
      const t = tightened.trim().slice(0, 40);
      slot.parent[slot.labelKey] = t;
    }
  }

  console.log(
    `    assigned ${assigned}/${slots.length} slot(s)${
      rejected > 0 ? ` — rejected ${rejected} hallucinated URL(s)` : ''
    }.`
  );
}

/**
 * Deep merge: preserves all non-empty values from `existing`,
 * only fills in values from `generated` where existing is empty ("", [], 0).
 */
function deepMergePreserveExisting(
  existing: unknown,
  generated: unknown
): unknown {
  if (generated === null || generated === undefined) return existing;
  if (existing === null || existing === undefined) return generated;

  if (typeof existing === 'string') {
    return existing === '' && typeof generated === 'string'
      ? generated
      : existing;
  }

  if (typeof existing === 'number') {
    return existing === 0 && typeof generated === 'number'
      ? generated
      : existing;
  }

  if (typeof existing === 'boolean') return existing;

  if (Array.isArray(existing)) {
    if (
      existing.length === 0 &&
      Array.isArray(generated) &&
      generated.length > 0
    ) {
      return generated;
    }
    if (
      Array.isArray(generated) &&
      existing.length > 0 &&
      generated.length > 0
    ) {
      return existing.map((item, i) => {
        if (i < generated.length && typeof item === 'object' && item !== null) {
          return deepMergePreserveExisting(item, generated[i]);
        }
        return item;
      });
    }
    return existing;
  }

  if (
    typeof existing === 'object' &&
    typeof generated === 'object' &&
    !Array.isArray(generated)
  ) {
    const result = { ...(existing as Record<string, unknown>) };
    const gen = generated as Record<string, unknown>;
    for (const key of Object.keys(result)) {
      if (key in gen) {
        result[key] = deepMergePreserveExisting(result[key], gen[key]);
      }
    }
    return result;
  }

  return existing;
}

/** Best-effort correction: replace AI-generated image paths with the closest available file. */
function correctImagePaths(
  obj: unknown,
  available: AvailableImages,
  jsonPath = ''
): {
  corrections: Array<{ jsonPath: string; from: string; to: string }>;
  missing: Array<{ jsonPath: string; value: string }>;
} {
  const corrections: Array<{ jsonPath: string; from: string; to: string }> = [];
  const missing: Array<{ jsonPath: string; value: string }> = [];

  if (obj === null || obj === undefined) return { corrections, missing };

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      if (typeof item === 'string' && isImagePath(item)) {
        const match = findBestImageMatch(item, available);
        if (match && match !== item) {
          obj[i] = match;
          corrections.push({
            jsonPath: `${jsonPath}[${i}]`,
            from: item,
            to: match,
          });
        } else if (!match) {
          missing.push({ jsonPath: `${jsonPath}[${i}]`, value: item });
        }
      } else if (typeof item === 'object' && item !== null) {
        const sub = correctImagePaths(item, available, `${jsonPath}[${i}]`);
        corrections.push(...sub.corrections);
        missing.push(...sub.missing);
      }
    });
    return { corrections, missing };
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    for (const [key, val] of Object.entries(record)) {
      const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (typeof val === 'string' && isImagePath(val)) {
        const match = findBestImageMatch(val, available);
        if (match && match !== val) {
          record[key] = match;
          corrections.push({ jsonPath: keyPath, from: val, to: match });
        } else if (!match) {
          missing.push({ jsonPath: keyPath, value: val });
        }
      } else if (typeof val === 'object' && val !== null) {
        const sub = correctImagePaths(val, available, keyPath);
        corrections.push(...sub.corrections);
        missing.push(...sub.missing);
      }
    }
  }
  return { corrections, missing };
}

function findBestImageMatch(
  generated: string,
  available: AvailableImages
): string | null {
  // Preserve absolute deploy-style URLs when they already map to an on-disk /images/... path.
  // Example: https://www.site.tld/images/foo.webp should stay absolute if /images/foo.webp exists.
  if (/^https?:\/\//i.test(generated)) {
    try {
      const u = new URL(generated);
      const pathname = u.pathname || '';
      if (pathname.startsWith('/images/') && available.all.includes(pathname)) {
        return generated;
      }
    } catch {
      // Ignore URL parse errors; treat as a plain string.
    }
  }

  if (available.all.includes(generated)) return generated;

  const genBase = path.basename(generated).toLowerCase();
  const genDir = path.basename(path.dirname(generated)).toLowerCase();

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const candidate of available.all) {
    const candBase = path.basename(candidate).toLowerCase();
    const candDir = path.basename(path.dirname(candidate)).toLowerCase();

    if (genBase === candBase) return candidate;

    let score = 0;

    const dirAliases: Record<string, string[]> = {
      gallerie: ['gallery', 'gallerie', 'galerie'],
      hero: ['hero', 'header'],
      info: ['info', 'info-section'],
      team: ['team'],
      about: ['about', 'ueber-uns', 'ueber uns'],
      trustblock: ['trustblock', 'partnerlogos', 'partner-logos', 'trust'],
    };
    for (const [canonical, aliases] of Object.entries(dirAliases)) {
      if (aliases.includes(genDir) && aliases.includes(candDir)) {
        score += 5;
        break;
      }
      if (genDir === canonical && aliases.includes(candDir)) {
        score += 5;
        break;
      }
    }

    if (genDir === candDir) score += 5;

    const genNum = genBase.match(/(\d+)/)?.[1];
    const candNum = candBase.match(/(\d+)/)?.[1];
    if (genNum && candNum && genNum === candNum) score += 3;

    const genExt = path.extname(genBase);
    const candExt = path.extname(candBase);
    if (genExt === candExt) score += 1;

    const genStem = genBase.replace(/\.[^.]+$/, '');
    const candStem = candBase.replace(/\.[^.]+$/, '');
    if (candStem.includes(genStem) || genStem.includes(candStem)) score += 2;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestScore >= 5 ? bestMatch : null;
}

function buildSystemPrompt(
  templateJson: string,
  siteId: string | null,
  availableImages?: AvailableImages | null
): string {
  const idInstruction = siteId
    ? `  • "id" — MUST be exactly "${siteId}". This is the site identifier used for folder names and image paths. Use "${siteId}" wherever {site-id} appears in image path patterns below.`
    : '  • "id" — unique kebab-case identifier (e.g. "business-name-city")';

  const imagePathRule = availableImages
    ? '- Image paths: do NOT generate — the AVAILABLE IMAGES list is reference only; post-processing assigns every path from disk'
    : '- Image paths: do NOT generate — tooling assigns paths from public/images/{site-id} after generation';

  return buildAiPrompt('full-generation-system', {
    ID_INSTRUCTION: idInstruction,
    IMAGE_PATH_RULE: imagePathRule,
    PROTECTED_PATHS_BLOCK: buildProtectedPathsBlock(),
    TEMPLATE_JSON: templateJson,
    AVAILABLE_IMAGES_BLOCK: availableImages
      ? buildImageInstructions(availableImages)
      : '',
  });
}

/** Max continuation attempts when the model truncates its response. */
const MAX_CONTINUATIONS = 2;

type OpenRouterResult = {
  content: string;
  finishReason: string | undefined;
  promptTokens: number;
  completionTokens: number;
};

async function openRouterCall(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  operation = 'openRouter'
): Promise<OpenRouterResult> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    id?: string;
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
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
    script: '06-generate-website',
    operation,
    model,
    usage: data.usage ?? null,
    generationId: data.id ?? null,
  });

  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content)
    throw new Error('OpenRouter response missing choices[0].message.content');

  return {
    content,
    finishReason: choice?.finish_reason,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

/**
 * Core AI call: generate rich ueber-uns blocks for a site entry already in memory.
 * Returns the new blocks array, or null on failure (logs error but does not exit).
 *
 * @param siteEntry - the in-memory website entry object (business + pages must be present)
 * @param userPrompt - prompt.md content (already loaded)
 * @param topicsRaw  - topics.json content (already loaded)
 */
type UeberUnsBlocksAiResult = { h1?: string; blocks: unknown[] };

async function callUeberUnsBlocksAi(
  apiKey: string,
  model: string,
  siteEntry: Record<string, unknown>,
  userPrompt: string,
  topicsRaw: string,
  availableImages: AvailableImages | null
): Promise<UeberUnsBlocksAiResult | null> {
  const pages = siteEntry.pages as Array<Record<string, unknown>> | undefined;
  const ueberUnsPage = (pages ?? []).find(
    (p) => typeof p.name === 'string' && p.name === 'ueber-uns'
  );
  if (!ueberUnsPage) {
    console.warn(
      '    No "ueber-uns" page found in entry — skipping block generation.'
    );
    return null;
  }

  const aboutImages = availableImages?.byCategory?.['about'] ?? [];
  const imageHint =
    aboutImages.length > 0
      ? `\n\nVerfügbare About-Bilder auf der Festplatte (nur zur Info — src NICHT setzen):\n${aboutImages.map((p) => `  ${p}`).join('\n')}`
      : '';

  const systemPrompt = getAiPromptSection('ueber-uns-blocks');
  const businessJson = JSON.stringify(siteEntry.business ?? {}, null, 2);
  const existingBlocksJson = JSON.stringify(ueberUnsPage.blocks ?? [], null, 2);
  const websiteBriefing =
    typeof siteEntry.websiteBriefing === 'string'
      ? siteEntry.websiteBriefing.trim()
      : '';
  const briefingSection = websiteBriefing
    ? `WEBSITE BRIEFING (Excel "Content Briefing" — HÖCHSTE PRIORITÄT, überschreibt Template / Business-Daten bei Konflikt):\n${websiteBriefing}\n\n`
    : '';

  const userContent = (
    briefingSection +
    [
      `BRAND PROMPT (prompt.md):\n${userPrompt}`,
      ``,
      `TOPICS & KEYWORDS (topics.json):\n${topicsRaw}`,
      ``,
      `BUSINESS DATA:\n${businessJson}`,
      imageHint,
      ``,
      `BESTEHENDE BLÖCKE (zur Orientierung — werden vollständig ersetzt):\n${existingBlocksJson}`,
      ``,
      `Erstelle jetzt ein "h1"-Feld (kurze Hero-Überschrift für die Seite) UND einen vollständigen, reichhaltigen "blocks"-Array für die Über-uns-Seite, wie im System-Prompt beschrieben.`,
    ].join('\n')
  ).trim();

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await openRouterCall(
        apiKey,
        model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        16000,
        'ueber-uns-blocks'
      );

      console.log(
        `    Tokens: ${result.promptTokens} prompt + ${result.completionTokens} completion`
      );

      const parsed = JSON.parse(extractJsonFromResponse(result.content)) as {
        h1?: string;
        blocks?: unknown[];
      };

      if (
        !parsed ||
        !Array.isArray(parsed.blocks) ||
        parsed.blocks.length === 0
      ) {
        throw new Error(
          'AI response missing "blocks" array or returned empty array'
        );
      }

      if (typeof parsed.h1 === 'string' && parsed.h1.trim()) {
        console.log(`    ✓ Generated h1: ${parsed.h1.trim().slice(0, 80)}${parsed.h1.length > 80 ? '…' : ''}`);
      } else {
        console.warn(
          '    ⚠ Response missing non-empty "h1" — leave empty in JSON or re-run; hero falls back to pageTitle.'
        );
      }

      console.log(`    ✓ Generated ${parsed.blocks.length} block(s).`);
      return { h1: parsed.h1, blocks: parsed.blocks };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = 5000 * (attempt + 1);
        console.warn(
          `    Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed — retrying in ${delay / 1000}s...`,
          err instanceof Error ? err.message : err
        );
        await sleep(delay);
      } else {
        console.error(
          `    Failed after ${MAX_RETRIES + 1} attempts:`,
          err instanceof Error ? err.message : err
        );
        return null;
      }
    }
  }
  return null;
}

/**
 * Apply newly generated ueber-uns blocks onto an in-memory entry:
 * sets h1 (if provided), blocks, then re-assigns about image paths from disk.
 */
function applyUeberUnsBlocks(
  entry: Record<string, unknown>,
  result: UeberUnsBlocksAiResult,
  availableImages: AvailableImages | null
): void {
  const { h1, blocks } = result;
  const pages = entry.pages as Array<Record<string, unknown>> | undefined;
  const ueberUnsPage = (pages ?? []).find((p) => p.name === 'ueber-uns');
  if (!ueberUnsPage) return;
  if (typeof h1 === 'string' && h1.trim() !== '') {
    ueberUnsPage.h1 = h1.trim();
  }
  ueberUnsPage.blocks = blocks;
  const aboutImages = availableImages?.byCategory?.['about'] ?? [];
  if (aboutImages.length > 0) {
    let ai = 0;
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block.type === 'image' && block.src === '') {
        block.src = aboutImages[ai % aboutImages.length];
        ai++;
      }
    }
    if (ai > 0) {
      console.log(`    ✓ Assigned ${ai} about image path(s) from disk.`);
    }
  }
}

type HeroH1TopicsContext = {
  topics?: Record<string, string[]>;
  keywords?: string[];
  h1Suggestions?: string[];
  subtitleSuggestions?: string[];
  mustCover?: string[];
  avoidAngles?: string[];
};

function toHeroH1StringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

/**
 * Parse a topics.json string into the same shape used by the dedicated hero-h1 prompt.
 * Returns null if the JSON is invalid or contains no relevant data.
 */
function parseTopicsForHeroH1(
  topicsRaw: string | null
): HeroH1TopicsContext | null {
  if (!topicsRaw) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(topicsRaw);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const ctx: HeroH1TopicsContext = {
    keywords: toHeroH1StringList(r.keywords),
    h1Suggestions: toHeroH1StringList(r.h1Suggestions),
    subtitleSuggestions: toHeroH1StringList(r.subtitleSuggestions),
    mustCover: toHeroH1StringList(r.mustCover),
    avoidAngles: toHeroH1StringList(r.avoidAngles),
  };

  const topics = r.topics;
  if (topics && typeof topics === 'object' && !Array.isArray(topics)) {
    const normalized: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(
      topics as Record<string, unknown>
    )) {
      const list = toHeroH1StringList(value);
      if (list.length > 0) normalized[key] = list;
    }
    if (Object.keys(normalized).length > 0) ctx.topics = normalized;
  }

  const hasData =
    (ctx.topics && Object.keys(ctx.topics).length > 0) ||
    (ctx.keywords?.length ?? 0) > 0 ||
    (ctx.h1Suggestions?.length ?? 0) > 0 ||
    (ctx.subtitleSuggestions?.length ?? 0) > 0 ||
    (ctx.mustCover?.length ?? 0) > 0 ||
    (ctx.avoidAngles?.length ?? 0) > 0;
  return hasData ? ctx : null;
}

function pickBusinessContextForHeroH1(
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
 * Dedicated AI step: generate ONE perfect SEO-optimized hero H1 for the new website.
 * Mirrors the equivalent step in scripts/clone-website.ts and reuses the same
 * prompt section (`clone-hero-h1`). Uses prompt.md (`userPrompt`) and topics.json
 * (`topicsRaw`) as primary input, with the business + any websiteBriefing as context.
 *
 * Returns the generated H1 (cleaned) or null on failure.
 */
async function callHeroH1Ai(
  apiKey: string,
  model: string,
  siteEntry: Record<string, unknown>,
  userPrompt: string,
  topicsRaw: string,
  siteId: string | null
): Promise<string | null> {
  const pages = siteEntry.pages as Array<Record<string, unknown>> | undefined;
  const homePage = (pages ?? []).find(
    (p) => typeof p?.name === 'string' && p.name === 'home'
  );
  const homeHero =
    (homePage?.hero as Record<string, unknown> | undefined) ?? undefined;
  if (!homeHero) {
    console.warn(
      '  [hero-h1] No home page hero found in entry — skipping dedicated H1 step.'
    );
    return null;
  }

  const currentH1 =
    typeof homeHero.h1 === 'string' ? (homeHero.h1 as string) : '';
  const businessSubset = pickBusinessContextForHeroH1(siteEntry);
  const topicsContext = parseTopicsForHeroH1(topicsRaw);
  const websiteBriefing =
    typeof siteEntry.websiteBriefing === 'string'
      ? (siteEntry.websiteBriefing as string).trim()
      : '';
  const deployDomain =
    typeof siteEntry.deployDomain === 'string'
      ? (siteEntry.deployDomain as string)
      : '';

  const systemPrompt = buildAiPrompt('clone-hero-h1', {});

  const context: Record<string, unknown> = {
    newSiteId: siteId ?? (siteEntry.id as string | undefined) ?? '',
    deployDomain,
    business: businessSubset,
    currentH1,
  };
  if (topicsContext) context.topicsContext = topicsContext;
  if (websiteBriefing) context.newWebsiteBriefing = websiteBriefing;

  const briefingHeader = websiteBriefing
    ? `WEBSITE BRIEFING for the NEW location (Excel "Content Briefing" — AUTHORITATIVE, overrides template where conflicting):\n${websiteBriefing}\n\n---\n\n`
    : '';

  const userContent =
    briefingHeader +
    [
      `Generate ONE perfect, SEO-optimized hero H1 for the new website.`,
      `Use the location prompt (prompt.md) and topics/keywords (topics.json) as your primary input.`,
      ``,
      `---`,
      ``,
      `LOCATION PROMPT (prompt.md):`,
      userPrompt || '(none provided)',
      ``,
      `---`,
      ``,
      `CONTEXT:`,
      JSON.stringify(context, null, 2),
    ].join('\n');

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `  [hero-h1] Generating SEO-optimized hero H1 with dedicated AI step...`
      );
      const result = await openRouterCall(
        apiKey,
        model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        512,
        'hero-h1'
      );

      console.log(
        `  [hero-h1] Tokens: ${result.promptTokens} prompt + ${result.completionTokens} completion`
      );

      const parsed = JSON.parse(extractJsonFromResponse(result.content)) as {
        h1?: unknown;
      };
      const rawH1 = typeof parsed?.h1 === 'string' ? parsed.h1.trim() : '';
      if (!rawH1) throw new Error('Response missing non-empty "h1" string');

      const cleaned = rawH1
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
      return cleaned;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = 5000 * (attempt + 1);
        console.warn(
          `  [hero-h1] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed — retrying in ${delay / 1000}s...`,
          err instanceof Error ? err.message : err
        );
        await sleep(delay);
      } else {
        console.error(
          `  [hero-h1] Failed after ${MAX_RETRIES + 1} attempts:`,
          err instanceof Error ? err.message : err
        );
        return null;
      }
    }
  }
  return null;
}

/**
 * Apply a newly generated hero H1 onto the in-memory entry.
 * No-op when the entry has no home page hero.
 */
function applyHeroH1(entry: Record<string, unknown>, h1: string): boolean {
  const pages = entry.pages as Array<Record<string, unknown>> | undefined;
  const homePage = (pages ?? []).find(
    (p) => typeof p?.name === 'string' && p.name === 'home'
  );
  const homeHero = homePage?.hero as Record<string, unknown> | undefined;
  if (!homeHero) return false;
  homeHero.h1 = h1;
  return true;
}

async function generateWithOpenRouter(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  userMessageContent?: string,
  maxTokens?: number,
  verbose = false
): Promise<string> {
  if (verbose) {
    console.log(`  Using model: ${model}`);
    console.log(`  Sending request to OpenRouter...`);
  }

  const effectiveMax = maxTokens ?? 65536;
  const userContent =
    userMessageContent ??
    buildAiPrompt('generate-website-user-message', {
      USER_PROMPT: userPrompt,
      TOPICS_SECTION: '',
    });

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  let result = await openRouterCall(
    apiKey,
    model,
    messages,
    effectiveMax,
    'generate-website:main'
  );
  let totalPrompt = result.promptTokens;
  let totalCompletion = result.completionTokens;
  let accumulated = extractJsonFromResponse(result.content);

  for (
    let attempt = 0;
    attempt < MAX_CONTINUATIONS && result.finishReason === 'length';
    attempt++
  ) {
    console.warn(
      `\n  ⚠ Response truncated (finish_reason: "length") — requesting continuation (${attempt + 1}/${MAX_CONTINUATIONS})...`
    );

    const continuationMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
      { role: 'assistant', content: accumulated },
      {
        role: 'user',
        content: getAiPromptSection('json-continuation'),
      },
    ];

    result = await openRouterCall(
      apiKey,
      model,
      continuationMessages,
      effectiveMax,
      `generate-website:continuation:${attempt + 1}`
    );
    totalPrompt += result.promptTokens;
    totalCompletion += result.completionTokens;

    const continuation = extractJsonFromResponse(result.content);
    accumulated += continuation;
  }

  if (verbose)
    console.log(
      `  Tokens used: ${totalPrompt} prompt + ${totalCompletion} completion = ${totalPrompt + totalCompletion} total`
    );

  if (result.finishReason === 'length') {
    console.warn(
      `\n  ⚠ Still truncated after ${MAX_CONTINUATIONS} continuation(s). Attempting repair...`
    );
  }

  return accumulated;
}

function validateGeneratedWebsite(
  generated: Record<string, unknown>,
  template: Record<string, unknown>
): string[] {
  const warnings: string[] = [];

  const requiredTopKeys = [
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

  for (const key of requiredTopKeys) {
    if (!(key in generated)) {
      warnings.push(`Missing top-level key: "${key}"`);
    }
  }

  const pages = generated.pages;
  if (Array.isArray(pages) && pages.length > 0) {
    const page = pages[0] as Record<string, unknown>;
    const templatePages = template.pages as Record<string, unknown>[];
    if (templatePages?.[0]) {
      const templatePage = templatePages[0];
      const requiredPageKeys = Object.keys(templatePage);
      for (const key of requiredPageKeys) {
        if (!(key in page)) {
          warnings.push(`Missing page key: "pages[0].${key}"`);
        }
      }
    }

    const expectedPageNames = [
      'home',
      'faq',
      'impressum',
      'datenschutz',
      'ueber-uns',
    ];
    const generatedPageNames = (pages as Array<Record<string, unknown>>).map(
      (p) => p.name
    );
    for (const name of expectedPageNames) {
      if (!generatedPageNames.includes(name)) {
        warnings.push(`Missing page in pages array: "${name}"`);
      }
    }
  } else {
    warnings.push('"pages" array is missing or empty');
  }

  return warnings;
}

function removeRatgeberReferences(generated: Record<string, unknown>): void {
  const removeRatgeberLinksFromArray = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr[i];
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const href = String(rec.href ?? rec.url ?? '').trim();
      const page = String(rec.page ?? rec.name ?? '')
        .trim()
        .toLowerCase();
      const slug = href.toLowerCase().replace(/\/+$/, '');
      if (page === 'ratgeber' || slug === '/ratgeber') {
        arr.splice(i, 1);
      }
    }
  };

  const pages = generated.pages;
  if (Array.isArray(pages)) {
    generated.pages = pages.filter((p) => {
      if (!p || typeof p !== 'object') return true;
      const rec = p as Record<string, unknown>;
      return String(rec.name ?? '').toLowerCase() !== 'ratgeber';
    });
  }

  const header = generated.header as Record<string, unknown> | undefined;
  if (header && typeof header === 'object') {
    removeRatgeberLinksFromArray(header.links);
    removeRatgeberLinksFromArray(header.navigation);
    removeRatgeberLinksFromArray(header.navLinks);
  }

  const footer = generated.footer as Record<string, unknown> | undefined;
  if (footer && typeof footer === 'object') {
    removeRatgeberLinksFromArray(footer.links);
    removeRatgeberLinksFromArray(footer.navigation);
    removeRatgeberLinksFromArray(footer.navLinks);
  }
}

/** Match strings that look like image paths (path or file extension). */
function isImagePath(value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const v = value.trim();
  return v.startsWith('/images/') || /\.(webp|jpg|jpeg|png|gif)$/i.test(v);
}

/** Recursively collect all image paths from generated website JSON with their JSON paths. */
function collectImagePaths(
  obj: unknown,
  jsonPath = ''
): Array<{ jsonPath: string; value: string }> {
  const out: Array<{ jsonPath: string; value: string }> = [];
  if (obj === null || obj === undefined) return out;

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      if (typeof item === 'string' && isImagePath(item)) {
        out.push({ jsonPath: `${jsonPath}[${i}]`, value: item });
      } else if (typeof item === 'object' && item !== null) {
        out.push(...collectImagePaths(item, `${jsonPath}[${i}]`));
      }
    });
    return out;
  }

  if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (typeof val === 'string') {
        if (isImagePath(val)) out.push({ jsonPath: keyPath, value: val });
      } else if (typeof val === 'object' && val !== null) {
        out.push(...collectImagePaths(val, keyPath));
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY in .env.local');
    process.exit(1);
  }

  const {
    clientId: argClientId,
    promptFile,
    useStdin,
    templateIndex,
    dryRun,
    verbose,
    outFile,
    skipCloneCheck,
    skipExcel,
    ueberUns,
  } = parseArgs();

  const clients = getAvailableClients();
  if (clients.length === 0) {
    console.error('No client folders found under src/data/');
    process.exit(1);
  }

  // --- Client selection ---
  let clientId: string;
  if (argClientId && clients.includes(argClientId)) {
    clientId = argClientId;
  } else if (argClientId) {
    console.error(
      `Unknown client: ${argClientId}. Available: ${clients.join(', ')}`
    );
    process.exit(1);
  } else {
    const answer = await inquirer.prompt<{ client: string }>([
      {
        type: 'list',
        name: 'client',
        message: 'Which client do you want to generate the website for?',
        choices: clients,
      },
    ]);
    clientId = answer.client;
  }

  const dataDir = getDataDir(clientId);
  const websitesPath = path.join(dataDir, 'websites.json');
  const languageConfigPath = path.join(dataDir, 'language.config.json');

  if (!fs.existsSync(websitesPath)) {
    console.error(
      `websites.json not found for client "${clientId}": ${websitesPath}`
    );
    process.exit(1);
  }

  // --- Process Excel data (optional) ---
  {
    let runExcel = !skipExcel;
    if (!skipExcel) {
      ({ runExcel } = await inquirer.prompt<{ runExcel: boolean }>([
        {
          type: 'confirm',
          name: 'runExcel',
          message:
            'Run 04-process-excel-data to update websites.json from data.xlsx before generating?',
          default: true,
        },
      ]));
    }
    if (runExcel) {
      console.log('\n  Running 04-process-excel-data...\n');
      const excelResult = spawnSync(
        'pnpm',
        [
          'exec',
          'node',
          'scripts/04-process-excel-data.mjs',
          `--client=${clientId}`,
        ],
        { cwd: process.cwd(), stdio: 'inherit' }
      );
      if (excelResult.status !== 0) {
        console.warn(
          `  04-process-excel-data exited with code ${excelResult.status} — continuing anyway.\n`
        );
      } else {
        console.log('');
      }
    }
  }

  // --- Prompt selection ---
  let userPrompt: string;
  let siteId: string | null = null;
  let promptPath: string | null = null;
  if (useStdin) {
    console.log('Reading prompt from stdin...');
    userPrompt = await readStdin();
  } else if (promptFile) {
    const resolved = path.resolve(process.cwd(), promptFile);
    if (!fs.existsSync(resolved)) {
      console.error(`Prompt file not found: ${resolved}`);
      process.exit(1);
    }
    promptPath = resolved;
    userPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
    siteId = path.basename(path.dirname(promptPath));
    if (verbose)
      console.log(
        `Read prompt from: ${promptPath} (${userPrompt.length} chars)`
      );
  } else {
    // Interactive: select website folder with prompt.md (fallback: prompt.txt)
    const websiteFolders = getWebsiteFoldersWithPrompt(clientId);
    if (websiteFolders.length === 0) {
      console.error(
        `No website folders with prompt.md (or prompt.txt) found in src/data/${clientId}/. ` +
          'Add a subfolder with prompt.md (e.g. src/data/haus-zum-wald/my-website/prompt.md)'
      );
      process.exit(1);
    }
    const answer = await inquirer.prompt<{ website: string }>([
      {
        type: 'list',
        name: 'website',
        message: `Select website to generate (prompt from folder):`,
        choices: websiteFolders.map((w) => ({
          name: w.hasTopics
            ? `${w.folder} ✓`
            : `${w.folder} ⚠ missing topics.json`,
          value: w.folder,
        })),
      },
    ]);
    siteId = answer.website;
    const selectedFolder = websiteFolders.find((w) => w.folder === siteId)!;
    promptPath = selectedFolder.promptPath;
    userPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
    if (verbose)
      console.log(
        `Read prompt from: ${promptPath} (${userPrompt.length} chars)`
      );
  }

  if (!userPrompt) {
    console.error('Prompt is empty.');
    process.exit(1);
  }

  // --- Load topics.json from the same folder as the prompt ---
  let topicsContent: string | null = null;
  if (promptPath) {
    const websiteFolder = path.dirname(promptPath);
    const topicsPath = path.join(websiteFolder, 'topics.json');
    if (!fs.existsSync(topicsPath)) {
      console.error(
        `\n✗ topics.json not found at: ${topicsPath}\n` +
          `  Both prompt.md and topics.json are required in the website folder.\n` +
          `  Run the topics generation step first, or create topics.json manually.`
      );
      process.exit(1);
    }
    topicsContent = fs.readFileSync(topicsPath, 'utf-8').trim();
    console.log(
      `Read topics from: ${topicsPath} (${topicsContent.length} chars)`
    );
  }

  // --- --ueber-uns mode: regenerate only the ueber-uns blocks on an existing entry and exit ---
  if (ueberUns) {
    if (!siteId || !topicsContent) {
      console.error(
        '\n✗ --ueber-uns requires a website folder with prompt.md + topics.json.\n' +
          '  Use --prompt=src/data/<client>/<site>/prompt.md or run interactively.'
      );
      process.exit(1);
    }
    const model = loadModel(languageConfigPath);
    const availableImagesForSite = scanAvailableImages(siteId);

    const websites = loadWebsites(websitesPath);
    const siteEntryIndex = websites.findIndex(
      (w) => (w as Record<string, string>).id === siteId
    );
    if (siteEntryIndex < 0) {
      console.error(
        `\n✗ No website entry with id "${siteId}" found in websites.json.\n` +
          `  Run the full generation first (pnpm 06-generate-website).`
      );
      process.exit(1);
    }
    const siteEntry = websites[siteEntryIndex] as Record<string, unknown>;

    console.log(`\n  --ueber-uns mode for "${siteId}"`);
    console.log(`  Using model: ${model}`);

    const ueberResult = await callUeberUnsBlocksAi(
      apiKey,
      model,
      siteEntry,
      userPrompt,
      topicsContent,
      availableImagesForSite
    );

    if (!ueberResult) {
      console.error('\n✗ ueber-uns block generation failed.');
      process.exit(1);
    }

    applyUeberUnsBlocks(siteEntry, ueberResult, availableImagesForSite);

    if (dryRun) {
      const ueberUnsPage = (
        siteEntry.pages as Array<Record<string, unknown>>
      ).find((p) => p.name === 'ueber-uns');
      console.log('\n[DRY-RUN] Generated ueber-uns h1 + blocks (not saved):');
      if (ueberUnsPage?.h1) console.log('h1:', ueberUnsPage.h1);
      console.log(JSON.stringify(ueberUnsPage?.blocks ?? ueberResult.blocks, null, 2));
      return;
    }

    writeWebsites(websitesPath, websites);
    console.log(
      `\n✓ Saved updated "ueber-uns" blocks to ${path.relative(process.cwd(), websitesPath)}`
    );
    runFetchPlaceHeroAddressForSite(clientId, siteId);
    runRefineWebsiteDataForSite(clientId, siteId);
    return;
  }

  const targetWebsites = loadWebsites(websitesPath);

  // Check if there's an existing entry for this siteId (fill-blanks mode)
  const existingEntryIndex = siteId
    ? targetWebsites.findIndex(
        (w) => (w as Record<string, string>).id === siteId
      )
    : -1;
  const existingEntry =
    existingEntryIndex >= 0 ? targetWebsites[existingEntryIndex] : null;
  const isFillBlanks = existingEntry !== null;

  if (isFillBlanks) {
    const emptyFieldCount = findEmptyFields(existingEntry).length;
    console.log(
      `\n  Found existing entry "${siteId}" — fill-blanks mode (${emptyFieldCount} empty field(s)).`
    );
  }

  const model = loadModel(languageConfigPath);

  // --- Clone check: only when NOT filling blanks ---
  if (
    !isFillBlanks &&
    !skipCloneCheck &&
    targetWebsites.length > 0 &&
    siteId !== null
  ) {
    console.log(
      `\n  Client has ${targetWebsites.length} existing website(s). Verifying if any match...`
    );
    try {
      const match = await findMatchingClientWebsite(
        apiKey,
        userPrompt,
        targetWebsites,
        model
      );
      if (match.matched) {
        console.log(
          `\n  Found matching website "${match.sourceId}" → delegating to clone-website.ts\n`
        );
        const code = invokeCloneWebsite(
          clientId,
          match.sourceId,
          siteId,
          promptPath,
          promptPath ? null : userPrompt,
          dryRun,
          outFile
        );
        process.exit(code);
      }
    } catch (err) {
      console.warn(
        '  Clone verification failed, continuing with full generation:',
        err
      );
    }
  }

  // Scan for available images
  let availableImages: AvailableImages | null = null;
  if (siteId) {
    availableImages = scanAvailableImages(siteId);
    if (availableImages) {
      console.log(
        `\nFound ${availableImages.all.length} image(s) on disk for "${siteId}":`
      );
      for (const [cat, paths] of Object.entries(
        availableImages.byCategory
      ).sort()) {
        console.log(`  ${cat}: ${paths.length} file(s)`);
      }
    } else {
      console.log(
        `\nNo images found at public/images/${siteId}/ — AI will use placeholder paths.`
      );
    }
  }

  let systemPrompt: string | undefined;
  let userMessageContent: string | undefined;
  let template: Record<string, unknown>;

  if (isFillBlanks) {
    // --- Fill-blanks mode: existing entry found; chunked AI generation ---
    template = existingEntry!;
    const existingJson = JSON.stringify(existingEntry, null, 2);
    const emptyFields = findEmptyFields(existingEntry);

    console.log(
      `\nMode: fill-blanks — batched flat-path AI (updating existing entry)`
    );
    if (verbose) {
      console.log(`Existing entry size: ${existingJson.length} chars`);
      console.log(`Empty fields (total): ${emptyFields.length}`);
      console.log(`Prompt size: ${userPrompt.length} chars\n`);
    }

    if (siteId && verbose) {
      console.log(`Site ID: ${siteId} (from folder name)`);
    }
  } else {
    // --- Generate-from-scratch mode: use template ---
    let templateWebsites = targetWebsites;

    // When client has no websites, use another client's as template
    if (targetWebsites.length === 0) {
      const clientsWithWebsites = getClientsWithWebsites();
      if (clientsWithWebsites.length === 0) {
        console.error(
          'No client has any websites in websites.json. Add at least one website entry somewhere to use as template.'
        );
        process.exit(1);
      }
      let templateClientId: string;
      if (clientsWithWebsites.length === 1) {
        templateClientId = clientsWithWebsites[0].clientId;
        console.log(
          `\nClient "${clientId}" has no websites. Using "${templateClientId}" as template source.`
        );
      } else {
        const answer = await inquirer.prompt<{ templateClient: string }>([
          {
            type: 'list',
            name: 'templateClient',
            message: `Client "${clientId}" has no websites. Select a client to use as template:`,
            choices: clientsWithWebsites.map((c) => ({
              name: `${c.clientId} (${c.count} website${c.count > 1 ? 's' : ''})`,
              value: c.clientId,
            })),
          },
        ]);
        templateClientId = answer.templateClient;
      }
      const templateSourcePath = path.join(
        getDataDir(templateClientId),
        'websites.json'
      );
      templateWebsites = loadWebsites(templateSourcePath);
    }

    if (templateIndex < 0 || templateIndex >= templateWebsites.length) {
      console.error(
        `Template index ${templateIndex} out of range (0-${templateWebsites.length - 1})`
      );
      process.exit(1);
    }

    template = templateWebsites[templateIndex];
    applyDiskImagePathsToEntry(template, availableImages);
    const templateJson = JSON.stringify(template, null, 2);

    console.log(
      `\nTemplate: website[${templateIndex}] (id: ${(template as Record<string, string>).id})`
    );
    if (verbose) {
      console.log(`Template size: ${templateJson.length} chars`);
      console.log(`Prompt size: ${userPrompt.length} chars\n`);
    }

    if (siteId && verbose) {
      console.log(`Site ID: ${siteId} (from folder name)`);
    }

    systemPrompt = buildSystemPrompt(templateJson, siteId, availableImages);
    const topicsSection = topicsContent
      ? `\n\n═══════════════════════════════════════════════════════\nTOPICS, KEYWORDS & CONTENT STRATEGY (from topics.json)\n═══════════════════════════════════════════════════════\n\nUse the following topics, keywords, h1/subtitle suggestions, and content guidelines to inform the generated content:\n\n${topicsContent}`
      : '';
    userMessageContent = buildAiPrompt('generate-website-user-message', {
      USER_PROMPT: userPrompt,
      TOPICS_SECTION: topicsSection,
    });
  }

  console.log(
    isFillBlanks
      ? '\nFilling empty fields with AI (chunked)...\n'
      : '\nGenerating website entry with AI...\n'
  );

  let generated: Record<string, unknown>;

  if (isFillBlanks && siteId && existingEntry) {
    const persistChunk =
      !dryRun && !outFile
        ? {
            websitesPath,
            targetWebsites,
            existingEntryIndex,
          }
        : null;
    try {
      generated = await generateChunkedFillBlanks(
        apiKey,
        model,
        existingEntry as Record<string, unknown>,
        userPrompt,
        topicsContent,
        siteId,
        availableImages,
        persistChunk,
        verbose
      );
      console.log(
        persistChunk
          ? '\n  Fill-blanks finished (saved to websites.json).'
          : '\n  Fill-blanks finished (in-memory only — dry-run or --out).'
      );
    } catch (err) {
      console.error('\nFailed to generate website (fill-blanks):', err);
      process.exit(1);
    }
  } else {
    let generatedJson: string;
    try {
      generatedJson = await generateWithOpenRouter(
        apiKey,
        model,
        systemPrompt!,
        userPrompt,
        userMessageContent,
        undefined,
        verbose
      );
    } catch (err) {
      console.error('\nFailed to generate website:', err);
      process.exit(1);
    }

    try {
      generated = robustJsonParse(generatedJson);
    } catch (parseErr) {
      console.error(
        '\nFailed to parse AI response as JSON (all repair strategies failed):',
        parseErr
      );
      console.error('\nRaw response (first 2000 chars):');
      console.error(generatedJson.slice(0, 2000));
      process.exit(1);
    }
  }

  // Only strip protected paths from a full AI JSON response. In fill-blanks mode,
  // `generated` is the merged working copy (already built from the real entry);
  // stripping here would DELETE deployDomain, googleTagId, etc. from disk.
  if (!isFillBlanks) {
    stripProtectedPaths(generated);
    applyTemplateReviewsFromTemplate(generated, template);
  }
  applyDiskImagePathsToEntry(generated, availableImages);
  if (availableImages) {
    console.log(
      `  Image paths: assigned from disk (${availableImages.all.length} file(s) under public/images/${availableImages.siteId}/).`
    );
  }
  applyTemplateFaqDataFiles(generated, template);
  applyOpenGraphUrls(generated);
  applyBusinessDataToSchema(generated);

  // Fill empty footer/header-CTA/bookingUrl slots from the scraped candidate list (constrained AI pick).
  try {
    await applyExternalFooterNavAndHeaderCtaLinks(
      apiKey,
      model,
      generated,
      clientId,
      siteId
    );
  } catch (err) {
    console.warn(
      `    unexpected error: ${(err as Error).message} — continuing.`
    );
  }

  if (siteId) {
    if (generated.id !== siteId) {
      console.log(`  Correcting id: "${generated.id}" → "${siteId}"`);
      generated.id = siteId;
    }
  }

  removeRatgeberReferences(generated);

  const warnings = validateGeneratedWebsite(generated, template);
  if (warnings.length > 0) {
    console.warn('\nValidation warnings:');
    for (const w of warnings) {
      console.warn(`  ⚠ ${w}`);
    }
  } else {
    console.log('\n  Structure validation passed.');
  }

  const imageList = collectImagePaths(generated);

  if (availableImages && imageList.length > 0) {
    const { corrections, missing } = correctImagePaths(
      generated,
      availableImages
    );

    if (corrections.length > 0) {
      console.log('\n═══════════════════════════════════════════════════════');
      console.log(`AUTO-CORRECTED ${corrections.length} IMAGE PATH(S)`);
      console.log('═══════════════════════════════════════════════════════\n');
      for (const { jsonPath, from, to } of corrections) {
        console.log(`  ${jsonPath}`);
        console.log(`    ✗ ${from}`);
        console.log(`    ✓ ${to}\n`);
      }
    }

    const updatedImageList = collectImagePaths(generated);
    const matched = updatedImageList.filter(({ value }) =>
      availableImages!.all.includes(value)
    );
    const stillMissing = updatedImageList.filter(
      ({ value }) => value && !availableImages!.all.includes(value)
    );

    if (matched.length > 0) {
      console.log(
        `\n  ✓ ${matched.length} image path(s) matched to files on disk.`
      );
    }

    if (stillMissing.length > 0) {
      console.log('\n═══════════════════════════════════════════════════════');
      console.log(`UNMATCHED IMAGE PATHS (${stillMissing.length})`);
      console.log(
        'These paths in the generated JSON do not match any file on disk.'
      );
      console.log('═══════════════════════════════════════════════════════\n');
      for (const { jsonPath, value } of stillMissing) {
        console.log(`  ${value}`);
        console.log(`    → JSON path: ${jsonPath}\n`);
      }
      console.log('Available images on disk:');
      for (const p of availableImages.all) {
        console.log(`  ${p}`);
      }
      console.log('');
    }
  } else if (imageList.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('IMAGES FOR PRODUCT MANAGER');
    console.log(
      'No images found on disk. Replace these placeholders with real files.'
    );
    console.log('═══════════════════════════════════════════════════════\n');
    for (const { jsonPath, value } of imageList) {
      console.log(`  ${value}`);
      console.log(`    → JSON path: ${jsonPath}\n`);
    }
    console.log('═══════════════════════════════════════════════════════\n');
  }

  // --- Dedicated AI step: regenerate the home hero H1 with an SEO-optimised prompt
  //     (uses prompt.md + topics.json + business + websiteBriefing). Mirrors the
  //     equivalent step in scripts/clone-website.ts. ---
  if (promptPath && topicsContent) {
    console.log('\n  Generating SEO-optimised hero H1...');
    try {
      const newH1 = await callHeroH1Ai(
        apiKey,
        model,
        generated,
        userPrompt,
        topicsContent,
        siteId
      );
      if (newH1) {
        const applied = applyHeroH1(generated, newH1);
        if (applied) {
          console.log(
            `  [hero-h1] Applied SEO-optimised hero H1 (${newH1.length} chars):\n    "${newH1}"`
          );
        } else {
          console.warn(
            '  [hero-h1] Could not apply hero H1 — home page hero not found on entry.'
          );
        }
      } else {
        console.warn(
          '  [hero-h1] Dedicated step did not return a usable headline — keeping the H1 from the main generation pass.'
        );
      }
    } catch (err) {
      console.warn(
        `  [hero-h1] Dedicated step failed — keeping the H1 from the main generation pass. ${(err as Error).message}`
      );
    }
  }

  // --- Always generate rich ueber-uns blocks when prompt.md + topics.json are available ---
  if (promptPath && topicsContent) {
    console.log('\n  Generating ueber-uns blocks...');
    const ueberUnsResult = await callUeberUnsBlocksAi(
      apiKey,
      model,
      generated,
      userPrompt,
      topicsContent,
      availableImages
    );
    if (ueberUnsResult) {
      applyUeberUnsBlocks(generated, ueberUnsResult, availableImages);
    } else {
      console.warn('    Block generation failed — existing blocks kept.');
    }
  }

  try {
    await applyGooglePlaceAddressToWebsiteEntry(
      generated as Record<string, unknown>
    );
  } catch (e) {
    console.warn(
      '  [place-address] Unexpected error — hero address unchanged.',
      e instanceof Error ? e.message : e
    );
  }

  const outputJson = JSON.stringify(generated, null, 2);

  if (dryRun) {
    console.log('\n--- DRY RUN: Generated website JSON ---\n');
    console.log(outputJson);
    console.log('\n--- End of dry run ---');
    return;
  }

  if (outFile) {
    const outPath = path.resolve(process.cwd(), outFile);
    fs.writeFileSync(outPath, outputJson + '\n');
    console.log(`\nWrote generated website to: ${outPath}`);
  } else if (isFillBlanks) {
    targetWebsites[existingEntryIndex] = generated;
    writeWebsites(websitesPath, targetWebsites);
    console.log(`\nUpdated website (id: "${siteId}") in ${websitesPath}`);
    console.log(`websites.json contains ${targetWebsites.length} website(s).`);
  } else {
    const existingId = (generated as Record<string, string>).id;
    const duplicate = targetWebsites.find(
      (w) => (w as Record<string, string>).id === existingId
    );
    if (duplicate) {
      console.warn(
        `\n  Warning: A website with id "${existingId}" already exists in websites.json.`
      );
      console.warn(
        '  The entry will still be appended. You may want to update the id manually.'
      );
    }

    const updatedWebsites = [...targetWebsites, generated];
    writeWebsites(websitesPath, updatedWebsites);
    console.log(
      `\nAppended new website (id: "${existingId}") to ${websitesPath}`
    );
    console.log(
      `websites.json now contains ${updatedWebsites.length} website(s).`
    );
  }

  if (!outFile) {
    const idForAddress =
      isFillBlanks && siteId
        ? siteId
        : (generated as Record<string, string>).id;
    if (idForAddress) {
      runFetchPlaceHeroAddressForSite(clientId, idForAddress);
      runRefineWebsiteDataForSite(clientId, idForAddress);
    }
  }

  console.log('\nNext steps:');
  console.log('  1. Review the generated entry in websites.json');
  console.log(
    '  2. Replace placeholder images (see list above); pass the image list to your product manager if needed'
  );
  console.log(
    '  3. Fill in googleTagId; set business.googlePlacesId to auto-fill hero address (card2) and run reviews'
  );
  console.log('  4. Run: pnpm fetch-google-reviews to populate reviews (if not already)');
  console.log('  5. Run: pnpm translate-data to generate translations');
  if (!outFile) {
    console.log(
      '  6. (Done) Ran 08-refine-website-data for this site — re-run if it warned above'
    );
    console.log('  7. Run: pnpm dev to verify the new website');
  } else {
    console.log(
      '  6. Run: pnpm run 08-refine-website-data -- --client-id=<client> --website-id=<id> after merging into websites.json'
    );
    console.log('  7. Run: pnpm dev to verify the new website');
  }
}

main();
