/**
 * Fix image paths in src/data/<client>/websites.json using files on disk under:
 *   public/images/<siteId>/... (all nested image files)
 *
 * This script ONLY normalizes image path fields (logo/hero/info/gallery/trustblock/about + OG/twitter/schema),
 * using the same shared helper as 06/clone/08: applyDiskImagePathsToEntry().
 *
 * Usage:
 *   pnpm 09-fix-image-paths -- --client=tiemann-photography
 *   pnpm 09-fix-image-paths -- --client=tiemann-photography --site=fotograf-hochzeit
 *   pnpm 09-fix-image-paths -- --client=tiemann-photography --dry-run
 *   pnpm 09-fix-image-paths -- --client=tiemann-photography --metadata-absolute
 */

import fs from 'fs';
import path from 'path';
import { applyDiskImagePathsToEntry, scanAvailableImages } from './lib/website-disk-images';

type WebsitesJson = {
  clientDomain?: string;
  clientName?: string;
  websites: Array<Record<string, unknown>>;
} | Array<Record<string, unknown>>;

const ROOT = process.cwd();

function parseArgs(): {
  clientId: string | null;
  siteId: string | null;
  dryRun: boolean;
  verbose: boolean;
  metadataMode: 'preserve' | 'relative' | 'absolute';
  metadataModeExplicit: boolean;
} {
  const args = process.argv.slice(2);
  let clientId: string | null = null;
  let siteId: string | null = null;
  let dryRun = false;
  let verbose = false;
  let metadataMode: 'preserve' | 'relative' | 'absolute' = 'preserve';
  let metadataModeExplicit = false;

  for (const a of args) {
    if (a.startsWith('--client=')) clientId = a.slice('--client='.length).trim() || null;
    else if (a.startsWith('--site=')) siteId = a.slice('--site='.length).trim() || null;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--metadata-relative') {
      metadataMode = 'relative';
      metadataModeExplicit = true;
    } else if (a === '--metadata-absolute') {
      metadataMode = 'absolute';
      metadataModeExplicit = true;
    } else if (a === '--metadata-preserve') {
      metadataMode = 'preserve';
      metadataModeExplicit = true;
    }
  }

  return {
    clientId,
    siteId,
    dryRun,
    verbose: verbose || dryRun,
    metadataMode,
    metadataModeExplicit,
  };
}

