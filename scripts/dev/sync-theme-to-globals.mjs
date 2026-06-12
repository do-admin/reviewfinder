/**
 * Syncs the active client's theme.config.json (src/data/current) into
 * src/styles/globals.css :root. Also validates font families against Google Fonts
 * and generates/writes googleFontsUrl from fonts.body and fonts.heading.
 *
 * Run after `pnpm use-client <client>`. Used by pnpm dev (predev) and pnpm sync-theme.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getThemeColorsDoc, stringifyThemeConfig } from '../lib/theme-config-disk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const THEME_CONFIG_PATH = path.join(ROOT, 'src', 'data', 'current', 'theme.config.json');
const GLOBALS_CSS_PATH = path.join(ROOT, 'src', 'styles', 'globals.css');

const GOOGLE_FONTS_CSS_BASE = 'https://fonts.googleapis.com/css2';
const BODY_WEIGHTS = '300;400;500;600;700';
const HEADING_WEIGHTS = '400;700';

const SEMANTIC_KEYS = [
  'background', 'foreground', 'heading-foreground', 'card', 'card-foreground',
  'primary', 'primary-foreground', 'secondary',
  'muted', 'muted-foreground', 'accent', 'accent-foreground', 'accent-soft',
  'tertiary', 'tertiary-foreground',
  'hero-cta', 'hero-cta-foreground',
  'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'radius',
];

// Only these tokens live in theme.config.json — the PO-picked pair plus the
// derived colors that depend on them. Everything else (background, muted,
// border, ring, destructive, …) keeps its globals.css default.
const THEME_CONFIG_KEYS = [
  'primary', 'accent',
  'primary-foreground', 'accent-foreground',
  'tertiary', 'tertiary-foreground',
  'accent-soft',
  'hero-cta', 'hero-cta-foreground',
];

// Tokens stripped from theme.config.json if they appear there (retired or now
// globals-only). Unknown custom keys like "hero-h1" are still preserved.
const STRIP_FROM_THEME_CONFIG = new Set(
  SEMANTIC_KEYS.filter((k) => k !== 'radius' && !THEME_CONFIG_KEYS.includes(k))
    .concat(['popover', 'popover-foreground'])
);

const DEFAULT_SEMANTIC = {
  background: '0 0% 100%',
  foreground: '220 13% 34%',
  'heading-foreground': '0 0% 7%',
  card: '0 0% 100%',
  'card-foreground': '0 0% 7%',
  primary: '328 85% 46%',
  'primary-foreground': '0 0% 100%',
  secondary: '0 0% 96%',
  muted: '0 0% 96%',
  'muted-foreground': '0 0% 40%',
  accent: '328 85% 46%',
  'accent-foreground': '0 0% 100%',
  'accent-soft': '328 60% 88%',
  tertiary: '0 0% 85%',
  'tertiary-foreground': '0 0% 7%',
  'hero-cta': '328 85% 46%',
  'hero-cta-foreground': '0 0% 100%',
  destructive: '0 84% 60%',
  'destructive-foreground': '0 0% 100%',
  border: '0 0% 90%',
  input: '0 0% 90%',
  ring: '328 85% 46%',
  radius: '0.5rem',
};

function encodeFamilyForUrl(family) {
  return String(family).trim().replace(/\s+/g, '+');
}

/**
 * Returns true if the theme appears to provide this font family via a local stylesheet
 * (e.g. fontStylesheetUrls contains "/fonts/Lemonade-Stand/fonts.css" for family "Lemonade Stand").
 */
function isLocalFont(theme, familyName) {
  const name = String(familyName).trim();
  if (!name) return false;
  const slug = name.replace(/\s+/g, '-');
  const urls = theme?.fontStylesheetUrls ?? [];
  return urls.some(
    (url) =>
      typeof url === 'string' &&
      url.startsWith('/') &&
      url.toLowerCase().includes(slug.toLowerCase())
  );
}

/**
 * Returns true if the family is served by Google Fonts (CSS API returns 200 and font-face for that family).
 */
async function isGoogleFont(family) {
  if (!family || !String(family).trim()) return false;
  const encoded = encodeFamilyForUrl(family);
  const url = `${GOOGLE_FONTS_CSS_BASE}?family=${encoded}&display=swap`;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const css = await res.text();
    const needleSingle = `font-family: '${family}'`;
    const needleDouble = `font-family: "${family}"`;
    return css.includes('@font-face') && (css.includes(needleSingle) || css.includes(needleDouble));
  } catch {
    return false;
  }
}

