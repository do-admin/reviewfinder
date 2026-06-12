#!/usr/bin/env node

/**
 * Generate grounding.md (Ontology V2 format) for a client.
 *
 * Writes ONE file at src/data/<clientId>/grounding.md, aggregating content from
 * all websites in that client's websites.json. Every site reuses this file at
 * runtime (via src/data/current/ after use-client).
 *
 * Follows the groundingpage.com standard to create structured entity
 * definitions for AI systems.
 *
 * Usage:
 *   pnpm run generate-grounding
 *   node scripts/generate-grounding.mjs [clientId]
 *   node scripts/generate-grounding.mjs --client <clientId>
 *   node scripts/generate-grounding.mjs --all
 *
 * Legacy: a second positional arg or --site <id> is accepted but ignored (no
 * per-site output).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import ora from 'ora';
import enquirer from 'enquirer';
import { logOpenRouterChatResponse } from './lib/log-ai-cost.mjs';

dotenv.config({ path: '.env.local', quiet: true });

const { Select } = enquirer;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DATA_DIR = path.join(projectRoot, 'src', 'data');

// ─── OpenRouter Setup ─────────────────────────────────────────

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
    'X-Title': 'template.location Grounding Page Generator',
  },
});

// ─── Helpers ──────────────────────────────────────────────────

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

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

function getSiteIds(clientId) {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return parseWebsitesJson(raw).map((w) => w.id).filter(Boolean);
  } catch { return []; }
}

function loadWebsiteEntry(clientId, siteId) {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return parseWebsitesJson(raw).find((w) => w.id === siteId) ?? null;
}

function siteDataRoot(clientId, siteId) {
  return path.join(DATA_DIR, clientId, siteId);
}

function cleanText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, ' ').replace(/:\s*$/, '').replace(/^\s*:\s*/, '').trim();
}

/** DD.MM.YYYY in Europe/Berlin — grounding page “freshness” fields must match generation day. */
function getGroundingDateGerman() {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date());
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const year = parts.find((p) => p.type === 'year')?.value ?? '2026';
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
}

/**
 * Forces “Zuletzt aktualisiert” and METADATA publication rows to the given date.
 * Runs after removeUmlauts so list keys match the expected ASCII form.
 * Normalizes CRLF and accepts `-`, `*`, or `+` list markers so model output still matches.
 */
function enforceGroundingPublicationDates(text, dateStr) {
  if (!dateStr || !text) return text;
  let out = text.replace(/\r\n/g, '\n');
  out = out.replace(/^## Zuletzt aktualisiert:\s*.+$/m, `## Zuletzt aktualisiert: ${dateStr}`);
  const metaFreshnessLine = (label) =>
    new RegExp(`^(\\s*[-*+]\\s*)${label}:\\s*.+$`, 'gm');
  out = out.replace(metaFreshnessLine('Veroeffentlicht'), `$1Veroeffentlicht: ${dateStr}`);
  out = out.replace(metaFreshnessLine('Aktualisiert'), `$1Aktualisiert: ${dateStr}`);
  out = out.replace(metaFreshnessLine('Geprueft'), `$1Geprueft: ${dateStr}`);
  return out;
}

// ─── Content Loaders ──────────────────────────────────────────

function buildSiteMetaFromEntry(entry, siteId) {
  const business = entry.business || {};
  const home = entry.pages?.find((p) => p.name === 'home') ?? entry.pages?.[0];
  const meta = home?.metadata;
  const description = (typeof meta?.description === 'string' && meta.description) || meta?.openGraph?.description || meta?.twitter?.description || '';
  const addr = business.locationAddress || {};
  return {
    id: siteId,
    name: business.brandName || business.name || siteId,
    description,
    domain: entry.deployDomain || entry.clientDomain || '',
    contact: {
      email: business.email || '',
      phone: business.phone || '',
      address: { street: addr.street || '', postalCode: addr.postalCode || '', location: addr.city || business.location?.city || '', country: addr.country || '' },
    },
    social: business.social || entry.social || {},
    openingHours: business.openingHours?.display || business.openingHours?.short || '',
    contactPerson: business.contactPerson || null,
    ustId: business.ustId || '',
    vertreter: business.vertreter || '',
  };
}

function appendFaqsFromJson(data, faqs, defaultCategory) {
  if (!data) return;
  if (Array.isArray(data)) {
    if (data.length === 0) return;
    if (data[0]?.group_name && Array.isArray(data[0].faqs)) {
      for (const group of data) {
        for (const faq of group.faqs || []) {
          if (faq.question && faq.answer) faqs.push({ category: group.group_name || defaultCategory, question: faq.question, answer: faq.answer });
        }
      }
      return;
    }
    for (const item of data) {
      if (item.question && item.answer) faqs.push({ category: item.category || defaultCategory, question: item.question, answer: item.answer });
    }
    return;
  }
  if (typeof data === 'object') {
    if (data.faq_groups) {
      for (const group of data.faq_groups) {
        for (const faq of group.faqs || []) {
          if (faq.question && faq.answer) faqs.push({ category: group.group_name || defaultCategory, question: faq.question, answer: faq.answer });
        }
      }
      return;
    }
    if (Array.isArray(data.faqs)) {
      for (const faq of data.faqs) {
        if (faq.question && faq.answer) faqs.push({ category: faq.category || defaultCategory, question: faq.question, answer: faq.answer });
      }
    }
  }
}

function loadFAQContent(clientId, siteId) {
  const dir = siteDataRoot(clientId, siteId);
  if (!fs.existsSync(dir)) return [];
  const faqs = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f.toLowerCase().includes('faq'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      appendFaqsFromJson(data, faqs, file.replace(/\.json$/i, ''));
    } catch (error) { console.warn(`Error loading FAQ file ${file}:`, error.message); }
  }
  return faqs;
}

