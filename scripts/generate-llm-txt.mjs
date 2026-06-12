#!/usr/bin/env node

/**
 * Generate src/data/<client>/<site>/llm.txt from site content (OpenRouter + Gemini),
 * then copy it to public/llm.txt.
 * Paths follow this repo: src/data/<clientId>/<siteId>/…
 *
 * Usage:
 *   pnpm run generate-llm-txt
 *   node scripts/generate-llm-txt.mjs [clientId] [siteId|all|--all]
 *
 * Interactive mode (no args): enquirer prompts for client, then site
 * (including "All sites" to run sequentially).
 * CLI: third arg `all` or `--all` generates for every site in that client.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import ora from 'ora';
import enquirer from 'enquirer';
import { logOpenRouterChatResponse, logAiCost } from './lib/log-ai-cost.mjs';
import { copyLlmTxtToPublic } from './lib/copy-llm-txt-to-public.mjs';

dotenv.config({ path: '.env.local', quiet: true });

const { Select } = enquirer;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DATA_DIR = path.join(projectRoot, 'src', 'data');

/** Sentinel for interactive "generate for every site in this client" */
const ALL_SITES_CHOICE = '__ALL_SITES__';

const DEFAULT_LLM_TXT_PROMPT = `You are generating an llm.txt file for a public website.
The file should help AI systems understand what the site is about, how to summarize it accurately, and what topics users may ask about.
Use clear sections, German "Du" tone if the site content is German, and avoid inventing facts not supported by the provided data.
Keep paragraphs short; one main idea per paragraph.`;

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function getClients() {
  if (!fileExists(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => {
      const p = path.join(DATA_DIR, f);
      return (
        fs.statSync(p).isDirectory() &&
        f !== 'current' &&
        f !== '_template' &&
        fileExists(path.join(p, 'websites.json'))
      );
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
    const websites = parseWebsitesJson(raw);
    return websites.map((w) => w.id).filter((id) => !!id);
  } catch {
    return [];
  }
}

function loadWebsiteEntry(clientId, siteId) {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const websites = parseWebsitesJson(raw);
  return websites.find((w) => w.id === siteId) ?? null;
}

function siteDataRoot(clientId, siteId) {
  return path.join(DATA_DIR, clientId, siteId);
}

const openrouterApiKey = process.env.OPENROUTER_API_KEY;
if (!openrouterApiKey) {
  console.error('❌ OPENROUTER_API_KEY not found. Set it in .env.local');
  process.exit(1);
}

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: openrouterApiKey,
  defaultHeaders: {
    'HTTP-Referer':
      process.env.OPENROUTER_REFERER_URL || 'https://stadtkueken.de',
    'X-Title': 'template.location LLM Text Generator',
  },
});

function formatUsd(cost) {
  if (!Number.isFinite(cost)) return '$0.000000';
  return `$${cost.toFixed(6)}`;
}

function cleanText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/:\s*$/, '')
    .replace(/^\s*:\s*/, '')
    .trim();
}

function extractTextFromTypeScript(content) {
  const texts = new Set();

  const textFieldPatterns = [
    /(?:title|subtitle|description|content|text|label|heading|name|h1Text|subtitleHighlight|mission|headline):\s*["']([^"']{20,})["']/g,
    /(?:title|subtitle|description|content|text|label|heading|name|h1Text|subtitleHighlight|mission|headline):\s*`([^`]{20,})`/g,
  ];

  for (const pattern of textFieldPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const text = cleanText(match[1]);
      if (text.length > 20) {
        texts.add(text);
      }
    }
  }

  const arrayPatterns = [
    /(?:title|description|text|label):\s*["']([^"']{20,})["']/g,
    /(?:title|description|text|label):\s*`([^`]{20,})`/g,
  ];

  for (const pattern of arrayPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const text = cleanText(match[1]);
      if (text.length > 20) {
        texts.add(text);
      }
    }
  }

  const faqPatterns = [
    /question:\s*["']([^"']{10,})["']/gi,
    /answer:\s*["']([^"']{20,})["']/gi,
  ];

  for (const pattern of faqPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const text = cleanText(match[1]);
      if (text.length > 10) {
        texts.add(text);
      }
    }
  }

  return Array.from(texts);
}