function discoverClientIds(): string[] {
  const dataDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((name) => name !== 'current' && name !== '_template')
    .filter((name) => fs.existsSync(path.join(dataDir, name, 'websites.json')))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

async function promptSelect<T extends string>(
  message: string,
  choices: T[]
): Promise<T> {
  const { default: enquirer } = await import('enquirer');
  const res = await enquirer.prompt<{ selected: T }>({
    type: 'select',
    name: 'selected',
    message,
    choices,
    // @ts-expect-error enquirer SelectOptions supports limit (types incomplete)
    limit: 20,
  });
  return res.selected;
}

function getWebsitesPath(clientId: string): string {
  return path.join(ROOT, 'src', 'data', clientId, 'websites.json');
}

function readWebsitesFile(websitesPath: string): WebsitesJson {
  const raw = fs.readFileSync(websitesPath, 'utf-8');
  return JSON.parse(raw) as WebsitesJson;
}

function extractWebsitesContainer(data: WebsitesJson): {
  container: { websites: Array<Record<string, unknown>> };
  isArrayTopLevel: boolean;
} {
  if (Array.isArray(data)) return { container: { websites: data }, isArrayTopLevel: true };
  return { container: data, isArrayTopLevel: false };
}

function writeWebsitesFile(
  websitesPath: string,
  original: WebsitesJson,
  updatedWebsites: Array<Record<string, unknown>>
): void {
  if (Array.isArray(original)) {
    fs.writeFileSync(websitesPath, JSON.stringify(updatedWebsites, null, 2) + '\n', 'utf-8');
    return;
  }
  const next = { ...(original as Record<string, unknown>), websites: updatedWebsites };
  fs.writeFileSync(websitesPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

function idOf(site: Record<string, unknown>): string {
  return typeof site.id === 'string' ? site.id.trim() : '';
}

function jsonStableStringify(value: unknown): string {
  // OK here: we just need a deterministic before/after comparison for mutation detection.
  return JSON.stringify(value);
}

function absolutizedImagesUrlToRelative(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = /^https?:\/\/[^/]+(\/images\/.+)$/i.exec(url.trim());
  return m ? m[1] : null;
}

type MetaSnapshotItem = {
  hasMeta: boolean;
  hasOpenGraph: boolean;
  openGraph?: unknown;
  hasTwitter: boolean;
  twitter?: unknown;
  hasSchema: boolean;
  schema?: unknown;
};

function snapshotMetadataImageUrls(site: Record<string, unknown>): string {
  const pages = site.pages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(pages)) return '';
  const out = pages.map((p) => {
    const meta = p.metadata as Record<string, unknown> | undefined;
    if (!meta) {
      const empty: MetaSnapshotItem = {
        hasMeta: false,
        hasOpenGraph: false,
        hasTwitter: false,
        hasSchema: false,
      };
      return empty;
    }
    const item: MetaSnapshotItem = {
      hasMeta: true,
      hasOpenGraph: Object.prototype.hasOwnProperty.call(meta, 'openGraph'),
      hasTwitter: Object.prototype.hasOwnProperty.call(meta, 'twitter'),
      hasSchema: Object.prototype.hasOwnProperty.call(meta, 'schema'),
    };
    if (item.hasOpenGraph) item.openGraph = meta.openGraph;
    if (item.hasTwitter) item.twitter = meta.twitter;
    if (item.hasSchema) item.schema = meta.schema;
    return {
      ...item,
    };
  });
  return JSON.stringify(out);
}

function restoreMetadataImageUrls(site: Record<string, unknown>, snapshot: string): void {
  if (!snapshot) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot) as unknown;
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  const pages = site.pages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(pages)) return;

  for (let i = 0; i < pages.length; i++) {
    const item = parsed[i] as MetaSnapshotItem | undefined;
    if (!item || typeof item !== 'object') continue;
    const meta = pages[i].metadata as Record<string, unknown> | undefined;
    if (!meta) continue;

    // Only restore keys that originally existed; otherwise delete keys that were introduced.
    if (item.hasOpenGraph) meta.openGraph = item.openGraph;
    else if ('openGraph' in meta) delete meta.openGraph;

    if (item.hasTwitter) meta.twitter = item.twitter;
    else if ('twitter' in meta) delete meta.twitter;

    if (item.hasSchema) meta.schema = item.schema;
    else if ('schema' in meta) delete meta.schema;
  }
}

function normalizeMetadataImagesToRelative(site: Record<string, unknown>): void {
  const pages = site.pages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(pages)) return;

  for (const page of pages) {
    const meta = page.metadata as Record<string, unknown> | undefined;
    if (!meta) continue;

    const og = meta.openGraph as Record<string, unknown> | undefined;
    if (og) {
      const images = og.images as unknown[] | undefined;
      if (Array.isArray(images)) {
        for (const img of images) {
          if (!img) continue;
          if (typeof img === 'string') {
            // Some configs store OG images as string URLs.
            // We can't mutate a primitive in-place here; leave it.
            continue;
          }
          if (typeof img === 'object') {
            const rec = img as Record<string, unknown>;
            const rel = absolutizedImagesUrlToRelative(rec.url);
            if (rel) rec.url = rel;
          }
        }
      }
    }

    const tw = meta.twitter as Record<string, unknown> | undefined;
    if (tw) {
      const images = tw.images as unknown;
      if (Array.isArray(images)) {
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          if (typeof img === 'string') {
            const rel = absolutizedImagesUrlToRelative(img);
            if (rel) images[i] = rel;
          } else if (img && typeof img === 'object') {
            const rec = img as Record<string, unknown>;
            const rel = absolutizedImagesUrlToRelative(rec.url);
            if (rel) rec.url = rel;
          }
        }
      }
    }

    const schemas = meta.schema as unknown[] | undefined;
    if (Array.isArray(schemas)) {
      for (const sch of schemas) {
        if (!sch || typeof sch !== 'object') continue;
        const s = sch as Record<string, unknown>;
        const data = s.data as Record<string, unknown> | undefined;
        if (!data) continue;
        const rel = absolutizedImagesUrlToRelative(data.logo);
        if (rel) data.logo = rel;
      }
    }
  }
}

