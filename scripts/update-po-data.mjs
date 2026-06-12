/**
 * Update PO data — one-shot helper that:
 *   1. Pulls all assets from Google Drive into googleDrive/<client>/
 *   2. Organizes drive assets for websites.json (03-organize-drive-assets.mjs)
 *   3. Processes the Excel data into JSON (04-process-excel-data.mjs)
 *
 * The client is selected once (via --client flag or interactive prompt) and
 * forwarded to both sub-scripts so the user is never asked twice.
 *
 * Usage:
 *   pnpm update-po-data                       # interactive client picker
 *   pnpm update-po-data --client=nicezeit     # skip the prompt
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Parse --client flag
// ---------------------------------------------------------------------------
const clientArg = process.argv
  .slice(2)
  .find((a) => a.startsWith('--client='))
  ?.slice('--client='.length)
  .trim() || null;

// ---------------------------------------------------------------------------
// Discover available clients
// ---------------------------------------------------------------------------
function discoverClients() {
  const dataDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== 'current' &&
        !e.name.startsWith('_') &&
        !e.name.startsWith('.') &&
        fs.existsSync(path.join(dataDir, e.name, 'websites.json'))
    )
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Resolve client (flag → auto → prompt)
// ---------------------------------------------------------------------------
async function resolveClient() {
  const clients = discoverClients();

  if (clients.length === 0) {
    console.error('No client folders with websites.json found in src/data/.');
    process.exit(1);
  }

  if (clientArg) {
    if (!clients.includes(clientArg)) {
      console.error(
        `Client "${clientArg}" not found. Available: ${clients.join(', ')}`
      );
      process.exit(1);
    }
    return clientArg;
  }

  if (clients.length === 1) {
    console.log(`Using client: ${clients[0]}`);
    return clients[0];
  }

  const { default: enquirer } = await import('enquirer');
  const { selected } = await enquirer.prompt({
    type: 'select',
    name: 'selected',
    message: 'Which client?',
    choices: clients,
  });
  return selected;
}

// ---------------------------------------------------------------------------
// Run a command, exit on failure
// ---------------------------------------------------------------------------
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\n✗ Command failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const clientId = await resolveClient();

console.log(`\n▶ [1/3] Pulling Google Drive assets for "${clientId}"…\n`);
run('node', [
  '--no-warnings=punycode',
  'scripts/02-pull-from-google-drive.mjs',
  `--client=${clientId}`,
]);

console.log(`\n▶ [2/3] Organizing drive assets for "${clientId}"…\n`);
run('node', ['scripts/03-organize-drive-assets.mjs', `--client=${clientId}`]);

console.log(`\n▶ [3/3] Processing Excel data for "${clientId}"…\n`);
run('node', [
  'scripts/04-process-excel-data.mjs',
  `--client=${clientId}`,
]);

console.log('\n✓ Done');
