/**
 * Pull files (images, documents, etc.) from Google Drive.
 *
 * Mode 1 – Site folders (recommended): Use a single root Drive folder that contains
 * subfolders named "site-*" (e.g. site-eisdiele-linden, site-page-xyz). The script
 * discovers all site-* folders and recursively downloads every file (including all
 * subfolders) into outputBaseDir/<site-slug>/ with the same folder structure.
 *
 * Mode 2 – Legacy per-website: Use "websites" in config with driveFolderId, files,
 * and outputDir per website (pull only the listed file names).
 *
 * Setup:
 * 1. Create a Google Cloud project, enable the Google Drive API.
 * 2. Create a Service Account, download its JSON key, and save as
 *    google-drive-credentials.json in the repo root (gitignored).
 * 3. Share the Drive folder(s) with the service account email as Viewer.
 * 4. Ensure each client has src/data/<client>/websites.json with driveFolderId set.
 *
 * Multi-client support:
 *   Clients are discovered by scanning src/data/<client>/websites.json. The Google Drive
 *   folder ID is read from the top-level "driveFolderId" field when present. If
 *   websites.json exists but driveFolderId is missing, you are prompted for the folder ID
 *   (or set PULL_ASSETS_DRIVE_FOLDER_ID or PULL_ASSETS_DRIVE_FOLDER_ID_<CLIENTID> for CI).
 *   When multiple clients are found and no --client flag is given, an interactive prompt
 *   lets you pick one.
 *
 * Usage:
 *   pnpm 02-pull-assets                          # prompt to select client (if multiple)
 *   pnpm 02-pull-assets --client=nicezeit        # use "nicezeit" client directly
 *   pnpm 02-pull-assets --excel-only             # pull only extraFiles (e.g. data.xlsx)
 *   pnpm pull-data                            # same as --excel-only (does NOT download site-* folders)
 *
 * Skip unchanged (default on): before each download, fetch Drive metadata (size + md5Checksum).
 * If the local file exists and matches, the full file is not re-downloaded.
 *   --no-skip-unchanged              # always re-download every file
 *   --skip-unchanged-relaxed         # if Drive has no md5, skip when file size matches (faster, tiny risk)
 *   PULL_ASSETS_SKIP_UNCHANGED=0     # same as --no-skip-unchanged
 *   PULL_ASSETS_SKIP_RELAXED=1       # enable relaxed size-only skip
 *
 * Non-interactive / automation:
 *   PULL_ASSETS_DRIVE_FOLDER_ID      # when websites.json has no driveFolderId, use this folder ID
 *   PULL_ASSETS_DRIVE_FOLDER_ID_<ID> # per-client override (e.g. HAUS_ZUM_WALD for client haus-zum-wald)
 *   PULL_ASSETS_NO_PROMPT=1            # skip interactive Drive folder prompt (requires env or driveFolderId in JSON)
 */

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { pipeline } from 'stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_PAGE_SIZE = 1000;
const DEFAULT_DOWNLOAD_CONCURRENCY = 8;
const DRIVE_CREDENTIALS_PATH = 'google-drive-credentials.json';
const DRIVE_OUTPUT_BASE_DIR = 'googleDrive';
const DRIVE_SITE_FOLDER_PREFIX = 'site-';
const DRIVE_EXTRA_FILES = ['data.xlsx'];

/**
 * Maps Google Workspace MIME types to the export MIME type and file extension.
 * When a file stored natively in Google Docs/Sheets/Slides is encountered, we
 * must use drive.files.export instead of drive.files.get (alt=media).
 */
