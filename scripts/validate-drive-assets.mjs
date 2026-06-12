/**
 * validate-drive-assets.mjs
 *
 * Validates the completeness and naming of files pulled from Google Drive.
 * For every site folder found under googleDrive/, checks:
 *
 *   Folder structure:
 *     01-content/faq/
 *     01-content/partners/
 *     02-images/gallerie/
 *     02-images/hero/
 *     02-images/info-section/
 *     02-images/logo/
 *     02-images/partnerLogos/
 *     02-images/team/
 *     02-images/ueber uns/
 *
 *   Content files:
 *     faq/          → one file ending in faq-xxl.json, one ending in faq.json
 *     partners/     → partners.json (exact name); each entry `src` (or legacy `logo`)
 *                     must match a file in 02-images/partnerLogos/ (URLs use /images/trustblock/…)
 *
 *   Image files (each folder must contain an image with the correct suffix):
 *     hero/         → {siteId}-hero.{ext}
 *     info-section/ → {siteId}-info.{ext}
 *     logo/         → *-logo.{ext}
 *     team/         → *-team.{ext}
 *     ueber uns/    → *-ueber-uns.{ext}
 *     gallerie/     → 8 images with -gallerie-1 through -gallerie-8
 *     partnerLogos/ → at least one image
 *
 * Usage:
 *   pnpm validate-drive-assets                       # validate all clients
 *   pnpm validate-drive-assets --client=caralingua   # validate one client only
 *   pnpm validate-drive-assets --output=report.md    # custom output path
 *
 * If you pass --client=<id> and googleDrive/<slug>/ is missing (slug = slugify(clientName)
 * from websites.json, same as pull-from-google-drive), the script runs
 * pull-from-google-drive --client=<id> once, then validates.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import enquirer from 'enquirer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GOOGLE_DRIVE_DIR = path.join(ROOT, 'googleDrive');

/** Same slug rules as 02-pull-from-google-drive.mjs / 03-organize-drive-assets.mjs */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c])
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Read src/data/<clientId>/websites.json for Drive folder slug + id. */
function readClientWebsitesMeta(clientId) {
  const wp = path.join(ROOT, 'src', 'data', clientId, 'websites.json');
  if (!fs.existsSync(wp)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(wp, 'utf-8'));
    const driveFolderName = data.clientName
      ? slugify(data.clientName)
      : clientId;
    return {
      driveFolderName,
      driveFolderId: data.driveFolderId || null,
    };
  } catch {
    return null;
  }
}

function runPullFromDrive(clientId, driveFolderName) {
  const pullScript = path.join(__dirname, '02-pull-from-google-drive.mjs');
  console.log(
    `[validate] No folder at googleDrive/${driveFolderName}/ — running pull-from-google-drive…\n`
  );
  const r = spawnSync(
    process.execPath,
    [pullScript, `--client=${clientId}`],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.status !== 0) {
    console.error('[validate] pull-from-google-drive failed.');
    process.exit(r.status ?? 1);
  }
}

const REQUIRED_FOLDERS = [
  '01-content/faq',
  '01-content/partners',
  '02-images/hero',
  '02-images/info-section',
  '02-images/logo',
  '02-images/partnerLogos',
  '02-images/team',
  '02-images/ueber uns',
];

const ALTERNATIVE_REQUIRED_FOLDERS = {
  '02-images/gallerie': ['02-images/gallery'],
};

/**
 * Segments under /images/... that map to 02-images/partnerLogos in Drive
 * (see organize-drive-assets IMAGE_CATEGORY_DEFAULTS.partnerLogos → trustblock).
 */