function publicSiteHost(site: Record<string, unknown>): string {
  const raw =
    (typeof site.clientDomain === 'string' ? site.clientDomain : '') ||
    (typeof site.deployDomain === 'string' ? site.deployDomain : '');
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function toAbsoluteSiteImageUrl(value: unknown, host: string): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v; // already absolute
  if (!v.startsWith('/images/')) return null; // only normalize /images/*
  if (!host) return v; // host unknown, keep relative
  return `https://${host}${v}`;
}

function normalizeMetadataImagesToAbsolute(site: Record<string, unknown>): void {
  const host = publicSiteHost(site);
  const pages = site.pages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(pages)) return;

  for (const page of pages) {
    const meta = page.metadata as Record<string, unknown> | undefined;
    if (!meta) continue;

    const og = meta.openGraph as Record<string, unknown> | undefined;
    if (og) {
      const images = og.images as unknown[] | undefined;
      if (Array.isArray(images)) {
        for (const img of images) {
          if (!img) continue;
          if (typeof img === 'string') {
            // If OG images are stored as strings, we do not rewrite them here.
            continue;
          }
          if (typeof img === 'object') {
            const rec = img as Record<string, unknown>;
            const abs = toAbsoluteSiteImageUrl(rec.url, host);
            if (abs) rec.url = abs;
          }
        }
      }
    }

    const tw = meta.twitter as Record<string, unknown> | undefined;
    if (tw) {
      const images = tw.images as unknown;
      if (Array.isArray(images)) {
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          if (typeof img === 'string') {
            const abs = toAbsoluteSiteImageUrl(img, host);
            if (abs) images[i] = abs;
          } else if (img && typeof img === 'object') {
            const rec = img as Record<string, unknown>;
            const abs = toAbsoluteSiteImageUrl(rec.url, host);
            if (abs) rec.url = abs;
          }
        }
      }
    }

    const schemas = meta.schema as unknown[] | undefined;
    if (Array.isArray(schemas)) {
      for (const sch of schemas) {
        if (!sch || typeof sch !== 'object') continue;
        const s = sch as Record<string, unknown>;
        const data = s.data as Record<string, unknown> | undefined;
        if (!data) continue;
        const abs = toAbsoluteSiteImageUrl(data.logo, host);
        if (abs) data.logo = abs;
      }
    }
  }
}

function normalizeNonMetadataImageUrlsToRelative(site: Record<string, unknown>): void {
  const skipKeys = new Set(['metadata']);

  function walk(node: unknown, inMetadata: boolean): void {
    if (!node) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inMetadata);
      return;
    }
    if (typeof node !== 'object') return;

    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      const nextInMetadata = inMetadata || skipKeys.has(k);
      if (!nextInMetadata && typeof v === 'string') {
        const rel = absolutizedImagesUrlToRelative(v);
        if (rel) rec[k] = rel;
      } else {
        walk(v, nextInMetadata);
      }
    }
  }

  walk(site, false);
}