function loadSubpageContent(pageKey, clientId, siteId) {
  const subpagePath = path.join(
    siteDataRoot(clientId, siteId),
    'subpages',
    `${pageKey}.ts`
  );

  if (!fs.existsSync(subpagePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(subpagePath, 'utf8');

    let metadata = {};
    const titleMatch = content.match(/title:\s*["']([^"']+)["']/);
    const descMatch = content.match(/description:\s*["']([^"']+)["']/);
    if (titleMatch) {
      metadata.title = cleanText(titleMatch[1]);
    }
    if (descMatch) {
      metadata.description = cleanText(descMatch[1]);
    }

    const texts = extractTextFromTypeScript(content);

    const cleanedTexts = Array.from(
      new Set(texts.map((t) => cleanText(t)).filter((t) => t.length > 20))
    );

    return {
      key: pageKey,
      metadata,
      components: cleanedTexts,
    };
  } catch (error) {
    console.warn(`Error loading subpage ${pageKey}:`, error.message);
    return null;
  }
}

function appendFaqsFromJson(data, faqs, defaultCategory) {
  if (!data) return;
  if (Array.isArray(data)) {
    if (data.length === 0) return;
    if (data[0]?.group_name && Array.isArray(data[0].faqs)) {
      for (const group of data) {
        for (const faq of group.faqs || []) {
          if (faq.question && faq.answer) {
            faqs.push({
              category: group.group_name || defaultCategory,
              question: faq.question,
              answer: faq.answer,
            });
          }
        }
      }
      return;
    }
    for (const item of data) {
      if (item.question && item.answer) {
        faqs.push({
          category: item.category || defaultCategory,
          question: item.question,
          answer: item.answer,
        });
      }
    }
    return;
  }
  if (typeof data === 'object') {
    if (data.faq_groups) {
      for (const group of data.faq_groups) {
        for (const faq of group.faqs || []) {
          if (faq.question && faq.answer) {
            faqs.push({
              category: group.group_name || defaultCategory,
              question: faq.question,
              answer: faq.answer,
            });
          }
        }
      }
      return;
    }
    if (Array.isArray(data.faqs)) {
      for (const faq of data.faqs) {
        if (faq.question && faq.answer) {
          faqs.push({
            category: faq.category || defaultCategory,
            question: faq.question,
            answer: faq.answer,
          });
        }
      }
    }
  }
}

function loadFAQContent(clientId, siteId) {
  const dir = siteDataRoot(clientId, siteId);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const faqs = [];
  const files = fs.readdirSync(dir).filter((f) => {
    if (!f.endsWith('.json')) return false;
    const lower = f.toLowerCase();
    return lower.includes('faq');
  });

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const cat = file.replace(/\.json$/i, '');
      appendFaqsFromJson(data, faqs, cat);
    } catch (error) {
      console.warn(`Error loading FAQ file ${file}:`, error.message);
    }
  }

  return faqs;
}

function loadLexikonContent(clientId, siteId) {
  const lexikonDir = path.join(
    siteDataRoot(clientId, siteId),
    'json',
    'lexikon'
  );

  if (!fs.existsSync(lexikonDir)) {
    return [];
  }

  const terms = [];
  const files = fs.readdirSync(lexikonDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    try {
      const filePath = path.join(lexikonDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      for (const [term, definition] of Object.entries(data)) {
        terms.push({
          term,
          definition:
            typeof definition === 'string'
              ? definition
              : JSON.stringify(definition),
        });
      }
    } catch (error) {
      console.warn(`Error loading Lexikon file ${file}:`, error.message);
    }
  }

  return terms;
}

function loadArticleContent(clientId, siteId) {
  const articlesDir = path.join(siteDataRoot(clientId, siteId), 'articles');

  if (!fs.existsSync(articlesDir)) {
    return [];
  }

  const articles = [];
  const files = fs.readdirSync(articlesDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    try {
      const filePath = path.join(articlesDir, file);
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const { data, content } = matter(fileContents);

      articles.push({
        title: data.title || '',
        author: data.author || '',
        datePublished: data['date-published'] || '',
        category: data.category || '',
        content: content.trim(),
      });
    } catch (error) {
      console.warn(`Error loading article ${file}:`, error.message);
    }
  }

  return articles;
}

function loadPartnersContent(clientId, siteId) {
  const p = path.join(siteDataRoot(clientId, siteId), 'partners.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.map((row) => ({
      name: row.name || '',
      description: row.description || '',
      url: row.url || '',
    }));
  } catch {
    return [];
  }
}

