/**
 * Copy active client's favicon into public/ (same resolution as dev: client → _template).
 * Used by use-client (optional) and build:deploy (required).
 */

import fs from 'fs';
import path from 'path';
import { detectFaviconExtension, FAVICON_EXTS } from './favicon.mjs';

/**
 * @param {string} projectRoot Absolute repo root
 * @param {string} clientId Client folder name under src/data/
 * @param {{ required?: boolean }} [options] If required, throws when no favicon source exists
 */
export function copyClientFaviconToPublic(projectRoot, clientId, options = {}) {
  const { required = false } = options;
  const dataDir = path.join(projectRoot, 'src', 'data');
  const clientPath = path.join(dataDir, clientId);
  const publicDir = path.join(projectRoot, 'public');
  const templateDir = path.join(dataDir, '_template');

  /** @returns {{ path: string; storedExt: string; label: string } | null} */
  function findFaviconSource() {
    for (const ext of FAVICON_EXTS) {
      const p = path.join(clientPath, `favicon.${ext}`);
      if (fs.existsSync(p)) {
        return {
          path: p,
          storedExt: ext,
          label: `src/data/${clientId}/favicon.${ext}`,
        };
      }
    }
    for (const ext of FAVICON_EXTS) {
      const p = path.join(templateDir, `favicon.${ext}`);
      if (fs.existsSync(p)) {
        return {
          path: p,
          storedExt: ext,
          label: `src/data/_template/favicon.${ext} (no per-client favicon for "${clientId}")`,
        };
      }
    }
    return null;
  }

  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  const source = findFaviconSource();
  if (!source) {
    if (required) {
      throw new Error(
        `Missing favicon for client "${clientId}". Add src/data/${clientId}/favicon.svg|ico|png or src/data/_template/favicon.*, or run: pnpm extract-favicon`
      );
    }
    console.warn(
      `  ⚠ No favicon found for "${clientId}" — run favicon extraction after adding the client's domain.`
    );
    return;
  }

  const buf = fs.readFileSync(source.path);
  const detectedExt = detectFaviconExtension(buf);
  const targetPath = path.join(publicDir, `favicon.${detectedExt}`);

  for (const e of FAVICON_EXTS) {
    const stale = path.join(publicDir, `favicon.${e}`);
    if (stale !== targetPath && fs.existsSync(stale)) {
      try {
        fs.unlinkSync(stale);
      } catch {
        /* ignore */
      }
    }
  }

  fs.writeFileSync(targetPath, buf);
  if (source.storedExt !== detectedExt) {
    console.log(
      '  ⚠ Favicon format mismatch detected — saved with correct extension.'
    );
  }
}
