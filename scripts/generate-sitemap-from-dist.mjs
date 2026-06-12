#!/usr/bin/env node

/**
 * Generate sitemap.xml from the Astro static build output (dist/).
 * Called automatically after `astro build` via the `build` npm script.
 *
 * Strategy: walk dist/ for every index.html, convert the directory path to
 * a canonical URL, apply priority/changefreq rules, then write dist/sitemap.xml.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { normalizePublicUrl } from './lib/normalize-public-url.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env.local'), quiet: true });
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

const DIST_DIR = path.join(projectRoot, 'dist');

// Same canonical-URL source as astro.config.mjs: `clientDomain` first,
// `deployDomain` as fallback. DEPLOY_DOMAIN env not consulted (raw target ≠ canonical).
function getDefaultSiteUrl() {
  try {
    const websitesPath = path.join(projectRoot, 'src', 'data', 'current', 'websites.json');
    const data = JSON.parse(fs.readFileSync(websitesPath, 'utf-8'));
    const websites = Array.isArray(data) ? data : (data.websites ?? []);
    const topLevelDomain = !Array.isArray(data) ? data.clientDomain : undefined;
    const siteId = process.env.SITE_ID ?? '';
    const selectedWebsite = siteId
      ? websites.find((w) => w?.id === siteId)
      : websites[0];
    const domain =
      selectedWebsite?.clientDomain ??
      topLevelDomain ??
      selectedWebsite?.deployDomain ??
      websites[0]?.clientDomain ??
      topLevelDomain ??
      websites[0]?.deployDomain;
    if (domain) {
      const url = domain.startsWith('http') ? domain : `https://${domain}`;
      return normalizePublicUrl(url);
    }
  } catch {
    // No current client data available
  }
  return normalizePublicUrl('https://example.com');
}

const SITE_URL = normalizePublicUrl(process.env.SITE_URL || getDefaultSiteUrl());

// ── Exclusions ────────────────────────────────────────────────────────────────
// Legal / utility pages that should not appear in the sitemap.
const EXCLUDE_PATTERNS = [
  /\/404(\/|$)/,
  /\/coming-soon(\/|$)/,   // noIndex placeholder for ungenerated pages
];

// ── Priority & changefreq rules ───────────────────────────────────────────────
/**
 * Derive sitemap metadata from a root-relative URL path such as "/de/hannover/".
 * Rules are applied in order; the first match wins.
 */
function getUrlMeta(urlPath) {
  const segments = urlPath.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  const depth = segments.length;
  const lastSegment = segments[segments.length - 1] ?? '';

  // Root index (redirect page, /index.html)
  if (depth === 0) {
    return { changefreq: 'weekly', priority: '1.0' };
  }

  // Language home pages: /de/, /en/, ...
  if (depth === 1) {
    return { changefreq: 'weekly', priority: '1.0' };
  }

  // Ratgeber article pages: /de/ratgeber/<slug>/
  if (depth === 3 && segments[1] === 'ratgeber') {
    return { changefreq: 'monthly', priority: '0.6' };
  }

  // Ratgeber listing page: /de/ratgeber/
  if (depth === 2 && lastSegment === 'ratgeber') {
    return { changefreq: 'weekly', priority: '0.8' };
  }

  // Secondary / editorial pages (internal page names + common localized EN slugs)
  const secondaryPages = new Set([
    'faq',
    'ueber-uns',
    'about-us',
    'kontakt',
    'team',
    'galerie',
    'grounding',
  ]);
  if (depth === 2 && secondaryPages.has(lastSegment)) {
    return { changefreq: 'monthly', priority: '0.7' };
  }

  // Legal pages — low priority, rarely changes
  const legalPages = new Set([
    'impressum',
    'datenschutz',
    'imprint',
    'privacy-policy',
  ]);
  if (depth === 2 && legalPages.has(lastSegment)) {
    return { changefreq: 'yearly', priority: '0.3' };
  }

  // Other language-prefixed pages at depth 2 (e.g. /de/faq/)
  if (depth === 2) {
    return { changefreq: 'weekly', priority: '0.8' };
  }

  // Anything deeper
  return { changefreq: 'monthly', priority: '0.5' };
}

// ── File discovery ────────────────────────────────────────────────────────────
/**
 * Recursively collect all index.html files under `dir`.
 * Returns root-relative URL paths such as "/de/hannover/".
 */
function collectUrlPaths(dir, baseDir = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectUrlPaths(fullPath, baseDir));
    } else if (entry.name === 'index.html') {
      const rel = path.relative(baseDir, path.dirname(fullPath));
      // Normalise Windows separators; empty rel means root index.html
      const urlPath = rel === '' || rel === '.'
        ? '/'
        : '/' + rel.replace(/\\/g, '/') + '/';
      results.push(urlPath);
    }
  }

  return results;
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildXml(entries) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const entry of entries) {
    lines.push(
      '  <url>',
      `    <loc>${escapeXml(entry.loc)}</loc>`,
      `    <lastmod>${entry.lastmod}</lastmod>`,
      `    <changefreq>${entry.changefreq}</changefreq>`,
      `    <priority>${entry.priority}</priority>`,
      '  </url>',
    );
  }
  lines.push('</urlset>');
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (!fs.existsSync(DIST_DIR)) {
  console.error(`[Sitemap] ❌ dist/ not found at ${DIST_DIR} — run 'pnpm build' first.`);
  process.exit(1);
}

const today = new Date().toISOString().split('T')[0];

const allPaths = collectUrlPaths(DIST_DIR);

const filteredPaths = allPaths.filter(
  (p) => !EXCLUDE_PATTERNS.some((re) => re.test(p)),
);

const entries = filteredPaths.map((urlPath) => {
  const { changefreq, priority } = getUrlMeta(urlPath);
  const pathNoTrail = urlPath.replace(/\/+$/, '') || '';
  const loc = normalizePublicUrl(pathNoTrail ? `${SITE_URL}${pathNoTrail}` : SITE_URL);
  return { loc, lastmod: today, changefreq, priority };
});

// Sort by priority descending, then alphabetically for deterministic output.
entries.sort((a, b) => {
  const pd = parseFloat(b.priority) - parseFloat(a.priority);
  return pd !== 0 ? pd : a.loc.localeCompare(b.loc);
});

const xml = buildXml(entries);
const sitemapPath = path.join(DIST_DIR, 'sitemap.xml');
fs.writeFileSync(sitemapPath, xml, 'utf8');

const robotsPath = path.join(DIST_DIR, 'robots.txt');
const robotsContent = `User-agent: *
Disallow:

Sitemap: ${SITE_URL}/sitemap.xml
`;
fs.writeFileSync(robotsPath, robotsContent, 'utf8');

console.log(`[Sitemap] ✅ ${sitemapPath}`);
console.log(`[Sitemap]    Base URL  : ${SITE_URL}`);
console.log(`[Sitemap]    Pages     : ${entries.length}`);
console.log(`[Robots] ✅ ${robotsPath}`);
