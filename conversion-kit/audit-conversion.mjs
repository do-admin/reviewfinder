#!/usr/bin/env node
/**
 * Final completeness audit: one Claude session with a large model (default opus-4.6).
 * Reads CHECKS.md + prd.md + repo tree context via prompt.
 *
 * Usage:
 *   node conversion-kit/audit-conversion.mjs --dest /path/to/astro-repo
 * Env:
 *   CLAUDE_AUDIT_MODEL  default: opus-4.6 (pass to claude CLI if supported)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
function parseArgs(argv) {
  const out = { dest: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dest' && argv[i + 1]) out.dest = path.resolve(argv[++i]);
  }
  return out;
}

function buildAuditPrompt(dest) {
  const prd = fs.existsSync(path.join(dest, 'prd.md'))
    ? fs.readFileSync(path.join(dest, 'prd.md'), 'utf-8')
    : '';
  const checks = fs.existsSync(path.join(dest, 'CHECKS.md'))
    ? fs.readFileSync(path.join(dest, 'CHECKS.md'), 'utf-8')
    : '';

  return `You are a senior reviewer performing a FINAL completeness audit of an Astro migration.

Repository root: ${dest}

## Inputs

### CHECKS.md
${checks}

### prd.md (task list)
${prd.slice(0, 12000)}${prd.length > 12000 ? '\n... (truncated)' : ''}

## Your job
1. Verify every prd task is marked passes: true. List any still false.
2. Search the codebase mentally for: raw <h1>-<h6> outside Heading.tsx, hardcoded user strings in components that should be in websites.json, missing alt text patterns, broken imports.
3. Confirm impressum + datenschutz exist in websites.json pages[] and legal blocks format.
4. Recommend exact follow-up tasks if anything fails.

## Output format
- Start with AUDIT_RESULT: PASS or AUDIT_RESULT: FAIL
- Bullet findings
- If FAIL, numbered list of required fixes

Do not modify files; report only.
`;
}

function main() {
  const { dest } = parseArgs(process.argv.slice(2));
  if (!dest || !fs.existsSync(dest)) {
    console.error('Usage: node conversion-kit/audit-conversion.mjs --dest <astro-repo>');
    process.exit(1);
  }

  const model = process.env.CLAUDE_AUDIT_MODEL || 'opus-4.6';
  const prompt = buildAuditPrompt(dest);
  const promptFile = path.join(dest, '.claude-audit-prompt.md');
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  console.log(`Audit prompt written: ${promptFile}`);
  console.log(`Model hint: ${model} (set CLAUDE_AUDIT_MODEL to override)`);

  try {
    execSync(`claude -p "$(cat "${promptFile}")" --dangerously-skip-permissions --print`, {
      stdio: 'inherit',
      cwd: dest,
      shell: '/bin/bash',
      env: { ...process.env, CLAUDE_MODEL: model },
    });
  } catch (e) {
    console.error('Audit command failed. Run manually:');
    console.error(`  cd "${dest}" && claude -p "$(cat .claude-audit-prompt.md)" --print`);
    process.exit(1);
  }
}

main();
