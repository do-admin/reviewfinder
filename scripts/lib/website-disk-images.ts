/**
 * Scan public/images/{siteId}/ and assign paths to website JSON entries.
 * Shared by scripts/06-generate-website.ts and scripts/clone-website.ts.
 */

import fs from 'fs';
import path from 'path';
import { readImageDimensions, computeHeaderLogoWidth } from './image-dimensions';

const PUBLIC_DIR = path.join(process.cwd(), 'public');

export interface AvailableImages {
  siteId: string;
  all: string[];
  byCategory: Record<string, string[]>;
}

export function scanAvailableImages(siteId: string): AvailableImages | null {
  const imageDir = path.join(PUBLIC_DIR, 'images', siteId);
  if (!fs.existsSync(imageDir)) return null;

  const all: string[] = [];
  const byCategory: Record<string, string[]> = {};

  function walkDir(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name));
      } else if (/\.(webp|jpg|jpeg|png|gif|svg|avif)$/i.test(entry.name)) {
        const fullPath = path.join(dir, entry.name);

        // Skip 0-byte placeholders (undelivered Drive assets) — would render as broken images.
        try {
          if (fs.statSync(fullPath).size === 0) continue;
        } catch {
          continue;
        }

        const relativePath = '/' + path.relative(PUBLIC_DIR, fullPath);
        all.push(relativePath);

        const parentFolder = path.basename(path.dirname(fullPath));
        const category = parentFolder === siteId ? 'root' : parentFolder;
        if (!byCategory[category]) byCategory[category] = [];
        byCategory[category].push(relativePath);
      }
    }
  }

  walkDir(imageDir);
  all.sort();
  return { siteId, all, byCategory };
}

function sortedCategoryPaths(
  byCategory: Record<string, string[]>,
  key: string
): string[] {
  return [...(byCategory[key] ?? [])].sort();
}

/** First existing path among category folders (e.g. hero, info, team). */
function firstPathInCategories(
  byCategory: Record<string, string[]>,
  ...categoryKeys: string[]
): string | undefined {
  for (const k of categoryKeys) {
    const s = sortedCategoryPaths(byCategory, k);
    if (s.length > 0) return s[0];
  }
  return undefined;
}

/** Prefer logo subfolder, else root file whose name contains "logo", else first root image. */
function pickLogoRelativePath(available: AvailableImages): string | undefined {
  const bc = available.byCategory;
  const fromLogoDir = firstPathInCategories(bc, 'logo');
  if (fromLogoDir) return fromLogoDir;
  const root = sortedCategoryPaths(bc, 'root');
  const logoNamed = root.find((p) => /logo/i.test(path.basename(p)));
  if (logoNamed) return logoNamed;
  return root[0];
}

function stringField(entry: Record<string, unknown>, key: string): string {
  const v = entry[key];
  return typeof v === 'string' ? v : '';
}

