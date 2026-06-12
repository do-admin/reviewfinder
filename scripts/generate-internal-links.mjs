#!/usr/bin/env node

/**
 * Generate internal links between subpages based on keyword matching.
 *
 * Analyses ratgeber articles and static pages from websites.json to extract
 * important keywords, then finds keyword overlaps across pages and produces
 * an internalLinks.json mapping file consumed at build time.
 *
 * Features:
 *   - Extracts keywords from existing metadata first (free, no AI)
 *   - Falls back to AI (OpenRouter/Gemini Flash) only when metadata is sparse
 *   - Caches content hashes to skip unchanged pages on re-runs
 *   - Writes output to src/data/<client>/internalLinks.json (symlinked into current/)
 *
 * Usage:
 *   pnpm run generate-internal-links
 *   node scripts/generate-internal-links.mjs [clientId]
 *   node scripts/generate-internal-links.mjs --all
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import ora from 'ora';
import enquirer from 'enquirer';
import { logOpenRouterChatResponse, logAiCost } from './lib/log-ai-cost.mjs';

dotenv.config({ path: '.env.local', quiet: true });

const { Select } = enquirer;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DATA_DIR = path.join(projectRoot, 'src', 'data');
const CONTENT_DIR = path.join(projectRoot, 'src', 'content');

// ─── Config ──────────────────────────────────────────────────

/** Maximum related links per page. */
const MAX_RELATED_PER_PAGE = 5;

/** Minimum relevance score to include a link (0–1). */
const MIN_RELEVANCE_SCORE = 0.15;

// ─── OpenRouter Setup ────────────────────────────────────────

const openrouterApiKey = process.env.OPENROUTER_API_KEY;
if (!openrouterApiKey) {
  console.error('❌ OPENROUTER_API_KEY not found. Set it in .env.local');
  process.exit(1);
}

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: openrouterApiKey,
  defaultHeaders: {
    'HTTP-Referer': process.env.OPENROUTER_REFERER_URL || 'https://hero-pages.com',
    'X-Title': 'template.location Internal Links Generator',
  },
});

// ─── Cost Tracking (same aggregation as clone-website / generate-llm-txt) ─

function formatUsd(cost) {
  if (!Number.isFinite(cost)) return '$0.000000';
  return `$${cost.toFixed(6)}`;
}

