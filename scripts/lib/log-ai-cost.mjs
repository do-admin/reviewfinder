/**
 * Append AI usage / cost to:
 *   - tmp/ai-costs.jsonl  (one JSON object per line)
 *   - tmp/ai-costs.log   (human-readable blocks)
 * Repo root = parent of `scripts/`. Safe to call from any script; failures only warn on stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(REPO_ROOT, 'tmp');
const LOG_FILE_JSONL = path.join(LOG_DIR, 'ai-costs.jsonl');
const LOG_FILE_HUMAN = path.join(LOG_DIR, 'ai-costs.log');

const HUMAN_RULE = '────────────────────────────────────────────────────────────';

/**
 * @param {number | null | undefined} n
 */
function formatUsdShort(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  const x = Number(n);
  if (Math.abs(x) < 0.01) return `$${x.toFixed(6)}`;
  return `$${x.toFixed(4)}`;
}

/**
 * @param {Record<string, unknown>} record
 */
function formatHumanBlock(record) {
  const lines = [HUMAN_RULE];
  const ts = typeof record.ts === 'string' ? record.ts : String(record.ts ?? '');
  const pid = record.pid != null ? String(record.pid) : '?';
  lines.push(`${ts}  pid=${pid}`);

  const put = (label, key) => {
    const v = record[key];
    if (v === undefined || v === null || v === '') return;
    lines.push(`  ${label.padEnd(12)}${String(v)}`);
  };

  put('script:', 'script');
  put('operation:', 'operation');
  put('model:', 'model');
  const pt = record.promptTokens;
  const ct = record.completionTokens;
  const tt = record.totalTokens;
  if (pt != null || ct != null || tt != null) {
    const p = pt != null ? Number(pt) : 0;
    const c = ct != null ? Number(ct) : 0;
    const t = tt != null ? Number(tt) : p + c;
    const fmtN = (n) => n.toLocaleString('en-US');
    lines.push(
      `  tokens:      prompt=${fmtN(p)}  completion=${fmtN(c)}  total=${fmtN(t)}`
    );
  }
  const cost = record.costUsd;
  const src = record.costSource != null ? String(record.costSource) : '';
  const pc = record.promptCostUsd;
  const cc = record.completionCostUsd;
  let costLine = `  cost USD:    total=${formatUsdShort(typeof cost === 'number' ? cost : null)}`;
  if (src) costLine += `  (${src})`;
  lines.push(costLine);
  if (
    (typeof pc === 'number' && Number.isFinite(pc)) ||
    (typeof cc === 'number' && Number.isFinite(cc))
  ) {
    lines.push(
      `               in=${formatUsdShort(typeof pc === 'number' ? pc : null)}  out=${formatUsdShort(typeof cc === 'number' ? cc : null)}`
    );
  }
  put('generation:', 'generationId');
  if (record.extra != null && typeof record.extra === 'object') {
    let j = '';
    try {
      j = JSON.stringify(record.extra);
    } catch {
      j = '[extra: not serializable]';
    }
    if (j.length > 280) j = `${j.slice(0, 277)}…`;
    lines.push(`  extra:         ${j}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * @param {Record<string, unknown>} entry
 */
export function logAiCost(entry) {
  try {
    ensureLogDir();
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    };
    fs.appendFileSync(LOG_FILE_JSONL, `${JSON.stringify(record)}\n`, 'utf8');
    fs.appendFileSync(LOG_FILE_HUMAN, formatHumanBlock(record), 'utf8');
  } catch (err) {
    console.warn(
      `[log-ai-cost] ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * @param {Record<string, unknown> | null | undefined} usage
 * @returns {{
 *   promptTokens: number,
 *   completionTokens: number,
 *   totalTokens: number,
 *   costUsd: number | null,
 *   promptCostUsd: number | null,
 *   completionCostUsd: number | null,
 * }}
 */
export function normalizeOpenRouterUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: null,
      promptCostUsd: null,
      completionCostUsd: null,
    };
  }
  const pt = Number(usage.prompt_tokens ?? 0) || 0;
  const ct = Number(usage.completion_tokens ?? 0) || 0;
  const tt = Number(usage.total_tokens ?? pt + ct) || 0;
  const rawCost = usage.cost;
  const rawPc = usage.prompt_tokens_cost;
  const rawCc = usage.completion_tokens_cost;
  let costUsd =
    rawCost != null && Number.isFinite(Number(rawCost))
      ? Number(rawCost)
      : null;
  const promptCostUsd =
    rawPc != null && Number.isFinite(Number(rawPc)) ? Number(rawPc) : null;
  const completionCostUsd =
    rawCc != null && Number.isFinite(Number(rawCc)) ? Number(rawCc) : null;
  if (
    (costUsd == null || !Number.isFinite(costUsd)) &&
    (promptCostUsd != null || completionCostUsd != null)
  ) {
    costUsd = (promptCostUsd ?? 0) + (completionCostUsd ?? 0);
  }
  return {
    promptTokens: pt,
    completionTokens: ct,
    totalTokens: tt,
    costUsd,
    promptCostUsd,
    completionCostUsd,
  };
}

/**
 * Log one OpenRouter chat completion (raw `usage` from API JSON or SDK completion.usage).
 * @param {{
 *   script: string,
 *   operation?: string | null,
 *   model?: string | null,
 *   usage?: Record<string, unknown> | null,
 *   generationId?: string | null,
 *   costSource?: string | null,
 *   extra?: Record<string, unknown> | null,
 * }} parts
 */
export function logOpenRouterChatResponse(parts) {
  const {
    script,
    operation,
    model,
    usage,
    generationId,
    costSource,
    extra,
  } = parts;
  const n = normalizeOpenRouterUsage(usage);
  const inferredSource =
    costSource ??
    (n.costUsd != null && n.costUsd > 0
      ? 'api'
      : n.promptTokens + n.completionTokens > 0
        ? 'tokens_only'
        : 'unknown');
  /** @type {Record<string, unknown>} */
  const row = {
    script,
    operation: operation ?? null,
    model: model ?? null,
    promptTokens: n.promptTokens,
    completionTokens: n.completionTokens,
    totalTokens: n.totalTokens,
    costUsd: n.costUsd,
    promptCostUsd: n.promptCostUsd,
    completionCostUsd: n.completionCostUsd,
    generationId: generationId ?? null,
    costSource: inferredSource,
  };
  if (extra && typeof extra === 'object' && Object.keys(extra).length > 0) {
    row.extra = extra;
  }
  logAiCost(row);
}

/**
 * OpenAI SDK completion from OpenRouter (usage + optional id).
 * @param {{
 *   script: string,
 *   operation?: string,
 *   model?: string,
 *   completion: { id?: string; model?: string; usage?: Record<string, unknown> },
 *   extra?: Record<string, unknown>,
 * }} p
 */
export function logOpenRouterSdkCompletion(p) {
  const { script, operation, model, completion, extra } = p;
  logOpenRouterChatResponse({
    script,
    operation: operation ?? null,
    model: model ?? completion?.model ?? null,
    usage: completion?.usage ?? null,
    generationId: completion?.id ?? null,
    extra: extra ?? null,
  });
}