const GOOGLE_APPS_EXPORT_MAP = {
  'application/vnd.google-apps.spreadsheet': {
    exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
  'application/vnd.google-apps.document': {
    exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
  },
  'application/vnd.google-apps.presentation': {
    exportMime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let client = null;
  let excelOnly = false;
  let concurrency = null;
  let skipUnchanged = null;
  let skipUnchangedRelaxed = null;
  let verbose = false;
  let folderId = null;
  let outputDir = null;
  for (const a of args) {
    if (a.startsWith('--client='))
      client = a.slice('--client='.length).trim() || null;
    else if (a === '--excel-only') excelOnly = true;
    else if (a === '--no-skip-unchanged') skipUnchanged = false;
    else if (a === '--skip-unchanged-relaxed') skipUnchangedRelaxed = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a.startsWith('--folder-id='))
      folderId = a.slice('--folder-id='.length).trim() || null;
    else if (a.startsWith('--output-dir='))
      outputDir = a.slice('--output-dir='.length).trim() || null;
    else if (a.startsWith('--concurrency=')) {
      const parsed = Number.parseInt(a.slice('--concurrency='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) concurrency = parsed;
    }
  }
  return {
    client,
    excelOnly,
    concurrency,
    skipUnchanged,
    skipUnchangedRelaxed,
    verbose,
    folderId,
    outputDir,
  };
}

async function getDriveClient(credentialsPath) {
  const keyPath = path.isAbsolute(credentialsPath)
    ? credentialsPath
    : path.join(ROOT, credentialsPath);
  if (!fs.existsSync(keyPath)) {
    console.error(`  Credentials file not found: ${keyPath}`);
    console.error(
      '  Create a Google Cloud Service Account, download JSON key, and save as google-drive-credentials.json in repo root.'
    );
    process.exit(1);
  }
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

function escapeQuery(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const DRIVE_LIST_OPTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
};

/**
 * Drive file metadata for skip-unchanged checks (small `files.get` without media body).
 */
async function getRemoteFileMeta(drive, fileId) {
  const res = await drive.files.get({
    fileId,
    fields: 'id,size,md5Checksum,modifiedTime',
    supportsAllDrives: true,
  });
  const d = res.data;
  const size =
    d.size != null && d.size !== ''
      ? Number.parseInt(String(d.size), 10)
      : null;
  return {
    size: Number.isFinite(size) ? size : null,
    md5Checksum: d.md5Checksum || null,
    modifiedTime: d.modifiedTime || null,
  };
}

/**
 * MD5 hex digest of a local file (streaming).
 */
function fileMd5Hex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * If local file matches remote metadata, skip re-download.
 * - Prefer md5Checksum from Drive when present (matches uploaded binaries e.g. images).
 * - If no md5: compare size only when skipUnchangedRelaxed is true (Google-native files often lack md5).
 */
async function shouldSkipDownload(drive, fileId, outputPath, options) {
  const { skipUnchanged = true, skipUnchangedRelaxed = false } = options;

  if (!skipUnchanged || !fs.existsSync(outputPath)) return false;

  let stat;
  try {
    stat = fs.statSync(outputPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const remote = await getRemoteFileMeta(drive, fileId);
  const localSize = stat.size;

  if (remote.size != null && localSize !== remote.size) return false;

  if (remote.md5Checksum) {
    const localHex = await fileMd5Hex(outputPath);
    const remoteHex = remote.md5Checksum.toLowerCase();
    return localHex.toLowerCase() === remoteHex;
  }

  if (
    skipUnchangedRelaxed &&
    remote.size != null &&
    localSize === remote.size
  ) {
    return true;
  }

  return false;
}

/**
 * List direct subfolders of folderId (optionally filtered by prefix).
 * Paginates fully — the Drive API returns at most 100 items per page; without
 * pagination, site-* folders can be missing when the root has many children.
 * Prefix match is case-insensitive (Drive folder names may use "Site-" vs "site-").
 */
async function listSubfolders(drive, folderId, prefix = '') {
  const q = `'${escapeQuery(folderId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const files = [];
  let pageToken = null;
  const prefixLower = prefix ? prefix.toLowerCase() : '';
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name)',
      pageSize: DRIVE_PAGE_SIZE,
      pageToken: pageToken || undefined,
      orderBy: 'name',
      ...DRIVE_LIST_OPTS,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  if (!prefix) return files;
  return files.filter(
    (f) => f.name && f.name.toLowerCase().startsWith(prefixLower)
  );
}

/**
 * List all direct files (non-folders) in a folder. Paginates.
 */
async function listFilesInFolder(drive, folderId) {
  const q = `'${escapeQuery(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
  const items = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: DRIVE_PAGE_SIZE,
      pageToken: pageToken || undefined,
      ...DRIVE_LIST_OPTS,
    });
    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return items;
}

/**
 * List all direct children of a folder (files and subfolders). Paginates.
 */
async function listAllInFolder(drive, folderId) {
  const q = `'${escapeQuery(folderId)}' in parents and trashed = false`;
  const items = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: DRIVE_PAGE_SIZE,
      pageToken: pageToken || undefined,
      ...DRIVE_LIST_OPTS,
    });
    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return items;
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

async function mapLimit(items, limit, worker) {
  const run = createLimiter(limit);
  await Promise.all(items.map((item) => run(() => worker(item))));
}

/**
 * Recursively download all files from a Drive folder into localDir, preserving subfolder structure.
 * Returns { downloaded, skipped } — skipped = unchanged local files (see skip-unchanged options).
 */
async function downloadFolderRecursive(
  drive,
  folderId,
  localDir,
  options = {}
) {
  const { downloadConcurrency = DEFAULT_DOWNLOAD_CONCURRENCY } = options;
  const children = await listAllInFolder(drive, folderId);
  const folders = children.filter((item) => item.mimeType === FOLDER_MIME);
  const files = children.filter((item) => item.mimeType !== FOLDER_MIME);

  let downloaded = 0;
  let skipped = 0;
  await mapLimit(files, downloadConcurrency, async (item) => {
    const itemPath = path.join(localDir, item.name);
    const result = await downloadFile(drive, item.id, itemPath, {
      ...options,
      mimeType: item.mimeType,
    });
    if (result === 'skipped') skipped++;
    else downloaded++;
  });

  await mapLimit(folders, downloadConcurrency, async (item) => {
    const itemPath = path.join(localDir, item.name);
    const sub = await downloadFolderRecursive(
      drive,
      item.id,
      itemPath,
      options
    );
    downloaded += sub.downloaded;
    skipped += sub.skipped;
  });

  return { downloaded, skipped };
}

/**
 * Download file by ID to outputPath.
 * Automatically uses drive.files.export for Google Workspace files (Sheets, Docs, Slides)
 * since those cannot be downloaded with alt=media.
 * @param {string} [mimeType] - Optional MIME type of the file (from Drive listing). When
 *   omitted for Google Apps files, a metadata fetch is used to detect the type.
 * @returns {'downloaded'|'skipped'}
 */
async function downloadFile(drive, fileId, outputPath, options = {}) {
  const {
    skipUnchanged = true,
    skipUnchangedRelaxed = false,
    verbose = false,
    mimeType: providedMimeType,
  } = options;

  // Resolve mimeType: use provided value, or fetch from Drive metadata.
  let mimeType = providedMimeType;
  if (!mimeType) {
    try {
      const meta = await drive.files.get({
        fileId,
        fields: 'mimeType',
        supportsAllDrives: true,
      });
      mimeType = meta.data.mimeType || '';
    } catch {
      mimeType = '';
    }
  }

  const exportInfo = GOOGLE_APPS_EXPORT_MAP[mimeType];
  const isGoogleAppsFile = Boolean(exportInfo);

  // For native Google Apps files, skip-unchanged based on md5 is unavailable.
  // We fall back to modifiedTime comparison to avoid re-exporting unchanged files.
  if (!isGoogleAppsFile) {
    if (
      await shouldSkipDownload(drive, fileId, outputPath, {
        skipUnchanged,
        skipUnchangedRelaxed,
      })
    ) {
      if (verbose) {
        console.log(`  skip (unchanged): ${outputPath}`);
      }
      return 'skipped';
    }
  } else if (skipUnchanged && fs.existsSync(outputPath)) {
    // For Google Apps files: compare modifiedTime to avoid unnecessary exports.
    try {
      const meta = await drive.files.get({
        fileId,
        fields: 'modifiedTime',
        supportsAllDrives: true,
      });
      const remoteModified = meta.data.modifiedTime;
      if (remoteModified) {
        const localMtime = fs.statSync(outputPath).mtimeMs;
        const remoteMtime = new Date(remoteModified).getTime();
        if (localMtime >= remoteMtime) {
          if (verbose) {
            console.log(`  skip (unchanged, Google Apps export): ${outputPath}`);
          }
          return 'skipped';
        }
      }
    } catch {
      // If metadata fetch fails, proceed with download.
    }
  }

  const destDir = path.dirname(outputPath);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  if (isGoogleAppsFile) {
    // Ensure the output file has the correct extension for the exported format.
    // For example, a Google Sheet exported as .xlsx keeps the .xlsx extension.
    // If the caller already named it correctly (e.g. data.xlsx), no rename needed.
    let effectiveOutputPath = outputPath;
    if (!outputPath.toLowerCase().endsWith(exportInfo.ext)) {
      // Strip any existing extension and append the correct one.
      const base = outputPath.replace(/\.[^.]+$/, '');
      effectiveOutputPath = base + exportInfo.ext;
      if (verbose) {
        console.log(
          `  Google Apps file – exporting as ${exportInfo.ext}: ${effectiveOutputPath}`
        );
      }
    }
    const res = await drive.files.export(
      { fileId, mimeType: exportInfo.exportMime },
      { responseType: 'stream' }
    );
    const writer = fs.createWriteStream(effectiveOutputPath);
    await pipeline(res.data, writer);
    return 'downloaded';
  }

  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  const writer = fs.createWriteStream(outputPath);
  await pipeline(res.data, writer);
  return 'downloaded';
}

/**
 * Download extra files from the root Drive folder (e.g. Excel sheets).
 * Config: extraFiles – array of file names to download from rootDriveFolderId.
 *         extraFilesOutputDir – local directory to save them (defaults to outputBaseDir).
 */
async function pullExtraFiles(drive, config) {
  const {
    rootDriveFolderId,
    outputBaseDir,
    extraFiles = [],
    extraFilesOutputDir,
    skipUnchanged = true,
    skipUnchangedRelaxed = false,
    verbose = false,
  } = config;

  if (!extraFiles.length) return;

  const destDir = path.isAbsolute(extraFilesOutputDir || '')
    ? extraFilesOutputDir
    : path.join(ROOT, extraFilesOutputDir || outputBaseDir);

  const pullOpts = { skipUnchanged, skipUnchangedRelaxed, verbose };

  for (const fileName of extraFiles) {
    const file = await findFileByName(drive, fileName, rootDriveFolderId);
    if (!file) {
      console.warn(
        `  Extra file not found in root folder: ${fileName}`
      );
      continue;
    }
    const outputPath = path.join(destDir, fileName);
    const result = await downloadFile(drive, file.id, outputPath, {
      ...pullOpts,
      mimeType: file.mimeType,
    });
    if (result === 'skipped') {
      if (verbose) console.log(`  Extra file (unchanged, skipped): ${fileName}`);
    } else {
      if (verbose) console.log(`  Extra file: ${fileName} → ${outputPath}`);
    }
  }
}

/**
 * Mode 1: Pull all files from all site-* folders under rootDriveFolderId.
 */
async function pullSiteFolders(drive, config, clientFilter) {
  const {
    rootDriveFolderId,
    outputBaseDir,
    siteFolderPrefix = 'site-',
    downloadConcurrency = DEFAULT_DOWNLOAD_CONCURRENCY,
    skipUnchanged = true,
    skipUnchangedRelaxed = false,
    verbose = false,
  } = config;

  if (!rootDriveFolderId || !outputBaseDir) {
    console.error(
      '  Mode 1 requires rootDriveFolderId and outputBaseDir in config.'
    );
    process.exit(1);
  }

  // Check that the service account can see the folder (it must be shared with the SA)
  try {
    await drive.files.get({
      fileId: rootDriveFolderId,
      fields: 'id, name',
      supportsAllDrives: true,
    });
  } catch (err) {
    const code = err.code ?? err.response?.status;
    if (code === 404 || (err.message && err.message.includes('404'))) {
      console.error(
        '  Folder not found. Check rootDriveFolderId in config.'
      );
    } else if (
      code === 403 ||
      (err.message && err.message.includes('403')) ||
      (err.message && err.message.toLowerCase().includes('access'))
    ) {
      console.error(
        '  Access denied. Share the Drive folder with your service account.'
      );
      console.error(
        '  Service account email is in google-drive-credentials.json (client_email).'
      );
      console.error(
        '  In Drive: select the folder → Share → add that email as Viewer.'
      );
    } else {
      console.error('  ', err.message || err);
    }
    process.exit(1);
  }

  const baseDir = path.isAbsolute(outputBaseDir)
    ? outputBaseDir
    : path.join(ROOT, outputBaseDir);
  const subfolders = await listSubfolders(
    drive,
    rootDriveFolderId,
    siteFolderPrefix
  );

  if (subfolders.length === 0) {
    const allFolders = await listSubfolders(drive, rootDriveFolderId, '');
    console.warn(
      `  No subfolders found with prefix "${siteFolderPrefix}" in folder ${rootDriveFolderId}.`
    );
    if (allFolders.length > 0) {
      console.warn(
        '  Subfolders in that folder:',
        allFolders.map((f) => f.name).join(', ')
      );
      console.warn(
        '  Expected folders with the "site-" prefix. Rename folders or pass through a client-specific folder-id.'
      );
    } else {
      console.warn(
        '  That folder has no subfolders. Check the folder ID and that the service account has access.'
      );
    }
    return;
  }

  const slugFromName = (name) => {
    const p = siteFolderPrefix.toLowerCase();
    if (name.toLowerCase().startsWith(p)) {
      return name.slice(siteFolderPrefix.length);
    }
    return name;
  };

  for (const folder of subfolders) {
    const siteSlug = slugFromName(folder.name);
    if (clientFilter && siteSlug !== clientFilter) continue;

    const siteDir = path.join(baseDir, siteSlug);
    const { downloaded, skipped } = await downloadFolderRecursive(
      drive,
      folder.id,
      siteDir,
      {
        downloadConcurrency,
        skipUnchanged,
        skipUnchangedRelaxed,
        verbose,
      }
    );
    if (downloaded === 0 && skipped === 0) {
      if (verbose) console.log(`  ${folder.name}: no files, skipping.`);
    } else {
      const parts = [];
      if (downloaded > 0) parts.push(`${downloaded} downloaded`);
      if (skipped > 0) parts.push(`${skipped} unchanged (skipped)`);
      console.log(`  ${folder.name}: ${parts.join(', ')}.`);
    }
  }
}

/**
 * Search for a file by exact name in optional folder. Returns first match (id, name).
 */
async function findFileByName(drive, fileName, folderId) {
  const q = `name = '${escapeQuery(fileName)}' and trashed = false${folderId ? ` and '${folderId}' in parents` : ''}`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType)',
    ...DRIVE_LIST_OPTS,
    pageSize: 1,
  });
  const files = res.data.files || [];
  return files[0] || null;
}

