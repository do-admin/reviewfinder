/**
 * Portable AI content block registry: loads scripts/ai-block-registry.json (or AI_BLOCK_REGISTRY).
 * Used by 06-generate-website, 08-refine-website-data, and clone-website for consistent batching.
 */

import fs from 'fs';
import path from 'path';
import {
  buildAiPrompt,
  getAiPromptSection,
} from './ai-prompts';
import {
  groupPathsBySections,
  type SectionBatch,
} from './ai-protected-paths';

export type AiBlockScope = 'page' | 'root';

/** One logical block (page subtree or root prefix) in registration order. */
export type AiBlockEntry = {
  id: string;
  scope?: AiBlockScope;
  /** For scope "page": must match `pages[].name` in websites.json */
  pageName?: string;
  /** For scope "root": prefix under website root (e.g. business, header) */
  pathPrefix?: string;
  /** Dot path under the page or under pathPrefix; omit or "" for whole page / whole prefix subtree */
  propertyPath?: string;
  isArrayRoot?: boolean;
  batchSize?: number;
  /** clone-block-* sections; optional extra guidance for 06/08 */
  promptSection?: string;
};

export type AiBlockRegistry = {
  version: number;
  pageAliasToSlimRoot?: Record<string, string>;
  blocks: AiBlockEntry[];
};

export type CloneBlockSpec = {
  blockPath: string;
  promptSection: string;
  isArrayOfBlocks?: boolean;
  batchSize?: number;
};

export type PartitionedBatch = {
  /** Unique batch label (logging, OpenRouter tag) */
  section: string;
  blockId: string;
  paths: string[];
  promptSection?: string;
};

export type LoadAiBlockRegistryResult = {
  registry: AiBlockRegistry;
  resolvedPath: string;
};

const DEFAULT_RELATIVE = path.join('scripts', 'ai-block-registry.json');

/** Inline fallback if JSON is missing or invalid (matches committed default registry). */
const FALLBACK_CLONE_BLOCK_SPECS: CloneBlockSpec[] = [
  { blockPath: 'home.pageTitle', promptSection: 'clone-block-page-title' },
  { blockPath: 'home.metadata', promptSection: 'clone-block-metadata' },
  { blockPath: 'home.hero', promptSection: 'clone-block-hero' },
  { blockPath: 'home.info', promptSection: 'clone-block-info' },
  { blockPath: 'home.contact', promptSection: 'clone-block-contact' },
  { blockPath: 'home.gallery', promptSection: 'clone-block-gallery' },
  { blockPath: 'home.map', promptSection: 'clone-block-map' },
  { blockPath: 'home.faq', promptSection: 'clone-block-faq-intro' },
  { blockPath: 'home.trust', promptSection: 'clone-block-trust' },
  { blockPath: 'home.usp', promptSection: 'clone-block-usp' },
  { blockPath: 'home.features', promptSection: 'clone-block-features' },
  { blockPath: 'home.cta', promptSection: 'clone-block-cta' },
  { blockPath: 'home.services', promptSection: 'clone-block-services' },
  { blockPath: 'home.reviews', promptSection: 'clone-block-reviews-intro' },
  { blockPath: 'faq.pageTitle', promptSection: 'clone-block-page-title' },
  { blockPath: 'faq.metadata', promptSection: 'clone-block-metadata' },
  { blockPath: 'faq.hero', promptSection: 'clone-block-hero' },
  { blockPath: 'impressum.pageTitle', promptSection: 'clone-block-page-title' },
  { blockPath: 'impressum.metadata', promptSection: 'clone-block-metadata' },
  {
    blockPath: 'datenschutz.pageTitle',
    promptSection: 'clone-block-page-title',
  },
  { blockPath: 'datenschutz.metadata', promptSection: 'clone-block-metadata' },
  { blockPath: 'ueberUns.pageTitle', promptSection: 'clone-block-page-title' },
  { blockPath: 'ueberUns.metadata', promptSection: 'clone-block-metadata' },
  { blockPath: 'ueberUns.hero', promptSection: 'clone-block-hero' },
  { blockPath: 'ueberUns.info', promptSection: 'clone-block-info' },
  {
    blockPath: 'ueberUns.blocks',
    promptSection: 'clone-block-ueberuns-blocks',
    isArrayOfBlocks: true,
    batchSize: 4,
  },
];

function defaultRegistryPath(): string {
  const fromEnv = process.env.AI_BLOCK_REGISTRY?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(process.cwd(), fromEnv);
  return path.join(process.cwd(), DEFAULT_RELATIVE);
}

