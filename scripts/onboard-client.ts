/**
 * Single-command client onboarding: runs create-client, pull-assets, organize-assets,
 * process-excel-data, 05-extract-client-data (favicon + client prompt), download fonts,
 * 06-generate-website (per prompt.md), use-client, sync-theme, and
 * optional translate / Google reviews / website data refinement / llm.txt generation — in the correct order.
 *
 * The script asks for a single input: the Google Drive folder ID. It then downloads
 * the Excel file from Drive, extracts the client ID (and all other metadata) from it,
 * and runs the full pipeline without further prompts.
 *
 * Usage:
 *   pnpm onboard-client
 *   pnpm onboard-client --help
 *   pnpm onboard-client --skip-create --client-id=haus-zum-wald
 *
 * Override the auto-detected client id or drive folder:
 *   pnpm onboard-client --drive-folder-id=abc123 --client-id=my-client
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import * as dotenv from 'dotenv';
import inquirer from 'inquirer';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'src', 'data');

dotenv.config({ path: path.join(ROOT, '.env.local') });

type PhaseId =
  | 'create'
  | 'assets'
  | 'extract'
  | 'generate'
  | 'activate'
  | 'enhancements'
  | 'polish'
  | 'translate';

type PhaseStatus = 'ok' | 'skipped' | 'failed' | 'warn';

interface OnboardConfig {
  clientId: string;
  driveFolderId: string;
  siteId: string | null;
  skipCreate: boolean;
  skipAssets: boolean;
  skipExtract: boolean;
  skipColors: boolean;
  skipGenerate: boolean;
  skipReviews: boolean;
  skipPolish: boolean;
  skipGrounding: boolean;
  skipInternalLinks: boolean;
  skipLlmTxt: boolean;
  skipTranslate: boolean;
  only: PhaseId | null;
}

interface PhaseResult {
  id: PhaseId;
  label: string;
  status: PhaseStatus;
  detail?: string;
}

function printHelp(): void {
  console.log(`
pnpm onboard-client — run the full client onboarding pipeline in order.

Phases:
  0. pre-flight    — prompt for Google Drive folder ID, pull Excel, extract client ID
  1. create        — create-client (folder, websites.json, theme, language)
  2. assets        — pull + organize + process-excel (Drive), then favicon + client prompt, then fonts, then colors
  3. generate      — 06-generate-website for each src/data/<client>/*/prompt.md
  4. activate      — use-client + sync-theme
  5. enhancements  — fetch-google-reviews + 08-refine-website-data
  6. polish        — generate-grounding + generate-internal-links + generate-llm-txt
  7. translate     — translate-data for every language.config.json targetLanguage
                     (websites.json AND per-site files like faq.json / partners.json)

  Re-run favicon + client prompt only: --only=extract

The script starts by asking for the Google Drive folder ID, downloads the Excel file
from Drive, and extracts all client metadata (id, name, domain, etc.) automatically.

Options:
  --drive-folder-id=     Google Drive folder ID (skips the prompt)
  --client-id=           Override the client ID extracted from the Excel
  --site-id=             Website id for use-client (default: first site in websites.json)

  --skip-create          Skip phase 1 (client folder must already exist)
  --skip-assets          Skip phase 2
  --skip-extract         Skip favicon + client prompt during assets (still runs fonts + colors)
  --skip-colors          Skip brand-color extraction (05-extract-website:colors) during assets
  --skip-generate        Skip generate phase
  --skip-reviews         Skip Google reviews in enhancements
  --skip-polish          Skip all of phase 6 (grounding + internal-links + llm.txt)
  --skip-grounding       Skip grounding page generation inside polish
  --skip-internal-links  Skip internalLinks.json regeneration inside polish
  --skip-llm-txt         Skip llm.txt generation inside polish
  --skip-translate       Skip phase 7 (translate-data for all target languages)

  --only=<phase>         Run only one phase: create | assets | extract | generate | activate | enhancements | polish | translate

  -h, --help             Show this help

Examples:
  pnpm onboard-client                                          # prompts for Drive folder ID
  pnpm onboard-client --drive-folder-id=abc123                # skip the prompt
  pnpm onboard-client --skip-create --client-id=nicezeit      # re-run skipping create
  pnpm onboard-client --only=assets --client-id=nicezeit      # assets phase only