/**
 * Mode 2 (legacy): Pull listed files per website.
 */
async function pullForWebsite(drive, websiteId, siteConfig, pullOptions = {}) {
  const { driveFolderId, files, outputDir } = siteConfig;
  const {
    skipUnchanged = true,
    skipUnchangedRelaxed = false,
    verbose = false,
  } = pullOptions;
  if (!files || !Array.isArray(files) || files.length === 0) {
    console.log(`  ${websiteId}: no files listed, skipping.`);
    return;
  }
  const baseDir = path.isAbsolute(outputDir)
    ? outputDir
    : path.join(ROOT, outputDir);
  let downloaded = 0;
  let skipped = 0;
  const missing = [];
  const dlOpts = { skipUnchanged, skipUnchangedRelaxed, verbose };
  for (const fileName of files) {
    const file = await findFileByName(drive, fileName, driveFolderId || null);
    if (!file) {
      missing.push(fileName);
      continue;
    }
    const outputPath = path.join(baseDir, fileName);
    const result = await downloadFile(drive, file.id, outputPath, {
      ...dlOpts,
      mimeType: file.mimeType,
    });
    if (result === 'skipped') {
      skipped++;
      if (verbose) {
        console.log(
          `  ${websiteId}: ${fileName} (unchanged, skipped)`
        );
      }
    } else {
      console.log(`  ${websiteId}: ${fileName} → ${outputPath}`);
      downloaded++;
    }
  }
  if (missing.length > 0) {
    console.warn(
      `  ${websiteId}: not found in Drive: ${missing.join(', ')}`
    );
  }
  if (downloaded > 0 || skipped > 0) {
    const parts = [];
    if (downloaded > 0) parts.push(`${downloaded} downloaded`);
    if (skipped > 0) parts.push(`${skipped} unchanged (skipped)`);
    console.log(`  ${websiteId}: ${parts.join(', ')}.`);
  }
}