function loadLexikonContent(clientId, siteId) {
  const lexikonDir = path.join(siteDataRoot(clientId, siteId), 'json', 'lexikon');
  if (!fs.existsSync(lexikonDir)) return [];
  const terms = [];
  for (const file of fs.readdirSync(lexikonDir).filter((f) => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(lexikonDir, file), 'utf8'));
      for (const [term, definition] of Object.entries(data)) {
        terms.push({ term, definition: typeof definition === 'string' ? definition : JSON.stringify(definition) });
      }
    } catch (error) { console.warn(`Error loading Lexikon file ${file}:`, error.message); }
  }
  return terms;
}

function loadArticleContent(clientId, siteId) {
  const articlesDir = path.join(siteDataRoot(clientId, siteId), 'articles');
  if (!fs.existsSync(articlesDir)) return [];
  const articles = [];
  for (const file of fs.readdirSync(articlesDir).filter((f) => f.endsWith('.md'))) {
    try {
      const { data, content } = matter(fs.readFileSync(path.join(articlesDir, file), 'utf8'));
      articles.push({ title: data.title || '', author: data.author || '', datePublished: data['date-published'] || '', category: data.category || '', content: content.trim() });
    } catch (error) { console.warn(`Error loading article ${file}:`, error.message); }
  }
  return articles;
}

function loadPartnersContent(clientId, siteId) {
  const p = path.join(siteDataRoot(clientId, siteId), 'partners.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.map((row) => ({ name: row.name || '', description: row.description || '', url: row.url || '' }));
  } catch { return []; }
}

function collectPageInfo(entry) {
  const pages = [];
  if (!entry.pages) return pages;
  for (const page of entry.pages) {
    const info = { name: page.name || 'unknown' };
    if (page.metadata?.title) info.title = page.metadata.title;
    if (page.metadata?.description) info.description = page.metadata.description;
    // Extract relevant text from page sections
    const texts = [];
    for (const [key, val] of Object.entries(page)) {
      if (['name', 'metadata', 'blocks'].includes(key)) continue;
      if (val && typeof val === 'object') {
        for (const [k, v] of Object.entries(val)) {
          if (typeof v === 'string' && v.length > 15 && !v.startsWith('http') && !v.startsWith('/')) {
            texts.push(cleanText(v));
          }
        }
      }
    }
    if (texts.length > 0) info.content = texts.slice(0, 10);
    pages.push(info);
  }
  return pages;
}

// ─── Content Collection ───────────────────────────────────────

function collectSiteContent(clientId, siteId, { quiet } = {}) {
  const entry = loadWebsiteEntry(clientId, siteId);
  if (!entry) throw new Error(`Website "${siteId}" not found in src/data/${clientId}/websites.json`);

  const site = buildSiteMetaFromEntry(entry, siteId);
  if (!quiet) console.log(`Collecting content for client "${clientId}", site "${siteId}" (${site.name})`);

  const faqs = loadFAQContent(clientId, siteId);
  const lexikonTerms = loadLexikonContent(clientId, siteId);
  const articles = loadArticleContent(clientId, siteId);
  const partners = loadPartnersContent(clientId, siteId);
  const pages = collectPageInfo(entry);

  return { siteId, site, faqs, lexikonTerms, articles, partners, pages };
}

