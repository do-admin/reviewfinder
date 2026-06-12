/**
 * Interactively sets the active client and site for dev/build.
 *
 * 1. Lists all client folders under src/data/ and asks the user to pick one.
 * 2. Populates src/data/current with the chosen client's shared config files only
 *    (no site subdirectories — those are linked by pnpm dev for the selected site).
 * 3. Lists all websites from that client's websites.json and asks the user to pick one.
 * 4. Writes CLIENT_ID, SITE_ID (and DEPLOY_DOMAIN) into .env.local.
 *
 * Non-interactive fallback (skips prompts when both are supplied):
 *   pnpm use-client <clientId> <siteId>
 *   CLIENT_ID=nicezeit SITE_ID=eisdiele-linden pnpm use-client
 *
 * Client only (symlink src/data/current + CLIENT_ID in .env.local, no SITE_ID):
 *   pnpm use-client -- --activate-only <clientId>
 */

import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { copyClientFaviconToPublic } from './lib/copy-client-favicon-to-public.mjs';
import { copyLlmTxtToPublic } from './lib/copy-llm-txt-to-public.mjs';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const CURRENT_PATH = path.join(DATA_DIR, 'current');
const ENV_LOCAL = path.join(process.cwd(), '.env.local');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_INTERNAL_LINKS = {
  generatedAt: new Date(0).toISOString(),
  version: 1,
  pageCount: 0,
  linkCount: 0,
  links: {},
};

function ensureInternalLinksJsonExists(): void {
  const p = path.join(CURRENT_PATH, 'internalLinks.json');
  if (fs.existsSync(p)) return;
  fs.writeFileSync(p, JSON.stringify(EMPTY_INTERNAL_LINKS, null, 2), 'utf-8');
}

function getAvailableClients(): string[] {
  return fs.readdirSync(DATA_DIR).filter((f) => {
    const p = path.join(DATA_DIR, f);
    return fs.statSync(p).isDirectory() && f !== 'current';
  });
}

interface WebsiteEntry {
  id: string;
  business?: { name?: string };
  clientDomain?: string;
  deployDomain?: string;
}

interface WebsitesJson {
  clientDomain?: string;
  websites: WebsiteEntry[];
}

function readWebsitesJson(clientId: string): WebsitesJson {
  const file = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fs.existsSync(file)) {
    console.error(`Client data not found for "${clientId}". Has this client been set up?`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as WebsitesJson;
  if (!Array.isArray(raw.websites) || raw.websites.length === 0) {
    console.error(`No websites found for client "${clientId}". Check websites.json.`);
    process.exit(1);
  }
  return raw;
}

function removeCurrent(): void {
  if (!fs.existsSync(CURRENT_PATH)) return;
  const stat = fs.lstatSync(CURRENT_PATH);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fs.unlinkSync(CURRENT_PATH);
  } else {
    fs.rmSync(CURRENT_PATH, { recursive: true });
  }
}

function switchClient(clientId: string): void {
  const clientPath = path.join(DATA_DIR, clientId);
  removeCurrent();

  fs.mkdirSync(CURRENT_PATH, { recursive: true });

  const entries = fs.readdirSync(clientPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(clientPath, entry.name);
    const dest = path.join(CURRENT_PATH, entry.name);
    try {
      fs.symlinkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
    }
  }

  // internalLinks.json is optional but must exist for Vite module resolution
  ensureInternalLinksJsonExists();

  console.log(`  ✓ Activated client: ${clientId}`);
  copyClientFaviconToPublic(process.cwd(), clientId, { required: false });
}

/**
 * Symlink per-website data files (e.g. faq.json, faq-xxl.json, partners.json)
 * from the selected website's subdirectory into src/data/current/.
 */
function linkPerWebsiteFiles(clientId: string, siteId: string): void {
  const sitePath = path.join(DATA_DIR, clientId, siteId);
  if (!fs.existsSync(sitePath) || !fs.statSync(sitePath).isDirectory()) return;

  const entries = fs.readdirSync(sitePath, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(sitePath, entry.name);
    const dest = path.join(CURRENT_PATH, entry.name);
    if (fs.existsSync(dest)) continue; // don't overwrite shared client files
    try {
      fs.symlinkSync(src, dest);
      count++;
    } catch {
      fs.copyFileSync(src, dest);
      count++;
    }
  }
  if (count > 0) {
    // per-website files linked silently
    void count;
  }

  // If a site provides an internalLinks.json, it will be linked above. Otherwise keep empty stub.
  ensureInternalLinksJsonExists();
}