export function loadAiBlockRegistry(
  resolvedPath = defaultRegistryPath()
): LoadAiBlockRegistryResult | null {
  try {
    if (!fs.existsSync(resolvedPath)) return null;
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw) as AiBlockRegistry;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.blocks) || parsed.blocks.length === 0) return null;
    return { registry: parsed, resolvedPath };
  } catch {
    return null;
  }
}

export function slimBlockPathFromEntry(
  block: AiBlockEntry,
  pageAliasToSlimRoot: Record<string, string>
): string {
  const scope = block.scope ?? 'page';
  if (scope === 'root') {
    const base = block.pathPrefix?.trim() ?? '';
    const rest = block.propertyPath?.trim();
    if (!base) return '';
    return rest ? `${base}.${rest}` : base;
  }
  const pageName = block.pageName?.trim();
  if (!pageName) return '';
  const slimKey = pageAliasToSlimRoot[pageName] ?? pageName;
  const rest = block.propertyPath?.trim();
  if (!rest) return slimKey;
  return `${slimKey}.${rest}`;
}

export function registryToCloneBlockSpecs(
  registry: AiBlockRegistry
): CloneBlockSpec[] {
  const aliases = registry.pageAliasToSlimRoot ?? {};
  const out: CloneBlockSpec[] = [];
  for (const b of registry.blocks) {
    const blockPath = slimBlockPathFromEntry(b, aliases);
    if (!blockPath) continue;
    const promptSection = b.promptSection?.trim();
    if (!promptSection) continue;
    out.push({
      blockPath,
      promptSection,
      isArrayOfBlocks: b.isArrayRoot,
      batchSize: b.batchSize,
    });
  }
  return out;
}

/**
 * Clone pipeline: load JSON registry or use inline fallback (same order as legacy CLONE_BLOCK_REGISTRY).
 */
export function getCloneBlockSpecsWithFallback(
  log?: (msg: string) => void
): CloneBlockSpec[] {
  const loaded = loadAiBlockRegistry();
  if (!loaded) {
    log?.(
      `[ai-block-registry] No registry at ${defaultRegistryPath()} — using built-in clone block fallback`
    );
    return FALLBACK_CLONE_BLOCK_SPECS;
  }
  const specs = registryToCloneBlockSpecs(loaded.registry);
  if (specs.length === 0) {
    log?.(
      `[ai-block-registry] Registry at ${loaded.resolvedPath} produced no clone specs — using built-in fallback`
    );
    return FALLBACK_CLONE_BLOCK_SPECS;
  }
  return specs;
}

export function parsePathSegments(pathValue: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const parts = pathValue.split('.');
  for (const part of parts) {
    const regex = /([^[\]]+)|\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(part)) !== null) {
      if (match[1]) {
        segments.push(match[1]);
      } else if (match[2]) {
        segments.push(Number(match[2]));
      }
    }
  }
  return segments;
}

export function getValueAtPath(root: unknown, pathValue: string): unknown {
  const segments = parsePathSegments(pathValue);
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current))
        return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

export function findPageIndexByName(
  website: Record<string, unknown>,
  pageName: string
): number {
  const pages = website.pages;
  if (!Array.isArray(pages)) return -1;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      if ((p as Record<string, unknown>).name === pageName) return i;
    }
  }
  return -1;
}

function guessAbsoluteBase(website: Record<string, unknown>): string {
  const pages = website.pages;
  if (!Array.isArray(pages)) return 'https://www.example.com';
  const home = pages.find(
    (p) =>
      p &&
      typeof p === 'object' &&
      !Array.isArray(p) &&
      (p as Record<string, unknown>).name === 'home'
  ) as Record<string, unknown> | undefined;
  const og = home?.metadata as Record<string, unknown> | undefined;
  const openGraph = og?.openGraph as Record<string, unknown> | undefined;
  const url = openGraph?.url;
  if (typeof url === 'string' && url.startsWith('http')) {
    return url.replace(/\/$/, '');
  }
  return 'https://www.example.com';
}

function interpolateLoose(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key in vars ? vars[key]! : `{{${key}}}`
  );
}

/**
 * Optional block guidance (clone-block-*) appended to fill-blanks or content-quality base prompts.
 */