/** Aggregate every site under the client for one shared grounding.md. */
function collectAllSitesContent(clientId) {
  const siteIds = getSiteIds(clientId);
  if (siteIds.length === 0) {
    throw new Error(`No websites in src/data/${clientId}/websites.json`);
  }
  const sites = [];
  for (const siteId of siteIds) {
    try {
      sites.push(collectSiteContent(clientId, siteId, { quiet: true }));
    } catch (err) {
      console.warn(`⚠️  Skipping site "${siteId}": ${err.message}`);
    }
  }
  if (sites.length === 0) {
    throw new Error(`No loadable websites for client "${clientId}"`);
  }
  console.log(
    `Collecting content for client "${clientId}" — ${sites.length} website(s): ${sites.map((s) => s.siteId).join(', ')}`,
  );
  return { clientId, sites };
}

// ─── Format for Prompt ────────────────────────────────────────

/** One website slice: { siteId, site, faqs, lexikonTerms, articles, partners, pages } */
function formatOneSiteContentForPrompt(sitePayload, { includeTitle = true } = {}) {
  const content = sitePayload;
  let out = '';
  if (includeTitle) {
    out += `# Website: ${content.site.name}\n`;
  }
  out += `Domain: https://${content.site.domain}\n`;
  out += `Beschreibung: ${content.site.description}\n\n`;

  out += `## Geschäftsinformationen\n\n`;
  out += `- Name: ${content.site.name}\n`;
  out += `- E-Mail: ${content.site.contact.email || 'N/A'}\n`;
  out += `- Telefon: ${content.site.contact.phone || 'N/A'}\n`;
  const addr = content.site.contact.address;
  if (addr && (addr.street || addr.postalCode || addr.location)) {
    out += `- Adresse: ${addr.street || ''}, ${addr.postalCode || ''} ${addr.location || ''}, ${addr.country || ''}\n`;
  }
  if (content.site.openingHours) out += `- Öffnungszeiten: ${content.site.openingHours}\n`;
  if (content.site.contactPerson?.name) out += `- Ansprechpartner: ${content.site.contactPerson.name}${content.site.contactPerson.title ? ` (${content.site.contactPerson.title})` : ''}\n`;
  if (content.site.ustId) out += `- USt-IdNr.: ${content.site.ustId}\n`;
  if (content.site.vertreter) out += `- Vertreter: ${content.site.vertreter}\n`;
  out += '\n';

  if (content.partners?.length) {
    out += `## Partner / Vertrauenselemente (${content.partners.length})\n\n`;
    for (const p of content.partners) {
      out += `- **${p.name}**${p.description ? `: ${p.description}` : ''}${p.url ? ` (${p.url})` : ''}\n`;
    }
    out += '\n';
  }

  if (content.pages?.length) {
    out += `## Seitenstruktur (${content.pages.length} Seiten)\n\n`;
    for (const p of content.pages) {
      out += `### Seite: ${p.name}\n`;
      if (p.title) out += `Titel: ${p.title}\n`;
      if (p.description) out += `Beschreibung: ${p.description}\n`;
      if (p.content?.length) {
        out += `Inhalte:\n`;
        p.content.forEach((text, idx) => { out += `${idx + 1}. ${text}\n`; });
      }
      out += '\n';
    }
  }

  if (content.faqs?.length) {
    out += `## FAQ (${content.faqs.length} Fragen)\n\n`;
    const byCategory = {};
    content.faqs.forEach((faq) => {
      const cat = faq.category || 'Allgemein';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(faq);
    });
    for (const [category, faqs] of Object.entries(byCategory)) {
      out += `### ${category}\n\n`;
      faqs.forEach((faq) => { out += `F: ${faq.question}\nA: ${faq.answer}\n\n`; });
    }
  }

  if (content.lexikonTerms?.length) {
    out += `## Lexikon (${content.lexikonTerms.length} Begriffe)\n\n`;
    content.lexikonTerms.forEach((term) => { out += `**${term.term}**: ${term.definition}\n\n`; });
  }

  if (content.articles?.length) {
    out += `## Ratgeber-Artikel (${content.articles.length})\n\n`;
    for (const art of content.articles) {
      out += `### ${art.title}\n`;
      if (art.author) out += `Autor: ${art.author}\n`;
      if (art.datePublished) out += `Veröffentlicht: ${art.datePublished}\n`;
      if (art.category) out += `Kategorie: ${art.category}\n`;
      out += `\n${art.content.substring(0, 2000)}${art.content.length > 2000 ? '...\n' : '\n'}\n`;
    }
  }

  return out;
}

