export type ResponsiveImagePreset =
  | 'hero'
  | 'gallery'
  | 'info'
  | 'logo'
  | 'team'
  | 'trust'
  | 'avatar'
  | 'content';

export const RESPONSIVE_IMAGE_PRESETS: Record<
  ResponsiveImagePreset,
  { widths: readonly number[]; sizes: string }
>;

export const DEFAULT_OPTIMIZE_PRESET: ResponsiveImagePreset;

export function getPresetWidths(presetKey: string): readonly number[];