function loadOptionalSitePrompt(clientId, siteId) {
  const siteRoot = siteDataRoot(clientId, siteId);
  const pMd = path.join(siteRoot, 'prompt.md');
  const pTxt = path.join(siteRoot, 'prompt.txt');
  const p = fs.existsSync(pMd) ? pMd : pTxt;
  if (!fs.existsSync(p)) return '';
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

function buildSiteMetaFromEntry(entry, siteId) {
  const business = entry.business || {};
  const home = entry.pages?.find((p) => p.name === 'home') ?? entry.pages?.[0];
  const meta = home?.metadata;
  const description =
    (typeof meta?.description === 'string' && meta.description) ||
    meta?.openGraph?.description ||
    meta?.twitter?.description ||
    '';

  const addr = business.locationAddress || {};
  return {
    id: siteId,
    name: business.brandName || business.name || siteId,
    description,
    domain: entry.deployDomain || entry.clientDomain || '',
    contact: {
      email: business.email || '',
      phone: business.phone || '',
      address: {
        street: addr.street || '',
        postalCode: addr.postalCode || '',
        location: addr.city || business.location?.city || '',
        country: addr.country || '',
      },
    },
    social: business.social || entry.social || {},
    openingHours:
      business.openingHours?.display || business.openingHours?.short || '',
  };
}

function collectAllContent(clientId, siteId) {
  const entry = loadWebsiteEntry(clientId, siteId);
  if (!entry) {
    throw new Error(
      `Website "${siteId}" not found in src/data/${clientId}/websites.json`
    );
  }

  const site = buildSiteMetaFromEntry(entry, siteId);

  console.log(
    `Collecting content for client "${clientId}", site "${siteId}" (${site.name})`
  );

  const subpages = [];
  const subpagesDir = path.join(siteDataRoot(clientId, siteId), 'subpages');

  if (fs.existsSync(subpagesDir)) {
    const files = fs.readdirSync(subpagesDir);
    for (const file of files) {
      if (file.endsWith('.ts') && !file.includes('programmatic')) {
        const pageKey = file.replace('.ts', '');
        const content = loadSubpageContent(pageKey, clientId, siteId);
        if (content) {
          subpages.push(content);
        }
      }
    }
  }

  const faqs = loadFAQContent(clientId, siteId);
  const lexikonTerms = loadLexikonContent(clientId, siteId);
  const articles = loadArticleContent(clientId, siteId);
  const partners = loadPartnersContent(clientId, siteId);

  return {
    site,
    subpages,
    faqs,
    lexikonTerms,
    articles,
    partners,
  };
}

function loadPrompt() {
  const candidates = [
    path.join(projectRoot, 'docs', 'LLM_TXT_GENERATION_PROMPT.md'),
    path.join(__dirname, 'prompts', 'LLM_TXT_GENERATION_PROMPT.md'),
  ];
  for (const promptPath of candidates) {
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf8');
    }
  }
  return DEFAULT_LLM_TXT_PROMPT;
}

