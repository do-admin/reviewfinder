#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Copy per-site llm.txt from src/data/<clientId>/<siteId>/llm.txt to public/llm.txt.
 * If the source file is missing, removes public/llm.txt so a previous client’s file
 * is not served by mistake.
 *
 * @param {string} projectRoot
 * @param {string} clientId
 * @param {string} siteId
 * @param {{ silent?: boolean }} [options]
 * @returns {boolean} true if a file was copied from the site folder
 */
export function copyLlmTxtToPublic(projectRoot, clientId, siteId, options = {}) {
  const { silent = false } = options;
  const src = path.join(
    projectRoot,
    'src',
    'data',
    clientId,
    siteId,
    'llm.txt'
  );
  const publicDir = path.join(projectRoot, 'public');
  const dest = path.join(publicDir, 'llm.txt');

  if (!fs.existsSync(src)) {
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
      if (!silent) {
        console.warn(
          `[llm.txt] Removed public/llm.txt — missing src/data/${clientId}/${siteId}/llm.txt`
        );
      }
    } else if (!silent) {
      console.warn(
        `[llm.txt] Skipped — no src/data/${clientId}/${siteId}/llm.txt`
      );
    }
    return false;
  }

  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
  if (!silent) {
    console.log(
      `[llm.txt] public/llm.txt ← src/data/${clientId}/${siteId}/llm.txt`
    );
  }
  return true;
}

function loadEnv(projectRoot) {
  dotenv.config({ path: path.join(projectRoot, '.env.local'), quiet: true });
}

function isMainModule() {
  const self = fileURLToPath(import.meta.url);
  const arg = process.argv[1];
  return arg === self || arg?.endsWith('copy-llm-txt-to-public.mjs');
}

if (isMainModule()) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  loadEnv(projectRoot);
  const clientId = process.argv[2] || process.env.CLIENT_ID;
  const siteId = process.argv[3] || process.env.SITE_ID;
  if (!clientId || !siteId) {
    console.error(
      'Usage: node scripts/lib/copy-llm-txt-to-public.mjs <clientId> <siteId>\n' +
        '   or: set CLIENT_ID and SITE_ID in .env.local'
    );
    process.exit(1);
  }
  copyLlmTxtToPublic(projectRoot, clientId, siteId);
}