/** Host for absolute OG/schema image URLs. `clientDomain` first, `deployDomain` fallback; verbatim (no www mutation). */
function publicSiteHost(entry: Record<string, unknown>): string {
  const raw = stringField(entry, 'clientDomain') || stringField(entry, 'deployDomain');
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/** Build https://{host}/path for OG/schema; pass through if already absolute. */
function toAbsoluteSiteImageUrl(relativePath: string, host: string): string {
  if (!relativePath?.trim()) return relativePath;
  if (/^https?:\/\//i.test(relativePath)) return relativePath;
  if (!host) return relativePath;
  const p = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `https://${host}${p}`;
}

/**
 * Set every image `src` / path field from files on disk and derive absolute
 * openGraph / twitter / schema logo URLs.
 */
export function applyDiskImagePathsToEntry(
  entry: Record<string, unknown>,
  availableImages: AvailableImages | null
): void {
  if (!availableImages || availableImages.all.length === 0) return;

  const bc = availableImages.byCategory;
  const host = publicSiteHost(entry);

  const heroRel = firstPathInCategories(bc, 'hero');
  const infoRel = firstPathInCategories(bc, 'info', 'info-section');
  const teamRel = firstPathInCategories(bc, 'team');
  const logoRel = pickLogoRelativePath(availableImages);
  const gallerieSorted = sortedCategoryPaths(bc, 'gallerie');
  const aboutSorted = sortedCategoryPaths(bc, 'about');

  const abs = (rel: string | undefined): string =>
    rel ? toAbsoluteSiteImageUrl(rel, host) : '';

  if (teamRel) {
    const biz = entry.business as Record<string, unknown> | undefined;
    const cp = biz?.contactPerson as Record<string, unknown> | undefined;
    if (cp) cp.imageUrl = teamRel;
  }

  if (logoRel) {
    const h = entry.header as Record<string, unknown> | undefined;
    if (h) {
      h.logoUrl = logoRel;
      // Compute logoWidth from on-disk image; skip if operator already set a valid value.
      const currentRaw = h.logoWidth;
      const currentWidth =
        typeof currentRaw === 'number' && Number.isFinite(currentRaw) && currentRaw > 0
          ? currentRaw
          : 0;
      if (currentWidth === 0) {
        const absLogoPath = path.join(PUBLIC_DIR, logoRel.replace(/^\/+/, ''));
        const dims = readImageDimensions(absLogoPath);
        h.logoWidth = computeHeaderLogoWidth(dims);
      }
    }
  }

  const pages = entry.pages as Record<string, unknown>[] | undefined;
  if (!Array.isArray(pages) || pages.length === 0) return;

  const p0 = pages[0];
  if (p0 && typeof p0 === 'object') {
    const page0 = p0 as Record<string, unknown>;

    const hero = page0.hero as Record<string, unknown> | undefined;
    if (hero && heroRel) hero.backgroundImage = heroRel;

    const info = page0.info as Record<string, unknown> | undefined;
    if (info && infoRel) info.imageUrl = infoRel;

    const gallery = page0.gallery as Record<string, unknown> | undefined;
    if (gallery && gallerieSorted.length > 0) {
      const imgs = gallery.images as Array<Record<string, unknown>> | undefined;
      if (!imgs) {
        gallery.images = gallerieSorted.map((src) => ({ src, alt: '' }));
      } else {
        for (let i = 0; i < gallerieSorted.length; i++) {
          if (i < imgs.length) {
            imgs[i].src = gallerieSorted[i];
          } else {
            imgs.push({ src: gallerieSorted[i], alt: '' });
          }
        }
      }
    }

    const trust = page0.trust as Record<string, unknown> | undefined;
    if (trust) {
      delete trust.logos;
    }
  }

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi] as Record<string, unknown>;
    const pageName = typeof page.name === 'string' ? page.name : '';

    const ogRel =
      pageName === 'ueber-uns' && aboutSorted[0]
        ? aboutSorted[0]
        : (heroRel ?? aboutSorted[0]);

    const blocks = page.blocks as unknown[] | undefined;
    if (Array.isArray(blocks) && aboutSorted.length > 0) {
      let ai = 0;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'image' && 'src' in b) {
          // Preserve manual /team/ or /gallery/ paths; only auto-assign when empty or already pointing at /about/.
          const currentSrc = typeof b.src === 'string' ? b.src : '';
          const shouldOverride =
            !currentSrc.trim() || /\/about\//i.test(currentSrc);
          if (shouldOverride) {
            b.src = aboutSorted[ai % aboutSorted.length];
            ai++;
          }
        }
      }
    }

    const meta = page.metadata as Record<string, unknown> | undefined;
    if (meta) {
      if (ogRel) {
        const og = meta.openGraph as Record<string, unknown> | undefined;
        if (og) {
          const images = og.images as unknown[] | undefined;
          if (Array.isArray(images) && images.length > 0) {
            const first = images[0];
            if (first && typeof first === 'object' && first !== null) {
              (first as Record<string, unknown>).url = abs(ogRel);
            }
          }
        }

        const tw = meta.twitter as Record<string, unknown> | undefined;
        if (tw) {
          const timages = tw.images as unknown;
          if (Array.isArray(timages) && timages.length > 0) {
            const t0 = timages[0];
            if (typeof t0 === 'string') {
              timages[0] = abs(ogRel);
            } else if (t0 && typeof t0 === 'object') {
              (t0 as Record<string, unknown>).url = abs(ogRel);
            }
          }
        }
      }

      const schemas = meta.schema as unknown[] | undefined;
      if (Array.isArray(schemas) && logoRel) {
        for (const sch of schemas) {
          if (!sch || typeof sch !== 'object') continue;
          const s = sch as Record<string, unknown>;
          if (s.id !== 'organization') continue;
          const data = s.data as Record<string, unknown> | undefined;
          if (data) data.logo = abs(logoRel);
        }
      }
    }
  }
}
