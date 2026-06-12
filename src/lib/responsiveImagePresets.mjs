/**
 * Single source of truth for responsive image widths and `sizes` hints.
 * Used by `src/components/ResponsiveImage.tsx` and `scripts/10-optimize-images.mjs`.
 * When adding a preset key, also update `responsiveImagePresets.d.ts`.
 */

/** @type {const} */
export const RESPONSIVE_IMAGE_PRESETS = {
  hero: {
    widths: [768, 1200, 1920],
    sizes: '100vw',
  },
  gallery: {
    widths: [400, 800, 1200],
    sizes: '(max-width: 768px) 100vw, 896px',
  },
  info: {
    widths: [400, 800],
    sizes: '(max-width: 1024px) 100vw, 50vw',
  },
  logo: {
    widths: [180, 360],
    sizes: '180px',
  },
  team: {
    widths: [256, 512],
    sizes: '256px',
  },
  trust: {
    widths: [120, 240],
    sizes: '120px',
  },
  avatar: {
    widths: [48, 96],
    sizes: '48px',
  },
  content: {
    widths: [400, 800, 1200],
    sizes: '(max-width: 768px) 100vw, 768px',
  },
};

/** Fallback when `10-optimize-images` cannot infer a folder-based preset. */
export const DEFAULT_OPTIMIZE_PRESET = 'content';

/**
 * @param {string} presetKey
 * @returns {readonly number[]}
 */
export function getPresetWidths(presetKey) {
  const preset =
    RESPONSIVE_IMAGE_PRESETS[presetKey] ??
    RESPONSIVE_IMAGE_PRESETS[DEFAULT_OPTIMIZE_PRESET];
  return preset.widths;
}
