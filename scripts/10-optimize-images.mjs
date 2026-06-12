/**
 * Generate responsive WebP variants next to originals under public/images/.
 * Preset widths: `src/lib/responsiveImagePresets.mjs` (shared with ResponsiveImage).
 *
 * For each raster file, emits `<basename>-w<width>.webp` (never overwrites originals).
 * Skips files that already look like variants (`*-w123.webp` or legacy `*-123w.webp`).
 * Skips each variant that already exists, is non-empty, and is at least as new as the source.
 *
 * Usage:
 *   pnpm 10-optimize-images
 *   node scripts/10-optimize-images.mjs --dry-run
 *
 * Also importable: `import { runOptimizeImages } from './10-optimize-images.mjs'`
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { glob } from 'glob';
import {
  DEFAULT_OPTIMIZE_PRESET,
  getPresetWidths,
} from '../src/lib/responsiveImagePresets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_IMAGES_DIR = path.join(ROOT, 'public', 'images');

const EXT_RE = /\.(webp|jpg|jpeg|png)$/i;

/** Matches responsive variants: `-wNNN.webp` (current) or legacy `-NNNw.webp`. */
function isResponsiveVariant(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext !== '.webp') return false;
  const base = path.basename(absPath, ext);
  return /-w\d+$/i.test(base) || /-\d+w$/i.test(base);
}

/**
 * Infer preset from normalized path segments (POSIX-style, lowercased).
 * First matching rule wins (order matters).
 *
 * Folder-based rules run before filename heuristics so trustblock files named
 * `*-logo.webp` use the trust preset, not logo ([180, 360] vs [120, 240]).
 */
function presetForRelativePath(relPath) {
  const lowered = relPath.replace(/\\/g, '/').toLowerCase();

  const has = (needle) =>
    lowered.split('/').includes(needle) ||
    lowered.includes(`/${needle}/`) ||
    lowered.startsWith(`${needle}/`);

  if (
    has('trust') ||
    has('partner') ||
    has('trustblock') ||
    lowered.includes('partnerlogos')
  ) {
    return 'trust';
  }
  if (has('team') || has('kontakt') || has('contact')) return 'team';
  if (
    has('gallerie') ||
    has('gallery') ||
    lowered.includes('/gallerie/')
  ) {
    return 'gallery';
  }
  if (
    has('hero') ||
    has('header') ||
    lowered.includes('hintergrund')
  ) {
    return 'hero';
  }
  if (has('info')) return 'info';
  if (has('avatar')) return 'avatar';
  if (has('logo') || lowered.includes('/logo/') || lowered.endsWith('/logo')) {
    return 'logo';
  }

  return DEFAULT_OPTIMIZE_PRESET;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return { dryRun: args.includes('--dry-run') || args.includes('-n') };
}

/**
 * @param {string} outPath
 * @param {string} srcPath
 * @returns {boolean} true if existing output is valid and up-to-date vs source
 */
function shouldSkipExistingVariant(outPath, srcPath) {
  if (!fs.existsSync(outPath)) return false;
  let outStat;
  let srcStat;
  try {
    outStat = fs.statSync(outPath);
    srcStat = fs.statSync(srcPath);
  } catch {
    return false;
  }
  if (outStat.size <= 0) return false;
  return outStat.mtimeMs >= srcStat.mtimeMs;
}

async function processFile(absPath, { dryRun, imagesDir }) {
  if (isResponsiveVariant(absPath)) {
    return { skipped: true, reason: 'variant' };
  }

  const base = path.basename(absPath, path.extname(absPath));

  const relFromImages = path.relative(imagesDir, absPath);
  const preset = presetForRelativePath(relFromImages);
  const widths = getPresetWidths(preset);

  const dir = path.dirname(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const results = [];

  for (const w of widths) {
    const outName = `${base}-w${w}.webp`;
    const outPath = path.join(dir, outName);

    if (shouldSkipExistingVariant(outPath, absPath)) {
      results.push({ w, outPath, action: 'skip-fresh' });
      continue;
    }

    if (dryRun) {
      results.push({ w, outPath, action: 'would-write' });
      continue;
    }

    const pipeline = sharp(absPath).resize({
      width: w,
      withoutEnlargement: true,
      fit: 'inside',
    });

    const finalPipeline =
      ext === '.png'
        ? pipeline.webp({ quality: 85, effort: 4, alphaQuality: 90 })
        : pipeline.webp({ quality: 82, effort: 4 });

    await finalPipeline.toFile(outPath);
    results.push({ w, outPath, action: 'written' });
  }

  return { skipped: false, preset, results };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.quiet] If true, omit per-file logs and some informational lines
 * @param {string} [options.root] Repo root (default: parent of scripts/)
 * @param {string} [options.imagesDir] Scan this directory instead of public/images
 * @returns {Promise<{ noDir: boolean, processedSources: number, written: number, skippedFresh: number }>}
 */
export async function runOptimizeImages(options = {}) {
  const {
    dryRun = false,
    quiet = false,
    root = ROOT,
    imagesDir = path.join(root, 'public', 'images'),
  } = options;

  const log = quiet ? () => {} : (...a) => console.log(...a);

  if (!fs.existsSync(imagesDir)) {
    if (!quiet) {
      console.warn(
        `[10-optimize-images] No directory at ${imagesDir} — nothing to do.`
      );
    }
    return {
      noDir: true,
      processedSources: 0,
      written: 0,
      skippedFresh: 0,
    };
  }

  const pattern = path.join(imagesDir, '**/*.{webp,jpg,jpeg,png}').replace(
    /\\/g,
    '/'
  );
  const files = await glob(pattern, {
    nodir: true,
    nocase: true,
    dot: false,
  });

  const rasterFiles = files.filter((f) => {
    const name = path.basename(f);
    if (!EXT_RE.test(name)) return false;
    if (isResponsiveVariant(f)) return false;
    return true;
  });

  if (rasterFiles.length === 0) {
    if (!quiet) {
      console.log('[10-optimize-images] No raster files found under public/images/');
    }
    return {
      noDir: false,
      processedSources: 0,
      written: 0,
      skippedFresh: 0,
    };
  }

  let written = 0;
  let skippedFresh = 0;

  log(
    `[10-optimize-images] ${dryRun ? '(dry-run) ' : ''}Processing ${rasterFiles.length} source file(s)…`
  );

  const ctx = { dryRun, imagesDir };

  for (const absPath of rasterFiles) {
    const out = await processFile(absPath, ctx);
    if (out.skipped) {
      continue;
    }
    for (const r of out.results ?? []) {
      if (r.action === 'written' || r.action === 'would-write') {
        written++;
        if (dryRun) {
          log(`  would write ${path.relative(root, r.outPath)} (${r.w}px)`);
        } else if (r.action === 'written') {
          log(`  wrote ${path.relative(root, r.outPath)} (${r.w}px)`);
        }
      }
      if (r.action === 'skip-fresh') skippedFresh++;
    }
  }

  console.log(
    `[10-optimize-images] Done. ${dryRun ? 'Would write / refresh' : 'Wrote'} ${written} variant(s); skipped up-to-date: ${skippedFresh}.`
  );

  return {
    noDir: false,
    processedSources: rasterFiles.length,
    written,
    skippedFresh,
  };
}

async function main() {
  const { dryRun } = parseArgs();
  await runOptimizeImages({ dryRun, quiet: false });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