function formatContentForPrompt(content) {
  let formatted = `# Website Content Data\n\n`;
  formatted += `## Site Information\n\n`;
  formatted += `- Name: ${content.site.name}\n`;
  formatted += `- Domain: ${content.site.domain}\n`;
  formatted += `- Description: ${content.site.description}\n`;
  formatted += `- Contact Email: ${content.site.contact.email || 'N/A'}\n`;
  formatted += `- Contact Phone: ${content.site.contact.phone || 'N/A'}\n`;
  if (content.site.openingHours) {
    formatted += `- Opening hours: ${content.site.openingHours}\n`;
  }
  const addr = content.site.contact.address;
  if (addr && (addr.street || addr.postalCode || addr.location)) {
    formatted += `- Address: ${addr.street || ''}, ${addr.postalCode || ''} ${addr.location || ''}, ${addr.country || ''}\n`;
  }
  formatted += `\n`;

  if (content.partners?.length) {
    formatted += `## Partners / trust (${content.partners.length})\n\n`;
    for (const p of content.partners) {
      formatted += `- **${p.name}**${p.description ? `: ${p.description}` : ''}${p.url ? ` (${p.url})` : ''}\n`;
    }
    formatted += `\n`;
  }

  formatted += `## Subpages (${content.subpages.length} pages)\n\n`;
  for (const page of content.subpages) {
    formatted += `### Page: ${page.key}\n`;
    if (page.metadata?.title) {
      formatted += `Title: ${page.metadata.title}\n`;
    }
    if (page.metadata?.description) {
      formatted += `Description: ${page.metadata.description}\n`;
    }
    if (page.components && page.components.length > 0) {
      formatted += `Content:\n`;
      page.components.slice(0, 20).forEach((text, idx) => {
        formatted += `${idx + 1}. ${text}\n`;
      });
      if (page.components.length > 20) {
        formatted += `... (${page.components.length - 20} more content items)\n`;
      }
    }
    formatted += `\n`;
  }

  formatted += `## FAQ Content (${content.faqs.length} questions)\n\n`;
  const faqsByCategory = {};
  content.faqs.forEach((faq) => {
    const category = faq.category || 'Allgemein';
    if (!faqsByCategory[category]) {
      faqsByCategory[category] = [];
    }
    faqsByCategory[category].push(faq);
  });

  for (const [category, categoryFaqs] of Object.entries(faqsByCategory)) {
    formatted += `### ${category}\n\n`;
    categoryFaqs.forEach((faq) => {
      formatted += `Q: ${faq.question}\n`;
      formatted += `A: ${faq.answer}\n\n`;
    });
  }

  formatted += `## Lexikon Terms (${content.lexikonTerms.length} terms)\n\n`;
  content.lexikonTerms.forEach((term) => {
    formatted += `**${term.term}**: ${term.definition}\n\n`;
  });

  formatted += `## Articles (${content.articles.length} articles)\n\n`;
  content.articles.forEach((article) => {
    formatted += `### ${article.title}\n`;
    if (article.author) formatted += `Author: ${article.author}\n`;
    if (article.datePublished)
      formatted += `Published: ${article.datePublished}\n`;
    if (article.category) formatted += `Category: ${article.category}\n`;
    formatted += `\nContent:\n${article.content.substring(0, 2000)}${article.content.length > 2000 ? '...\n' : '\n'}\n\n`;
  });

  return formatted;
}