/** Set only CLIENT_ID; clear SITE_ID / DEPLOY_DOMAIN (e.g. before clone-website picks a site). */
function writeClientIdOnlyEnv(clientId: string): void {
  let content = '';
  if (fs.existsSync(ENV_LOCAL)) {
    const lines = fs.readFileSync(ENV_LOCAL, 'utf-8').split('\n');
    const filtered = lines.filter(
      (l) =>
        !l.startsWith('CLIENT_ID=') &&
        !l.startsWith('SITE_ID=') &&
        !l.startsWith('DEPLOY_DOMAIN='),
    );
    content = filtered.join('\n').replace(/\n+$/, '');
    if (content) content += '\n';
  }
  content += `CLIENT_ID=${clientId}\n`;
  fs.writeFileSync(ENV_LOCAL, content, 'utf-8');
  console.log(`  Active client: ${clientId}`);
}

function writeSiteEnv(clientId: string, siteId: string, deployDomain?: string): void {
  let content = '';
  if (fs.existsSync(ENV_LOCAL)) {
    const lines = fs.readFileSync(ENV_LOCAL, 'utf-8').split('\n');
    const filtered = lines.filter(
      (l) =>
        !l.startsWith('CLIENT_ID=') &&
        !l.startsWith('SITE_ID=') &&
        !l.startsWith('DEPLOY_DOMAIN='),
    );
    content = filtered.join('\n').replace(/\n+$/, '');
    if (content) content += '\n';
  }
  content += `CLIENT_ID=${clientId}\n`;
  content += `SITE_ID=${siteId}\n`;
  if (deployDomain) content += `DEPLOY_DOMAIN=${deployDomain}\n`;
  fs.writeFileSync(ENV_LOCAL, content, 'utf-8');
  const domainSuffix = deployDomain ? ` (${deployDomain})` : '';
  console.log(`  Active: ${clientId} / ${siteId}${domainSuffix}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const activateIdx = process.argv.indexOf('--activate-only');
  if (activateIdx !== -1) {
    const clientId = process.argv[activateIdx + 1];
    if (!clientId || clientId.startsWith('-')) {
      console.error(
        'Usage: pnpm use-client -- --activate-only <clientId>',
      );
      process.exit(1);
    }
    const clients = getAvailableClients();
    if (!clients.includes(clientId)) {
      console.error(
        `Unknown client "${clientId}". Available: ${clients.join(', ')}`,
      );
      process.exit(1);
    }
    switchClient(clientId);
    writeClientIdOnlyEnv(clientId);
    return;
  }

  const clients = getAvailableClients();
  if (clients.length === 0) {
    console.error('No client folders found. Run the onboarding first.');
    process.exit(1);
  }

  // --- Client selection ---
  const argClient = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : undefined;
  const envClient = process.env.CLIENT_ID;

  let clientId: string;
  if (argClient && clients.includes(argClient)) {
    clientId = argClient;
  } else if (envClient && clients.includes(envClient)) {
    clientId = envClient;
  } else {
    const answer = await inquirer.prompt<{ client: string }>([
      {
        type: 'list',
        name: 'client',
        message: 'Select a client:',
        choices: clients,
      },
    ]);
    clientId = answer.client;
  }

  switchClient(clientId);

  // --- Site selection ---
  const websitesJson = readWebsitesJson(clientId);
  const websites = websitesJson.websites;
  const topLevelDomain = websitesJson.clientDomain;

  const argSite = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : undefined;
  const envSite = process.env.SITE_ID;

  let siteId: string;
  if (argSite && websites.some((w) => w.id === argSite)) {
    siteId = argSite;
  } else if (envSite && websites.some((w) => w.id === envSite)) {
    siteId = envSite;
  } else {
    const choices = websites.map((w) => {
      const domain = w.deployDomain ?? w.clientDomain ?? topLevelDomain;
      return {
        name: `${w.id}${w.business?.name ? `  (${w.business.name})` : ''}${domain ? `  → ${domain}` : ''}`,
        value: w.id,
      };
    });

    const answer = await inquirer.prompt<{ site: string }>([
      {
        type: 'list',
        name: 'site',
        message: `Select a website from "${clientId}":`,
        choices,
        pageSize: 20,
      },
    ]);
    siteId = answer.site;
  }

  const selectedWebsite = websites.find((w) => w.id === siteId);
  writeSiteEnv(clientId, siteId, selectedWebsite?.deployDomain ?? selectedWebsite?.clientDomain ?? topLevelDomain);
  linkPerWebsiteFiles(clientId, siteId);
  copyLlmTxtToPublic(process.cwd(), clientId, siteId);
}

main();
