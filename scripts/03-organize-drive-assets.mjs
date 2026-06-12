/**
 * Organize assets downloaded by 02-pull-from-google-drive.mjs into the
 * folder structure expected by websites.json.
 *
 * The pull-drive script downloads files into:
 *   <outputBaseDir>/<site-slug>/01-content/<type>/<file>
 *   <outputBaseDir>/<site-slug>/02-images/<category>/<file>
 *
 * This script:
 *   1. Parses websites.json to extract every image path referenced
 *   2. For each downloaded file, tries to match its filename against those paths
 *   3. Matched files → copied to the exact path websites.json expects
 *   4. Unmatched files → copied using category-based defaults
 *   5. Content files (FAQ, etc.) → copied to src/data/<client>/<site>/
 *   6. Shared partners.json → copied to every website folder (all sites use the same file)
 *   7. Top-level client files (e.g. data.xlsx) → copied to src/data/<client>/
 *   8. Runs responsive image variant generation (scripts/10-optimize-images.mjs)
 *
 * Excel data extraction (patching websites.json from .xlsx columns) is handled
 * by the separate `04-process-excel-data.mjs` script (pnpm 04-process-excel-data).
 *
 * Usage:
 *   pnpm organize-assets                          # organize all site folders
 *   pnpm organize-assets --client=eisdiele-linden  # organize one site only
 *   pnpm organize-assets --dry-run                 # preview without copying
 *   pnpm organize-assets --move                    # move instead of copy (default is copy)
 *   pnpm organize-assets --clean                   # remove empty source dirs after move (--move)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Fallback category mapping (used when no filename match in websites.json)
// Drive subfolder name → target directory under public/
// ---------------------------------------------------------------------------

// Drive subfolder name → subfolder under public/images/<site-slug>/
// All images land in public/images/<site-slug>/<subDir>/<file>
const IMAGE_CATEGORY_DEFAULTS = {
  hero: 'hero',
  'info-section': 'info',
  gallery: 'gallerie',
  team: 'team',
  logo: '',
  'ueber uns': 'about',
  partnerLogos: 'trustblock',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let client = null;
  let dryRun = false;
  let verbose = false;
  /** Default: copy so Drive download folders stay intact; use --move to rename/move. */
  let copyMode = true;
  let clean = false;
  let outputDir = null;

  for (const a of args) {
    if (a.startsWith('--client=')) {
      client = a.slice('--client='.length).trim() || null;
    } else if (a.startsWith('--output-dir=')) {
      outputDir = a.slice('--output-dir='.length).trim() || null;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--verbose' || a === '-v') {
      verbose = true;
    } else if (a === '--copy') {
      copyMode = true;
    } else if (a === '--move') {
      copyMode = false;
    } else if (a === '--clean') {
      clean = true;
    }
  }
  // dry-run is a preview mode — always show verbose so you see what would change
  return { client, dryRun, verbose: verbose || dryRun, copyMode, clean, outputDir };
}

function normalizeName(filename) {
  return filename.replace(/\s+/g, '-').toLowerCase();
}

function stripKnownSitePrefix(normalizedFilename, knownSiteIds) {
  if (!normalizedFilename || !Array.isArray(knownSiteIds) || knownSiteIds.length === 0) {
    return null;
  }
  // Prefer longest ids first to avoid partial matches.
  const sorted = [...knownSiteIds].sort((a, b) => String(b).length - String(a).length);
  for (const raw of sorted) {
    const siteId = String(raw || '').trim();
    if (!siteId) continue;
    const prefix = `${siteId}-`;
    if (normalizedFilename.startsWith(prefix)) {
      return { matchedSiteId: siteId, rest: normalizedFilename.slice(prefix.length) };
    }
  }
  return null;
}

function withSitePrefixIfMissing(siteId, basename) {
  const normalized = normalizeName(basename);
  return normalized.startsWith(`${siteId}-`)
    ? normalized
    : `${siteId}-${normalized}`;
}