async function fetchGenerationStats(generationId) {
  try {
    const response = await fetch(
      `https://openrouter.ai/api/v1/generation?id=${generationId}`,
      {
        headers: {
          Authorization: `Bearer ${openrouterApiKey}`,
          'HTTP-Referer':
            process.env.OPENROUTER_REFERER_URL || 'https://hero-pages.com',
          'X-Title': 'template.location Internal Links Generator',
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch generation stats: ${response.statusText}`
      );
    }

    return await response.json();
  } catch (error) {
    console.warn(`⚠️  Could not fetch generation stats: ${error.message}`);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function normalizeKeyword(kw) {
  return kw
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitKeywords(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,;|]/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 3);
}

function cleanText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
}

// ─── Client / Site Helpers (same as generate-grounding.mjs) ──

function getClients() {
  if (!fileExists(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((f) => {
      const p = path.join(DATA_DIR, f);
      return fs.statSync(p).isDirectory() && f !== 'current' && f !== '_template' && fileExists(path.join(p, 'websites.json'));
    })
    .sort();
}

function parseWebsitesJson(raw) {
  if (Array.isArray(raw)) return raw;
  return raw.websites ?? [];
}

function loadWebsitesJson(clientId) {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return { raw: null, websites: [] };
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return { raw, websites: parseWebsitesJson(raw) };
}

// ─── Cache ───────────────────────────────────────────────────

function loadCache(clientId) {
  const p = path.join(DATA_DIR, clientId, '.internal-links-cache.json');
  if (!fileExists(p)) return { version: 1, entries: {} };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveCache(clientId, cache) {
  const p = path.join(DATA_DIR, clientId, '.internal-links-cache.json');
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
}

// ─── Content Collection ──────────────────────────────────────

/**
 * Collect all pages from all content sources for a client.
 * Returns an array of { id, type, slug, title, path, content, existingKeywords }.
 */
function collectPages(clientId) {
  const pages = [];

  // Ratgeber articles from src/content/ratgeber/
  const ratgeberDir = path.join(CONTENT_DIR, 'ratgeber');
  if (fileExists(ratgeberDir)) {
    const mdFiles = fs.readdirSync(ratgeberDir).filter((f) => f.endsWith('.md'));
    for (const file of mdFiles) {
      const raw = fs.readFileSync(path.join(ratgeberDir, file), 'utf-8');
      const { data, content } = matter(raw);
      const keywords = [
        ...splitKeywords(data['meta-keywords']),
        ...(data['focus-keyphrase'] ? [data['focus-keyphrase']] : []),
      ];

      pages.push({
        id: `ratgeber:${data.slug || file.replace(/\.md$/, '')}`,
        type: 'ratgeber',
        slug: data.slug || file.replace(/\.md$/, ''),
        name: data.title || file.replace(/\.md$/, ''),
        title: data.title || '',
        pagePath: `ratgeber/${data.slug || file.replace(/\.md$/, '')}`,
        content: cleanText(content.substring(0, 3000)), // first 3000 chars for efficiency
        contentHash: sha256(raw),
        existingKeywords: keywords,
        nearby: [],
      });
    }
  }

  // Static pages from websites.json
  const { websites } = loadWebsitesJson(clientId);
  for (const website of websites) {
    if (!website.pages) continue;
    for (const page of website.pages) {
      // Skip legal pages (datenschutz, impressum) - not useful for interlinking
      if (['datenschutz', 'impressum'].includes(page.name)) continue;

      const textParts = [];
      for (const [key, val] of Object.entries(page)) {
        if (['name', 'metadata', 'blocks', 'sectionIds'].includes(key)) continue;
        if (val && typeof val === 'object') {
          for (const [, v] of Object.entries(val)) {
            if (typeof v === 'string' && v.length > 15 && !v.startsWith('http') && !v.startsWith('/')) {
              textParts.push(cleanText(v));
            }
          }
        }
      }

      pages.push({
        id: `static:${website.id}:${page.name}`,
        type: 'static',
        slug: page.name === 'home' ? '' : page.name,
        name: page.metadata?.title || page.name,
        title: page.metadata?.title || page.name,
        pagePath: page.name === 'home' ? '' : page.name,
        content: textParts.join(' '),
        contentHash: sha256(JSON.stringify(page)),
        existingKeywords: splitKeywords(page.metadata?.keywords),
        nearby: [],
      });
    }
  }

  return pages;
}

// ─── Keyword Extraction ──────────────────────────────────────

/**
 * Extract keywords from a page using AI analysis of the actual content.
 * Existing metadata keywords are passed as context to the AI for better results.
 */
async function extractKeywords(page, cache, aiUsageTotals) {
  // Check cache — skip if content hasn't changed
  const cached = cache.entries[page.id];
  if (cached && cached.contentHash === page.contentHash) {
    return cached.keywords;
  }

  // Always use AI to extract keywords from the actual content
  const keywords = await extractKeywordsWithAI(page, aiUsageTotals);

  // Update cache
  cache.entries[page.id] = {
    contentHash: page.contentHash,
    keywords,
    extractedAt: new Date().toISOString(),
  };

  return keywords;
}

async function extractKeywordsWithAI(page, aiUsageTotals) {
  const model = process.env.OPENROUTER_MODEL_KEYWORDS || 'google/gemini-2.5-flash';

  const systemPrompt = [
    'Du bist ein SEO-Experte fuer interne Verlinkung.',
    'Analysiere den gegebenen Seiteninhalt und extrahiere die 10-15 wichtigsten Keywords und Keyphrases.',
    'Fokussiere dich auf thematisch relevante Begriffe, die auch auf anderen Seiten derselben Website vorkommen koennten.',
    'Extrahiere sowohl spezifische Fachbegriffe als auch allgemeinere Themenbegriffe.',
    'Antworte NUR mit einem JSON-Array von Strings, z.B. ["Keyword 1", "Keyword 2"].',
  ].join(' ');

  const contentSnippet = page.content.substring(0, 3000);
  const metadataContext = page.existingKeywords.length > 0
    ? `\nVorhandene Meta-Keywords (als Kontext, nicht als einzige Quelle): ${page.existingKeywords.join(', ')}`
    : '';

  const userPrompt = [
    `Analysiere diese Seite und extrahiere 10-15 Keywords/Keyphrases:`,
    ``,
    `Seitentitel: ${page.title}`,
    `Seitentyp: ${page.type}${metadataContext}`,
    ``,
    `Seiteninhalt:`,
    contentSnippet,
  ].join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    });

    const text = completion.choices[0]?.message?.content || '';

    /** @type {Record<string, unknown>} */
    let mergedUsage =
      completion.usage && typeof completion.usage === 'object'
        ? { ...completion.usage }
        : {};

    if (completion.id) {
      const generationStats = await fetchGenerationStats(completion.id);
      if (generationStats?.usage && typeof generationStats.usage === 'object') {
        mergedUsage = { ...mergedUsage, ...generationStats.usage };
      }
    }

    const sectionLabel = page.id;

    if (Object.keys(mergedUsage).length > 0) {
      const promptTokens = Number(mergedUsage.prompt_tokens ?? 0);
      const completionTokens = Number(mergedUsage.completion_tokens ?? 0);
      const totalTokens = Number(
        mergedUsage.total_tokens ?? promptTokens + completionTokens
      );
      const promptCost = Number(mergedUsage.prompt_tokens_cost ?? 0);
      const completionCost = Number(mergedUsage.completion_tokens_cost ?? 0);
      const totalCostCandidate = Number(mergedUsage.cost);
      const sectionCost = Number.isFinite(totalCostCandidate)
        ? totalCostCandidate
        : promptCost + completionCost;

      aiUsageTotals.promptTokens += Number.isFinite(promptTokens) ? promptTokens : 0;
      aiUsageTotals.completionTokens += Number.isFinite(completionTokens)
        ? completionTokens
        : 0;
      aiUsageTotals.totalTokens += Number.isFinite(totalTokens) ? totalTokens : 0;
      if (Number.isFinite(sectionCost) && sectionCost > 0) {
        aiUsageTotals.totalCostUsd += sectionCost;
        aiUsageTotals.hasAnyCostData = true;
      }

      console.log(
        `  [generate-internal-links] "${sectionLabel}" — tokens: ${mergedUsage.prompt_tokens ?? '?'} + ${mergedUsage.completion_tokens ?? '?'} = ${mergedUsage.total_tokens ?? '?'}`
      );
      if (Number.isFinite(sectionCost) && sectionCost > 0) {
        console.log(
          `  [generate-internal-links] "${sectionLabel}" — AI cost: ${formatUsd(sectionCost)}`
        );
      }
    }

    logOpenRouterChatResponse({
      script: 'generate-internal-links',
      operation: `keywords:${page.id}`,
      model,
      usage: Object.keys(mergedUsage).length > 0 ? mergedUsage : null,
      generationId: completion.id ?? null,
      extra: { pageTitle: page.title, sectionLabel },
    });

    // Parse JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        // Deduplicate by normalized form
        const seen = new Set();
        return parsed
          .filter((k) => typeof k === 'string' && k.length >= 3)
          .filter((kw) => {
            const norm = normalizeKeyword(kw);
            if (!norm || seen.has(norm)) return false;
            seen.add(norm);
            return true;
          });
      }
    }
  } catch (err) {
    console.warn(`  ⚠ AI keyword extraction failed for ${page.id}: ${err.message}`);
  }
  return [];
}

// ─── Keyword Matching ────────────────────────────────────────

/** Minimum word length to index individually (skip "und", "der", etc.) */
const MIN_WORD_LENGTH = 4;

/** German stop words to exclude from word-level matching. */
const STOP_WORDS = new Set([
  'aber', 'alle', 'also', 'andere', 'auch', 'auf', 'aus', 'bei', 'beim',
  'bereits', 'best', 'besten', 'bestes', 'damit', 'dann', 'darf', 'das',
  'dass', 'dein', 'deine', 'deinem', 'deinen', 'deiner', 'denn', 'dich',
  'dies', 'diese', 'diesem', 'diesen', 'dieser', 'dieses', 'doch', 'dort',
  'durch', 'duerfen', 'eine', 'einem', 'einen', 'einer', 'einige', 'erst',
  'etwa', 'etwas', 'euch', 'euer', 'eure', 'fuer', 'ganz', 'gibt', 'haben',
  'halt', 'hier', 'ihre', 'ihrem', 'ihren', 'ihrer', 'immer', 'jede',
  'jedem', 'jeden', 'jeder', 'jedes', 'jene', 'jetzt', 'kann', 'kein',
  'keine', 'keinem', 'keinen', 'keiner', 'koennen', 'machen', 'mehr',
  'mein', 'meine', 'meinem', 'meinen', 'meiner', 'mich', 'noch', 'nicht',
  'nichts', 'noch', 'nach', 'natuerlich', 'neue', 'neuen', 'neuer', 'neues',
  'nicht', 'noch', 'oder', 'ohne', 'sehr', 'sein', 'seine', 'seinem',
  'seinen', 'seiner', 'sich', 'sind', 'soll', 'sollen', 'ueber', 'unser',
  'unsere', 'unserem', 'unseren', 'unserer', 'unter', 'viel', 'viele',
  'vielleicht', 'warum', 'wenn', 'werde', 'werden', 'weil', 'welch',
  'welche', 'welchem', 'welchen', 'welcher', 'wenig', 'wenige', 'werde',
  'werden', 'wieder', 'will', 'wir', 'wird', 'wohl', 'wurde', 'wuerden',
  'zwischen', 'andere', 'anderem', 'anderen', 'anderer', 'anderes',
]);

/**
 * Extract indexable tokens from a keyword: the full phrase + individual words.
 * E.g. "anonyme Bestattung Ablauf" → ["anonyme bestattung ablauf", "bestattung", "ablauf"]
 */
function tokenizeKeyword(kw) {
  const norm = normalizeKeyword(kw);
  if (!norm) return [];
  const tokens = [norm]; // full phrase
  const words = norm.split(/\s+/).filter((w) => w.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(w));
  for (const w of words) tokens.push(w);
  return tokens;
}

/**
 * Build an inverted index and compute relevance-scored links between pages.
 */
function computeInternalLinks(pages, keywordMap) {
  // Build inverted index: token → Set<pageId>
  // Indexes both full keyword phrases AND individual significant words.
  const invertedIndex = new Map();
  for (const page of pages) {
    const keywords = keywordMap.get(page.id) || [];
    for (const kw of keywords) {
      for (const token of tokenizeKeyword(kw)) {
        if (!invertedIndex.has(token)) invertedIndex.set(token, new Set());
        invertedIndex.get(token).add(page.id);
      }
    }
  }

  // For each page, find other pages sharing tokens
  const links = {};

  for (const page of pages) {
    const myTokens = (keywordMap.get(page.id) || []).flatMap(tokenizeKeyword).filter(Boolean);
    if (myTokens.length === 0) continue;

    const myNormSet = new Set(myTokens);
    const nearbySet = new Set();

    // Count shared keywords per other page
    const sharedCount = new Map();
    for (const norm of myNormSet) {
      const pageIds = invertedIndex.get(norm);
      if (!pageIds) continue;
      for (const otherId of pageIds) {
        if (otherId === page.id) continue;
        // Skip pages already linked via nearby
        if (nearbySet.has(otherId)) continue;
        sharedCount.set(otherId, (sharedCount.get(otherId) || 0) + 1);
      }
    }

    // Score and rank
    const candidates = [];
    for (const [otherId, count] of sharedCount) {
      const otherTokens = new Set((keywordMap.get(otherId) || []).flatMap(tokenizeKeyword).filter(Boolean));
      const minSize = Math.min(myNormSet.size, otherTokens.size);
      if (minSize === 0) continue;
      const score = count / minSize;
      if (score < MIN_RELEVANCE_SCORE) continue;

      const otherPage = pages.find((p) => p.id === otherId);
      if (!otherPage) continue;

      // Collect shared tokens (show the actual overlapping words/phrases)
      const matched = [...myNormSet].filter((t) => otherTokens.has(t));

      candidates.push({
        targetType: otherPage.type,
        targetSlug: otherPage.slug,
        targetTitle: otherPage.title,
        targetPath: otherPage.pagePath,
        matchedKeywords: matched.slice(0, 5),
        relevanceScore: Math.round(score * 100) / 100,
      });
    }

    // Sort by score desc, take top N
    candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const topLinks = candidates.slice(0, MAX_RELATED_PER_PAGE);
    if (topLinks.length > 0) {
      links[page.id] = topLinks;
    }
  }

  return links;
}

// ─── Interactive Prompts ─────────────────────────────────────

async function pickClientInteractive() {
  const clients = getClients();
  if (clients.length === 0) {
    console.error('No client folders with websites.json found under src/data/.');
    process.exit(1);
  }
  if (clients.length === 1) return clients[0];
  return new Select({
    name: 'clientId',
    message: 'Which client?',
    choices: clients.map((c) => ({ name: c, message: c })),
  }).run();
}

// ─── Generate for a Single Client ────────────────────────────

async function generateForClient(clientId) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Generating internal links for: ${clientId}`);
  console.log(`${'='.repeat(60)}`);

  const spinner = ora({ text: 'Collecting pages...', spinner: 'dots' }).start();

  const pages = collectPages(clientId);
  spinner.succeed(`Found ${pages.length} pages`);

  if (pages.length < 2) {
    console.log('⚠ Need at least 2 pages for internal linking. Skipping.');
    return false;
  }

  const cache = loadCache(clientId);
  const cachedCount = pages.filter((p) => {
    const c = cache.entries[p.id];
    return c && c.contentHash === p.contentHash;
  }).length;
  if (cachedCount > 0) {
    console.log(`  ${cachedCount}/${pages.length} pages unchanged (using cache)`);
  }

  const aiUsageTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    hasAnyCostData: false,
  };

  // 3. Extract keywords per page
  const extractSpinner = ora({ text: 'Extracting keywords...', spinner: 'dots' }).start();
  const keywordMap = new Map();
  let aiCalls = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    extractSpinner.text = `Extracting keywords (${i + 1}/${pages.length}): ${page.id}`;
    const keywords = await extractKeywords(page, cache, aiUsageTotals);
    keywordMap.set(page.id, keywords);

    // Check if AI was used
    const cached = cache.entries[page.id];
    if (cached && cached.contentHash === page.contentHash && cached.extractedAt === cache.entries[page.id]?.extractedAt) {
      // Was already cached, no AI call
    } else if (keywords.length > page.existingKeywords.length) {
      aiCalls++;
    }
  }
  extractSpinner.succeed(`Extracted keywords for ${pages.length} pages`);

  console.log('\n[generate-internal-links] AI usage totals:');
  console.log(
    `  Tokens: ${aiUsageTotals.promptTokens.toLocaleString()} prompt + ${aiUsageTotals.completionTokens.toLocaleString()} completion = ${aiUsageTotals.totalTokens.toLocaleString()} total`
  );
  if (aiUsageTotals.hasAnyCostData) {
    console.log(`  Total AI cost: ${formatUsd(aiUsageTotals.totalCostUsd)}`);
  } else {
    console.log(
      '  Total AI cost: n/a (cost not provided by API usage fields)'
    );
  }
  logAiCost({
    script: 'generate-internal-links',
    operation: 'run-totals',
    model: process.env.OPENROUTER_MODEL_KEYWORDS || 'google/gemini-2.5-flash',
    promptTokens: aiUsageTotals.promptTokens,
    completionTokens: aiUsageTotals.completionTokens,
    totalTokens: aiUsageTotals.totalTokens,
    costUsd: aiUsageTotals.hasAnyCostData ? aiUsageTotals.totalCostUsd : null,
    costSource: aiUsageTotals.hasAnyCostData ? 'aggregated' : 'tokens_only',
  });

  // 4. Compute matches
  const matchSpinner = ora({ text: 'Computing keyword matches...', spinner: 'dots' }).start();
  const links = computeInternalLinks(pages, keywordMap);
  const totalLinks = Object.values(links).reduce((sum, arr) => sum + arr.length, 0);
  matchSpinner.succeed(`Found ${totalLinks} internal link opportunities across ${Object.keys(links).length} pages`);

  // 5. Write output
  const output = {
    generatedAt: new Date().toISOString(),
    version: 1,
    pageCount: pages.length,
    linkCount: totalLinks,
    links,
  };

  const outPath = path.join(DATA_DIR, clientId, 'internalLinks.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`✅ Internal links saved — ${totalLinks} opportunities across ${Object.keys(links).length} pages`);

  saveCache(clientId, cache);

  return true;
}

// ─── Main ────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { clientId: null, all: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') { result.all = true; continue; }
    if (args[i] === '--client' && args[i + 1]) { result.clientId = args[++i]; continue; }
    if (!args[i].startsWith('-')) {
      if (!result.clientId) result.clientId = args[i];
    }
  }
  return result;
}

async function main() {
  const { clientId: argClient, all } = parseArgs();

  if (all) {
    const clients = getClients();
    let total = 0;
    for (const clientId of clients) {
      try {
        const ok = await generateForClient(clientId);
        if (ok) total++;
      } catch (err) {
        console.error(`❌ Failed for ${clientId}:`, err.message);
      }
    }
    console.log(`\n✅ Done! Generated internal links for ${total} clients.`);
    return;
  }

  let clientId = argClient;
  if (!clientId) clientId = await pickClientInteractive();

  const ok = await generateForClient(clientId);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