/** Client bundle: { clientId, sites: [...] } — one shared grounding.md for all sites. */
function formatBundleForPrompt(bundle) {
  const { clientId, sites } = bundle;
  if (sites.length === 1) {
    return formatOneSiteContentForPrompt(sites[0], { includeTitle: true });
  }
  let out = `# Mandant: ${clientId} — ${sites.length} Websites\n\n`;
  out += 'Die folgenden Abschnitte listen alle Websites dieses Mandanten. Erstelle EINE kohärente Grounding Page, die die Organisation insgesamt abbildet und jede Website bzw. jeden Standort klar zuordnet.\n\n';
  for (const s of sites) {
    out += '---\n\n';
    out += `## Website: ${s.site.name} (ID: \`${s.siteId}\`)\n\n`;
    out += formatOneSiteContentForPrompt(s, { includeTitle: false });
  }
  return out;
}

// ─── Umlaut Removal ──────────────────────────────────────────

function removeUmlauts(text) {
  return text
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
}

// ─── Cost Tracking ────────────────────────────────────────────

const MODEL_PRICING = {
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10 },
  'google/gemini-3-pro-preview': { input: 2, output: 12 },
  'google/gemini-3-flash-preview': { input: 0.5, output: 3 },
  'google/gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'google/gemini-1.5-flash': { input: 0.075, output: 0.3 },
};

function estimateTokens(text) { return Math.ceil((text || '').length / 4); }
function getModelPricing(model) { return MODEL_PRICING[model] || MODEL_PRICING['google/gemini-2.5-flash']; }
function calculateCost(tokens, pricePerM) { return (tokens / 1_000_000) * pricePerM; }
function formatCost(cost) { return cost < 0.01 ? `$${(cost * 1000).toFixed(2)} (${(cost * 100).toFixed(4)} cent)` : `$${cost.toFixed(4)}`; }