/**
 * Build Google Fonts CSS2 URL from font entries. Each entry: { family, role: 'body'|'heading' }.
 * Only includes families that pass validation. Uses BODY_WEIGHTS / HEADING_WEIGHTS.
 * Families that are provided locally (see isLocalFont) are skipped without warning.
 * @param {Array<{ family: string, role: string }>} fontEntries
 * @param {object} [theme] - Theme config; when present, fonts with a local stylesheet in fontStylesheetUrls are skipped silently.
 */
async function buildGoogleFontsUrl(fontEntries, theme) {
  const seen = new Set();
  const params = [];
  for (const { family, role } of fontEntries) {
    const name = String(family).trim();
    if (!name || seen.has(name)) continue;
    const valid = await isGoogleFont(name);
    if (!valid) {
      if (theme && isLocalFont(theme, name)) continue; // local font; skip without warning
      console.warn(`  ⚠ "${name}" is not a valid Google Font — skipping.`);
      continue;
    }
    seen.add(name);
    const weights = role === 'heading' ? HEADING_WEIGHTS : BODY_WEIGHTS;
    params.push(`family=${encodeFamilyForUrl(name)}:wght@${weights}`);
  }
  if (params.length === 0) return '';
  return `${GOOGLE_FONTS_CSS_BASE}?${params.join('&')}&display=swap`;
}

function loadThemeConfig() {
  if (!fs.existsSync(THEME_CONFIG_PATH)) {
    console.warn('  No theme config found — run use-client first.');
    return null;
  }
  let raw = fs.readFileSync(THEME_CONFIG_PATH, 'utf-8');
  raw = raw.replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('  Failed to parse theme config:', e.message);
    return null;
  }
}

function writeThemeConfig(theme) {
  theme.$colorsDoc = getThemeColorsDoc();
  fs.writeFileSync(THEME_CONFIG_PATH, stringifyThemeConfig(theme), 'utf-8');
}

/** Ensures $colorsDoc exists and matches the canonical text (e.g. after older configs). */
function ensureColorsDocInThemeFile(theme) {
  const want = getThemeColorsDoc();
  if (JSON.stringify(theme?.$colorsDoc) === JSON.stringify(want)) return;
  theme.$colorsDoc = want;
  writeThemeConfig(theme);
  console.log('  ✓ theme.config.json: $colorsDoc refreshed');
}

function parseHsl(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/([\d.]+)\s+([\d.]+)%?\s+([\d.]+)%?/);
  if (!m) return null;
  return { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
}

function formatHsl({ h, s, l }) {
  const round = (n, d = 1) => Number(n.toFixed(d));
  return `${round(h, 1)} ${round(s, 1)}% ${round(l, 1)}%`;
}

/**
 * Derive a third "tertiary" color from primary + accent so the template can
 * colour three cards from just two PO inputs.
 *
 * Hue: short-arc midpoint of primary + accent (so the derived hue always sits
 * visually between them). Saturation: max of the two, clamped to ≥25% so the
 * tint stays visible on white. Lightness: clamped to 55–70% so the /20 tint is
 * distinguishable from both primary/20 and accent/20. For monochrome brands
 * (s=0), the result stays neutral grey — we don't invent colour that isn't in
 * the brand.
 */
function deriveTertiary(primaryStr, accentStr) {
  const p = parseHsl(primaryStr);
  const a = parseHsl(accentStr);
  if (!p && !a) return null;
  const base = p ?? a;
  const other = a ?? p;

  const dh = ((other.h - base.h + 540) % 360) - 180; // short-arc delta
  const h = (base.h + dh / 2 + 360) % 360;

  let s = Math.max(base.s, other.s);
  if (s > 0) s = Math.max(s, 25);

  const l = Math.min(70, Math.max(55, (base.l + other.l) / 2));

  return formatHsl({ h, s, l });
}

/**
 * Auto-compute a readable text color for a given background HSL.
 * Light bg (lightness > 0.55) → dark text; otherwise white.
 * Returns null if the input is not a valid HSL component string.
 */
function deriveForeground(hslComponents) {
  if (!hslComponents || typeof hslComponents !== 'string') return null;
  const parts = hslComponents.match(/([\d.]+)\s+([\d.]+)%?\s+([\d.]+)%?/);
  if (!parts) return null;
  const l = parseFloat(parts[3]) / 100;
  return l > 0.55 ? '0 0% 7%' : '0 0% 100%';
}