/** Convert a display name like "Haus zum Wald" to a safe folder slug "haus-zum-wald". */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c])
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize driveFolderId from JSON: non-empty string or null.
 */
function normalizeDriveFolderId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * Per-client env: PULL_ASSETS_DRIVE_FOLDER_ID_HAUS_ZUM_WALD for client id "haus-zum-wald",
 * then fallback PULL_ASSETS_DRIVE_FOLDER_ID.
 */
function getDriveFolderIdFromEnv(clientId) {
  const suffix = clientId.toUpperCase().replace(/-/g, '_');
  const specificKey = `PULL_ASSETS_DRIVE_FOLDER_ID_${suffix}`;
  const specific = process.env[specificKey];
  if (specific != null && String(specific).trim() !== '') {
    return String(specific).trim();
  }
  const general = process.env.PULL_ASSETS_DRIVE_FOLDER_ID;
  if (general != null && String(general).trim() !== '') {
    return String(general).trim();
  }
  return null;
}

function canPromptForDriveFolderId() {
  if (process.env.CI) return false;
  if (
    ['1', 'true', 'yes'].includes(
      String(process.env.PULL_ASSETS_NO_PROMPT || '').toLowerCase()
    )
  ) {
    return false;
  }
  return Boolean(process.stdin.isTTY);
}