async function fetchGenerationStats(generationId) {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
      headers: { Authorization: `Bearer ${openrouterApiKey}`, 'HTTP-Referer': process.env.OPENROUTER_REFERER_URL || 'https://hero-pages.com', 'X-Title': 'Grounding Page Generator' },
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ─── AI Generation ────────────────────────────────────────────

function loadPrompt() {
  const promptPath = path.join(__dirname, 'prompts', 'GROUNDING_GENERATION_PROMPT.md');
  if (!fs.existsSync(promptPath)) {
    console.error('❌ Prompt file not found:', promptPath);
    process.exit(1);
  }
  return fs.readFileSync(promptPath, 'utf8');
}

async function generateGroundingPage(bundle) {
  const promptTemplate = loadPrompt();
  const formattedContent = formatBundleForPrompt(bundle);
  const primary = bundle.sites[0]?.site;
  const groundingDateStr = getGroundingDateGerman();
  const scopeHint =
    bundle.sites.length > 1
      ? `diesen Mandanten (${bundle.clientId}) und alle in den Quellen genannten Websites`
      : `die Website ${primary?.domain || ''}`;

  const systemPrompt = 'Du bist ein erfahrener Redakteur und erstellst Grounding Pages nach dem groundingpage.com Ontology V2 Standard. Folge den Anweisungen im Prompt exakt. Gib NUR den Markdown-Text der Grounding Page aus, OHNE Codeblock-Backticks drumherum.';
  const userPrompt = [
    promptTemplate,
    '',
    '---',
    '',
    '# GENERIERUNGSDATUM (verbindlich)',
    '',
    `Heutiges Datum für diese Grounding Page: **${groundingDateStr}**`,
    '',
    'Nutze ausschließlich dieses Datum (TT.MM.JJJJ) für:',
    '- die Zeile `## Zuletzt aktualisiert:`',
    '- in jedem METADATA-Block die Einträge `Veroeffentlicht:`, `Aktualisiert:` und `Geprueft:`',
    '',
    'Verwende für diese Felder keine Datumsangaben aus Artikeln, dem Referenz-Beispiel oder frei erfundene Daten. Datumsangaben in Kernfakten-Tabellen (Gründung, Veranstaltungen usw.) weiterhin nur aus den Quellen, falls dort vorhanden.',
    '',
    '---',
    '',
    '# AKTUELLE WEBSITE-INHALTE',
    '',
    formattedContent,
    '',
    '---',
    '',
    `Erstelle daraus die Grounding Page für ${scopeHint} gemäß den Regeln und der Struktur des Referenz-Beispiels. Wähle 2 bis 6 passende Entitäten aus. Gib NUR den reinen Markdown-Text aus, OHNE Codeblock-Backticks. Schreibe alle deutschen Begriffe mit korrekten Umlauten (ä, ö, ü, ß) — niemals ASCII-Ersatz (ae, oe, ue, ss) für Substantive, Verben oder Adjektive. Eigennamen wie "Boehmler", "Voelcker", "Bahnhofstrasse" bleiben unverändert.`,
  ].join('\n');

  const model = process.env.OPENROUTER_MODEL_GROUNDING || 'google/gemini-2.5-flash';
  const inputText = systemPrompt + '\n\n' + userPrompt;
  const estInputTokens = estimateTokens(inputText);
  const estOutputTokens = Math.ceil(estInputTokens * 0.5);
  const pricing = getModelPricing(model);
  const estCost = calculateCost(estInputTokens, pricing.input) + calculateCost(estOutputTokens, pricing.output);

  const spinner = ora({ text: `Generating grounding page...`, spinner: 'dots' }).start();
  const start = Date.now();
  const interval = setInterval(() => { spinner.text = `Generating... (${Math.floor((Date.now() - start) / 1000)}s)`; }, 1000);

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });
    clearInterval(interval);

    let text = completion.choices[0]?.message?.content;
    if (!text) { spinner.fail('No content from API'); throw new Error('No content generated'); }

    // Strip markdown code block wrapper if present
    text = text.replace(/^```(?:markdown)?\s*\n?/, '').replace(/\n?```\s*$/, '');

    // Safety net: remove any umlauts the LLM may have missed
    text = removeUmlauts(text);

    text = enforceGroundingPublicationDates(text, groundingDateStr);

    const usage = completion.usage || {};
    const inTok = usage.prompt_tokens || 0;
    const outTok = usage.completion_tokens || 0;
    let totalCost = null;
    let costFromGenerationApi = false;
    if (completion.id) {
      const stats = await fetchGenerationStats(completion.id);
      if (stats?.usage?.cost != null) {
        totalCost = stats.usage.cost;
        costFromGenerationApi = true;
      }
    }
    if (totalCost == null) totalCost = calculateCost(inTok, pricing.input) + calculateCost(outTok, pricing.output);

    logOpenRouterChatResponse({
      script: 'generate-grounding',
      operation: 'grounding-page',
      model,
      usage: {
        prompt_tokens: inTok,
        completion_tokens: outTok,
        total_tokens: inTok + outTok,
        cost: totalCost,
      },
      generationId: completion.id ?? null,
      costSource: costFromGenerationApi ? 'api' : 'estimated',
      extra: {
        clientId: bundle.clientId,
        siteCount: bundle.sites.length,
        primaryDomain: primary?.domain,
      },
    });

    spinner.succeed(`Generated ${(text.length / 1024).toFixed(1)} KB (${(inTok + outTok).toLocaleString()} tokens) | Cost: ${formatCost(totalCost)}`);
    return text;
  } catch (err) {
    clearInterval(interval);
    spinner.fail(err.message);
    throw err;
  }
}

// ─── Interactive Prompts ──────────────────────────────────────

async function pickClientInteractive() {
  const clients = getClients();
  if (clients.length === 0) { console.error('No client folders with websites.json found under src/data/.'); process.exit(1); }
  if (clients.length === 1) return clients[0];
  return new Select({ name: 'clientId', message: 'Which client?', choices: clients.map((c) => ({ name: c, message: c })) }).run();
}

// ─── Generate for client (one grounding.md shared by all sites) ─