function buildImageTargetFilename(siteId, category, originalName, knownSiteIds = []) {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, path.extname(originalName));
  const normalizedBase = normalizeName(base);
  const normalizedOriginal = normalizeName(originalName);
  const categorySlug = normalizeName(category);

  if (normalizedOriginal.startsWith(`${siteId}-`)) return normalizedOriginal;

  // If the original filename already carries another site's prefix, rewrite it to the target site.
  const stripped = stripKnownSitePrefix(normalizedOriginal, knownSiteIds);
  if (stripped && stripped.matchedSiteId !== siteId && stripped.rest) {
    return `${siteId}-${stripped.rest}`;
  }

  if (categorySlug === 'gallery') {
    return `${siteId}-${normalizedBase}${ext}`;
  }
  if (categorySlug === 'hero') {
    return `${siteId}-hero${ext}`;
  }
  if (categorySlug === 'info-section') {
    return `${siteId}-info${ext}`;
  }
  if (categorySlug === 'logo') {
    return `${siteId}-logo${ext}`;
  }
  if (categorySlug === 'team') {
    return `${siteId}-team${ext}`;
  }
  if (categorySlug === 'ueber-uns') {
    return `${siteId}-ueber-uns${ext}`;
  }

  return withSitePrefixIfMissing(siteId, `${normalizedBase}${ext}`);
}

function stripSitePrefix(slug) {
  return slug.replace(/^site-/, '');
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c])
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Read clientName from a client's websites.json and return a folder slug. */
function clientFolderSlug(clientId) {
  const websitesPath = path.join(
    ROOT,
    'src',
    'data',
    clientId,
    'websites.json'
  );
  try {
    const data = JSON.parse(fs.readFileSync(websitesPath, 'utf-8'));
    return data.clientName ? slugify(data.clientName) : clientId;
  } catch {
    return clientId;
  }
}

function discoverClientDirs() {
  const dataDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && e.name !== 'current' && !e.name.startsWith('.')
    )
    .map((e) => e.name);
}