async function ensureEnquirer() {
  try {
    await import('enquirer');
  } catch {
    console.log('  enquirer not found — installing...');
    const result = spawnSync('pnpm', ['add', '-D', 'enquirer'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
    if (result.status !== 0) {
      throw new Error('Failed to install enquirer');
    }
  }
  const { default: enquirer } = await import('enquirer');
  return enquirer;
}

/**
 * When websites.json has no driveFolderId, prompt or read env (see file header).
 */
async function promptDriveFolderIdIfMissing(clientId, verbose = false) {
  const fromEnv = getDriveFolderIdFromEnv(clientId);
  if (fromEnv) {
    if (verbose) console.log(
      `  Using Drive folder ID from environment for client "${clientId}".`
    );
    return fromEnv;
  }
  if (!canPromptForDriveFolderId()) {
    const suffix = clientId.toUpperCase().replace(/-/g, '_');
    console.error(
      `  No driveFolderId in src/data/${clientId}/websites.json.`
    );
    console.error(
      `  Add "driveFolderId" to that file, or set PULL_ASSETS_DRIVE_FOLDER_ID_${suffix} or PULL_ASSETS_DRIVE_FOLDER_ID (non-interactive / CI).`
    );
    process.exit(1);
  }
  const enquirer = await ensureEnquirer();
  const { folderId } = await enquirer.prompt({
    type: 'input',
    name: 'folderId',
    message: `Google Drive folder ID for client "${clientId}" (missing in websites.json):`,
    validate: (v) =>
      v && String(v).trim() !== '' ? true : 'Enter a non-empty folder ID',
  });
  return String(folderId).trim();
}

/**
 * Scan src/data/<client>/websites.json files and return a map of
 * clientId → { driveFolderId, folderSlug } for every client that has websites.json.
 * driveFolderId may be null if not set in JSON (prompt or env at resolve time).
 * folderSlug is derived from the clientName field (slugified), falling back to the clientId.
 */
function discoverClientsFromData() {
  const dataDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(dataDir)) return {};

  const clients = {};
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name === 'current' ||
      entry.name.startsWith('.')
    )
      continue;
    const websitesPath = path.join(dataDir, entry.name, 'websites.json');
    if (!fs.existsSync(websitesPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(websitesPath, 'utf-8'));
      clients[entry.name] = {
        driveFolderId: normalizeDriveFolderId(data.driveFolderId),
        folderSlug: data.clientName ? slugify(data.clientName) : entry.name,
      };
    } catch {
      // skip unparseable files
    }
  }
  return clients;
}

