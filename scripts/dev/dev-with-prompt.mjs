/**
 * Runs pnpm dev with interactive client and website selection via enquirer.
 *
 * 1. Prompts user to select a client (from src/data/*)
 * 2. Prompts user to select a website (from that client's websites.json)
 * 3. Runs use-client with the selected values
 * 4. Syncs theme and starts astro dev
 */

import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const DATA_DIR = path.join(ROOT, 'src', 'data');

console.log('ROOT', ROOT);
console.log('DATA_DIR', DATA_DIR);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAvailableClients() {
  return fs.readdirSync(DATA_DIR).filter((f) => {
    const p = path.join(DATA_DIR, f);
    return fs.statSync(p).isDirectory() && f !== 'current';
  });
}

function readWebsitesJson(clientId) {
  const file = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fs.existsSync(file)) {
    console.error(
      `[dev] websites.json not found for client "${clientId}": ${file}`
    );
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!Array.isArray(raw.websites) || raw.websites.length === 0) {
    console.error(`[dev] No websites found in ${file}`);
    process.exit(1);
  }
  return raw;
}

async function promptClientAndWebsite() {
  const { default: enquirer } = await import('enquirer');

  const clients = getAvailableClients();
  if (clients.length === 0) {
    console.error('[dev] No client folders found under src/data/');
    process.exit(1);
  }

  // Filter to clients that have websites.json
  const validClients = clients.filter((c) => {
    const p = path.join(DATA_DIR, c, 'websites.json');
    return fs.existsSync(p);
  });
  if (validClients.length === 0) {
    console.error('[dev] No client folders with websites.json found.');
    process.exit(1);
  }

  let clientId;
  if (validClients.length === 1) {
    clientId = validClients[0];
    console.log(`[dev] Using client: ${clientId}`);
  } else {
    const { client } = await enquirer.prompt({
      type: 'select',
      name: 'client',
      message: 'Which client do you want to run?',
      choices: validClients,
    });
    clientId = client;
  }

  const websitesJson = readWebsitesJson(clientId);
  const websites = websitesJson.websites;
  const topLevelDomain = websitesJson.clientDomain;
  const choices = websites.map((w) => {
    const domain = w.deployDomain ?? w.clientDomain ?? topLevelDomain ?? '';
    const label = `${w.id}${w.business?.name ? ` (${w.business.name})` : ''}${domain ? ` → ${domain}` : ''}`;
    return { name: label, value: w.id };
  });

  let siteId;
  if (choices.length === 1) {
    siteId = choices[0].value;
    console.log(`[dev] Using website: ${siteId}`);
  } else {
    const { site } = await enquirer.prompt({
      type: 'select',
      name: 'site',
      message: `Which website from "${clientId}"?`,
      choices,
      result(name) {
        const choice = this.choices.find((c) => c.name === name);
        return choice ? choice.value : name;
      },
    });
    siteId = site;
  }

  return { clientId, siteId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { clientId, siteId } = await promptClientAndWebsite();

  // Always start with a clean current/ to avoid stale files from previous runs
  const currentPath = path.join(DATA_DIR, 'current');
  if (fs.existsSync(currentPath)) {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.unlinkSync(currentPath);
    } else {
      fs.rmSync(currentPath, { recursive: true });
    }
  }

  // Run use-client script with selected values (non-interactive)
  const useClientResult = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/use-client.ts', clientId, siteId],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, CLIENT_ID: clientId, SITE_ID: siteId },
    }
  );
  if (useClientResult.status !== 0) {
    process.exit(useClientResult.status ?? 1);
  }

  // Symlink individual site data files directly into current/ (flat, not as subfolder)
  const siteDataPath = path.join(DATA_DIR, clientId, siteId);
  if (fs.existsSync(siteDataPath) && fs.statSync(siteDataPath).isDirectory()) {
    for (const file of fs.readdirSync(siteDataPath)) {
      const src = path.join(siteDataPath, file);
      if (!fs.statSync(src).isFile()) continue;
      const dest = path.join(currentPath, file);
      if (fs.existsSync(dest)) continue;
      try {
        fs.symlinkSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
      }
    }
    console.log(
      `[dev] src/data/current/ ← site files from src/data/${clientId}/${siteId}/`
    );
  }

  // Sync theme
  const syncResult = spawnSync(
    'node',
    ['scripts/dev/sync-theme-to-globals.mjs'],
    {
      cwd: ROOT,
      stdio: 'inherit',
    }
  );
  if (syncResult.status !== 0) {
    process.exit(syncResult.status ?? 1);
  }

  // Start astro dev (keep running)
  const astro = spawn('pnpm', ['exec', 'astro', 'dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SITE_ID: siteId },
  });

  astro.on('error', (err) => {
    console.error('[dev] Failed to start astro:', err);
    process.exit(1);
  });

  astro.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[dev]', err);
  process.exit(1);
});
