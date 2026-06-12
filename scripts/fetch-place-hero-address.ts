/**
 * Fetches formattedAddress from Google Places and writes `home.hero.card2Line1/2` (and
 * empty `business.locationAddress` when addressComponents are available). Same logic as
 * `apply-google-place-hero-address.ts` used from clone-website / 06-generate-website.
 *
 * Client / site:
 *   - `--client-id=<id>` or `--client=<id>` — always uses that client (no client prompt)
 *   - `--site-id=<id>` or `--website-id=<id>` — that website entry only
 *   - TTY: enquirer prompts for client, then for site (from websites.json id list)
 *   - Non-interactive: set both flags or set CLIENT_ID + one site flag
 *
 * Usage:
 *   pnpm run fetch-place-hero-address
 *   pnpm run fetch-place-hero-address -- --client=tiemann-photography
 *   pnpm run fetch-place-hero-address -- --client-id=tiemann-photography --site-id=hochzeitsfotograf-hamburg
 *
 * Debugging:
 *   - By default, prints `[place-address:debug] …` lines (API URL, page names, fallbacks, etc.)
 *   - Pass `--quiet` to hide debug lines; pass `--verbose` to force the same (alias for clarity)
 *   - `PLACE_ADDRESS_DEBUG=0` in .env can be used to reduce noise if we ever read that (optional; --quiet is preferred)
 *
 * Requires: GOOGLE_PLACES_API_KEY in .env.local; `business.googlePlacesId` on the site.
 */

import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { applyGooglePlaceAddressToWebsiteEntry } from './lib/apply-google-place-hero-address';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function wantApplyDebug(): boolean {
  if (process.env.PLACE_ADDRESS_DEBUG === '0' || process.env.PLACE_ADDRESS_DEBUG === 'false') {
    return false;
  }
  if (process.argv.includes('--quiet')) {
    return false;
  }
  // Default: debug on for this script (`--verbose` is implicit; use --quiet to hide traces)
  return true;
}

const DATA_ROOT = path.join(process.cwd(), 'src', 'data');

type WebsiteEntry = {
  id?: string;
  business?: { googlePlacesId?: string };
  pages?: unknown;
  [key: string]: unknown;
};

type WebsitesFile = WebsiteEntry[] | { shared?: unknown; websites: WebsiteEntry[] };

function getArgValue(prefix: string): string | undefined {
  const raw = process.argv.find((a) => a.startsWith(prefix));
  if (!raw) return undefined;
  const v = raw.slice(prefix.length).trim();
  return v || undefined;
}

function parseClientAndSiteFromArgv(): { client: string | undefined; site: string | undefined } {
  const client =
    getArgValue('--client-id=') ??
    getArgValue('--client=');
  const site =
    getArgValue('--site-id=') ??
    getArgValue('--website-id=');
  return { client, site };
}

function getAvailableClients(): string[] {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs
    .readdirSync(DATA_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'current' && d.name !== '_template')
    .map((d) => d.name);
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function readWebsitesFile(filePath: string): WebsiteEntry[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as WebsitesFile;
  return Array.isArray(data) ? data : (data.websites ?? []);
}

function writeWebsitesFile(
  filePath: string,
  websites: WebsiteEntry[]
): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const current = JSON.parse(raw) as WebsitesFile;
  if (Array.isArray(current)) {
    fs.writeFileSync(filePath, JSON.stringify(websites, null, 2) + '\n');
  } else {
    const updated = { ...current, websites };
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n');
  }
}

function getWebsiteDataFiles(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir)
    .filter(
      (f) =>
        f === 'websites.json' || (f.startsWith('websites-') && f.endsWith('.json'))
    )
    .map((f) => path.join(dataDir, f));
}

function listSiteIdsFromWebsitesJson(websitesJsonPath: string): string[] {
  if (!fs.existsSync(websitesJsonPath)) return [];
  const websites = readWebsitesFile(websitesJsonPath);
  return websites
    .map((w) => w.id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .sort();
}

async function promptClientId(): Promise<string> {
  const clients = getAvailableClients();
  if (clients.length === 0) {
    console.error('No client folders found in src/data/ (excluding _template).');
    process.exit(1);
  }
  try {
    const { default: enquirer } = await import('enquirer');
    const { clientId } = await enquirer.prompt<{ clientId: string }>({
      type: 'select',
      name: 'clientId',
      message: 'Which client?',
      choices: clients,
    });
    return clientId;
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e?.name === 'ExitPromptError' || e?.message?.includes('User force closed')) {
      process.exit(0);
    }
    throw err;
  }
}