export function augmentSystemPromptForBlock(
  baseKey: 'fill-blanks-flat' | 'content-quality-review',
  protectedPathsBlock: string,
  website: Record<string, unknown>,
  promptSection?: string
): string {
  const base = buildAiPrompt(baseKey, {
    PROTECTED_PATHS_BLOCK: protectedPathsBlock,
  });
  if (!promptSection?.trim()) return base;
  const raw = getAiPromptSection(promptSection.trim());
  const abs = guessAbsoluteBase(website);
  const wid = typeof website.id === 'string' ? website.id : 'website';
  const host = abs.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const extra = interpolateLoose(raw, {
    NEW_SITE_ID: wid,
    DEPLOY_DOMAIN: host,
    ABSOLUTE_BASE: abs,
  });
  return `${base}\n\n---\n\nBLOCK-SPECIFIC GUIDANCE:\n\n${extra}`;
}

function resolveBasePrefix(
  block: AiBlockEntry,
  website: Record<string, unknown>
): string | null {
  const scope = block.scope ?? 'page';
  if (scope === 'root') {
    const pfx = block.pathPrefix?.trim();
    if (!pfx) return null;
    const prop = block.propertyPath?.trim();
    return prop ? `${pfx}.${prop}` : pfx;
  }
  const pageName = block.pageName?.trim();
  if (!pageName) return null;
  const idx = findPageIndexByName(website, pageName);
  if (idx < 0) return null;
  const prop = block.propertyPath?.trim();
  return prop ? `pages[${idx}].${prop}` : `pages[${idx}]`;
}

function pullMatchingPaths(
  remaining: Set<string>,
  basePrefix: string
): string[] {
  const batchPaths: string[] = [];
  const dot = `${basePrefix}.`;
  for (const p of [...remaining]) {
    if (p === basePrefix || p.startsWith(dot)) {
      batchPaths.push(p);
      remaining.delete(p);
    }
  }
  return batchPaths.sort();
}

function collectBatchesForBlock(
  block: AiBlockEntry,
  website: Record<string, unknown>,
  remaining: Set<string>
): PartitionedBatch[] {
  const basePrefix = resolveBasePrefix(block, website);
  if (!basePrefix) return [];

  if (block.isArrayRoot) {
    const arr = getValueAtPath(website, basePrefix);
    if (!Array.isArray(arr)) return [];
    const batchSize = block.batchSize ?? 4;
    const out: PartitionedBatch[] = [];
    for (let i = 0; i < arr.length; i += batchSize) {
      const batchPaths: string[] = [];
      const end = Math.min(i + batchSize, arr.length);
      for (let k = i; k < end; k++) {
        const itemPrefix = `${basePrefix}[${k}]`;
        const dot = `${itemPrefix}.`;
        for (const p of [...remaining]) {
          if (p === itemPrefix || p.startsWith(dot)) {
            batchPaths.push(p);
            remaining.delete(p);
          }
        }
      }
      if (batchPaths.length > 0) {
        const batchNum = Math.floor(i / batchSize) + 1;
        const maxBatch = Math.ceil(arr.length / batchSize);
        const suffix = maxBatch > 1 ? `:batch${batchNum}` : '';
        out.push({
          section: `${block.id}${suffix}`,
          blockId: `${block.id}${suffix}`,
          paths: batchPaths.sort(),
          promptSection: block.promptSection,
        });
      }
    }
    return out;
  }

  const batchPaths = pullMatchingPaths(remaining, basePrefix);
  if (batchPaths.length === 0) return [];
  return [
    {
      section: block.id,
      blockId: block.id,
      paths: batchPaths,
      promptSection: block.promptSection,
    },
  ];
}

function legacyPartition(paths: string[]): PartitionedBatch[] {
  return groupPathsBySections(paths).map((s: SectionBatch) => ({
    section: s.section,
    blockId: `legacy:${s.section}`,
    paths: [...s.paths],
    promptSection: undefined,
  }));
}

/**
 * Assign paths to registry blocks in order; leftover paths get groupPathsBySections batches.
 */
export function partitionFillablePaths(
  paths: string[],
  website: Record<string, unknown>,
  registry: AiBlockRegistry | null
): PartitionedBatch[] {
  if (!registry?.blocks?.length) return legacyPartition(paths);

  const remaining = new Set(paths);
  const out: PartitionedBatch[] = [];

  for (const block of registry.blocks) {
    const batches = collectBatchesForBlock(block, website, remaining);
    out.push(...batches);
  }

  if (remaining.size > 0) {
    const rem = [...remaining];
    const legacy = groupPathsBySections(rem);
    for (const s of legacy) {
      out.push({
        section: s.section,
        blockId: `legacy:${s.section}`,
        paths: [...s.paths],
        promptSection: undefined,
      });
    }
  }

  return out;
}
