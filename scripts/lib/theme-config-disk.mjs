import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THEME_COLORS_DOC_PATH = path.join(__dirname, 'theme-colors-doc.json');

let _cached;

/** Canonical $colorsDoc lines; kept in one file so all writers stay in sync. */
export function getThemeColorsDoc() {
  if (!_cached) {
    _cached = JSON.parse(fs.readFileSync(THEME_COLORS_DOC_PATH, 'utf-8'));
  }
  return _cached;
}

/**
 * Stable key order: $colorsDoc, colors, then remaining keys in original order.
 * Always sets $colorsDoc from the canonical file (refreshes wording on write).
 */
export function orderThemeForDisk(theme) {
  const doc = getThemeColorsDoc();
  const colors = theme?.colors ?? {};
  const out = { $colorsDoc: doc, colors };
  for (const [k, v] of Object.entries(theme)) {
    if (k === '$colorsDoc' || k === 'colors') continue;
    out[k] = v;
  }
  return out;
}

export function stringifyThemeConfig(theme) {
  return JSON.stringify(orderThemeForDisk(theme), null, 2) + '\n';
}