/**
 * Resolve the effective config for a single client run.
 *
 * Discovers clients from src/data/<client>/websites.json (file must exist).
 * Falls back to a legacy flat config (rootDriveFolderId at top level) when no
 * client folders with websites.json are found.
 *
 * - --client=<id>  → use that client directly (error if not found)
 * - single client  → use it automatically
 * - multiple       → prompt the user to pick one
 *
 * If driveFolderId is missing in JSON, prompts for it (or uses env — see file header).
 *
 * Returns { resolvedConfig, resolvedClientId }.
 */
async function resolveClientConfig(baseConfig, clientArg, verbose = false) {
  const discovered = discoverClientsFromData();
  const clientIds = Object.keys(discovered);

  // Legacy mode: no websites.json under any client folder → use flat config
  if (clientIds.length === 0) {
    return { resolvedConfig: baseConfig, resolvedClientId: null };
  }

  let selectedId;

  if (clientArg) {
    if (!discovered[clientArg]) {
      console.error(
        `  Client "${clientArg}" not found (no src/data/${clientArg}/websites.json). Available: ${clientIds.join(', ')}`
      );
      process.exit(1);
    }
    selectedId = clientArg;
  } else if (clientIds.length === 1) {
    selectedId = clientIds[0];
    if (verbose) console.log(`  Using client: ${selectedId}`);
  } else {
    // Multiple clients → prompt
    const enquirer = await ensureEnquirer();
    const { id } = await enquirer.prompt({
      type: 'select',
      name: 'id',
      message: 'Which client do you want to pull assets for?',
      choices: clientIds,
    });
    selectedId = id;
  }

  const { driveFolderId: idFromJson, folderSlug } = discovered[selectedId];
  const driveFolderId =
    idFromJson ?? (await promptDriveFolderIdIfMissing(selectedId, verbose));

  const baseOutputDir = baseConfig.outputBaseDir || 'googleDrive';
  const clientOutputDir = `${baseOutputDir}/${folderSlug}`;

  if (verbose) console.log(`  Output folder: ${clientOutputDir}`);

  const resolvedConfig = {
    ...baseConfig,
    rootDriveFolderId: driveFolderId,
    outputBaseDir: clientOutputDir,
    extraFilesOutputDir: clientOutputDir,
  };

  return { resolvedConfig, resolvedClientId: selectedId };
}