async function generateForClient(clientId) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Generating central grounding page for client: ${clientId}`);
  console.log(`${'='.repeat(60)}`);

  const bundle = collectAllSitesContent(clientId);
  const pagesTotal = bundle.sites.reduce((n, s) => n + s.pages.length, 0);
  const faqsTotal = bundle.sites.reduce((n, s) => n + s.faqs.length, 0);
  const articlesTotal = bundle.sites.reduce((n, s) => n + s.articles.length, 0);
  console.log(
    `  Content collected: ${bundle.sites.length} site(s), ${pagesTotal} page blocks, ${faqsTotal} FAQs, ${articlesTotal} articles`,
  );

  const groundingMd = await generateGroundingPage(bundle);

  const outDir = path.join(DATA_DIR, clientId);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'grounding.md');
  fs.writeFileSync(outPath, groundingMd, 'utf8');
  console.log(`✅ Grounding page saved to ${path.relative(projectRoot, outPath)} (${(groundingMd.length / 1024).toFixed(1)} KB)`);

  ensureGroundingPageEntriesForClient(clientId);

  return true;
}

/** Append { name: 'grounding' } to pages[] for every website that is missing it. */
function ensureGroundingPageEntriesForClient(clientId) {
  const wPath = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fs.existsSync(wPath)) return;
  let raw;
  let json;
  try {
    raw = fs.readFileSync(wPath, 'utf8');
    json = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `⚠️  Could not read ${path.relative(process.cwd(), wPath)} to add grounding page entries: ${err.message}`,
    );
    return;
  }
  const websites = Array.isArray(json) ? json : json.websites;
  if (!Array.isArray(websites)) return;

  const topClientDomain = Array.isArray(json) ? '' : json.clientDomain || '';
  let added = 0;

  for (const site of websites) {
    if (!site || !site.id) continue;
    if (!Array.isArray(site.pages)) site.pages = [];

    const existing = site.pages.find((p) => p && p.name === 'grounding');
    if (existing) continue;

    const bizName =
      (site.business && (site.business.brandName || site.business.name)) ||
      site.id;
    const domain =
      site.deployDomain ||
      site.clientDomain ||
      topClientDomain ||
      '';
    const baseUrl = domain
      ? `https://${domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}/de/wissensgrundlage`
      : '';

    site.pages.push({
      name: 'grounding',
      pageTitle: `Grounding | ${bizName}`,
      metadata: {
        title: `Grounding | ${bizName}`,
        description: `KI-Grounding-Seite für ${bizName} — strukturierte Entity-Definitionen und Fakten zur Website für KI-Systeme.`,
        keywords: `Grounding, KI, AI, ${bizName}, Referenzseite`,
        openGraph: {
          url: baseUrl,
          title: `Grounding | ${bizName}`,
          images: [{ url: '', width: 1200, height: 630, alt: '' }],
          description: `KI-Grounding-Seite für ${bizName}.`,
        },
        twitter: {
          title: `Grounding | ${bizName}`,
          description: `KI-Grounding-Seite für ${bizName}.`,
          images: [{ alt: '', url: '', width: 1200, height: 630 }],
        },
      },
      hero: {
        h1: 'Grounding',
        lead: `Strukturierte Fakten und Entity-Definitionen zu ${bizName}.`,
      },
      schema: [],
    });
    added++;
  }

  if (added > 0) {
    fs.writeFileSync(wPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    console.log(
      `✅ Added pages[].name='grounding' for ${added} website(s) in ${path.relative(process.cwd(), wPath)}`,
    );
  } else {
    console.log(`ℹ️  pages[].name='grounding' already present for all sites — leaving as-is`);
  }
}

// ─── Main ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { clientId: null, siteId: null, all: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') { result.all = true; continue; }
    if (args[i].startsWith('--client=')) {
      result.clientId = args[i].slice('--client='.length).trim() || null;
      continue;
    }
    if (args[i] === '--client' && args[i + 1]) { result.clientId = args[++i]; continue; }
    if (args[i].startsWith('--site=')) {
      result.siteId = args[i].slice('--site='.length).trim() || null;
      continue;
    }
    if (args[i] === '--site' && args[i + 1]) { result.siteId = args[++i]; continue; }
    if (!args[i].startsWith('-')) {
      if (!result.clientId) result.clientId = args[i];
      else if (!result.siteId) result.siteId = args[i];
    }
  }
  return result;
}

async function main() {
  const { clientId: argClient, siteId: argSite, all } = parseArgs();

  if (argSite) {
    console.log('ℹ️  Ignoring --site / second argument — one grounding.md is generated per client (all sites merged).');
  }

  if (all) {
    const clients = getClients();
    let total = 0;
    for (const clientId of clients) {
      try {
        await generateForClient(clientId);
        total++;
        if (total > 1) await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        console.error(`❌ Failed for ${clientId}:`, err.message);
      }
    }
    console.log(`\n✅ Done! Generated ${total} client grounding page(s).`);
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