async function fetchGenerationStats(generationId) {
  try {
    const response = await fetch(
      `https://openrouter.ai/api/v1/generation?id=${generationId}`,
      {
        headers: {
          Authorization: `Bearer ${openrouterApiKey}`,
          'HTTP-Referer':
            process.env.OPENROUTER_REFERER_URL || 'https://stadtkueken.de',
          'X-Title': 'template.location LLM Text Generator',
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch generation stats: ${response.statusText}`
      );
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.warn(`⚠️  Could not fetch generation stats: ${error.message}`);
    return null;
  }
}

async function generateLlmTxtWithAI(content, clientId, siteId) {
  let promptTemplate = loadPrompt();
  const sitePrompt = loadOptionalSitePrompt(clientId, siteId);
  if (sitePrompt) {
    promptTemplate += `\n\n---\n\n# Additional briefing (prompt.md)\n\n${sitePrompt}`;
  }

  const formattedContent = formatContentForPrompt(content);

  const systemPrompt = `You are an expert technical writer specializing in creating comprehensive documentation files optimized for LLM context chunking. Follow the instructions in the prompt exactly.`;

  const userPrompt = `${promptTemplate}

---

# ACTUAL WEBSITE CONTENT TO PROCESS

${formattedContent}

---

Please generate the llm.txt file following all the requirements and guidelines from the prompt above. Ensure each paragraph contains exactly one idea, all entities are properly defined, and the content is well-structured and comprehensive.`;

  const model =
    process.env.OPENROUTER_MODEL_LLM_TXT || 'google/gemini-2.5-flash';

  const spinner = ora({
    text: `Generating LLM content...`,
    spinner: 'dots',
  }).start();

  const startTime = Date.now();

  try {
    const spinnerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.text = `Generating llm.txt with ${model}... (${elapsed}s)`;
    }, 1000);

    const completion = await openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      temperature: 0.3,
    });

    clearInterval(spinnerInterval);
    spinner.text = 'Processing response...';

    const generatedText = completion.choices[0]?.message?.content;

    if (!generatedText) {
      spinner.fail('No content generated by OpenRouter API');
      throw new Error('No content generated by OpenRouter API');
    }

    /** @type {Record<string, unknown>} */
    let mergedUsage =
      completion.usage && typeof completion.usage === 'object'
        ? { ...completion.usage }
        : {};

    if (completion.id) {
      spinner.text = 'Fetching cost information from OpenRouter...';
      const generationStats = await fetchGenerationStats(completion.id);
      if (generationStats?.usage && typeof generationStats.usage === 'object') {
        mergedUsage = { ...mergedUsage, ...generationStats.usage };
      }
    }

    const totals = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      hasAnyCostData: false,
    };

    const sectionLabel = `${clientId}/${siteId}`;

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

      totals.promptTokens += Number.isFinite(promptTokens) ? promptTokens : 0;
      totals.completionTokens += Number.isFinite(completionTokens)
        ? completionTokens
        : 0;
      totals.totalTokens += Number.isFinite(totalTokens) ? totalTokens : 0;
      if (Number.isFinite(sectionCost) && sectionCost > 0) {
        totals.totalCostUsd += sectionCost;
        totals.hasAnyCostData = true;
      }

      console.log(
        `  [generate-llm-txt] "${sectionLabel}" — tokens: ${mergedUsage.prompt_tokens ?? '?'} + ${mergedUsage.completion_tokens ?? '?'} = ${mergedUsage.total_tokens ?? '?'}`
      );
      if (Number.isFinite(sectionCost) && sectionCost > 0) {
        console.log(
          `  [generate-llm-txt] "${sectionLabel}" — AI cost: ${formatUsd(sectionCost)}`
        );
      }
    }

    logOpenRouterChatResponse({
      script: 'generate-llm-txt',
      operation: 'generate-llm-txt',
      model,
      usage: Object.keys(mergedUsage).length > 0 ? mergedUsage : null,
      generationId: completion.id ?? null,
      extra: { sectionLabel, clientId, siteId },
    });

    const contentSize = (generatedText.length / 1024).toFixed(2);

    spinner.succeed(`Generated ${contentSize} KB of content`);

    console.log('\n[generate-llm-txt] AI usage totals:');
    console.log(
      `  Tokens: ${totals.promptTokens.toLocaleString()} prompt + ${totals.completionTokens.toLocaleString()} completion = ${totals.totalTokens.toLocaleString()} total`
    );
    if (totals.hasAnyCostData) {
      console.log(`  Total AI cost: ${formatUsd(totals.totalCostUsd)}`);
    } else {
      console.log(
        '  Total AI cost: n/a (cost not provided by API usage fields)'
      );
    }
    logAiCost({
      script: 'generate-llm-txt',
      operation: 'run-totals',
      model,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      costUsd: totals.hasAnyCostData ? totals.totalCostUsd : null,
      costSource: totals.hasAnyCostData ? 'aggregated' : 'tokens_only',
    });

    return generatedText;
  } catch (error) {
    spinner.fail(`Generation failed: ${error.message}`);
    if (error.response) {
      console.error('API error details:', error.response);
    }
    throw error;
  }
}

