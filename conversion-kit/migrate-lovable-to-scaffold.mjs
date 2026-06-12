#!/usr/bin/env node
/**
 * Mechanical migration: copy template-scaffold → destination, merge Lovable React
 * src/components + src/pages, emit [lang] Astro routes.
 *
 * Canonical copy of this script lives in `conversion-kit/` (copy the whole folder into any repo).
 *
 * Usage:
 *   node conversion-kit/migrate-lovable-to-scaffold.mjs \
 *     --src-repo /path/to/lovable-react-repo \
 *     --dest /path/to/target-astro-repo \
 *     --scaffold /path/to/template-scaffold
 *
 * Default scaffold: first existing path among:
 *   $CONVERSION_TEMPLATE_SCAFFOLD
 *   <conversion-kit>/../../template-scaffold (hero-pages layout)
 *   <conversion-kit>/../template-scaffold (kit at repo root next to scaffold)
 *
 * Options:
 *   --force          Overwrite destination if it exists (dangerous)
 *   --skip-install   Do not run pnpm install in dest
 *   --skip-pages     Only copy scaffold + components; do not generate Astro pages
 *   --generate-ralph Run generate-ralph-conversion.mjs after mechanical steps
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import {
  createPagesFromReactPages,
  mergeComponentsFromSrcRepo,
  mergePublicAndAssetsFromSrcRepo,
  LOVABLE_KITA_ROUTE_MAPPINGS,
} from './lib/react-to-astro-migrate.mjs';

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveDefaultScaffoldPath() {
  if (process.env.CONVERSION_TEMPLATE_SCAFFOLD) {
    return path.resolve(process.env.CONVERSION_TEMPLATE_SCAFFOLD);
  }
  const candidates = [
    path.resolve(KIT_DIR, '../../template-scaffold'),
    path.resolve(KIT_DIR, '../template-scaffold'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      return c;
    }
  }
  return path.resolve(KIT_DIR, '../../template-scaffold');
}

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function log(message, color = 'white') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function parseArgs(argv) {
  const out = {
    srcRepo: null,
    dest: null,
    scaffold: resolveDefaultScaffoldPath(),
    force: false,
    skipInstall: false,
    skipPages: false,
    generateRalph: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src-repo' && argv[i + 1]) {
      out.srcRepo = path.resolve(argv[++i]);
    } else if (a === '--dest' && argv[i + 1]) {
      out.dest = path.resolve(argv[++i]);
    } else if (a === '--scaffold' && argv[i + 1]) {
      out.scaffold = path.resolve(argv[++i]);
    } else if (a === '--force') {
      out.force = true;
    } else if (a === '--skip-install') {
      out.skipInstall = true;
    } else if (a === '--skip-pages') {
      out.skipPages = true;
    } else if (a === '--generate-ralph') {
      out.generateRalph = true;
    }
  }
  return out;
}

function assertDir(p, label) {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    log(`Error: ${label} is not a directory: ${p}`, 'red');
    process.exit(1);
  }
}

function copyScaffold(scaffoldAbs, destAbs, force) {
  if (fs.existsSync(destAbs)) {
    if (!force) {
      log(
        `Error: destination already exists. Use --force to overwrite: ${destAbs}`,
        'red'
      );
      process.exit(1);
    }
    fs.rmSync(destAbs, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.cpSync(scaffoldAbs, destAbs, { recursive: true });
  log(`✅ Copied scaffold → ${destAbs}`, 'green');
}

function runPnpmInstall(destAbs) {
  log('📦 Running pnpm install...', 'blue');
  try {
    execSync('pnpm install', { stdio: 'inherit', cwd: destAbs });
    log('✅ pnpm install completed', 'green');
  } catch {
    log('⚠️  pnpm install failed — run manually in destination', 'yellow');
  }
}

/**
 * Copy conversion-kit scripts into dest/conversion-kit/ so the user can run
 * generate-ralph, ralph-convert.sh, and audit-conversion from inside --dest
 * without needing access to the original template.location tree.
 */
function copyConversionKitToDest(destAbs) {
  const destKit = path.join(destAbs, 'conversion-kit');
  fs.mkdirSync(destKit, { recursive: true });

  const filesToCopy = [
    'generate-ralph-conversion.mjs',
    'ralph-convert.sh',
    'audit-conversion.mjs',
    'README.md',
  ];

  for (const file of filesToCopy) {
    const src = path.join(KIT_DIR, file);
    const dst = path.join(destKit, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Preserve executable bits
  for (const file of ['ralph-convert.sh', 'generate-ralph-conversion.mjs', 'audit-conversion.mjs']) {
    const dst = path.join(destKit, file);
    if (fs.existsSync(dst)) {
      fs.chmodSync(dst, 0o755);
    }
  }

  log('✅ Copied conversion-kit/ → dest/conversion-kit/', 'green');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.srcRepo || !args.dest) {
    log(
      'Usage: node conversion-kit/migrate-lovable-to-scaffold.mjs --src-repo <path> --dest <path> [--scaffold <path>] [--force] [--skip-install] [--skip-pages] [--generate-ralph]',
      'yellow'
    );
    log('Set CONVERSION_TEMPLATE_SCAFFOLD or pass --scaffold if the default path is wrong.', 'yellow');
    process.exit(1);
  }

  assertDir(args.srcRepo, 'src repo');
  assertDir(args.scaffold, 'scaffold');

  const pagesDir = path.join(args.srcRepo, 'src/pages');
  if (!fs.existsSync(pagesDir)) {
    log(`Error: ${pagesDir} not found`, 'red');
    process.exit(1);
  }

  log('\n🚀 Lovable → Astro scaffold (mechanical)\n', 'cyan');
  log(`  src repo:  ${args.srcRepo}`, 'white');
  log(`  dest:      ${args.dest}`, 'white');
  log(`  scaffold:  ${args.scaffold}`, 'white');
  log('', 'white');

  copyScaffold(args.scaffold, args.dest, args.force);

  mergeComponentsFromSrcRepo(args.srcRepo, args.dest, log);
  mergePublicAndAssetsFromSrcRepo(args.srcRepo, args.dest, log);

  if (!args.skipPages) {
    createPagesFromReactPages({
      astroAppDir: args.dest,
      pagesSourceDirAbs: pagesDir,
      routeMappings: LOVABLE_KITA_ROUTE_MAPPINGS,
      log,
      writeRootIndex: true,
    });
  }

  copyConversionKitToDest(args.dest);

  if (!args.skipInstall) {
    runPnpmInstall(args.dest);
  }

  if (args.generateRalph) {
    const gen = path.join(args.dest, 'conversion-kit/generate-ralph-conversion.mjs');
    if (fs.existsSync(gen)) {
      log('\n📝 Generating Ralph PRD/PROMPT in destination...', 'cyan');
      execSync(`node "${gen}" --dest "${args.dest}" --src-repo "${args.srcRepo}"`, {
        stdio: 'inherit',
      });
    }
  }

  log('\n🎉 Mechanical migration finished.', 'green');
  log(
    'Next steps (all from inside --dest):',
    'cyan'
  );
  log(
    '  cd ' + args.dest,
    'white'
  );
  log(
    '  node conversion-kit/generate-ralph-conversion.mjs --dest .   # (re)generate PRD/PROMPT',
    'white'
  );
  log(
    '  bash conversion-kit/ralph-convert.sh 25 .                    # run Ralph loop',
    'white'
  );
  log(
    '  node conversion-kit/audit-conversion.mjs --dest .            # final audit',
    'white'
  );
}

main();