`);
}

function parseArgValue(prefix: string, arg: string): string | null {
  if (arg.startsWith(prefix)) return arg.slice(prefix.length).trim() || null;
  return null;
}

function parseArgs(): Partial<OnboardConfig> & { help?: boolean } {
  const argv = process.argv.slice(2);
  const out: Partial<OnboardConfig> & { help?: boolean } = {};

  if (argv.includes('--help') || argv.includes('-h')) {
    out.help = true;
    return out;
  }

  let only: string | null = null;

  for (const arg of argv) {
    if (arg === '--skip-create') out.skipCreate = true;
    else if (arg === '--skip-assets') out.skipAssets = true;
    else if (arg === '--skip-extract') out.skipExtract = true;
    else if (arg === '--skip-colors') out.skipColors = true;
    else if (arg === '--skip-generate') out.skipGenerate = true;
    else if (arg === '--skip-reviews') out.skipReviews = true;
    else if (arg === '--skip-polish') out.skipPolish = true;
    else if (arg === '--skip-grounding') out.skipGrounding = true;
    else if (arg === '--skip-internal-links') out.skipInternalLinks = true;
    else if (arg === '--skip-llm-txt') out.skipLlmTxt = true;
    else if (arg === '--skip-translate') out.skipTranslate = true;
    else if (arg.startsWith('--only=')) only = parseArgValue('--only=', arg);
    else if (arg.startsWith('--client-id='))
      out.clientId = parseArgValue('--client-id=', arg) ?? undefined;
    else if (arg.startsWith('--drive-folder-id='))
      out.driveFolderId = parseArgValue('--drive-folder-id=', arg) ?? undefined;
    else if (arg.startsWith('--site-id='))
      out.siteId = parseArgValue('--site-id=', arg) ?? null;
  }

  if (only) {
    const valid: PhaseId[] = [
      'create',
      'assets',
      'extract',
      'generate',
      'activate',
      'enhancements',
      'polish',
      'translate',
    ];
    if (!valid.includes(only as PhaseId)) {
      console.error(
        `Invalid --only="${only}". Use one of: ${valid.join(', ')}`
      );
      process.exit(1);
    }
    out.only = only as PhaseId;
  }

  return out;
}

function loadEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Excel discovery — used to extract clientId without interactive prompts
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /[äöü]/g,
      (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c as 'ä' | 'ö' | 'ü'] ?? c
    )
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PLACEHOLDER_SLUGS = new Set([
  'my-client-name',
  'my-client',
  'client-name',
  'example-client',
  'example',
  'test',
  'test-client',
]);

/**
 * Strip scheme, www prefix, path, and TLD from a domain string, then slugify.
 * e.g. "https://www.caralingua.de/about" → "caralingua"
 */
function slugifyDomain(domain: string): string {
  const bare = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.$/, '')
    .replace(/\.[a-z]{2,}$/, '');
  return slugify(bare);
}

/**
 * Extract a usable client ID from the first data row of an xlsx file.
 *
 * Priority (first non-placeholder wins):
 *   1. Client Domain — most reliable because users always fill it in
 *      (e.g. "caralingua.de" → "caralingua")
 *   2. Client Name — slugified (e.g. "Haus zum Wald" → "haus-zum-wald")
 *   3. Client ID — used as-is after slugifying
 *
 * Template placeholders like "my-client-name" / "My Client" are skipped.
 */
function extractClientIdFromExcel(xlsxPath: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const XLSX = createRequire(import.meta.url)('xlsx') as any;
    const workbook = XLSX.readFile(xlsxPath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<
      string,
      string
    >[];

    let clientId: string | null = null;
    let clientName: string | null = null;
    let clientDomain: string | null = null;

    for (const row of rows) {
      for (const [key, val] of Object.entries(row)) {
        const normKey = String(key).trim().toLowerCase();
        const strVal = String(val).trim();
        if (!strVal) continue;

        if (normKey === 'client id' && !clientId) clientId = strVal;
        if (normKey === 'client name' && !clientName) clientName = strVal;
        if (normKey === 'client domain' && !clientDomain) clientDomain = strVal;
      }
      if (clientId || clientName || clientDomain) break;
    }

    if (clientDomain) {
      const slug = slugifyDomain(clientDomain);
      if (slug && !PLACEHOLDER_SLUGS.has(slug)) return slug;
    }

    if (clientName) {
      const slug = slugify(clientName);
      if (slug && !PLACEHOLDER_SLUGS.has(slug)) return slug;
    }

    if (clientId) {
      const slug = slugify(clientId);
      if (slug && !PLACEHOLDER_SLUGS.has(slug)) return slug;
    }

    return null;
  } catch {
    // xlsx not available or file unreadable — fall through
  }
  return null;
}

// ---------------------------------------------------------------------------

function readWebsitesJson(clientId: string): {
  websites: Array<{ id?: string }>;
} | null {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      websites?: Array<{ id?: string }>;
    };
    const websites = Array.isArray(raw)
      ? (raw as unknown as Array<{ id?: string }>)
      : (raw.websites ?? []);
    return { websites };
  } catch {
    return null;
  }
}

function getFirstSiteId(clientId: string): string | null {
  const data = readWebsitesJson(clientId);
  const id = data?.websites?.[0]?.id;
  return typeof id === 'string' ? id : null;
}

/** Every site id for a client, in websites.json order. Used by the polish phase. */
function getAllSiteIds(clientId: string): string[] {
  const data = readWebsitesJson(clientId);
  if (!data?.websites) return [];
  return data.websites
    .map((w) => w.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** Target languages per language.config.json (targetLanguages ?? supportedLanguages - defaultLanguage). Empty = skip translate phase. */
function getTranslationTargetLanguages(clientId: string): string[] {
  const p = path.join(DATA_DIR, clientId, 'language.config.json');
  if (!fileExists(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      defaultLanguage?: string;
      supportedLanguages?: string[];
      translation?: { targetLanguages?: string[] };
    };
    const defaultLang = raw.defaultLanguage ?? 'de';
    const supported = Array.isArray(raw.supportedLanguages)
      ? raw.supportedLanguages
      : [];
    const explicit = raw.translation?.targetLanguages;
    const targets =
      Array.isArray(explicit) && explicit.length > 0
        ? explicit
        : supported.filter((l) => l !== defaultLang);
    return targets.filter(
      (l): l is string => typeof l === 'string' && l.length > 0
    );
  } catch {
    return [];
  }
}

function getClientDomain(clientId: string): string | null {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      clientDomain?: string;
    };
    return data.clientDomain?.trim() || null;
  } catch {
    return null;
  }
}

/** Favicon download + client prompt generation (scripts/05-extract-client-data.mjs). */
function runExtractFaviconAndClientPrompt(config: OnboardConfig): PhaseResult {
  const siteForFavicon = config.siteId || getFirstSiteId(config.clientId);
  const clientDomain = getClientDomain(config.clientId);

  if (!siteForFavicon && !clientDomain) {
    console.warn(
      '[onboard-client] No site id or clientDomain — cannot extract favicon.'
    );
    return {
      id: 'extract',
      label: 'Extract favicon & client prompt',
      status: 'skipped',
      detail: 'no site id or clientDomain',
    };
  }

  const faviconArgs = [
    'exec',
    'node',
    'scripts/05-extract-client-data.mjs',
    '--favicon',
    `--client=${config.clientId}`,
  ];
  if (siteForFavicon) faviconArgs.push(`--site=${siteForFavicon}`);
  if (clientDomain) faviconArgs.push(`--domain=${clientDomain}`);

  console.log(
    `\n[onboard-client] Downloading favicon → public/favicon.ico (${clientDomain || siteForFavicon})\n`
  );
  const fav = runCmd('pnpm', faviconArgs);
  if (!fav.ok) {
    return {
      id: 'extract',
      label: 'Extract favicon & client prompt',
      status: 'warn',
      detail: `favicon exit ${fav.code}`,
    };
  }

  console.log(
    '\n[onboard-client] Generating client prompts (05-extract-client-data --client-prompt)\n'
  );
  const clientPrompt = runCmd('pnpm', [
    'exec',
    'node',
    'scripts/05-extract-client-data.mjs',
    '--client-prompt',
    `--client=${config.clientId}`,
  ]);

  return {
    id: 'extract',
    label: 'Extract favicon & client prompt',
    status: clientPrompt.ok ? 'ok' : 'warn',
    detail: clientPrompt.ok
      ? undefined
      : `client-prompt exit ${clientPrompt.code}`,
  };
}

function getWebsiteFoldersWithPrompt(
  clientId: string
): Array<{ folder: string; promptPath: string }> {
  const clientDir = path.join(DATA_DIR, clientId);
  if (!fileExists(clientDir)) return [];
  const result: Array<{ folder: string; promptPath: string }> = [];
  for (const e of fs.readdirSync(clientDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const promptMdPath = path.join(clientDir, e.name, 'prompt.md');
    const promptTxtPath = path.join(clientDir, e.name, 'prompt.txt');
    if (fileExists(promptMdPath)) {
      result.push({ folder: e.name, promptPath: promptMdPath });
    } else if (fileExists(promptTxtPath)) {
      result.push({ folder: e.name, promptPath: promptTxtPath });
    }
  }
  return result.sort((a, b) => a.folder.localeCompare(b.folder));
}

function hasGooglePlaceIds(clientId: string): boolean {
  const data = readWebsitesJson(clientId);
  if (!data?.websites) return false;
  for (const w of data.websites) {
    const site = w as {
      business?: { googlePlacesId?: string };
      pages?: Array<{ reviews?: { googlePlacesId?: string } }>;
    };
    if (site.business?.googlePlacesId?.trim()) return true;
    for (const page of site.pages ?? []) {
      if (page.reviews?.googlePlacesId?.trim()) return true;
    }
  }
  return false;
}

function runCmd(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): { ok: boolean; code: number | null } {
  const r = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  return { ok: r.status === 0, code: r.status };
}

function shouldRun(phase: PhaseId, config: OnboardConfig): boolean {
  if (config.only) {
    return config.only === phase;
  }
  // Favicon + client prompt run inside the assets phase after process-excel; standalone
  // extract phase is only for --only=extract.
  if (phase === 'extract') {
    return false;
  }
  return true;
}

function isSkipped(
  phase: PhaseId,
  config: OnboardConfig
): { skip: boolean; reason?: string } {
  switch (phase) {
    case 'create':
      if (config.skipCreate) return { skip: true, reason: '--skip-create' };
      return { skip: false };
    case 'assets':
      if (config.skipAssets) return { skip: true, reason: '--skip-assets' };
      return { skip: false };
    case 'extract':
      if (config.skipExtract) return { skip: true, reason: '--skip-extract' };
      return { skip: false };
    case 'generate':
      if (config.skipGenerate) return { skip: true, reason: '--skip-generate' };
      return { skip: false };
    case 'activate':
      return { skip: false };
    case 'enhancements':
      return { skip: false };
    case 'polish':
      if (config.skipPolish) return { skip: true, reason: '--skip-polish' };
      return { skip: false };
    case 'translate':
      if (config.skipTranslate)
        return { skip: true, reason: '--skip-translate' };
      return { skip: false };
    default:
      return { skip: false };
  }
}

/**
 * Download ALL assets from the given Drive folder into a staging directory
 * (googleDrive/.onboarding/), extract the client ID from the Excel file found
 * there, and return the id (or null on failure).
 *
 * The staging directory is kept on disk so that after the client folder is
 * created (Phase 1) it can be moved to its permanent location
 * (googleDrive/<clientId>/) by `moveOnboardingAssets`. Phase 2 will then skip
 * the download step and work directly with the already-present files.
 */
async function pullAssetsAndGetClientId(
  driveFolderId: string
): Promise<string | null> {
  const cred = path.join(ROOT, 'google-drive-credentials.json');
  if (!fileExists(cred)) {
    console.warn(
      '  Google Drive credentials not found — cannot download assets from Drive.'
    );
    return null;
  }

  const stagingDir = path.join(ROOT, 'googleDrive', '.onboarding');
  const stagingDirRel = path.relative(ROOT, stagingDir);

  console.log('\n  Downloading assets from Google Drive...\n');
  const pull = runCmd('pnpm', [
    'exec',
    'node',
    '--no-warnings=punycode',
    'scripts/02-pull-from-google-drive.mjs',
    `--folder-id=${driveFolderId}`,
    `--output-dir=${stagingDirRel}`,
  ]);

  if (!pull.ok) {
    console.warn('  Asset download from Drive failed.');
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }

  let clientId: string | null = null;
  if (fs.existsSync(stagingDir)) {
    const found = fs
      .readdirSync(stagingDir)
      .find((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('.'));
    if (found) {
      clientId = extractClientIdFromExcel(path.join(stagingDir, found));
    }
  }

  return clientId;
}

/**
 * Move the pre-flight staging directory (googleDrive/.onboarding/) to its
 * permanent location (googleDrive/<clientId>/) so Phase 2 scripts can find
 * the already-downloaded assets without re-downloading.
 */
function moveOnboardingAssets(clientId: string): void {
  const stagingDir = path.join(ROOT, 'googleDrive', '.onboarding');
  if (!fs.existsSync(stagingDir)) return;

  const targetDir = path.join(ROOT, 'googleDrive', clientId);
  if (fs.existsSync(targetDir)) {
    console.log(
      `[onboard-client] googleDrive/${clientId}/ already exists — cleaning up staging dir.`
    );
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    fs.renameSync(stagingDir, targetDir);
    console.log(
      `[onboard-client] Moved googleDrive/.onboarding/ → googleDrive/${clientId}/`
    );
  } catch {
    console.warn(
      `[onboard-client] Could not move .onboarding/ → googleDrive/${clientId}/ — Phase 2 will re-download assets.`
    );
  }
}

/** Write driveFolderId into an existing websites.json if it isn't already set. */
function injectDriveFolderId(clientId: string, driveFolderId: string): void {
  if (!driveFolderId) return;
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<
      string,
      unknown
    >;
    if (data.driveFolderId === driveFolderId) return;
    data.driveFolderId = driveFolderId;
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
    console.log(
      `[onboard-client] Set driveFolderId in src/data/${clientId}/websites.json`
    );
  } catch {
    /* ignore */
  }
}

async function promptConfig(
  partial: Partial<OnboardConfig>
): Promise<OnboardConfig> {
  let skipCreate = partial.skipCreate ?? false;
  if (partial.only && partial.only !== 'create') {
    skipCreate = true;
  }
  const clientId = partial.clientId?.trim() || '';
  let driveFolderId = partial.driveFolderId?.trim() || '';
  const siteId = partial.siteId ?? null;

  // For new clients: ask for the Drive folder ID (the one required input).
  // clientId will be resolved from the Excel in main() after this returns.
  if (!skipCreate && !driveFolderId) {
    const { id } = await inquirer.prompt<{ id: string }>([
      {
        type: 'input',
        name: 'id',
        message: 'Google Drive folder ID:',
        validate: (input: string) =>
          input.trim() ? true : 'Drive folder ID is required.',
        filter: (input: string) => input.trim(),
      },
    ]);
    driveFolderId = id;
  }

  // For --skip-create (re-running existing client): clientId must be known.
  if (skipCreate && !clientId) {
    const driveDir = path.join(ROOT, 'googleDrive');
    const driveClients = fs.existsSync(driveDir)
      ? fs
          .readdirSync(driveDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
      : [];

    const clients =
      driveClients.length > 0
        ? driveClients
        : fs.readdirSync(DATA_DIR).filter((f) => {
            const p = path.join(DATA_DIR, f);
            return (
              fs.statSync(p).isDirectory() &&
              f !== 'current' &&
              f !== '_template' &&
              fileExists(path.join(p, 'websites.json'))
            );
          });

    if (clients.length === 0) {
      console.error('No client folders found in googleDrive/ or src/data/.');
      process.exit(1);
    }
    if (clients.length === 1) {
      return buildConfig(
        clients[0],
        driveFolderId,
        siteId,
        skipCreate,
        partial
      );
    }
    const { picked } = await inquirer.prompt<{ picked: string }>([
      {
        type: 'list',
        name: 'picked',
        message: 'Which client?',
        choices: clients,
      },
    ]);
    return buildConfig(picked, driveFolderId, siteId, skipCreate, partial);
  }

  if (partial.only === 'create' && skipCreate) {
    console.error('Cannot use --only=create together with --skip-create.');
    process.exit(1);
  }

  return buildConfig(clientId, driveFolderId, siteId, skipCreate, partial);
}

function buildConfig(
  clientId: string,
  driveFolderId: string,
  siteId: string | null,
  skipCreate: boolean,
  partial: Partial<OnboardConfig>
): OnboardConfig {
  return {
    clientId,
    driveFolderId,
    siteId,
    skipCreate,
    skipAssets: partial.skipAssets ?? false,
    skipExtract: partial.skipExtract ?? false,
    skipColors: partial.skipColors ?? false,
    skipGenerate: partial.skipGenerate ?? false,
    skipReviews: partial.skipReviews ?? false,
    skipPolish: partial.skipPolish ?? false,
    skipGrounding: partial.skipGrounding ?? false,
    skipInternalLinks: partial.skipInternalLinks ?? false,
    skipLlmTxt: partial.skipLlmTxt ?? false,
    skipTranslate: partial.skipTranslate ?? false,
    only: partial.only ?? null,
  };
}

function phaseHeader(n: number, title: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Phase ${n}: ${title}`);
  console.log(`${'═'.repeat(60)}\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs();
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  // promptConfig asks for the Drive folder ID when creating a new client,
  // or for the existing client selection when --skip-create is set.
  const config = await promptConfig(parsed);

  // -------------------------------------------------------------------------
  // Pre-flight: download ALL assets from Drive → extract clientId from Excel.
  // (Only for new clients where clientId hasn't been supplied via --client-id=)
  // Assets land in googleDrive/.onboarding/ and are moved to
  // googleDrive/<clientId>/ after Phase 1 so Phase 2 can skip re-downloading.
  // -------------------------------------------------------------------------
  let assetsPulledInPreflight = false;

  if (!config.skipCreate && !config.clientId && config.driveFolderId) {
    console.log('\n  Fetching client info from Drive...');
    const extracted = await pullAssetsAndGetClientId(config.driveFolderId);
    if (!extracted) {
      console.error(
        'Could not identify the client from the Drive files.\n' +
          '  Make sure the Excel file has a "Client Domain" or "Client Name" column and the Drive folder is accessible.\n' +
          '  You can also pass --client-id=<id> to set it manually.'
      );
      process.exit(1);
    }
    config.clientId = extracted;
    assetsPulledInPreflight = true;
    console.log(`  Client identified: ${config.clientId}`);
  }

  if (!config.clientId) {
    console.error(
      '[onboard-client] clientId is required. Pass --client-id=<id> or ensure the Excel has a "Client ID" column.'
    );
    process.exit(1);
  }

  if (config.skipCreate) {
    const clientPath = path.join(DATA_DIR, config.clientId);
    if (!fileExists(clientPath)) {
      console.error(
        `Client folder not found: src/data/${config.clientId} (use create phase first or run without --skip-create)`
      );
      process.exit(1);
    }
  }

  const results: PhaseResult[] = [];

  const runPhase = (
    id: PhaseId,
    label: string,
    phaseNum: number,
    fn: () => PhaseResult
  ) => {
    if (!shouldRun(id, config)) return;
    const { skip, reason } = isSkipped(id, config);
    if (skip) {
      results.push({ id, label, status: 'skipped', detail: reason });
      console.log(`\n⏭  Skipping ${label} (${reason})`);
      return;
    }
    phaseHeader(phaseNum, label);
    results.push(fn());
  };

  // --- Phase 1: create ---
  runPhase('create', 'Create client', 1, () => {
    const clientPath = path.join(DATA_DIR, config.clientId);
    if (fileExists(clientPath)) {
      console.log(
        `[onboard-client] Client folder already exists: src/data/${config.clientId}/ — skipping create.`
      );
      return {
        id: 'create',
        label: 'Create client',
        status: 'ok',
        detail: 'already exists',
      };
    }
    const r = runCmd('pnpm', [
      'exec',
      'tsx',
      'scripts/01-create-client.ts',
      `--client-id=${config.clientId}`,
    ]);
    return {
      id: 'create',
      label: 'Create client',
      status: r.ok ? 'ok' : 'failed',
      detail: r.ok ? undefined : `exit ${r.code}`,
    };
  });

  if (results.some((x) => x.id === 'create' && x.status === 'failed')) {
    printSummary(results);
    process.exit(1);
  }

  // Inject the Drive folder ID into websites.json so the Phase 2 pull can
  // find the right Drive folder (04-process-excel-data will overwrite it anyway).
  if (!config.skipCreate && config.driveFolderId) {
    injectDriveFolderId(config.clientId, config.driveFolderId);
  }

  // Move pre-flight staged assets (googleDrive/.onboarding/) to the permanent
  // per-client location (googleDrive/<clientId>/) so Phase 2 can work with
  // the already-downloaded files and skip the pull step.
  if (assetsPulledInPreflight) {
    moveOnboardingAssets(config.clientId);
  }

  // --- Phase 2: assets ---
  runPhase('assets', 'Pull & organize assets', 2, () => {
    const cred = path.join(ROOT, 'google-drive-credentials.json');
    if (!fileExists(cred)) {
      console.warn(
        '[onboard-client] google-drive-credentials.json not found — skipping pull & organize.'
      );
      return {
        id: 'assets',
        label: 'Pull & organize assets',
        status: 'skipped',
        detail: 'no google-drive-credentials.json',
      };
    }

    if (assetsPulledInPreflight) {
      console.log(
        `\n[onboard-client] Assets already downloaded to googleDrive/${config.clientId}/ — skipping pull.\n`
      );
    } else {
      const pull = runCmd('pnpm', [
        'exec',
        'node',
        '--no-warnings=punycode',
        'scripts/02-pull-from-google-drive.mjs',
        `--client=${config.clientId}`,
      ]);
      if (!pull.ok) {
        return {
          id: 'assets',
          label: 'Pull & organize assets',
          status: 'warn',
          detail: `pull-assets exit ${pull.code}`,
        };
      }
    }
    const org = runCmd('pnpm', [
      'exec',
      'node',
      'scripts/03-organize-drive-assets.mjs',
      `--client=${config.clientId}`,
    ]);
    if (!org.ok) {
      return {
        id: 'assets',
        label: 'Pull & organize assets',
        status: 'warn',
        detail: `organize exit ${org.code}`,
      };
    }
    const excel = runCmd('pnpm', [
      'exec',
      'node',
      'scripts/04-process-excel-data.mjs',
      `--client=${config.clientId}`,
    ]);

    if (!excel.ok) {
      return {
        id: 'assets',
        label: 'Extracting data from Excel',
        status: 'warn',
        detail: `process-excel exit ${excel.code}`,
      };
    }

    if (!config.skipExtract) {
      const extractRes = runExtractFaviconAndClientPrompt(config);
      if (extractRes.status === 'warn') {
        return {
          id: 'assets',
          label: 'Pull & organize assets',
          status: 'warn',
          detail: extractRes.detail,
        };
      }
    }

    console.log('\n--- download fonts (05-extract-client-data) ---\n');
    const fonts = runCmd('node', [
      'scripts/05-extract-client-data.mjs',
      '--download-fonts',
      `--client=${config.clientId}`,
    ]);

    let colorsDetail: string | undefined;
    let colorsOk = true;
    if (!config.skipColors) {
      console.log('\n--- extract colors (05-extract-client-data) ---\n');
      const colors = runCmd('node', [
        'scripts/05-extract-client-data.mjs',
        '--extract-colors',
        `--client=${config.clientId}`,
      ]);
      colorsOk = colors.ok;
      colorsDetail = colors.ok
        ? undefined
        : `extract-colors exit ${colors.code}`;
    }

    const combinedOk = fonts.ok && colorsOk;
    const detailParts: string[] = [];
    if (!fonts.ok) detailParts.push(`download-fonts exit ${fonts.code}`);
    if (colorsDetail) detailParts.push(colorsDetail);
    return {
      id: 'assets',
      label: 'Pull & organize assets',
      status: combinedOk ? 'ok' : 'warn',
      detail: detailParts.length ? detailParts.join('; ') : undefined,
    };
  });

  // --- Extract only (--only=extract): favicon + client prompt without Drive pull ---
  runPhase('extract', 'Extract favicon & client prompt', 3, () =>
    runExtractFaviconAndClientPrompt(config)
  );

  // --- Phase 3: generate ---
  runPhase('generate', 'Generate websites (AI)', 3, () => {
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn(
        '[onboard-client] OPENROUTER_API_KEY not set — skipping 06-generate-website.'
      );
      return {
        id: 'generate',
        label: 'Generate websites',
        status: 'skipped',
        detail: 'no OPENROUTER_API_KEY',
      };
    }
    const folders = getWebsiteFoldersWithPrompt(config.clientId);
    if (folders.length === 0) {
      console.log(
        `[onboard-client] No prompt.md (or prompt.txt) folders under src/data/${config.clientId}/ — nothing to generate.`
      );
      return {
        id: 'generate',
        label: 'Generate websites',
        status: 'skipped',
        detail: 'no prompt.md folders',
      };
    }
    let failed = 0;
    for (const { folder, promptPath } of folders) {
      console.log(`\n--- 06-generate-website: ${folder} ---\n`);
      const g = runCmd('pnpm', [
        'exec',
        'tsx',
        'scripts/06-generate-website.ts',
        `--client=${config.clientId}`,
        `--prompt=${promptPath}`,
        '--skip-excel',
      ]);
      if (!g.ok) failed++;
    }
    return {
      id: 'generate',
      label: 'Generate websites',
      status: failed === 0 ? 'ok' : 'warn',
      detail: failed ? `${failed} folder(s) failed` : undefined,
    };
  });

  // --- Phase 4: activate ---
  runPhase('activate', 'Activate client & sync theme', 4, () => {
    const site = config.siteId || getFirstSiteId(config.clientId);
    if (!site) {
      console.error(
        '[onboard-client] No website id in websites.json — cannot run use-client.'
      );
      return {
        id: 'activate',
        label: 'Activate client',
        status: 'failed',
        detail: 'no website id',
      };
    }
    const u = runCmd('pnpm', [
      'exec',
      'tsx',
      'scripts/use-client.ts',
      config.clientId,
      site,
    ]);
    if (!u.ok) {
      return {
        id: 'activate',
        label: 'Activate client',
        status: 'failed',
        detail: `use-client exit ${u.code}`,
      };
    }
    const s = runCmd('node', ['scripts/dev/sync-theme-to-globals.mjs']);
    return {
      id: 'activate',
      label: 'Activate client & sync theme',
      status: s.ok ? 'ok' : 'failed',
      detail: s.ok ? undefined : `sync-theme exit ${s.code}`,
    };
  });

  if (results.some((x) => x.id === 'activate' && x.status === 'failed')) {
    printSummary(results);
    process.exit(1);
  }

  // --- Phase 5: enhancements ---
  runPhase(
    'enhancements',
    'Enhancements (reviews + refine website data)',
    5,
    () => {
      const clientEnv = { ...process.env, CLIENT_ID: config.clientId };

      let hadWarnings = false;
      const detailParts: string[] = [];

      if (config.skipReviews) {
        detailParts.push('reviews skipped');
      } else if (!process.env.GOOGLE_PLACES_API_KEY) {
        console.warn('  Google API key not configured — skipping reviews.');
        detailParts.push('reviews skipped (no GOOGLE_PLACES_API_KEY)');
      } else if (!hasGooglePlaceIds(config.clientId)) {
        console.log('  No Google Place ID found in data — skipping reviews.');
        detailParts.push('reviews skipped (no googlePlacesId)');
      } else {
        console.log('\n  Fetching Google reviews...\n');
        const fr = runCmd(
          'pnpm',
          ['exec', 'tsx', 'scripts/07-fetch-google-reviews.ts'],
          clientEnv
        );
        if (!fr.ok) {
          hadWarnings = true;
          detailParts.push('Google reviews fetch failed');
        }
      }

      console.log('\n  Refining website data...\n');
      const dv = runCmd(
        'pnpm',
        [
          'run',
          '08-refine-website-data',
          '--',
          `--client-id=${config.clientId}`,
          '--all-websites',
        ],
        clientEnv
      );
      if (!dv.ok) {
        hadWarnings = true;
        detailParts.push('website data refinement failed');
      }

      return {
        id: 'enhancements',
        label: 'Enhancements (reviews + refine website data)',
        status: hadWarnings ? 'warn' : 'ok',
        detail: detailParts.length > 0 ? detailParts.join('; ') : undefined,
      };
    }
  );

  // --- Phase 6: polish (grounding + internal-links + llm.txt) ---
  runPhase('polish', 'Polish (grounding + internal-links + llm.txt)', 6, () => {
    if (config.skipPolish) {
      return {
        id: 'polish',
        label: 'Polish (grounding + internal-links + llm.txt)',
        status: 'skipped',
        detail: '--skip-polish',
      };
    }

    if (!process.env.OPENROUTER_API_KEY) {
      console.warn('  AI key not configured — skipping polish phase.');
      return {
        id: 'polish',
        label: 'Polish (grounding + internal-links + llm.txt)',
        status: 'skipped',
        detail: 'no OPENROUTER_API_KEY',
      };
    }

    const clientEnv = { ...process.env, CLIENT_ID: config.clientId };
    const siteIds = getAllSiteIds(config.clientId);
    if (siteIds.length === 0) {
      return {
        id: 'polish',
        label: 'Polish (grounding + internal-links + llm.txt)',
        status: 'skipped',
        detail: 'no websites in websites.json',
      };
    }

    let hadWarnings = false;
    const detailParts: string[] = [];

    // 1. Grounding — one central grounding.md per client (all sites merged).
    if (config.skipGrounding) {
      detailParts.push('grounding skipped');
    } else {
      console.log('\n  Generating central grounding page...\n');
      const r = runCmd(
        'node',
        ['scripts/generate-grounding.mjs', `--client=${config.clientId}`],
        clientEnv
      );
      if (!r.ok) {
        hadWarnings = true;
        detailParts.push('grounding generation failed');
      }
    }

    // 2. Internal links — one internalLinks.json per client (covers every site/page).
    if (config.skipInternalLinks) {
      detailParts.push('internal-links skipped');
    } else {
      console.log('\n  Building internal link map...\n');
      const r = runCmd(
        'node',
        ['scripts/generate-internal-links.mjs', config.clientId],
        clientEnv
      );
      if (!r.ok) {
        hadWarnings = true;
        detailParts.push('internal links generation failed');
      }
    }

    // 3. llm.txt — one per website.
    if (config.skipLlmTxt) {
      detailParts.push('llm.txt skipped');
    } else {
      console.log('\n  Generating AI content files...\n');
      for (const site of siteIds) {
        const r = runCmd(
          'node',
          ['text-editor/scripts/generate-llm-txt.mjs', config.clientId, site],
          clientEnv
        );
        if (!r.ok) {
          hadWarnings = true;
          detailParts.push(`llm.txt failed for ${site}`);
        }
      }
    }

    return {
      id: 'polish',
      label: 'Polish (grounding + internal-links + llm.txt)',
      status: hadWarnings ? 'warn' : 'ok',
      detail: detailParts.length > 0 ? detailParts.join('; ') : undefined,
    };
  });

  // --- Phase 7: translate (websites.json + per-site faq/partners/…) ---
  runPhase(
    'translate',
    'Translate (websites + per-site files for every target language)',
    7,
    () => {
      if (config.skipTranslate || config.skipPolish) {
        return {
          id: 'translate',
          label: 'Translate',
          status: 'skipped',
          detail: '--skip-translate',
        };
      }

      const targets = getTranslationTargetLanguages(config.clientId);
      if (targets.length === 0) {
        console.log(`  No target languages configured — skipping translation.`);
        return {
          id: 'translate',
          label: 'Translate',
          status: 'skipped',
          detail: 'no target languages',
        };
      }

      if (!process.env.OPENROUTER_API_KEY) {
        console.warn('  AI key not configured — skipping translation.');
        return {
          id: 'translate',
          label: 'Translate',
          status: 'skipped',
          detail: 'no OPENROUTER_API_KEY',
        };
      }

      const clientEnv = { ...process.env, CLIENT_ID: config.clientId };
      console.log(`\n  Translating content to: ${targets.join(', ')}...\n`);
      const r = runCmd(
        'pnpm',
        ['exec', 'tsx', 'scripts/translation/translate-data.ts', '--sites=all'],
        clientEnv
      );
      return {
        id: 'translate',
        label: 'Translate',
        status: r.ok ? 'ok' : 'warn',
        detail: r.ok
          ? `${targets.length} language(s) translated`
          : 'translation failed',
      };
    }
  );

  printSummary(results);
}

function printSummary(results: PhaseResult[]): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Summary');
  console.log(`${'═'.repeat(60)}\n`);
  const icon: Record<PhaseStatus, string> = {
    ok: '✓',
    skipped: '○',
    failed: '✗',
    warn: '⚠',
  };
  for (const r of results) {
    const line = `  ${icon[r.status]} ${r.label.padEnd(28)} ${r.status}${r.detail ? ` — ${r.detail}` : ''}`;
    console.log(line);
  }
  console.log('\nNext: pnpm dev   (or review websites.json and images)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