/**
 * Remove stale local copies of extra files (e.g. data.xlsx) from src/data/<clientId>/.
 * These copies can drift out of sync with the Google Drive version and cause data issues
 * in downstream scripts (e.g. 04-process-excel-data) that read both locations.
 */
function deleteStaleLocalExtraFiles(clientId, extraFiles, verbose = false) {
  if (!clientId || !extraFiles.length) return;
  const clientDataDir = path.join(ROOT, 'src', 'data', clientId);
  for (const fileName of extraFiles) {
    const filePath = path.join(clientDataDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      if (verbose) console.log(
        `  Removed stale local copy: src/data/${clientId}/${fileName}`
      );
    }
  }
}

function envBool(name) {
  const v = process.env[name];
  if (v == null || v === '') return null;
  const lower = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return null;
}

function createBaseConfig() {
  return {
    credentialsPath: DRIVE_CREDENTIALS_PATH,
    outputBaseDir: DRIVE_OUTPUT_BASE_DIR,
    siteFolderPrefix: DRIVE_SITE_FOLDER_PREFIX,
    extraFiles: [...DRIVE_EXTRA_FILES],
    extraFilesOutputDir: DRIVE_OUTPUT_BASE_DIR,
  };
}

function resolveSkipUnchangedFlags(
  baseConfig,
  { skipUnchanged: argSkip, skipUnchangedRelaxed: argRelaxed, verbose }
) {
  const envSkip = envBool('PULL_ASSETS_SKIP_UNCHANGED');
  const envRelaxed = envBool('PULL_ASSETS_SKIP_RELAXED');

  let skipUnchanged = baseConfig.skipUnchanged !== false;
  if (argSkip === false) skipUnchanged = false;
  else if (envSkip === false) skipUnchanged = false;
  else if (envSkip === true) skipUnchanged = true;

  let skipUnchangedRelaxed = Boolean(baseConfig.skipUnchangedRelaxed);
  if (argRelaxed === true) skipUnchangedRelaxed = true;
  else if (envRelaxed === true) skipUnchangedRelaxed = true;
  else if (envRelaxed === false) skipUnchangedRelaxed = false;

  return { skipUnchanged, skipUnchangedRelaxed, verbose };
}