/**
 * Auto-compute <key>-foreground from the base color if not explicitly set.
 * POs only pick Brand (primary) and Akzent (accent); their readable text
 * colors are derived here so nobody has to think about contrast in Excel.
 */
function ensureAutoForegrounds(colors) {
  for (const base of ['primary', 'accent', 'tertiary', 'hero-cta']) {
    const fgKey = `${base}-foreground`;
    if (colors[fgKey]) continue; // explicit value wins
    const derived = deriveForeground(colors[base]);
    if (derived) colors[fgKey] = derived;
  }
}

/**
 * Populate `tertiary` if the theme didn't provide one, derived from
 * primary + accent. Runs before ensureAutoForegrounds so its foreground
 * can be auto-computed too.
 */
function ensureTertiary(colors) {
  if (colors.tertiary) return;
  const derived = deriveTertiary(colors.primary, colors.accent);
  if (derived) colors.tertiary = derived;
}

/**
 * Hero CTA pill background. Defaults to the brand primary so the button matches
 * the rest of the site. The hero uses a light overlay (bg-black/20), so we no
 * longer brighten dark coloured primaries — only substitute white when primary
 * is near-black monochrome (e.g. Tiemann/Cube at 0 0% 0%) where a filled pill
 * would vanish on the photo.
 *
 * Rule:
 *   - s < 10 && L < 20  → white (foreground will end up dark).
 *   - otherwise         → primary unchanged.
 * Returns null if primary is missing.
 */
function deriveHeroCta(primaryStr) {
  const p = parseHsl(primaryStr);
  if (!p) return null;
  if (p.s < 10 && p.l < 20) return '0 0% 100%';
  return formatHsl(p);
}

function ensureHeroCta(colors) {
  if (colors['hero-cta']) return;
  const derived = deriveHeroCta(colors.primary);
  if (derived) colors['hero-cta'] = derived;
}

/**
 * Guarantee a visible "soft accent" card-background tint. When accent/20 over
 * white would be indistinguishable from white (near-white accent OR very low
 * saturation), we emit accent-soft as a boosted variant of accent's hue: sat
 * ≥30%, lightness clamped to [80, 88]. Otherwise we fall back to the raw
 * accent (card 3 uses bg-accent-soft directly; no opacity math needed).
 * Monochrome brands (sat=0) borrow the tertiary hue instead so card 3 still
 * differs from card 1.
 */
function ensureAccentSoft(colors) {
  if (colors['accent-soft']) return;
  const a = parseHsl(colors.accent);
  if (!a) return;

  const tooPale = a.l > 88;
  const tooGrey = a.s < 10;

  if (!tooPale && !tooGrey) {
    // Accent is visible at /20 — render the card with the normal accent tint.
    colors['accent-soft'] = formatHsl({ h: a.h, s: a.s, l: Math.min(a.l, 90) });
    return;
  }

  // Pick a hue with actual chroma: use accent's hue if it has any, else the
  // tertiary's (already complements primary) so card 3 ≠ card 1.
  let h = a.h;
  let s = a.s;
  if (tooGrey) {
    const t = parseHsl(colors.tertiary);
    if (t) { h = t.h; s = Math.max(t.s, 30); }
    else { s = 30; }
  } else {
    s = Math.max(s, 30);
  }

  const l = 85; // readable pastel; contrasts white background clearly
  colors['accent-soft'] = formatHsl({ h, s, l });
}

/**
 * Write the fully-resolved semantic palette back to theme.config.json.colors.
 * Keeps every SEMANTIC_KEYS entry (except `radius`, which isn't a color) in
 * stable order. Only writes if something actually changed, to avoid no-op
 * churn in git. A dev editing any of these values wins on the next run
 * because `ensure*` guards only derive when the slot is missing.
 */