async function main(): Promise<void> {
  let { clientId, siteId, dryRun, verbose, metadataMode, metadataModeExplicit } =
    parseArgs();
  if (!clientId) {
    const clients = discoverClientIds();
    if (clients.length === 0) {
      console.error('No clients found under src/data/* with a websites.json.');
      process.exit(1);
    }
    if (clients.length === 1) {
      clientId = clients[0];
      if (verbose) console.log(`Using client: ${clientId}`);
    } else {
      clientId = await promptSelect('Which client do you want to fix image paths for?', clients);
    }
  }

  const websitesPath = getWebsitesPath(clientId);
  if (!fs.existsSync(websitesPath)) {
    console.error(`websites.json not found: ${websitesPath}`);
    process.exit(1);
  }

  const data = readWebsitesFile(websitesPath);
  const { container, isArrayTopLevel } = extractWebsitesContainer(data);
  const websites = container.websites ?? [];

  if (!Array.isArray(websites) || websites.length === 0) {
    console.error('websites.json has no websites array.');
    process.exit(1);
  }

  if (!siteId) {
    const ids = websites.map(idOf).filter(Boolean);
    const uniqueIds = [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en'));
    if (uniqueIds.length === 0) {
      console.error(`No websites[].id entries found in ${websitesPath}`);
      process.exit(1);
    }
    const choices = (['(all sites)' as const, ...uniqueIds] as const) as unknown as string[];
    const picked = await promptSelect(
      'Which site do you want to fix image paths for?',
      choices as string[]
    );
    siteId = picked === '(all sites)' ? null : picked;
  }

  if (!metadataModeExplicit) {
    const pickedMode = await promptSelect(
      'Metadata image URLs: what do you want to change?',
      [
        'preserve (do not touch metadata URLs)',
        'absolute (https://<clientDomain>/images/...)',
        'relative (/images/...)',
      ]
    );
    if (pickedMode.startsWith('absolute')) metadataMode = 'absolute';
    else if (pickedMode.startsWith('relative')) metadataMode = 'relative';
    else metadataMode = 'preserve';
  }

  const targets = siteId
    ? websites.filter((w) => idOf(w) === siteId)
    : websites;

  if (siteId && targets.length === 0) {
    console.error(`No website entry with id "${siteId}" found in ${websitesPath}`);
    process.exit(1);
  }

  let changedCount = 0;
  let missingImagesCount = 0;

  for (const site of targets) {
    const wid = idOf(site);
    if (!wid) continue;

    const available = scanAvailableImages(wid);
    if (!available || available.all.length === 0) {
      missingImagesCount++;
      if (verbose) console.warn(`No images found under public/images/${wid}/ — skipping image normalization.`);
      continue;
    }

    const before = jsonStableStringify(site);
    // For preserve/relative we keep metadata as-is (relative is for non-metadata fields only).
    const metaSnapshot =
      metadataMode === 'preserve' || metadataMode === 'relative'
        ? snapshotMetadataImageUrls(site)
        : '';
    applyDiskImagePathsToEntry(site, available);
    if (metadataMode === 'preserve') {
      restoreMetadataImageUrls(site, metaSnapshot);
    } else if (metadataMode === 'absolute') {
      normalizeMetadataImagesToAbsolute(site);
    } else {
      // Relative: keep metadata unchanged, but normalize any other absolute /images URLs to relative.
      restoreMetadataImageUrls(site, metaSnapshot);
      normalizeNonMetadataImageUrlsToRelative(site);
    }
    const after = jsonStableStringify(site);

    if (before !== after) {
      changedCount++;
      if (verbose) {
        console.log(`✓ Updated image paths from disk for "${wid}" (${available.all.length} file(s))`);
      }
    } else if (verbose) {
      console.log(`· No image path changes for "${wid}"`);
    }
  }

  if (dryRun) {
    console.log('\n[DRY-RUN] No files written.');
    console.log(`Targets: ${targets.length}`);
    console.log(`Would change: ${changedCount}`);
    if (missingImagesCount > 0) {
      console.log(`Skipped (no images on disk): ${missingImagesCount}`);
    }
    return;
  }

  if (changedCount === 0) {
    console.log('No image path changes needed.');
    return;
  }

  // Persist changes by rewriting the websites file with the mutated objects.
  const updatedWebsites = websites;
  if (isArrayTopLevel) {
    writeWebsitesFile(websitesPath, data, updatedWebsites);
  } else {
    writeWebsitesFile(websitesPath, data, updatedWebsites);
  }

  console.log(`Saved image path updates to ${path.relative(ROOT, websitesPath)} (${changedCount} website(s) changed).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