async function main() {
  const {
    client,
    excelOnly,
    concurrency,
    skipUnchanged: argSkipUnchanged,
    skipUnchangedRelaxed: argSkipRelaxed,
    verbose,
    folderId,
    outputDir,
  } = parseArgs();
  const baseConfig = createBaseConfig();

  let resolvedConfig, resolvedClientId;

  if (folderId) {
    // --folder-id bypasses client discovery — use the folder ID directly.
    const baseOutputDir = outputDir ?? DRIVE_OUTPUT_BASE_DIR;
    resolvedConfig = {
      ...baseConfig,
      rootDriveFolderId: folderId,
      outputBaseDir: baseOutputDir,
      extraFilesOutputDir: baseOutputDir,
    };
    resolvedClientId = null;
  } else {
    ({ resolvedConfig, resolvedClientId } = await resolveClientConfig(
      baseConfig,
      client,
      verbose
    ));
  }
  // Delete stale local copies of extra files before downloading fresh ones from Drive.
  // Prevents src/data/<client>/data.xlsx from shadowing the authoritative Drive version.
  deleteStaleLocalExtraFiles(resolvedClientId, resolvedConfig.extraFiles ?? [], verbose);

  const effectiveConcurrency =
    concurrency ||
    Number.parseInt(process.env.PULL_ASSETS_CONCURRENCY || '', 10) ||
    resolvedConfig.downloadConcurrency ||
    DEFAULT_DOWNLOAD_CONCURRENCY;
  resolvedConfig.downloadConcurrency = Math.max(1, effectiveConcurrency);
  if (verbose) console.log(
    `  Download concurrency: ${resolvedConfig.downloadConcurrency}`
  );

  const skipFlags = resolveSkipUnchangedFlags(resolvedConfig, {
    skipUnchanged: argSkipUnchanged,
    skipUnchangedRelaxed: argSkipRelaxed,
    verbose,
  });
  Object.assign(resolvedConfig, skipFlags);
  if (verbose) console.log(
    `  Skip unchanged: ${resolvedConfig.skipUnchanged}${resolvedConfig.skipUnchangedRelaxed ? ' (relaxed: size-only when no md5)' : ''}`
  );

  const credentialsPath = resolvedConfig.credentialsPath || DRIVE_CREDENTIALS_PATH;

  const drive = await getDriveClient(credentialsPath);

  if (excelOnly) {
    if (verbose) console.log(
      '  Mode: --excel-only (extraFiles only). Site-* folders are not downloaded. For full assets run: pnpm 02-pull-assets'
    );
    // Only download extraFiles (e.g. data.xlsx) from the root Drive folder
    if (!resolvedConfig.rootDriveFolderId) {
      console.error(
        '  --excel-only requires rootDriveFolderId in config.'
      );
      process.exit(1);
    }

    let effectiveExtraFiles = resolvedConfig.extraFiles ?? [];

    // When --folder-id is used directly and no extraFiles are configured,
    // auto-discover any .xlsx files in the root Drive folder.
    if (folderId && effectiveExtraFiles.length === 0) {
      const allFiles = await listFilesInFolder(
        drive,
        resolvedConfig.rootDriveFolderId
      );
      const xlsxNames = allFiles
        .filter((f) => f.name.toLowerCase().endsWith('.xlsx'))
        .map((f) => f.name);
      if (xlsxNames.length === 0) {
        console.warn(
          '  --excel-only: no .xlsx files found in Drive folder.'
        );
        return;
      }
      if (verbose) console.log(
        `  Auto-discovered xlsx: ${xlsxNames.join(', ')}`
      );
      effectiveExtraFiles = xlsxNames;
    }

    if (!effectiveExtraFiles.length) {
      console.warn(
        '  --excel-only: no extra files configured.'
      );
      return;
    }
    await pullExtraFiles(drive, {
      ...resolvedConfig,
      extraFiles: effectiveExtraFiles,
    });
    return;
  } else if (resolvedConfig.rootDriveFolderId) {
    // When resolvedClientId is set, rootDriveFolderId is already scoped to
    // that client's Drive folder — don't filter site-* subfolders by name.
    const siteFolderFilter = resolvedClientId ? null : client || null;
    await pullSiteFolders(drive, resolvedConfig, siteFolderFilter);
    await pullExtraFiles(drive, resolvedConfig);
  } else {
    const websites = resolvedConfig.websites || {};
    const websiteIds = client ? [client] : Object.keys(websites);
    if (websiteIds.length === 0) {
      console.error(
        '  No client websites discovered. Ensure src/data/<client>/websites.json exists and includes driveFolderId.'
      );
      process.exit(1);
    }
    const pullOpts = {
      skipUnchanged: resolvedConfig.skipUnchanged,
      skipUnchangedRelaxed: resolvedConfig.skipUnchangedRelaxed,
      verbose: resolvedConfig.verbose,
    };
    for (const id of websiteIds) {
      const siteConfig = websites[id];
      if (!siteConfig) {
        console.warn(`  Unknown client: ${id}, skipping.`);
        continue;
      }
      await pullForWebsite(drive, id, siteConfig, pullOpts);
    }
  }
}

main().catch((err) => {
  console.error('  ', err.message || err);
  process.exit(1);
});