function discoverDriveClients() {
  const driveDir = path.join(ROOT, 'googleDrive');
  if (!fs.existsSync(driveDir)) return [];
  return fs
    .readdirSync(driveDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/**
 * Map a googleDrive folder name back to the src/data client ID.
 * 1. Direct match: src/data/<driveFolder>/websites.json exists
 * 2. Reverse lookup: find a src/data/<clientId> whose clientFolderSlug matches
 * 3. Fallback: use the drive folder name as-is
 */
function clientWebsitesJsonPath(clientId) {
  return path.join(ROOT, 'src', 'data', clientId, 'websites.json');
}

function isDataClientId(clientId) {
  return fs.existsSync(clientWebsitesJsonPath(clientId));
}

function mapDriveFolderToClientId(driveFolder) {
  if (isDataClientId(driveFolder)) return driveFolder;

  const clientDirs = discoverClientDirs();
  for (const clientId of clientDirs) {
    if (!isDataClientId(clientId)) continue;
    if (clientFolderSlug(clientId) === driveFolder) return clientId;
  }

  return driveFolder;
}

/**
 * Resolve CLI / env client id to src/data folder name.
 * Drive folder slugs (e.g. googleDrive/haus-zum-wald) map via clientName in websites.json.
 */
function resolveClientDataId(clientArg, driveClients, dataClients) {
  if (dataClients.includes(clientArg) && isDataClientId(clientArg)) {
    return clientArg;
  }
  if (driveClients.includes(clientArg)) {
    const mapped = mapDriveFolderToClientId(clientArg);
    if (isDataClientId(mapped)) return mapped;
  }
  return null;
}

async function resolveClient(clientArg) {
  const driveClients = discoverDriveClients();
  const dataClients = discoverClientDirs();

  if (clientArg) {
    const clientId = resolveClientDataId(clientArg, driveClients, dataClients);
    if (clientId) {
      if (clientId !== clientArg) {
        console.log(
          `  Drive folder "${clientArg}" → data client "${clientId}"`
        );
      }
      return clientId;
    }
    console.warn(
      `  Client "${clientArg}" not found in googleDrive/ or src/data/. Available: ${[...new Set([...driveClients, ...dataClients])].join(', ')}`
    );
    return null;
  }

  if (driveClients.length === 0 && dataClients.length === 0) {
    console.warn('  No client folders found in googleDrive/ or src/data/.');
    return null;
  }

  // Prefer googleDrive/ folders as the selectable list; fall back to src/data/
  const choices = driveClients.length > 0 ? driveClients : dataClients;

  if (choices.length === 1) {
    const clientId = driveClients.length > 0
      ? mapDriveFolderToClientId(choices[0])
      : choices[0];
    console.log(`  Using client: ${clientId}`);
    return clientId;
  }

  // Multiple clients — prompt
  try {
    await import('enquirer');
  } catch {
    const { spawnSync } = await import('child_process');
    spawnSync('pnpm', ['add', '-D', 'enquirer'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  }
  const { default: enquirer } = await import('enquirer');
  const { selected } = await enquirer.prompt({
    type: 'select',
    name: 'selected',
    message: 'Which client do you want to organise assets for?',
    choices,
  });

  return driveClients.length > 0
    ? mapDriveFolderToClientId(selected)
    : selected;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function moveOrCopy(src, dest, copyMode) {
  ensureDir(path.dirname(dest));
  if (copyMode) {
    fs.copyFileSync(src, dest);
  } else {
    fs.renameSync(src, dest);
  }
}

function removeEmptyDirsUp(dir, stopAt) {
  let current = dir;
  while (current !== stopAt && current.startsWith(stopAt)) {
    try {
      const entries = fs.readdirSync(current);
      const realEntries = entries.filter((e) => e !== '.DS_Store');
      if (realEntries.length > 0) break;
      for (const e of entries) fs.unlinkSync(path.join(current, e));
      fs.rmdirSync(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

const PARTNERS_JSON_RE = /^partners(-[a-z]{2})?\.json$/i;

/** @returns {{ name: string, src: string }[]} */
function listPartnersJsonFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && PARTNERS_JSON_RE.test(e.name))
    .map((e) => ({ name: e.name, src: path.join(dir, e.name) }));
}

/** @returns {string[]} website ids from websites.json */
function getClientWebsiteIds(clientDataDir) {
  const websitesJsonPath = path.join(clientDataDir, 'websites.json');
  if (!fs.existsSync(websitesJsonPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(websitesJsonPath, 'utf-8'));
    const websites = Array.isArray(data?.websites) ? data.websites : [];
    return websites
      .map((w) => String(w?.id ?? '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the single shared partners JSON set for a client (partners.json,
 * partners-en.json, …). All websites reuse these files.
 *
 * @returns {{ name: string, src: string }[]}
 */
function findSharedPartnersSources(outputBaseDir, clientDataDir, siteSlugs) {
  const fromClientData = listPartnersJsonFiles(clientDataDir);
  if (fromClientData.length > 0) return fromClientData;

  const fromClientDrive = listPartnersJsonFiles(
    path.join(outputBaseDir, '01-content', 'partners')
  );
  if (fromClientDrive.length > 0) return fromClientDrive;

  for (const slug of [...siteSlugs].sort()) {
    const fromSite = listPartnersJsonFiles(
      path.join(outputBaseDir, slug, '01-content', 'partners')
    );
    if (fromSite.length > 0) return fromSite;
  }

  return [];
}

/**
 * Copy shared partners JSON into src/data/<client>/<websiteId>/ for every site.
 */
function syncSharedPartnersToWebsites(
  clientDataDir,
  websiteIds,
  partnerFiles,
  opts
) {
  const { dryRun, verbose } = opts;
  const moves = [];
  if (!clientDataDir || partnerFiles.length === 0 || websiteIds.length === 0) {
    return moves;
  }

  for (const websiteId of websiteIds) {
    const siteDataDir = path.join(clientDataDir, websiteId);
    for (const { name, src } of partnerFiles) {
      const destFile = path.join(siteDataDir, name);
      const relSrc = path.relative(ROOT, src);
      const relDest = path.relative(ROOT, destFile);

      moves.push({
        src: relSrc,
        dest: relDest,
        publicPath: null,
        category: 'content/partners (shared)',
        matched: false,
      });

      if (dryRun) {
        if (verbose) {
          console.log(`  [DRY-RUN]         ${relSrc}`);
          console.log(`         → ${relDest}`);
        }
      } else {
        moveOrCopy(src, destFile, true);
        if (verbose) {
          console.log(`  COPY (shared partners): ${relSrc} → ${relDest}`);
        }
      }
    }
  }

  return moves;
}

// ---------------------------------------------------------------------------
// Parse websites.json to build a filename → public-path index
// ---------------------------------------------------------------------------

function extractImagePaths(obj, results = []) {
  if (typeof obj === 'string') {
    if (obj.match(/^\/images\/.*\.\w{2,5}$/)) {
      results.push(obj);
    }
    return results;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) extractImagePaths(item, results);
    return results;
  }
  if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) extractImagePaths(val, results);
  }
  return results;
}

/**
 * Build a map of normalized-filename → full public path from websites.json.
 * If the same filename appears at multiple paths, keep the first occurrence.
 */
function buildPathIndex(websitesJsonPath) {
  const index = new Map();
  const knownSiteIds = new Set();
  if (!fs.existsSync(websitesJsonPath)) return { index, knownSiteIds };

  try {
    const data = JSON.parse(fs.readFileSync(websitesJsonPath, 'utf-8'));
    const paths = extractImagePaths(data);
    for (const p of paths) {
      const basename = path.basename(p);
      const normalized = normalizeName(basename);
      if (!index.has(normalized)) {
        index.set(normalized, p);
      }
    }

    const websites = Array.isArray(data?.websites) ? data.websites : [];
    for (const w of websites) {
      const id = String(w?.id ?? '').trim();
      if (id) knownSiteIds.add(id);
    }
  } catch (e) {
    console.warn(`  Could not parse websites.json: ${e.message}`);
  }
  return { index, knownSiteIds };
}

// ---------------------------------------------------------------------------
// Site processing
// ---------------------------------------------------------------------------

/**
 * @param {string} baseDir - directory to scan
 * @param {boolean} strict - when true, only folders with 01-content or 02-images
 *   qualify (used for legacy public/images to avoid picking up destination folders)
 */
function discoverSiteFolders(baseDir, strict = false) {
  if (!fs.existsSync(baseDir)) return [];
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });

  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .filter((e) => {
      const siteDir = path.join(baseDir, e.name);
      const hasContent = fs.existsSync(path.join(siteDir, '01-content'));
      const hasImages = fs.existsSync(path.join(siteDir, '02-images'));
      if (strict) return hasContent || hasImages;
      const hasFiles = fs
        .readdirSync(siteDir)
        .some(
          (f) =>
            !f.startsWith('.') && fs.statSync(path.join(siteDir, f)).isFile()
        );
      return hasContent || hasImages || hasFiles;
    })
    .map((e) => e.name);

  return folders;
}

function collectFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function organizeSite(siteSlug, baseDir, clientDataDir, pathIndex, knownSiteIds, opts) {
  const { dryRun, copyMode, clean, verbose } = opts;
  const siteDir = path.join(baseDir, siteSlug);
  const destSlug = stripSitePrefix(siteSlug);
  const action = copyMode ? 'COPY' : 'MOVE';
  const moves = [];

  // --- Process images (02-images/) → public/images/<destSlug>/<subDir>/ ---
  const imagesDir = path.join(siteDir, '02-images');
  if (fs.existsSync(imagesDir)) {
    // Iterate every actual subfolder on disk; use IMAGE_CATEGORY_DEFAULTS mapping
    // when the folder name is known, otherwise fall back to the folder name itself.
    const imageCategoryDirs = fs
      .readdirSync(imagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);

    for (const category of imageCategoryDirs) {
      const subDir = Object.prototype.hasOwnProperty.call(
        IMAGE_CATEGORY_DEFAULTS,
        category
      )
        ? IMAGE_CATEGORY_DEFAULTS[category]
        : category;
      const categoryDir = path.join(imagesDir, category);
      if (!fs.existsSync(categoryDir)) continue;

      const files = collectFiles(categoryDir);
      for (const srcFile of files) {
        const originalName = path.basename(srcFile);
        const normalizedName = normalizeName(originalName);
        const targetName = buildImageTargetFilename(destSlug, category, originalName, [
          ...(Array.isArray(knownSiteIds) ? knownSiteIds : []),
          destSlug,
        ]);

        // Preserve relative subfolder structure within the category dir
        // e.g. 02-images/hero/city/img.webp → public/images/<site>/hero/city/img.webp
        const relWithinCategory = path.relative(
          categoryDir,
          path.dirname(srcFile)
        );
        const normalizedRelDir = relWithinCategory
          ? relWithinCategory.split(path.sep).map(normalizeName).join(path.sep)
          : '';

        // Logo: always copy to this site's folder so every site gets the logo
        const useSiteFolder = category === 'logo';
        const matchedPath = useSiteFolder
          ? null
          : pathIndex.get(targetName) || pathIndex.get(normalizedName);
        let destFile;
        let publicPath;

        if (matchedPath) {
          destFile = path.join(ROOT, 'public', matchedPath);
          publicPath = matchedPath;
        } else {
          const baseDestDir = subDir
            ? path.join(ROOT, 'public', 'images', destSlug, subDir)
            : path.join(ROOT, 'public', 'images', destSlug);
          const destDir = normalizedRelDir
            ? path.join(baseDestDir, normalizedRelDir)
            : baseDestDir;
          destFile = path.join(destDir, targetName);
          publicPath = '/' + path.relative(path.join(ROOT, 'public'), destFile);
        }

        const relSrc = path.relative(ROOT, srcFile);
        const relDest = path.relative(ROOT, destFile);
        const matched = !!matchedPath && !useSiteFolder;

        moves.push({
          src: relSrc,
          dest: relDest,
          publicPath,
          category,
          matched,
        });

        if (dryRun) {
          const tag = matched ? '✓ MATCH' : '  NEW  ';
          if (verbose) {
            console.log(`  [DRY-RUN] ${tag} ${relSrc}`);
            console.log(`         → ${relDest}`);
            console.log(`         public path: ${publicPath}`);
          }
        } else {
          moveOrCopy(srcFile, destFile, copyMode);
          if (verbose) console.log(`  ${action}: ${relSrc} → ${relDest}`);
        }
      }
    }
  }

  // --- Process content files (01-content/) and top-level files into per-site folder ---
  const siteDataDir = clientDataDir ? path.join(clientDataDir, destSlug) : null;

  const contentDir = path.join(siteDir, '01-content');
  if (fs.existsSync(contentDir) && siteDataDir) {
    // Iterate every actual subfolder on disk instead of a fixed whitelist.
    const contentCategoryDirs = fs
      .readdirSync(contentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      // Prompt files are generated by our pipeline now; do not copy legacy Drive master prompts.
      .filter((e) => e.name !== 'master-prompt')
      .map((e) => e.name);

    for (const category of contentCategoryDirs) {
      const categoryDir = path.join(contentDir, category);
      if (!fs.existsSync(categoryDir)) continue;

      // Partners are client-wide; synced to every website after all sites are processed.
      if (category === 'partners') continue;

      const files = collectFiles(categoryDir);
      for (const srcFile of files) {
        const originalName = path.basename(srcFile);
        // Safety net: skip prompt files from Drive content even outside master-prompt.
        if (originalName === 'prompt.md' || originalName === 'prompt.txt') {
          continue;
        }
        const destFile = path.join(siteDataDir, originalName);
        const relSrc = path.relative(ROOT, srcFile);
        const relDest = path.relative(ROOT, destFile);

        moves.push({
          src: relSrc,
          dest: relDest,
          publicPath: null,
          category: `content/${category}`,
          matched: false,
        });

        if (dryRun) {
          if (verbose) {
            console.log(`  [DRY-RUN]         ${relSrc}`);
            console.log(`         → ${relDest}`);
          }
        } else {
          moveOrCopy(srcFile, destFile, copyMode);
          if (verbose) console.log(`  ${action}: ${relSrc} → ${relDest}`);
        }
      }
    }
  }

  // --- Handle remaining top-level files (xlsx, etc.) → same per-site folder ---
  const topFiles = fs.existsSync(siteDir)
    ? fs
        .readdirSync(siteDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
    : [];

  for (const entry of topFiles) {
    const srcFile = path.join(siteDir, entry.name);
    const destDir = siteDataDir || path.join(ROOT, 'public', 'images');
    const destFile = path.join(destDir, normalizeName(entry.name));
    const relSrc = path.relative(ROOT, srcFile);
    const relDest = path.relative(ROOT, destFile);

    // Excel files are always copied so they remain in the source folder
    // for repeated runs and for the Excel processing step.
    const isExcel = entry.name.toLowerCase().endsWith('.xlsx');
    const effectiveCopy = isExcel ? true : copyMode;
    const effectiveAction = isExcel ? 'COPY' : action;

    moves.push({
      src: relSrc,
      dest: relDest,
      publicPath: null,
      category: 'other',
      matched: false,
    });

    if (dryRun) {
      if (verbose) {
        console.log(`  [DRY-RUN]         ${relSrc}`);
        console.log(`         → ${relDest}`);
      }
    } else {
      moveOrCopy(srcFile, destFile, effectiveCopy);
      if (verbose) console.log(`  ${effectiveAction}: ${relSrc} → ${relDest}`);
    }
  }

  // --- Clean up empty directories ---
  if (clean && !dryRun && !copyMode) {
    removeEmptyDirsUp(path.join(siteDir, '02-images'), baseDir);
    removeEmptyDirsUp(path.join(siteDir, '01-content'), baseDir);
    removeEmptyDirsUp(siteDir, baseDir);
  }

  return moves;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const { client, dryRun, verbose, copyMode, clean, outputDir } = parseArgs();

  const activeClient = await resolveClient(client);
  const clientDataDir =
    activeClient && fs.existsSync(path.join(ROOT, 'src', 'data', activeClient))
      ? path.join(ROOT, 'src', 'data', activeClient)
      : null;

  if (activeClient && !clientDataDir) {
    console.warn(
      `  src/data/${activeClient}/ not found — content/partners sync will be skipped.`
    );
  }

  // When --output-dir is not explicitly provided, scope to the client's own
  // subfolder under the base dir (e.g. googleDrive/haus-zum-wald/).
  const baseDir = 'googleDrive';
  const configuredDir = outputDir
    ? outputDir
    : activeClient
      ? `${baseDir}/${clientFolderSlug(activeClient)}`
      : baseDir;
  const outputBaseDir = path.isAbsolute(configuredDir)
    ? configuredDir
    : path.join(ROOT, configuredDir);

  if (!clientDataDir) {
    console.warn(
      '  No client selected — content files will be skipped.'
    );
  }

  // Build path index from websites.json
  const websitesJsonPath = clientDataDir
    ? path.join(clientDataDir, 'websites.json')
    : null;
  const { index: pathIndex, knownSiteIds } = websitesJsonPath
    ? buildPathIndex(websitesJsonPath)
    : { index: new Map(), knownSiteIds: new Set() };

  if (pathIndex.size > 0) {
    if (verbose) console.log(
      `  Loaded ${pathIndex.size} image path(s) from websites.json for filename matching.`
    );
  } else {
    if (verbose) console.log(
      '  No image paths found in websites.json — using category-based defaults only.'
    );
  }

  const siteSlugs = discoverSiteFolders(outputBaseDir);

  if (siteSlugs.length === 0) {
    console.log('  No site folders found in', outputBaseDir);
    console.log(
      '  Run "pnpm pull-drive" first to download assets from Google Drive.'
    );
    return;
  }

  if (dryRun) {
    console.log('  DRY RUN — no files will be copied or moved.\n');
  }

  const allMoves = [];

  for (const slug of siteSlugs) {
    const siteDir = path.join(outputBaseDir, slug);
    if (!fs.existsSync(siteDir)) {
      console.warn(`  Site folder not found: ${slug}, skipping.`);
      continue;
    }

    if (verbose) {
      console.log(`\n  Processing: ${slug}`);
      console.log('─'.repeat(60));
    }
    const moves = organizeSite(
      slug,
      outputBaseDir,
      clientDataDir,
      pathIndex,
      [...knownSiteIds],
      {
        dryRun,
        copyMode,
        clean,
        verbose,
      }
    );
    allMoves.push(...moves);
  }

  // --- Shared partners.json → every website folder in src/data/<client>/ ---
  if (clientDataDir) {
    const websiteIds = getClientWebsiteIds(clientDataDir);
    const partnerFiles = findSharedPartnersSources(
      outputBaseDir,
      clientDataDir,
      siteSlugs
    );
    if (partnerFiles.length > 0 && websiteIds.length > 0) {
      console.log(
        `\n  Shared partners (${partnerFiles.map((f) => f.name).join(', ')}) → ${websiteIds.length} website folder(s) under src/data/${activeClient}/`
      );
      const partnerMoves = syncSharedPartnersToWebsites(
        clientDataDir,
        websiteIds,
        partnerFiles,
        { dryRun, verbose, copyMode }
      );
      allMoves.push(...partnerMoves);
      if (!dryRun && !verbose) {
        const names = partnerFiles.map((f) => f.name).join(', ');
        for (const websiteId of websiteIds) {
          console.log(`    ✓ ${websiteId}/ (${names})`);
        }
      }
    } else if (websiteIds.length > 0) {
      console.warn(
        '\n  No partners.json found in Drive or src/data — skipped shared partners sync.'
      );
    } else {
      console.warn(
        '\n  No websites in websites.json — skipped shared partners sync.'
      );
    }
  }

  // --- Copy top-level client files (e.g. data.xlsx) → src/data/<client>/ ---
  if (clientDataDir && fs.existsSync(outputBaseDir)) {
    const topLevelFiles = fs
      .readdirSync(outputBaseDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'));

    for (const entry of topLevelFiles) {
      const srcFile = path.join(outputBaseDir, entry.name);
      const destFile = path.join(clientDataDir, normalizeName(entry.name));
      const relSrc = path.relative(ROOT, srcFile);
      const relDest = path.relative(ROOT, destFile);
      const effectiveAction = copyMode ? 'COPY' : 'MOVE';

      allMoves.push({
        src: relSrc,
        dest: relDest,
        publicPath: null,
        category: 'client-data',
        matched: false,
      });

      if (dryRun) {
        if (verbose) {
          console.log(`  [DRY-RUN]         ${relSrc}`);
          console.log(`         → ${relDest}`);
        }
      } else {
        moveOrCopy(srcFile, destFile, copyMode);
        if (verbose) console.log(`  ${effectiveAction}: ${relSrc} → ${relDest}`);
      }
    }
  }

  // --- Print summary ---
  console.log('\n' + '═'.repeat(60));
  const verb = dryRun ? 'would be ' : '';
  const op = copyMode ? 'copied' : 'moved';
  console.log(`  Done. ${allMoves.length} file(s) ${verb}${op}.`);

  const matched = allMoves.filter((m) => m.matched);
  const unmatched = allMoves.filter((m) => m.publicPath && !m.matched);

  if (matched.length > 0 && verbose) {
    console.log(
      `\n  ${matched.length} file(s) matched existing websites.json paths (✓):`
    );
    for (const m of matched) {
      console.log(`    ${m.publicPath}`);
    }
  }

  if (unmatched.length > 0) {
    console.log(
      `\n  ${unmatched.length} NEW file(s) not yet in websites.json — update paths:`
    );
    console.log('─'.repeat(60));

    const byCategory = {};
    for (const m of unmatched) {
      if (!byCategory[m.category]) byCategory[m.category] = [];
      byCategory[m.category].push(m.publicPath);
    }

    for (const [cat, paths] of Object.entries(byCategory)) {
      console.log(`\n  ${cat}:`);
      for (const p of paths) {
        console.log(`    "${p}"`);
      }
    }
  }

  // --- Responsive WebP variants under public/images/ (same as pnpm 10-optimize-images) ---
  try {
    const { runOptimizeImages } = await import('./10-optimize-images.mjs');
    console.log('\n' + '─'.repeat(60));
    console.log('  Responsive image variants (10-optimize-images)');
    await runOptimizeImages({
      dryRun,
      quiet: !verbose,
      root: ROOT,
    });
  } catch (err) {
    console.error(
      '\n[03-organize-assets] Responsive image optimization failed:',
      err?.message || err
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