const PARTNER_LOGOS_URL_SEGMENTS = new Set([
  'trustblock',
  'partnerlogos',
  'partner-logos',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let client = null;
  let outputFile = path.join(GOOGLE_DRIVE_DIR, 'validation-report.md');

  for (const a of args) {
    if (a.startsWith('--client='))
      client = a.slice('--client='.length).trim() || null;
    if (a.startsWith('--output='))
      outputFile = a.slice('--output='.length).trim();
  }
  return { client, outputFile };
}

/**
 * Derive the siteId used in filenames from the folder name.
 * Folders prefixed with "site-" use domain notation (last segment becomes TLD with dot).
 * All other folders use the folder name as-is.
 */
function getSiteId(folderName) {
  const name = folderName.trim();
  if (name.startsWith('site-')) {
    const withoutPrefix = name.replace(/^site-/, '');
    // Convert trailing -com / -de / -org / -net etc. to .tld
    return withoutPrefix.replace(/-([a-z]{2,4})$/, '.$1');
  }
  return name;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

function isImageFile(name) {
  return /\.(webp|jpg|jpeg|png|gif|svg|avif)$/i.test(name);
}

function discoverClientDirs() {
  if (!fs.existsSync(GOOGLE_DRIVE_DIR)) return [];
  return fs
    .readdirSync(GOOGLE_DRIVE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

function discoverClientIdsFromData() {
  const dataDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => {
      if (!e.isDirectory() && !e.isSymbolicLink()) return false;
      if (
        e.name === 'current' ||
        e.name === '_template' ||
        e.name.startsWith('.')
      ) {
        return false;
      }
      return fs.existsSync(path.join(dataDir, e.name, 'websites.json'));
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

async function promptClientFilter() {
  const clients = discoverClientIdsFromData();
  if (clients.length === 0) return null;
  const choices = [
    { name: '__all__', message: 'All clients' },
    ...clients.map((client) => ({ name: client, message: client })),
  ];
  const { client } = await enquirer.prompt({
    type: 'select',
    name: 'client',
    message: 'Which client should be validated?',
    choices,
  });
  if (client === '__all__') return null;
  return client;
}

function discoverSiteDirs(clientDir) {
  if (!fs.existsSync(clientDir)) return [];
  return fs
    .readdirSync(clientDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .filter((e) => {
      const siteDir = path.join(clientDir, e.name);
      return (
        fs.existsSync(path.join(siteDir, '01-content')) ||
        fs.existsSync(path.join(siteDir, '02-images'))
      );
    })
    .map((e) => e.name);
}

function resolveExistingPath(baseDir, preferredPath, alternatives = []) {
  const candidates = [preferredPath, ...alternatives];
  for (const rel of candidates) {
    const abs = path.join(baseDir, rel);
    if (fs.existsSync(abs)) return { rel, abs };
  }
  return null;
}

function decodePathSegment(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolve partners.json `src` (or synthesized from `logo`) to an expected basename in partnerLogos.
 * @returns {{ type: 'skip' } | { type: 'external' } | { type: 'invalid', reason: string } | { type: 'not-partner-path', reason: string } | { type: 'ok', basename: string }}
 */
function partnerEntryToExpectedBasename(src) {
  if (typeof src !== 'string' || !src.trim()) return { type: 'skip' };
  const t = src.trim();
  if (/^https?:\/\//i.test(t)) return { type: 'external' };
  if (!t.startsWith('/images/')) {
    return {
      type: 'invalid',
      reason: 'local partner image path should start with `/images/`',
    };
  }
  const parts = t.split('/').filter(Boolean);
  if (parts[0] !== 'images' || parts.length < 3) {
    return {
      type: 'invalid',
      reason: 'expected `/images/<segment>/.../<file>`',
    };
  }
  const rest = parts.slice(1);
  const rawName = decodePathSegment(rest[rest.length - 1]);
  const baseOnly = path.basename(rawName);
  if (!baseOnly || baseOnly.includes('..')) {
    return {
      type: 'invalid',
      reason: 'invalid or unsafe filename in path',
    };
  }
  if (rawName.includes('/') || rawName.includes('\\')) {
    return {
      type: 'invalid',
      reason: 'filename segment must not contain path separators',
    };
  }
  const dirSegs = rest.slice(0, -1).map((s) => s.toLowerCase());
  const hasPartnerSeg = dirSegs.some((s) => PARTNER_LOGOS_URL_SEGMENTS.has(s));
  if (!hasPartnerSeg) {
    return {
      type: 'not-partner-path',
      reason: `path has no \`trustblock\` / partnerLogos segment (Drive: 02-images/partnerLogos/) — ${t}`,
    };
  }
  return { type: 'ok', basename: baseOnly };
}

/** Exact file, or case-insensitive match within dir. */
function resolveBasenameInDir(dir, basename) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const exact = path.join(dir, basename);
  if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;
  const lower = basename.toLowerCase();
  for (const f of listFiles(dir)) {
    if (f.toLowerCase() === lower) return path.join(dir, f);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

/**
 * @typedef {{ severity: 'error'|'warning', category: string, path: string, message: string }} Issue
 */

function validateSite(siteDir, folderName) {
  /** @type {Issue[]} */
  const issues = [];
  const siteId = getSiteId(folderName);

  // 1. Required folder structure
  for (const folder of REQUIRED_FOLDERS) {
    if (!fs.existsSync(path.join(siteDir, folder))) {
      issues.push({
        severity: 'error',
        category: 'Missing Folder',
        path: folder + '/',
        message: `Required folder \`${folder}/\` does not exist`,
      });
    }
  }
  for (const [folder, alternatives] of Object.entries(
    ALTERNATIVE_REQUIRED_FOLDERS
  )) {
    const hasPreferred = fs.existsSync(path.join(siteDir, folder));
    const hasAlternative = alternatives.some((alt) =>
      fs.existsSync(path.join(siteDir, alt))
    );
    if (!hasPreferred && !hasAlternative) {
      issues.push({
        severity: 'error',
        category: 'Missing Folder',
        path: folder + '/',
        message: `Required folder \`${folder}/\` does not exist (accepted alternatives: ${alternatives.map((alt) => `\`${alt}/\``).join(', ')})`,
      });
    }
  }

  // 2. FAQ files
  const faqDir = path.join(siteDir, '01-content/faq');
  if (fs.existsSync(faqDir)) {
    const files = listFiles(faqDir).filter((f) => f.endsWith('.json'));
    const hasXxl = files.some((f) => f.endsWith('faq-xxl.json'));
    const hasHome = files.some(
      (f) =>
        (f.endsWith('home-faq.json') || f.endsWith('faq.json')) &&
        !f.endsWith('faq-xxl.json')
    );

    if (!hasXxl) {
      const found = files.length
        ? `Found: ${files.join(', ')}`
        : 'Folder is empty';
      issues.push({
        severity: 'error',
        category: 'Missing File',
        path: '01-content/faq/',
        message: `No file ending in \`faq-xxl.json\` — ${found}`,
      });
    }
    if (!hasHome) {
      const found = files.length
        ? `Found: ${files.join(', ')}`
        : 'Folder is empty';
      issues.push({
        severity: 'error',
        category: 'Missing File',
        path: '01-content/faq/',
        message: `No file ending in \`faq.json\` (excluding faq-xxl) — ${found}`,
      });
    }
  }

  // 3. Partners file — must be exactly "partners.json"
  const partnersDir = path.join(siteDir, '01-content/partners');
  if (fs.existsSync(partnersDir)) {
    const files = listFiles(partnersDir).filter((f) => f.endsWith('.json'));
    if (!files.includes('partners.json')) {
      const found = files.length
        ? `Found: ${files.join(', ')}`
        : 'No JSON files';
      issues.push({
        severity: 'error',
        category: 'Wrong Filename',
        path: '01-content/partners/',
        message: `Expected \`partners.json\` — ${found}`,
      });
    } else {
      const partnersJsonPath = path.join(partnersDir, 'partners.json');
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(partnersJsonPath, 'utf-8'));
      } catch (e) {
        issues.push({
          severity: 'error',
          category: 'Invalid JSON',
          path: '01-content/partners/partners.json',
          message: `Cannot parse: ${e.message}`,
        });
        raw = null;
      }
      if (raw !== null) {
        if (!Array.isArray(raw)) {
          issues.push({
            severity: 'error',
            category: 'Partners JSON',
            path: '01-content/partners/partners.json',
            message: 'Root value must be an array of partner objects',
          });
        } else {
          const partnerLogosDir = path.join(siteDir, '02-images/partnerLogos');
          raw.forEach((entry, idx) => {
            const label = `01-content/partners/partners.json [${idx}]`;
            if (!entry || typeof entry !== 'object') {
              issues.push({
                severity: 'warning',
                category: 'Partners JSON',
                path: label,
                message: 'Entry is not an object — skipped',
              });
              return;
            }
            let effectiveSrc = entry.src;
            if (
              (effectiveSrc == null || effectiveSrc === '') &&
              typeof entry.logo === 'string'
            ) {
              effectiveSrc = `/images/trustblock/${entry.logo}`;
            }
            if (effectiveSrc == null || effectiveSrc === '') {
              issues.push({
                severity: 'warning',
                category: 'Partners JSON',
                path: label,
                message:
                  'Missing `src` and `logo` — cannot verify partner image file',
              });
              return;
            }
            const parsed = partnerEntryToExpectedBasename(effectiveSrc);
            if (parsed.type === 'skip') return;
            if (parsed.type === 'external') return;
            if (parsed.type === 'invalid') {
              issues.push({
                severity: 'error',
                category: 'Partners JSON',
                path: label,
                message: `${parsed.reason} — \`${String(effectiveSrc)}\``,
              });
              return;
            }
            if (parsed.type === 'not-partner-path') {
              issues.push({
                severity: 'error',
                category: 'Partners JSON',
                path: label,
                message: parsed.reason,
              });
              return;
            }
            const resolved = resolveBasenameInDir(
              partnerLogosDir,
              parsed.basename
            );
            if (!resolved) {
              const listing = fs.existsSync(partnerLogosDir)
                ? listFiles(partnerLogosDir).filter(isImageFile).join(', ') ||
                  '(no image files)'
                : 'folder missing';
              issues.push({
                severity: 'error',
                category: 'Partners JSON',
                path: label,
                message: `src \`${effectiveSrc}\` → expected \`02-images/partnerLogos/${parsed.basename}\` — not found (${listing})`,
              });
            }
          });
        }
      }
    }
  }

  // 5. Hero image — must contain "{siteId}-hero"
  checkImageFolder(siteDir, '02-images/hero', siteId, '-hero', issues, {
    acceptedBaseNames: ['hero'],
  });

  // 6. Info-section image — must contain "{siteId}-info"
  checkImageFolder(siteDir, '02-images/info-section', siteId, '-info', issues, {
    acceptedBaseNames: ['info'],
  });

  // 7. Logo image — must contain "-logo" (may use client name, not siteId)
  checkImageFolder(siteDir, '02-images/logo', siteId, '-logo', issues, {
    requireSiteId: false,
    acceptedBaseNames: ['logo'],
  });

  // 8. Team image — must contain "-team" (may use client name, not siteId)
  checkImageFolder(siteDir, '02-images/team', siteId, '-team', issues, {
    requireSiteId: false,
    acceptedBaseNames: ['team'],
  });

  // 9. Über uns image — must contain "-ueber-uns"
  checkImageFolder(
    siteDir,
    '02-images/ueber uns',
    siteId,
    '-ueber-uns',
    issues,
    {
      requireSiteId: false,
      acceptedBaseNames: ['ueber-uns'],
    }
  );

  // 10. Gallery — must have 8 images with -gallerie-1 through -gallerie-8
  const gallerieMatch = resolveExistingPath(siteDir, '02-images/gallerie', [
    '02-images/gallery',
  ]);
  if (gallerieMatch) {
    const files = listFiles(gallerieMatch.abs).filter(isImageFile);
    for (let i = 1; i <= 8; i++) {
      const hasSlot = files.some(
        (f) =>
          f.includes(`-gallerie-${i}.`) ||
          f.endsWith(`-gallerie-${i}`) ||
          f === `${i}.webp` ||
          f === `${i}.jpg` ||
          f === `${i}.jpeg` ||
          f === `${i}.png` ||
          f === `${i}.avif` ||
          f === `${i}.gif` ||
          f === `${i}.svg`
      );
      if (!hasSlot) {
        issues.push({
          severity: 'error',
          category: 'Missing File',
          path: `${gallerieMatch.rel}/`,
          message: `Gallery image #${i} missing — expected \`${siteId}-gallerie-${i}.webp\``,
        });
      }
    }
    if (files.length === 0) {
      issues.push({
        severity: 'error',
        category: 'Empty Folder',
        path: `${gallerieMatch.rel}/`,
        message: 'Gallery folder is empty',
      });
    }
  }

  // 11. Partner logos — at least one image
  const partnerLogosDir = path.join(siteDir, '02-images/partnerLogos');
  if (fs.existsSync(partnerLogosDir)) {
    const files = listFiles(partnerLogosDir).filter(isImageFile);
    if (files.length === 0) {
      issues.push({
        severity: 'error',
        category: 'Empty Folder',
        path: '02-images/partnerLogos/',
        message: 'Partner logos folder has no image files',
      });
    }
  }

  return { siteId, issues };
}

/**
 * Checks that an image folder contains at least one image whose name includes `suffix`.
 * When `requireSiteId` is true, also checks that the filename starts with `siteId`.
 */
function checkImageFolder(
  siteDir,
  folderRelPath,
  siteId,
  suffix,
  issues,
  options = {}
) {
  const { requireSiteId = true, acceptedBaseNames = [] } = options;
  const dir = path.join(siteDir, folderRelPath);
  if (!fs.existsSync(dir)) return; // folder missing already reported above

  const files = listFiles(dir).filter(isImageFile);

  if (files.length === 0) {
    issues.push({
      severity: 'error',
      category: 'Empty Folder',
      path: folderRelPath + '/',
      message: `No image files found. Expected: \`${siteId}${suffix}.webp\``,
    });
    return;
  }

  // Check that at least one file contains the expected suffix
  const hasSuffix = files.some((f) => {
    const lower = f.toLowerCase();
    const hasExpectedSuffix =
      lower.includes(`${suffix}.`) || lower.includes(`${suffix}-`);
    if (hasExpectedSuffix) return true;

    if (acceptedBaseNames.length === 0) return false;
    const baseName = path.parse(lower).name;
    return acceptedBaseNames.some((allowed) => baseName === allowed);
  });

  if (!hasSuffix) {
    issues.push({
      severity: 'error',
      category: 'Wrong Filename',
      path: folderRelPath + '/',
      message: `No image contains \`${suffix}\` — Found: ${files.join(', ')}. Expected: \`${siteId}${suffix}.webp\``,
    });
    return;
  }

  // For site-specific images (hero, info), also verify the siteId prefix is used
  if (requireSiteId) {
    const hasSiteId = files.some((f) => {
      if (f.startsWith(siteId)) return true;
      if (acceptedBaseNames.length === 0) return false;
      const baseName = path.parse(f.toLowerCase()).name;
      return acceptedBaseNames.some((allowed) => baseName === allowed);
    });
    if (!hasSiteId) {
      issues.push({
        severity: 'warning',
        category: 'Naming Convention',
        path: folderRelPath + '/',
        message: `Image does not start with siteId \`${siteId}\` — Found: ${files.join(', ')}. Expected: \`${siteId}${suffix}.webp\``,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown report generation
// ---------------------------------------------------------------------------

function generateMarkdown(results, generatedAt) {
  const totalSites = results.flatMap((r) => r.sites).length;
  const sitesWithIssues = results
    .flatMap((r) => r.sites)
    .filter((s) => s.issues.length > 0);
  const totalIssues = sitesWithIssues.reduce(
    (sum, s) => sum + s.issues.length,
    0
  );
  const errorCount = sitesWithIssues.reduce(
    (sum, s) => sum + s.issues.filter((i) => i.severity === 'error').length,
    0
  );
  const warnCount = sitesWithIssues.reduce(
    (sum, s) => sum + s.issues.filter((i) => i.severity === 'warning').length,
    0
  );

  const lines = [
    '# Google Drive Asset Validation Report',
    '',
    `> Generated: ${generatedAt}`,
    '',
    '## Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total sites checked | ${totalSites} |`,
    `| Sites with issues | ${sitesWithIssues.length} |`,
    `| Total issues | ${totalIssues} |`,
    `| ❌ Errors | ${errorCount} |`,
    `| ⚠️ Warnings | ${warnCount} |`,
    '',
  ];

  if (sitesWithIssues.length === 0) {
    lines.push('## ✅ All sites passed validation — no issues found!', '');
    return lines.join('\n');
  }

  lines.push('## Issues by Client', '');

  for (const clientResult of results) {
    const clientSitesWithIssues = clientResult.sites.filter(
      (s) => s.issues.length > 0
    );
    if (clientSitesWithIssues.length === 0) continue;

    lines.push(`### Client: \`${clientResult.client}\``, '');

    for (const site of clientSitesWithIssues) {
      const errorIssues = site.issues.filter((i) => i.severity === 'error');
      const warnIssues = site.issues.filter((i) => i.severity === 'warning');
      const badge =
        errorIssues.length > 0
          ? `❌ ${errorIssues.length} error${errorIssues.length !== 1 ? 's' : ''}${warnIssues.length ? `, ⚠️ ${warnIssues.length} warning${warnIssues.length !== 1 ? 's' : ''}` : ''}`
          : `⚠️ ${warnIssues.length} warning${warnIssues.length !== 1 ? 's' : ''}`;

      lines.push(
        `#### 📁 \`${site.folder}\` (siteId: \`${site.siteId}\`) — ${badge}`,
        ''
      );

      // Group by category
      const byCategory = {};
      for (const issue of site.issues) {
        if (!byCategory[issue.category]) byCategory[issue.category] = [];
        byCategory[issue.category].push(issue);
      }

      for (const [category, categoryIssues] of Object.entries(byCategory)) {
        lines.push(`**${category}**`, '');
        for (const issue of categoryIssues) {
          const icon = issue.severity === 'error' ? '❌' : '⚠️';
          lines.push(`- ${icon} \`${issue.path}\` — ${issue.message}`);
        }
        lines.push('');
      }
    }
  }

  // Append a clean checklist section at the end for easy action tracking
  lines.push('---', '', '## Checklist of All Issues', '');
  lines.push(
    '> Copy this checklist to track your progress fixing the issues.',
    ''
  );

  for (const clientResult of results) {
    const clientSitesWithIssues = clientResult.sites.filter(
      (s) => s.issues.length > 0
    );
    if (clientSitesWithIssues.length === 0) continue;

    lines.push(`### ${clientResult.client}`, '');

    for (const site of clientSitesWithIssues) {
      lines.push(`**${site.folder}**`, '');
      for (const issue of site.issues) {
        lines.push(`- [ ] \`${issue.path}\`: ${issue.message}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let { client: filterClient, outputFile } = parseArgs();

  if (!filterClient && process.stdin.isTTY) {
    filterClient = await promptClientFilter();
  }

  /** Resolved googleDrive/<slug>/ when --client is set (same slug as pull script). */
  let driveFolderFilter = null;

  if (filterClient) {
    const meta = readClientWebsitesMeta(filterClient);
    if (!meta) {
      console.error(
        `[validate] No or invalid src/data/${filterClient}/websites.json — unknown client id.`
      );
      process.exit(1);
    }
    if (!meta.driveFolderId) {
      console.error(
        `[validate] websites.json has no driveFolderId — cannot pull from Drive.`
      );
      process.exit(1);
    }
    driveFolderFilter = meta.driveFolderName;
    const clientFolderPath = path.join(GOOGLE_DRIVE_DIR, driveFolderFilter);
    if (!fs.existsSync(clientFolderPath)) {
      runPullFromDrive(filterClient, driveFolderFilter);
    }
  }

  if (!fs.existsSync(GOOGLE_DRIVE_DIR)) {
    console.error(
      `[validate] googleDrive/ folder not found at: ${GOOGLE_DRIVE_DIR}`
    );
    process.exit(1);
  }

  const clientDirs = discoverClientDirs().filter(
    (c) => !driveFolderFilter || c === driveFolderFilter
  );

  if (clientDirs.length === 0) {
    console.warn(
      filterClient
        ? `[validate] Client folder "${driveFolderFilter}" not found in googleDrive/ (expected googleDrive/${driveFolderFilter}/).`
        : '[validate] No client folders found in googleDrive/'
    );
    process.exit(0);
  }

  console.log(`[validate] Checking ${clientDirs.length} client(s)…\n`);

  /** @type {{ client: string, sites: { folder: string, siteId: string, issues: Issue[] }[] }[]} */
  const results = [];

  for (const clientName of clientDirs) {
    const clientDir = path.join(GOOGLE_DRIVE_DIR, clientName);
    const siteFolders = discoverSiteDirs(clientDir);

    console.log(`  Client: ${clientName} (${siteFolders.length} site(s))`);

    const clientResult = { client: clientName, sites: [] };

    for (const folderName of siteFolders) {
      const siteDir = path.join(clientDir, folderName);
      const { siteId, issues } = validateSite(siteDir, folderName);
      clientResult.sites.push({ folder: folderName, siteId, issues });

      const status =
        issues.length === 0 ? '✅' : `❌ (${issues.length} issue(s))`;
      console.log(`    ${status} ${folderName}`);

      if (issues.length > 0) {
        for (const issue of issues) {
          const icon = issue.severity === 'error' ? '  ❌' : '  ⚠️';
          console.log(
            `${icon} [${issue.category}] ${issue.path} — ${issue.message}`
          );
        }
      }
    }

    results.push(clientResult);
    console.log('');
  }

  const totalSites = results.flatMap((r) => r.sites).length;
  const sitesWithErrors = results
    .flatMap((r) => r.sites)
    .filter((s) => s.issues.some((i) => i.severity === 'error')).length;
  const totalIssues = results
    .flatMap((r) => r.sites)
    .reduce((s, site) => s + site.issues.length, 0);

  console.log('═'.repeat(60));
  console.log(`[validate] ${totalSites} site(s) checked.`);
  if (totalIssues === 0) {
    console.log('[validate] ✅ All sites passed — no issues found!');
  } else {
    console.log(
      `[validate] Found ${totalIssues} issue(s) across ${sitesWithErrors} site(s).`
    );
  }

  const generatedAt = new Date().toLocaleString('de-DE', {
    dateStyle: 'long',
    timeStyle: 'short',
  });

  const markdown = generateMarkdown(results, generatedAt);
  const outputPath = path.isAbsolute(outputFile)
    ? outputFile
    : path.join(ROOT, outputFile);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, 'utf-8');

  const relOutput = path.relative(ROOT, outputPath);
  console.log(`[validate] Report written to: ${relOutput}`);

  if (sitesWithErrors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[validate]', err.message || err);
  process.exit(1);
});
