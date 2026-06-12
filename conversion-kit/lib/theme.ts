/**
 * Theme configuration loader and CSS variable generator.
 * Theme is loaded from the active client folder (src/data/current/theme.config.json).
 *
 * Fonts: Set fonts.body (body text) and fonts.heading (headings). For system fonts
 * leave googleFontsUrl empty; for web fonts set googleFontsUrl to the stylesheet URL.
 *
 * Colors: Single "colors" object. Known semantic keys (primary, accent, background, etc.)
 * are emitted as --primary, --accent, etc. Any other key is emitted as --color-<key>.
 * Semantic values should be HSL component form (e.g. "0 0% 20.5%") for use with hsl(var(--x)).
 */

import themeConfigJson from '@/data/theme.config.json';

export interface ThemeFont {
  family: string;
  fallback: string;
}

export interface ThemeConfig {
  /** Semantic keys (primary, accent, ...) → --key; other keys → --color-<key>. Values: HSL component form for semantic, any CSS color for custom. */
  colors?: Record<string, string>;
  fonts?: {
    body?: ThemeFont;
    heading?: ThemeFont;
  };
  /** Full URL for font stylesheet (e.g. Google Fonts). Leave empty for system fonts only. */
  googleFontsUrl?: string;
  /** When set, full list of font stylesheet URLs (Google API and/or site-relative e.g. /fonts/X/fonts.css). Takes precedence over single googleFontsUrl. */
  fontStylesheetUrls?: string[];
  /**
   * Per-component Tailwind class overrides. Values are raw Tailwind class strings
   * applied on top of the component's baseline classes. Known keys:
   *   - `faqHeading` — classes on the FAQ-question span (default: `text-2xl font-bold`).
   * Add new keys here as needed; read them via `getCustomCssClass(key, fallback)`.
   */
  customCss?: Record<string, string>;
}

/** Keys that are emitted as --key (semantic). All other keys in colors are emitted as --color-<key>. */
const SEMANTIC_KEYS = new Set([
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary',
  'muted', 'muted-foreground', 'accent',
  'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'radius',
]);

const DEFAULT_SEMANTIC: Record<string, string> = {
  background: '0 0% 100%',
  foreground: '0 0% 7%',
  card: '0 0% 100%',
  'card-foreground': '0 0% 7%',
  popover: '0 0% 100%',
  'popover-foreground': '0 0% 7%',
  primary: '328 85% 46%',
  'primary-foreground': '0 0% 100%',
  secondary: '0 0% 96%',
  muted: '0 0% 96%',
  'muted-foreground': '0 0% 40%',
  accent: '328 85% 46%',
  destructive: '0 84% 60%',
  'destructive-foreground': '0 0% 100%',
  border: '0 0% 90%',
  input: '0 0% 90%',
  ring: '328 85% 46%',
  radius: '0.5rem',
};

/** Default font stylesheet URL when not set in config. */
const DEFAULT_GOOGLE_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Amatic+SC:wght@400;700&family=Inter:wght@300;400;500;600;700&display=swap';

const DEFAULT_FONTS: NonNullable<ThemeConfig['fonts']> = {
  body: { family: 'Inter', fallback: 'Arial, Helvetica, sans-serif' },
  // 'cursive' is intentionally avoided as the final fallback because on many
  // systems it maps to a font (e.g. Apple Chancery) that lacks German glyphs or
  // renders them at zero visible size. Arial is Latin-complete on all platforms.
  heading: { family: 'Amatic SC', fallback: 'Arial, Helvetica, sans-serif' },
};

