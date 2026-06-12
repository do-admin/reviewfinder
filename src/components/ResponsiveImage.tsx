import type { ImgHTMLAttributes } from 'react';
import {
  RESPONSIVE_IMAGE_PRESETS,
  type ResponsiveImagePreset,
} from '@/lib/responsiveImagePresets';

export type { ResponsiveImagePreset };

/**
 * Build a srcSet for local raster paths (same origin, path starting with /).
 * Variants must match `scripts/10-optimize-images.mjs` output (`<base>-w<width>.webp`);
 * preset widths live in `@/lib/responsiveImagePresets`.
 */
export function buildResponsiveSrcSet(
  src: string,
  preset: ResponsiveImagePreset
): string | undefined {
  if (!src || !src.startsWith('/') || src.startsWith('//')) {
    return undefined;
  }
  // Variant files are only emitted for raster types (scripts/10-optimize-images.mjs).
  if (!/\.(webp|jpg|jpeg|png)$/i.test(src)) {
    return undefined;
  }
  const lastDot = src.lastIndexOf('.');
  if (lastDot <= 0) {
    return undefined;
  }
  const base = src.slice(0, lastDot);
  const { widths } = RESPONSIVE_IMAGE_PRESETS[preset];
  return widths.map((w) => `${base}-w${w}.webp ${w}w`).join(', ');
}

export type ResponsiveImageProps = {
  src: string;
  alt: string;
  preset: ResponsiveImagePreset;
  /** If true, do not set sizes (e.g. decorative / when parent controls layout). Rare. */
  omitSizes?: boolean;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'>;

/**
 * Local images: adds srcSet + sizes pointing at build-time WebP variants.
 * External URLs or missing paths: behaves like a normal img (srcSet omitted).
 */
export function ResponsiveImage({
  src,
  alt,
  preset,
  omitSizes = false,
  srcSet: srcSetProp,
  sizes: sizesProp,
  ...rest
}: ResponsiveImageProps) {
  const generated = buildResponsiveSrcSet(src, preset);
  const srcSet = srcSetProp ?? generated;
  const sizes =
    sizesProp ??
    (omitSizes || !generated ? undefined : RESPONSIVE_IMAGE_PRESETS[preset].sizes);

  return (
    <img
      src={src}
      alt={alt}
      {...(srcSet ? { srcSet } : {})}
      {...(sizes ? { sizes } : {})}
      {...rest}
    />
  );
}
