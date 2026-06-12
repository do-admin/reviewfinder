#!/usr/bin/env node
/**
 * Deprecated entry point — mechanical React→Astro migration is unified in
 * conversion-kit/migrate-lovable-to-scaffold.mjs (template-scaffold copy + merge).
 *
 * The old in-place `astro-app/` workflow was removed to avoid maintaining two pipelines.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrate = path.join(__dirname, '../conversion-kit/migrate-lovable-to-scaffold.mjs');

console.error(`
reactToAstro.mjs is retired.

Use the scaffold-based migration (one supported path):

  pnpm migrate:lovable-to-scaffold -- \\
    --src-repo /path/to/lovable-react-repo \\
    --dest /path/to/new-astro-repo \\
    [--scaffold /path/to/template-scaffold] \\
    [--generate-ralph]

Or:

  node "${migrate}" -- --src-repo … --dest … --generate-ralph

Docs: docs/MIGRATE-LOVABLE-RALPH.md  ·  conversion-kit/README.md
`);
process.exit(1);
