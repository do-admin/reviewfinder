#!/usr/bin/env node
/**
 * Run translation first, then in parallel (different outputs; grounding touches
 * websites.json only after translate is done):
 *   - text-editor/scripts/generate-llm-txt.mjs
 *   - scripts/generate-grounding.mjs
 *   - scripts/generate-internal-links.mjs
 *
 * Usage:
 *   pnpm run parallel-ai-pipeline
 *   pnpm run parallel-ai-pipeline -- --client=cube-guesthouse --site=hout-bay-guest-house
 *   pnpm run parallel-ai-pipeline -- --skip-translate   # only llm.txt + grounding + internal-links
 *
 * Env: CLIENT_ID / SITE_ID also work (SITE_ID → site id for llm.txt only; grounding is per client).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import enquirer from 'enquirer';

const { Select } = enquirer;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'src', 'data');

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function getClients() {
  if (!fileExists(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => {
      const p = path.join(DATA_DIR, f);
      return (
        fs.statSync(p).isDirectory() &&
        f !== 'current' &&
        f !== '_template' &&
        fileExists(path.join(p, 'websites.json'))
      );
    })
    .sort();
}

function getSiteIds(clientId) {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const websites = Array.isArray(raw) ? raw : raw.websites ?? [];
    return websites.map((w) => w.id).filter(Boolean);
  } catch {
    return [];
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let clientId = process.env.CLIENT_ID?.trim() || null;
  let siteId = process.env.SITE_ID?.trim() || null;
  let skipTranslate = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--skip-translate') {
      skipTranslate = true;
      continue;
    }
    if (a.startsWith('--client=')) {
      clientId = a.slice('--client='.length).trim() || clientId;
      continue;
    }
    if (a === '--client' && args[i + 1]) {
      clientId = args[++i].trim();
      continue;
    }
    if (a.startsWith('--site=')) {
      siteId = a.slice('--site='.length).trim() || siteId;
      continue;
    }
    if (a === '--site' && args[i + 1]) {
      siteId = args[++i].trim();
      continue;
    }
  }
  return { clientId, siteId, skipTranslate };
}

function runNode(scriptRelative, scriptArgs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT, scriptRelative);
    const child = spawn(
      process.execPath,
      [scriptPath, ...scriptArgs],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, ...extraEnv },
      }
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(scriptRelative)} exited with ${code}`));
    });
    child.on('error', reject);
  });
}

function runPnpmExecTsx(scriptRelative, extraEnv = {}, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'tsx', scriptRelative, ...extraArgs],
      {
        cwd: ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: { ...process.env, ...extraEnv },
      }
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptRelative} exited with ${code}`));
    });
    child.on('error', reject);
  });
}

async function pickClient() {
  const clients = getClients();
  if (clients.length === 0) {
    console.error('No client folders with websites.json found in src/data/.');
    process.exit(1);
  }
  if (clients.length === 1) return clients[0];
  return new Select({
    name: 'clientId',
    message: 'Which client?',
    choices: clients.map((c) => ({ name: c, message: c })),
  }).run();
}

async function pickSite(clientId) {
  const sites = getSiteIds(clientId);
  if (sites.length === 0) {
    console.error(`No sites found in src/data/${clientId}/websites.json.`);
    process.exit(1);
  }
  if (sites.length === 1) return sites[0];
  return new Select({
    name: 'siteId',
    message: 'Which site?',
    choices: sites.map((s) => ({ name: s, message: s })),
  }).run();
}

async function main() {
  let { clientId, siteId, skipTranslate } = parseArgs();

  if (!clientId) clientId = await pickClient();
  if (!siteId) siteId = await pickSite(clientId);

  console.log(
    `\n══ Parallel AI pipeline: client=${clientId} site=${siteId} skipTranslate=${skipTranslate} ══\n`
  );

  if (!skipTranslate) {
    console.log('▶ Phase 1: translate-data\n');
    await runPnpmExecTsx(
      'scripts/translation/translate-data.ts',
      { CLIENT_ID: clientId },
      ['--sites=all']
    );
    console.log('\n✓ translate-data finished\n');
  } else {
    console.log('⏭  Skipping translate-data (--skip-translate)\n');
  }

  console.log('▶ Phase 2 (parallel): llm.txt + grounding + internal-links\n');

  const tasks = [
    {
      label: 'llm.txt',
      run: () =>
        runNode('text-editor/scripts/generate-llm-txt.mjs', [clientId, siteId]),
    },
    {
      label: 'grounding',
      run: () => runNode('scripts/generate-grounding.mjs', [clientId]),
    },
    {
      label: 'internal-links',
      run: () => runNode('scripts/generate-internal-links.mjs', [clientId]),
    },
  ];

  const outcomes = await Promise.allSettled(tasks.map((t) => t.run()));

  let failed = false;
  outcomes.forEach((result, i) => {
    const name = tasks[i].label;
    if (result.status === 'fulfilled') {
      console.log(`✓ ${name}: ok`);
    } else {
      failed = true;
      console.error(`✗ ${name}: ${result.reason?.message || result.reason}`);
    }
  });

  if (failed) {
    console.error('\n✗ One or more parallel steps failed.');
    process.exit(1);
  }

  console.log('\n✓ Parallel AI pipeline completed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