async function promptSiteId(choices: string[]): Promise<string> {
  if (choices.length === 0) {
    console.error('No website ids found in websites.json for this client.');
    process.exit(1);
  }
  try {
    const { default: enquirer } = await import('enquirer');
    const { siteId } = await enquirer.prompt<{ siteId: string }>({
      type: 'select',
      name: 'siteId',
      message: 'Which site (website id)?',
      choices,
    });
    return siteId;
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e?.name === 'ExitPromptError' || e?.message?.includes('User force closed')) {
      process.exit(0);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  if (!process.env.GOOGLE_PLACES_API_KEY?.trim()) {
    console.error('GOOGLE_PLACES_API_KEY is not set in .env.local');
    process.exit(1);
  }

  const argvClientSite = parseClientAndSiteFromArgv();
  const envClientId = process.env.CLIENT_ID?.trim() || undefined;

  let clientId: string;
  if (argvClientSite.client) {
    clientId = argvClientSite.client;
  } else if (envClientId && !isInteractiveTerminal()) {
    clientId = envClientId;
  } else if (isInteractiveTerminal()) {
    clientId = await promptClientId();
  } else {
    console.error(
      'Non-interactive: pass --client-id=<id> or --client=<id>, or set CLIENT_ID.'
    );
    process.exit(1);
  }

  const dataDir = path.join(DATA_ROOT, clientId);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    console.error(`Client folder not found: ${dataDir}`);
    process.exit(1);
  }

  const websitesJsonPath = path.join(dataDir, 'websites.json');
  if (!fs.existsSync(websitesJsonPath)) {
    console.error(`websites.json not found: ${websitesJsonPath}`);
    process.exit(1);
  }

  let siteId: string;
  if (argvClientSite.site) {
    siteId = argvClientSite.site;
  } else if (isInteractiveTerminal()) {
    const ids = listSiteIdsFromWebsitesJson(websitesJsonPath);
    siteId = await promptSiteId(ids);
  } else {
    console.error(
      'Non-interactive: pass --site-id=<id> or --website-id=<id> (e.g. kebab-case website id from websites.json).'
    );
    process.exit(1);
  }

  const allIds = new Set(listSiteIdsFromWebsitesJson(websitesJsonPath));
  if (allIds.size > 0 && !allIds.has(siteId)) {
    console.error(
      `No website with id "${siteId}" in ${path.relative(process.cwd(), websitesJsonPath)}.`
    );
    process.exit(1);
  }

  const files = getWebsiteDataFiles(dataDir);
  if (files.length === 0) {
    console.error(`No websites*.json in ${dataDir}`);
    process.exit(1);
  }

  const applyDebug = wantApplyDebug();

  console.log(`\nfetch-place-hero-address — client: ${clientId} — site: ${siteId}`);
  if (applyDebug) {
    console.log('  (debug: on — use --quiet to hide [place-address:debug] lines)\n');
  } else {
    console.log();
  }

  let anyUpdated = false;
  let entryHits = 0;
  for (const filePath of files) {
    const websites = readWebsitesFile(filePath);
    let changed = false;
    const inThisFile = websites.filter((w) => w.id === siteId);
    if (applyDebug) {
      console.log(
        `  [fetch-place-hero-address:debug] file ${path.basename(filePath)} — ${websites.length} site row(s), ${inThisFile.length} match id "${siteId}"`
      );
    }
    for (const w of inThisFile) {
      entryHits++;
      // eslint-disable-next-line no-await-in-loop -- one entry per file; N files = N Places calls
      const ok = await applyGooglePlaceAddressToWebsiteEntry(
        w as Record<string, unknown>,
        { debug: applyDebug }
      );
      if (ok) {
        anyUpdated = true;
        changed = true;
      }
    }
    if (changed) {
      writeWebsitesFile(filePath, websites);
      console.log(`Updated ${path.relative(process.cwd(), filePath)}`);
    }
  }

  if (entryHits === 0) {
    console.error(
      `No data row with id "${siteId}" in any of ${files.length} website JSON file(s) under ${dataDir} — data file sync issue.`
    );
    process.exitCode = 1;
  } else if (!anyUpdated) {
    console.log(
      'No address applied (check business.googlePlacesId, API key, and Places API response).'
    );
    if (!applyDebug) {
      console.log('  Re-run with --verbose (or do not use --quiet) to print [place-address:debug] details.\n');
    } else {
      process.stdout.write('\n');
    }
    process.exitCode = 1;
  } else {
    console.log('\nDone.');
  }
}

function handleEnquirerExit(err: unknown): void {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'ExitPromptError' || e?.message?.includes('User force closed')) {
    process.exit(0);
  }
}

main().catch((err) => {
  handleEnquirerExit(err);
  console.error(err);
  process.exit(1);
});