async function generateLlmTxtForSite(clientId, siteId) {
  try {
    const content = collectAllContent(clientId, siteId);
    console.log(
      `  Content collected: ${content.subpages.length} subpages, ${content.faqs.length} FAQs, ${content.articles.length} articles`
    );

    const llmTxtContent = await generateLlmTxtWithAI(content, clientId, siteId);

    const siteRoot = siteDataRoot(clientId, siteId);
    if (!fs.existsSync(siteRoot)) {
      fs.mkdirSync(siteRoot, { recursive: true });
    }

    const outputPath = path.join(siteRoot, 'llm.txt');
    fs.writeFileSync(outputPath, llmTxtContent, 'utf8');
    console.log(
      `✅ llm.txt → src/data/${clientId}/${siteId}/llm.txt (${(llmTxtContent.length / 1024).toFixed(1)} KB)`
    );
    copyLlmTxtToPublic(projectRoot, clientId, siteId);
    return true;
  } catch (error) {
    console.error(
      `❌ Error generating llm.txt for ${clientId}/${siteId}:`,
      error
    );
    return false;
  }
}

async function pickClientInteractive() {
  const clients = getClients();
  if (clients.length === 0) {
    console.error(
      'No client folders with websites.json found under src/data/.'
    );
    process.exit(1);
  }
  if (clients.length === 1) {
    return clients[0];
  }
  return new Select({
    name: 'clientId',
    message: 'Which client?',
    choices: clients.map((c) => ({ name: c, message: c, hint: '' })),
  }).run();
}

async function pickSiteInteractive(clientId) {
  const sites = getSiteIds(clientId);
  if (sites.length === 0) {
    console.error(`No sites in src/data/${clientId}/websites.json.`);
    process.exit(1);
  }
  if (sites.length === 1) {
    return sites[0];
  }
  return new Select({
    name: 'siteId',
    message: 'Which site?',
    choices: [
      {
        name: ALL_SITES_CHOICE,
        message: 'All sites (one after another)',
        hint: `${sites.length} sites, same order as websites.json`,
      },
      ...sites.map((s) => ({ name: s, message: s, hint: '' })),
    ],
  }).run();
}

function isAllSitesToken(siteId) {
  return (
    siteId === ALL_SITES_CHOICE ||
    siteId === 'all' ||
    siteId === '--all'
  );
}

async function generateLlmTxtForAllSitesInClient(clientId) {
  const sites = getSiteIds(clientId);
  if (sites.length === 0) {
    console.error(`No sites in src/data/${clientId}/websites.json.`);
    process.exit(1);
  }
  let failed = 0;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    console.log(`\n--- [${i + 1}/${sites.length}] ${clientId}/${s} ---\n`);
    const ok = await generateLlmTxtForSite(clientId, s);
    if (!ok) failed += 1;
  }
  if (failed > 0) {
    console.error(
      `\n❌ Finished with ${failed} failure(s) out of ${sites.length} site(s).`
    );
    process.exit(1);
  }
  console.log(`\n✅ Generated llm.txt for all ${sites.length} site(s).`);
}

async function main() {
  try {
    const argvClient = process.argv[2];
    const argvSite = process.argv[3];

    let clientId = argvClient;
    let siteId = argvSite;

    if (!clientId) {
      clientId = await pickClientInteractive();
    }
    if (!siteId) {
      siteId = await pickSiteInteractive(clientId);
    }

    if (isAllSitesToken(siteId)) {
      await generateLlmTxtForAllSitesInClient(clientId);
    } else {
      const ok = await generateLlmTxtForSite(clientId, siteId);
      if (!ok) process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error generating llm.txt:', error);
    process.exit(1);
  }
}

main();