function persistResolvedColors(theme, resolved) {
  if (!theme.colors) theme.colors = {};
  const ordered = {};
  let changed = false;
  for (const k of THEME_CONFIG_KEYS) {
    const value = resolved[k];
    if (typeof value !== 'string') continue;
    ordered[k] = value;
    if (theme.colors[k] !== value) changed = true;
  }
  // Preserve any extra custom color keys the theme already had (e.g. hero-h1)
  // but drop tokens that now live only in globals.css defaults.
  for (const [k, v] of Object.entries(theme.colors)) {
    if (k in ordered) continue;
    if (STRIP_FROM_THEME_CONFIG.has(k)) { changed = true; continue; }
    ordered[k] = v;
  }
  if (!changed && Object.keys(theme.colors).length === Object.keys(ordered).length) return;
  theme.colors = ordered;
  writeThemeConfig(theme);
}

function buildRootVars(colors, fonts) {
  const semanticOnly = {};
  for (const k of SEMANTIC_KEYS) semanticOnly[k] = colors[k] ?? DEFAULT_SEMANTIC[k];
  const lines = [
    '  /* Semantic colors (HSL component form). Synced from src/data/current/theme.config.json (colors + fonts) by pnpm sync-theme / predev. */',
    ...Object.entries(semanticOnly).map(([key, value]) => `  --${key}: ${value};`),
  ];

  const bodyFont = fonts?.body;
  const headingFont = fonts?.heading;
  const DEFAULT_BODY = { family: 'Inter', fallback: 'Arial, Helvetica, sans-serif' };
  const DEFAULT_HEADING = { family: 'Amatic SC', fallback: 'Arial, Helvetica, sans-serif' };
  const b = bodyFont?.family ? bodyFont : DEFAULT_BODY;
  const h = headingFont?.family ? headingFont : DEFAULT_HEADING;
  lines.push(
    `  --font-body: '${b.family}', ${b.fallback ?? DEFAULT_BODY.fallback};`,
    `  --font-heading: '${h.family}', ${h.fallback ?? DEFAULT_HEADING.fallback};`,
  );

  return lines.join('\n');
}

async function main() {
  const theme = loadThemeConfig();
  if (!theme) {
    console.warn('  Skipping theme sync — run use-client first.');
    process.exit(0);
  }

  const colors = theme.colors ?? {};
  const fonts = theme.fonts ?? {};
  const bodyFamily = fonts.body?.family?.trim();
  const headingFamily = fonts.heading?.family?.trim();

  const fontEntries = [];
  if (bodyFamily) fontEntries.push({ family: bodyFamily, role: 'body' });
  if (headingFamily && headingFamily !== bodyFamily) fontEntries.push({ family: headingFamily, role: 'heading' });

  let googleFontsUrl = theme.googleFontsUrl ?? '';
  if (fontEntries.length > 0) {
    const generated = await buildGoogleFontsUrl(fontEntries, theme);
    if (generated) {
      googleFontsUrl = generated;
      const hasLocalFonts = Array.isArray(theme.fontStylesheetUrls) && theme.fontStylesheetUrls.length > 0;
      if (hasLocalFonts) {
        theme.fontStylesheetUrls[0] = generated;
        delete theme.googleFontsUrl;
      } else {
        theme.googleFontsUrl = googleFontsUrl;
      }
      writeThemeConfig(theme);
    }
  }

  // Derive foregrounds from the PO-picked base colors before falling back to
  // defaults, so e.g. a light accent gets dark text even if DEFAULT_SEMANTIC
  // would have given white.
  const withDerived = { ...colors };
  ensureTertiary(withDerived);
  ensureAccentSoft(withDerived);
  ensureHeroCta(withDerived);
  ensureAutoForegrounds(withDerived);
  const mergedColors = { ...DEFAULT_SEMANTIC, ...withDerived };

  // Persist the fully-resolved palette back into theme.config.json so any
  // token (not just primary/accent) can be edited by a dev. Derivation only
  // runs when a slot is missing, so edits here always win on the next sync.
  persistResolvedColors(theme, mergedColors);

  const rootContent = buildRootVars(mergedColors, fonts);

  let css = fs.readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const rootBlockRegex = /:root\s*\{([\s\S]*?)\s*\}/;
  const match = css.match(rootBlockRegex);
  if (!match) {
    console.error('  Could not find :root block in globals.css');
    process.exit(1);
  }
  css = css.replace(rootBlockRegex, `:root {\n${rootContent}\n}`);
  fs.writeFileSync(GLOBALS_CSS_PATH, css, 'utf-8');
  console.log('  ✓ Theme synced to styles.');

  ensureColorsDocInThemeFile(theme);
}

main().catch((err) => {
  console.error('  Theme sync failed:', err.message || err);
  process.exit(1);
});