const cfg = themeConfigJson as ThemeConfig;
const merged: ThemeConfig = {
  colors: { ...DEFAULT_SEMANTIC, ...cfg.colors },
  fonts: {
    body: {
      family: cfg.fonts?.body?.family ?? DEFAULT_FONTS.body!.family,
      fallback: cfg.fonts?.body?.fallback ?? DEFAULT_FONTS.body!.fallback,
    },
    heading: {
      family: cfg.fonts?.heading?.family ?? DEFAULT_FONTS.heading!.family,
      fallback: cfg.fonts?.heading?.fallback ?? DEFAULT_FONTS.heading!.fallback,
    },
  },
  googleFontsUrl: cfg.googleFontsUrl ?? DEFAULT_GOOGLE_FONTS_URL,
  fontStylesheetUrls: cfg.fontStylesheetUrls,
  customCss: cfg.customCss ?? {},
};

export function getThemeConfig(): ThemeConfig {
  return merged;
}

/**
 * Return a Tailwind class string from `theme.config.json`'s `customCss.<key>` when
 * set (and non-empty after trim), otherwise the provided fallback. Lets components
 * opt-in to per-client style overrides without forcing every client to declare them.
 */
export function getCustomCssClass(key: string, fallback: string): string {
  const raw = getThemeConfig().customCss?.[key];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || fallback;
}

/**
 * Generate :root CSS custom properties from theme config.
 * Semantic keys → --key; other keys in colors → --color-<key>. Font vars always emitted.
 */
export function getThemeCssVars(config?: ThemeConfig): string {
  const c = config ?? getThemeConfig();
  const lines: string[] = [];

  if (c.colors && Object.keys(c.colors).length > 0) {
    for (const [key, value] of Object.entries(c.colors)) {
      const varName = key.startsWith('--')
        ? key
        : SEMANTIC_KEYS.has(key)
          ? `--${key}`
          : `--color-${key}`;
      lines.push(`  ${varName}: ${value};`);
    }
  }

  if (c.fonts) {
    const body = c.fonts.body ?? DEFAULT_FONTS.body;
    const heading = c.fonts.heading ?? DEFAULT_FONTS.heading;
    lines.push(
      `  --font-body: '${body!.family}', ${body!.fallback};`,
      `  --font-heading: '${heading!.family}', ${heading!.fallback};`
    );
  }

  if (lines.length === 0) return '';
  return `:root {\n${lines.join('\n')}\n}`;
}

export function getThemeFontsUrl(config?: ThemeConfig): string | undefined {
  const c = config ?? getThemeConfig();
  if (c.googleFontsUrl !== undefined && c.googleFontsUrl !== null)
    return c.googleFontsUrl || undefined;
  return DEFAULT_GOOGLE_FONTS_URL;
}

/**
 * Returns the list of font stylesheet URLs to load.
 * If fontStylesheetUrls is set and non-empty, returns it; else if googleFontsUrl is set returns [googleFontsUrl]; else [].
 */
export function getThemeFontStylesheetUrls(config?: ThemeConfig): string[] {
  const c = config ?? getThemeConfig();
  if (c.fontStylesheetUrls && c.fontStylesheetUrls.length > 0) return c.fontStylesheetUrls;
  const single = getThemeFontsUrl(c);
  return single ? [single] : [];
}

/** Local font path convention: /fonts/<Folder>/fonts.css → woff2 at /fonts/<Folder>/400-normal-latin.woff2 */
const LOCAL_FONT_CSS_REGEX = /^\/fonts\/([^/]+)\/fonts\.css$/;

/**
 * Returns URLs for preloading local font woff2 files.
 * For each fontStylesheetUrl that looks like /fonts/X/fonts.css, returns /fonts/X/400-normal-latin.woff2.
 */
export function getThemeFontPreloadUrls(config?: ThemeConfig): string[] {
  const c = config ?? getThemeConfig();
  const urls = c.fontStylesheetUrls ?? [];
  const preload: string[] = [];
  for (const url of urls) {
    const m = typeof url === 'string' && url.startsWith('/') ? url.match(LOCAL_FONT_CSS_REGEX) : null;
    if (m) preload.push(`/fonts/${m[1]}/400-normal-latin.woff2`);
  }
  return preload;
}
