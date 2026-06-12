/**
 * Reads tmp/ai-costs.jsonl and writes tmp/ai-costs-summary.md with per-(pid, script) totals.
 * Excludes costSource "aggregated" rows by default so run-totals lines do not double-count API lines.
 *
 * Usage:
 *   pnpm ai-cost-summary
 *   node scripts/generate-ai-cost-summary.mjs [--include-aggregated] [--jsonl path/to/file.jsonl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_JSONL = path.join(REPO_ROOT, 'tmp', 'ai-costs.jsonl');
const OUT_MD = path.join(REPO_ROOT, 'tmp', 'ai-costs-summary.md');

function parseArgs(argv) {
  let includeAggregated = false;
  let jsonlPath = DEFAULT_JSONL;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--include-aggregated') includeAggregated = true;
    else if (a === '--jsonl' && argv[i + 1]) {
      jsonlPath = path.resolve(argv[++i]);
    }
  }
  return { includeAggregated, jsonlPath };
}

/**
 * @param {number | null | undefined} n
 */
function safeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeMdCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function main() {
  const { includeAggregated, jsonlPath } = parseArgs(process.argv);

  if (!fs.existsSync(jsonlPath)) {
    console.error(`[ai-cost-summary] File not found: ${jsonlPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  /** @type {Map<string, { pid: number, script: string, entries: number, costUsd: number, promptTokens: number, completionTokens: number, tsMin: string | null, tsMax: string | null }>} */
  const groups = new Map();

  let skipped = 0;
  let parseErrors = 0;

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }

    const src = row.costSource != null ? String(row.costSource) : '';
    if (!includeAggregated && src === 'aggregated') {
      skipped += 1;
      continue;
    }

    const pid = row.pid != null ? Number(row.pid) : NaN;
    const script =
      typeof row.script === 'string' && row.script.length > 0
        ? row.script
        : '(unknown)';
    if (!Number.isFinite(pid)) continue;

    const key = `${pid}\t${script}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        pid,
        script,
        entries: 0,
        costUsd: 0,
        promptTokens: 0,
        completionTokens: 0,
        tsMin: null,
        tsMax: null,
      };
      groups.set(key, g);
    }

    g.entries += 1;
    g.costUsd += safeNum(row.costUsd);
    g.promptTokens += safeNum(row.promptTokens);
    g.completionTokens += safeNum(row.completionTokens);

    const ts = typeof row.ts === 'string' ? row.ts : null;
    if (ts) {
      if (!g.tsMin || ts < g.tsMin) g.tsMin = ts;
      if (!g.tsMax || ts > g.tsMax) g.tsMax = ts;
    }
  }

  const rows = [...groups.values()].sort((a, b) => {
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    if (a.pid !== b.pid) return a.pid - b.pid;
    return a.script.localeCompare(b.script);
  });

  let grandCost = 0;
  let grandPrompt = 0;
  let grandCompletion = 0;
  let grandEntries = 0;

  const md = [];
  md.push('# AI cost summary');
  md.push('');
  md.push(`Generated from \`${path.relative(REPO_ROOT, jsonlPath)}\`.`);
  md.push(
    includeAggregated
      ? '**Include mode:** all rows including `costSource: aggregated`.'
      : '**Exclude mode:** rows with `costSource: aggregated` are omitted (avoids double-counting vs per-call API lines).'
  );
  md.push('');
  if (parseErrors > 0) {
    md.push(`> Warning: ${parseErrors} line(s) failed JSON parse.`);
    md.push('');
  }
  if (!includeAggregated && skipped > 0) {
    md.push(`> Skipped ${skipped} aggregated row(s).`);
    md.push('');
  }

  md.push('| PID | Script | Entries | Total USD | Prompt tokens | Completion tokens | First TS | Last TS |');
  md.push('|-----|--------|---------|-----------|----------------|-------------------|----------|---------|');

  for (const r of rows) {
    grandCost += r.costUsd;
    grandPrompt += r.promptTokens;
    grandCompletion += r.completionTokens;
    grandEntries += r.entries;

    md.push(
      `| ${r.pid} | ${escapeMdCell(r.script)} | ${r.entries} | ${r.costUsd.toFixed(6)} | ${r.promptTokens.toLocaleString('en-US')} | ${r.completionTokens.toLocaleString('en-US')} | ${r.tsMin ?? '—'} | ${r.tsMax ?? '—'} |`
    );
  }

  md.push(
    `| **Total** | | **${grandEntries}** | **${grandCost.toFixed(6)}** | **${grandPrompt.toLocaleString('en-US')}** | **${grandCompletion.toLocaleString('en-US')}** | | |`
  );
  md.push('');

  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md.join('\n'), 'utf8');

  console.log(`Wrote ${OUT_MD}`);
}

main();
