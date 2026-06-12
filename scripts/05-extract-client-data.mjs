#!/usr/bin/env node

/**
 * Extract Impressum and social-link data from a client website using Firecrawl,
 * then write the results into the matching website entry in
 * src/data/<client>/websites.json.
 *
 * Usage:
 *   pnpm 05-extract-client-data
 *   pnpm 05-extract-client-data -- --favicon
 *   pnpm 05-extract-client-data -- --client-prompt
 *   pnpm 05-extract-client-data -- --download-fonts
 *
 * Extract-colors mode (--extract-colors): Puppeteer samples hero CTA buttons + subline; writes
 * colors.primary and colors.secondary in src/data/<client>/theme.config.json.
 *   --client= --site= --domain=  resolve URL from websites.json (unless --colors-url=)
 *   --colors-url= or --url=       scrape this URL instead of clientDomain
 *   --colors-json                 print detection JSON only (no theme write)
 * Optional: OPENROUTER_API_KEY for ambiguous secondary-color tie-break.
 *
 * Download-fonts mode (--download-fonts): Puppeteer scrapes fonts → public/fonts/ + theme.config.json.
 *   --client= --site= --domain=  resolve scrape URL from websites.json (unless --fonts-url=)
 *   --fonts-url= or --url=       scrape this URL instead of clientDomain
 *   --fonts-json                 print detected font JSON only (no theme write); pair with --fonts-url for ad-hoc URLs
 *
 * Full extraction: interactively picks client + domain, then scrapes Impressum
 * and social links (requires FIRECRAWL_API_KEY).
 *
 * Favicon mode (--favicon): picks client + website(s), resolves the live site URL
 * from home openGraph (if set), then websites.json clientDomain (top-level and
 * per-site), then deployDomain; fetches the homepage HTML and saves the best
 * matching favicon to public/favicon.ico (no Firecrawl). Override with --domain=.
 * Supports multiselect: pick one or more websites (or --site=site1,site2).
 * Duplicate origins are fetched only once; output is always public/favicon.ico.
 *
 * What it updates in websites.json:
 *   • website.business.social  → keyed object { instagram, facebook, … } with URLs
 *   • impressum page           → removes legacy `blocks` if present (body comes from legal/impressum-content.json)
 *
 * Client-prompt mode (--client-prompt): scrapes brand-relevant subpages, runs topic/headline
 * analysis (OpenRouter), then writes src/data/<client>/<siteId>/prompt.md, topics.json, and
 * client-prompt-ai-input.json (scraped corpus + exact LLM prompts for reruns) for the selected
 * site(s). The same prompt.md and topics.json are then propagated to every other website entry
 * in that client's websites.json (per-site topics.json metadata uses each site's folder id).
 * client-prompt-ai-input.json is only written for the scraped site(s), not propagated.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import readline from 'readline';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { FirecrawlClient } from '@mendable/firecrawl-js';
import { detectFaviconExtension, FAVICON_EXTS } from './lib/favicon.mjs';
import { stringifyThemeConfig } from './lib/theme-config-disk.mjs';
import { logOpenRouterSdkCompletion } from './lib/log-ai-cost.mjs';

dotenv.config({ path: '.env.local', quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Enquirer bootstrap (install if missing)
// ---------------------------------------------------------------------------

async function getEnquirer() {
  try {
    await import('enquirer');
  } catch {
    console.log('  Installing required dependency...');
    const result = spawnSync('pnpm', ['add', '-D', 'enquirer'], {
      stdio: 'inherit',
      cwd: projectRoot,
    });
    if (result.status !== 0) {
      console.error('Failed to install enquirer. Aborting.');
      process.exit(1);
    }
  }
  const { default: enquirer } = await import('enquirer');
  return enquirer;
}

// ---------------------------------------------------------------------------
// Client / website discovery
// ---------------------------------------------------------------------------

function discoverClients() {
  const dataDir = path.join(projectRoot, 'src', 'data');
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => {
      if (!e.isDirectory() && !e.isSymbolicLink()) return false;
      if (
        e.name === 'current' ||
        e.name === '_template' ||
        e.name.startsWith('.')
      )
        return false;
      // Must have a websites.json to be a valid client
      return fs.existsSync(path.join(dataDir, e.name, 'websites.json'));
    })
    .map((e) => e.name);
}

async function promptClient(enquirer, clients) {
  if (clients.length === 0) {
    console.error('❌ No client folders with websites.json found in src/data/');
    process.exit(1);
  }
  if (clients.length === 1) {
    console.log(`ℹ️  Using client: ${clients[0]}`);
    return clients[0];
  }
  const { client } = await enquirer.prompt({
    type: 'select',
    name: 'client',
    message: 'Which client?',
    choices: clients,
  });
  return client;
}

async function promptDomain(enquirer, websitesData) {
  const websites = websitesData.websites ?? [];
  if (websites.length === 0) {
    console.error('❌ No website entries found in websites.json');
    process.exit(1);
  }

  // Collect unique clientDomain values (top-level first, then per-website fallback)
  const seen = new Set();
  const domains = [];
  if (websitesData.clientDomain && !seen.has(websitesData.clientDomain)) {
    seen.add(websitesData.clientDomain);
    domains.push(websitesData.clientDomain);
  }
  for (const w of websites) {
    const d = w.clientDomain;
    if (d && !seen.has(d)) {
      seen.add(d);
      domains.push(d);
    }
  }

  if (domains.length === 0) {
    console.error('❌ No clientDomain found in websites.json');
    process.exit(1);
  }
  if (domains.length === 1) {
    console.log(`ℹ️  Using domain: ${domains[0]}`);
    return domains[0];
  }

  const { domain } = await enquirer.prompt({
    type: 'select',
    name: 'domain',
    message: 'Which client domain to scrape?',
    choices: domains,
  });
  return domain;
}

// ---------------------------------------------------------------------------
// Config & Firecrawl (lazy — only for full extraction, not --favicon)
// ---------------------------------------------------------------------------

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_CLIENT_PROMPT_MODEL =
  process.env.OPENROUTER_MODEL_CLIENT_PROMPT || 'google/gemini-3.1-pro-preview';

let firecrawlClient = null;
let openRouterClient = null;
function getFirecrawl() {
  if (!FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY is not set');
  }
  if (!firecrawlClient) {
    firecrawlClient = new FirecrawlClient({ apiKey: FIRECRAWL_API_KEY });
  }
  return firecrawlClient;
}

function getOpenRouter() {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!openRouterClient) {
    openRouterClient = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: OPENROUTER_API_KEY,
      defaultHeaders: {
        'HTTP-Referer':
          process.env.OPENROUTER_REFERER_URL || 'https://stadtkueken.de',
        'X-Title': 'template.location Client Prompt Scraper',
      },
    });
  }
  return openRouterClient;
}

function log05ExtractAi(operation, model, completion, extra = undefined) {
  logOpenRouterSdkCompletion({
    script: '05-extract-client-data',
    operation,
    model,
    completion,
    extra,
  });
}

// ===========================================================================
// IMPRESSUM
// ===========================================================================

const IMPRESSUM_SECTION_PATTERNS = [
  /^Angaben gemäß/i,
  /^Kontakt$/i,
  /^Vertreten durch/i,
  /^Registereintrag/i,
  /^Umsatzsteuer-ID$/i,
  /^Verantwortlich für den Inhalt/i,
  /^Verbraucherstreitbeilegung/i,
  /^Online-Streitbeilegung/i,
  /^Haftung für Inhalte/i,
  /^Haftung für Links/i,
  /^Urheberrecht/i,
  /^Datenschutz/i,
  /^Hintergrundinformationen/i,
  /^Konzept,?\s*Design/i,
  /^Streitschlichtung/i,
  /^EU-Streitschlichtung/i,
  /^Handelsregister/i,
];

function isImpressumSectionHeading(line) {
  return IMPRESSUM_SECTION_PATTERNS.some((re) => re.test(line));
}

function parseLinkLine(line) {
  const colonIdx = line.indexOf(': ');
  if (colonIdx === -1) return null;
  const label = line.slice(0, colonIdx).trim();
  const rest = line.slice(colonIdx + 2).trim();
  const mdLink = rest.match(/^\[(.+?)\]\((.+?)\)$/);
  if (mdLink) {
    return { prefix: label + ': ', href: mdLink[2], text: mdLink[1] };
  }
  return null;
}

/**
 * Parse raw markdown into structured Impressum sections.
 * Returns an array of section objects:
 *   { heading, lines[], linesWithLinks[], link? }
 */
function parseImpressumContent(markdown) {
  const sections = [];
  const lines = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let currentSection = null;

  const pushSection = () => {
    if (!currentSection) return;
    if (currentSection.lines && currentSection.lines.length === 0) {
      delete currentSection.lines;
    }
    const hasContent =
      currentSection.lines?.length > 0 ||
      currentSection.linesWithLinks?.length > 0 ||
      currentSection.link != null;
    if (hasContent) sections.push(currentSection);
    currentSection = null;
  };

  const startSection = (heading) => {
    pushSection();
    currentSection = { heading, lines: [] };
  };

  for (const line of lines) {
    if (/^(-{3,}|_{3,}|\*{3,}|={3,})$/.test(line)) continue;

    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      if (/^Impressum$/i.test(heading)) continue;
      startSection(heading);
      continue;
    }

    const boldMatch = line.match(/^\*\*(.+?)\*\*$/);
    if (boldMatch) {
      const heading = boldMatch[1].trim();
      if (!/^https?:\/\//.test(heading)) {
        startSection(heading);
        continue;
      }
    }

    if (isImpressumSectionHeading(line)) {
      startSection(line);
      continue;
    }

    if (!currentSection) {
      currentSection = { heading: 'Angaben gemäß § 5 TMG', lines: [] };
    }

    const standaloneLinkMatch = line.match(/^\[(.+?)\]\((.+?)\)$/);
    if (standaloneLinkMatch) {
      currentSection.link = {
        href: standaloneLinkMatch[2],
        text: standaloneLinkMatch[1],
      };
      continue;
    }

    const linkLine = parseLinkLine(line);
    if (linkLine) {
      if (!currentSection.linesWithLinks) currentSection.linesWithLinks = [];
      currentSection.linesWithLinks.push(linkLine);
      continue;
    }

    if (/\*\*\[.+?\]\(.+?\)\*\*/.test(line)) continue;

    currentSection.lines.push(line);
  }

  pushSection();
  return sections;
}

/**
 * Convert parsed impressum sections → websites.json blocks format.
 *
 * Block types used:
 *   { type: 'heading', level: 2, text }
 *   { type: 'paragraph', parts: [
 *       { type: 'text', value },
 *       { type: 'br' },
 *       { type: 'link', href, value },
 *       { type: 'strong', value },
 *   ]}
 */
function sectionsToBlocks(sections) {
  const blocks = [];
  const FIRST_SECTION_HEADING = 'Angaben gemäß § 5 TMG';

  for (const section of sections) {
    const isFirst = section.heading === FIRST_SECTION_HEADING;

    // Heading block (skip the default first-section label)
    if (!isFirst) {
      blocks.push({ type: 'heading', level: 2, text: section.heading });
    }

    // Plain lines → one paragraph, joined with <br>
    if (section.lines && section.lines.length > 0) {
      const parts = [];
      for (let i = 0; i < section.lines.length; i++) {
        parts.push({ type: 'text', value: section.lines[i] });
        if (i < section.lines.length - 1) {
          parts.push({ type: 'br' });
        }
      }
      blocks.push({ type: 'paragraph', parts });
    }

    // Lines with embedded links → one paragraph per entry
    if (section.linesWithLinks && section.linesWithLinks.length > 0) {
      for (const entry of section.linesWithLinks) {
        blocks.push({
          type: 'paragraph',
          parts: [
            { type: 'text', value: entry.prefix },
            { type: 'link', href: entry.href, value: entry.text },
          ],
        });
      }
    }

    // Standalone link → paragraph with a single link part
    if (section.link) {
      blocks.push({
        type: 'paragraph',
        parts: [
          { type: 'link', href: section.link.href, value: section.link.text },
        ],
      });
    }
  }

  return blocks;
}

/**
 * Extract the first phone number found in raw impressum markdown.
 * Handles common German formats:
 *   Tel.: +49 511 123456
 *   Telefon: 0511 / 123 456
 *   Tel: 0511-123456
 *   +49 (0)511 123456
 */
function extractPhoneFromMarkdown(markdown) {
  if (!markdown) return null;

  // Label-prefixed phone  →  "Tel.*:" or "Telefon*:" followed by the number
  const labeled = markdown.match(
    /Tele(?:fon|phone|fax)?[^:\n]*:\s*((?:\+49|0049|0)[0-9\s/()\-\.]{6,20}[0-9])/i
  );
  if (labeled) return normalizePhone(labeled[1]);

  // Bare international format  →  +49 …
  const international = markdown.match(/(\+49[\s\-/()0-9]{6,20}[0-9])/);
  if (international) return normalizePhone(international[1]);

  return null;
}

function normalizePhone(raw) {
  let digits = String(raw ?? '').replace(/[\s\-()\/\.]/g, '');
  if (digits.startsWith('00')) {
    digits = '+' + digits.slice(2);
  } else if (digits.startsWith('0') && !digits.startsWith('+')) {
    digits = '+49' + digits.slice(1);
  }
  if (!digits.startsWith('+')) {
    digits = '+49' + digits;
  }
  return digits.replace(/[^\d+]/g, '');
}

// ===========================================================================
// LOCATION ADDRESS (operating / visitor address — separate from imprint)
// ===========================================================================

/** Return first PostalAddress-shaped object found in JSON-LD blocks, or null. */
function extractPostalAddressFromJsonLd(html) {
  if (!html || typeof html !== 'string') return null;
  const scriptBlocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (!scriptBlocks) return null;

  const walk = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    const street =
      typeof node.streetAddress === 'string' ? node.streetAddress.trim() : '';
    const postal =
      typeof node.postalCode === 'string' ? node.postalCode.trim() : '';
    const city =
      typeof node.addressLocality === 'string'
        ? node.addressLocality.trim()
        : '';
    if (street && postal && city) {
      return { street, postalCode: postal, city };
    }
    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };

  for (const block of scriptBlocks) {
    const jsonText = block.replace(/^<script[^>]*>|<\/script>$/gi, '').trim();
    try {
      const parsed = JSON.parse(jsonText);
      const found = walk(parsed);
      if (found) return found;
    } catch {
    }
  }
  return null;
}

/** Parse first German address pattern (street + number + 4-5 digit PLZ + city) out of text. */
function extractPostalAddressFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const rx =
    /([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?:[\s-]+[A-Za-zÄÖÜäöüß.\-]+)*\s+\d+[a-zA-Z]?)\s*[,\n·•|]+\s*(\d{4,5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\s.\-]+?)(?:[\s.,\n]|$)/;
  const m = text.match(rx);
  if (!m) return null;
  const [, street, postalCode, city] = m;
  const cleanCity = city.replace(/[\s.,]+$/, '').trim();
  if (!street || !postalCode || !cleanCity) return null;
  return {
    street: street.trim(),
    postalCode: postalCode.trim(),
    city: cleanCity,
  };
}

/** Normalise an address for diffing (whitespace + lowercase). */
function normaliseAddressForDiff(addr) {
  if (!addr) return '';
  return [addr.street, addr.postalCode, addr.city]
    .map((s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : ''))
    .join('|');
}

/** Scrape main + /kontakt + /contact for an operating address (JSON-LD preferred, text-regex fallback). Returns null when identical to imprint. */
async function scrapeLocationAddress(baseUrl, imprintAddress) {
  const candidates = ['', '/kontakt', '/contact'];
  const imprintKey = normaliseAddressForDiff(imprintAddress);
  for (const suffix of candidates) {
    let url;
    try {
      const parsed = new URL(baseUrl);
      const base = parsed.origin;
      url = suffix ? `${base}${suffix}` : parsed.toString();
    } catch {
      url = suffix ? `${baseUrl.replace(/\/+$/, '')}${suffix}` : baseUrl;
    }
    try {
      const result = await getFirecrawl().scrape(url, {
        formats: ['markdown', 'html'],
        onlyMainContent: false,
      });
      const html = result.html || result.rawHtml || '';
      const markdown = result.markdown || result.content || '';
      const fromLd = extractPostalAddressFromJsonLd(html);
      const fromText =
        fromLd || extractPostalAddressFromText(markdown || html);
      const found = fromLd || fromText;
      if (!found) {
        if (VERBOSE)
          console.log(`   ⚠️  Location address: none found at ${url}`);
        continue;
      }
      if (normaliseAddressForDiff(found) === imprintKey) {
        if (VERBOSE)
          console.log(
            `   ℹ️  Location address at ${url} matches imprint — no split needed`
          );
        return null;
      }
      if (VERBOSE)
        console.log(
          `   ✅ Location address found at ${url}: ${found.street}, ${found.postalCode} ${found.city}`
        );
      return found;
    } catch (err) {
      if (VERBOSE)
        console.log(`   ⚠️  Location-address scrape failed for ${url}: ${err.message}`);
    }
  }
  return null;
}

function applyLocationAddress(website, address) {
  if (!website.business) website.business = {};
  website.business.locationAddress = {
    street: address.street,
    postalCode: address.postalCode,
    city: address.city,
  };
}

async function scrapeImpressum(baseUrl) {
  let impressumUrl;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/impressum';
    }
    impressumUrl = parsed.toString();
  } catch {
    impressumUrl = baseUrl + '/impressum';
  }

  console.log(`\n📄 Scraping Impressum from: ${impressumUrl}`);
  try {
    const result = await getFirecrawl().scrape(impressumUrl, {
      formats: ['markdown'],
      onlyMainContent: true,
    });
    const markdown = result.markdown || result.content || '';
    if (!markdown.trim()) {
      if (VERBOSE) console.log('   ⚠️  No Impressum content returned');
      return null;
    }
    if (VERBOSE) console.log('   ✅ Impressum scraped successfully');
    const sections = parseImpressumContent(markdown);
    const phone = extractPhoneFromMarkdown(markdown);
    if (phone) {
      if (VERBOSE) console.log(`   📞 Phone found: ${phone}`);
    } else {
      if (VERBOSE) console.log('   ⚠️  No phone number detected in Impressum');
    }
    return { sections, phone };
  } catch (err) {
    if (VERBOSE) console.log(`   ⚠️  Impressum scrape failed: ${err.message}`);
    return null;
  }
}

// ===========================================================================
// SOCIAL LINKS
// ===========================================================================

const SOCIAL_PLATFORMS = [
  {
    name: 'Facebook',
    key: 'facebook',
    pattern: /facebook\.com\//i,
    icon: 'facebook',
    ariaLabel: 'Facebook',
  },
  {
    name: 'Instagram',
    key: 'instagram',
    pattern: /instagram\.com\//i,
    icon: 'instagram',
    ariaLabel: 'Instagram',
  },
  {
    name: 'LinkedIn',
    key: 'linkedin',
    pattern: /linkedin\.com\//i,
    icon: 'linkedin',
    ariaLabel: 'LinkedIn',
  },
  {
    name: 'X (Twitter)',
    key: 'twitter',
    pattern: /(?:twitter\.com|x\.com)\//i,
    icon: 'x-twitter',
    ariaLabel: 'X (Twitter)',
  },
  {
    name: 'YouTube',
    key: 'youtube',
    pattern: /youtube\.com\//i,
    icon: 'youtube',
    ariaLabel: 'YouTube',
  },
  {
    name: 'TikTok',
    key: 'tiktok',
    pattern: /tiktok\.com\//i,
    icon: 'tiktok',
    ariaLabel: 'TikTok',
  },
  {
    name: 'Pinterest',
    key: 'pinterest',
    pattern: /pinterest\./i,
    icon: 'pinterest',
    ariaLabel: 'Pinterest',
  },
  {
    name: 'Xing',
    key: 'xing',
    pattern: /xing\.com\//i,
    icon: 'xing',
    ariaLabel: 'Xing',
  },
  {
    name: 'Kununu',
    key: 'kununu',
    pattern: /kununu\.com\//i,
    icon: 'kununu',
    ariaLabel: 'Kununu',
  },
  {
    name: 'WhatsApp',
    key: 'whatsapp',
    pattern: /(?:whatsapp\.com|wa\.me)\//i,
    icon: 'whatsapp',
    ariaLabel: 'WhatsApp',
  },
  {
    name: 'Telegram',
    key: 'telegram',
    pattern: /t\.me\//i,
    icon: 'telegram',
    ariaLabel: 'Telegram',
  },
  {
    name: 'Threads',
    key: 'threads',
    pattern: /threads\.net\//i,
    icon: 'threads',
    ariaLabel: 'Threads',
  },
  {
    name: 'Bluesky',
    key: 'bluesky',
    pattern: /bsky\.app\//i,
    icon: 'bluesky',
    ariaLabel: 'Bluesky',
  },
  {
    name: 'Snapchat',
    key: 'snapchat',
    pattern: /snapchat\.com\//i,
    icon: 'snapchat',
    ariaLabel: 'Snapchat',
  },
  {
    name: 'Vimeo',
    key: 'vimeo',
    pattern: /vimeo\.com\//i,
    icon: 'vimeo',
    ariaLabel: 'Vimeo',
  },
  {
    name: 'GitHub',
    key: 'github',
    pattern: /github\.com\//i,
    icon: 'github',
    ariaLabel: 'GitHub',
  },
  {
    name: 'Mastodon',
    key: 'mastodon',
    pattern: /mastodon\./i,
    icon: 'mastodon',
    ariaLabel: 'Mastodon',
  },
];

function detectPlatform(url) {
  return SOCIAL_PLATFORMS.find((p) => p.pattern.test(url)) ?? null;
}

function isSocialUrl(url) {
  return SOCIAL_PLATFORMS.some((p) => p.pattern.test(url));
}

function extractHtmlLinks(html) {
  if (!html) return [];
  return [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map(
    (m) => m[1]
  );
}

function extractMarkdownLinks(markdown) {
  if (!markdown) return [];
  const links = new Set();
  for (const [, href] of markdown.matchAll(/\[.*?\]\((https?:\/\/[^)]+)\)/g)) {
    links.add(href.trim());
  }
  for (const [, url] of markdown.matchAll(
    /(?:^|[\s<])(https?:\/\/(?:www\.)?\w[\w.-]+\.[a-z]{2,}\/[^\s>)"]+)/gim
  )) {
    links.add(url.trim());
  }
  return [...links];
}

function collectSocialLinksFromResult(result) {
  const candidates = new Set();
  if (Array.isArray(result.links)) {
    result.links.forEach((l) => {
      const url = typeof l === 'string' ? l : (l?.url ?? l?.href ?? '');
      if (url) candidates.add(url);
    });
  }
  extractHtmlLinks(result.rawHtml).forEach((l) => candidates.add(l));
  extractMarkdownLinks(result.markdown).forEach((l) => candidates.add(l));
  return [...candidates].filter(isSocialUrl);
}

const CANDIDATE_PATHS = [
  '',
  '/kontakt',
  '/ueber-uns',
  '/impressum',
  '/rechtliches/impressum',
  '/about',
  '/contact',
];

async function scrapePage(url) {
  if (VERBOSE) console.log(`   Scraping: ${url}`);
  try {
    const result = await getFirecrawl().scrape(url, {
      formats: ['rawHtml', 'markdown', 'links'],
      onlyMainContent: false,
    });
    return collectSocialLinksFromResult(result);
  } catch (err) {
    if (VERBOSE) console.log(`   ⚠️  Failed (${err.message})`);
    return [];
  }
}

async function promptManualEntry() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const question = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log('\n📝 No social links found automatically.');
  console.log(
    '   Please enter them manually. Press Enter to skip a platform.\n'
  );

  const entries = [];
  for (const platform of SOCIAL_PLATFORMS.slice(0, 6)) {
    const answer = (
      await question(`   ${platform.name} URL (or Enter to skip): `)
    ).trim();
    if (answer && answer.startsWith('http')) {
      entries.push({
        key: platform.key,
        href: answer,
        name: platform.name,
        icon: platform.icon,
        ariaLabel: platform.ariaLabel,
      });
    }
  }

  while (true) {
    const extra = (
      await question('\n   Add another social link URL (or Enter to finish): ')
    ).trim();
    if (!extra) break;
    const platform = detectPlatform(extra);
    entries.push({
      key: platform?.key ?? 'social',
      href: extra,
      name: platform?.name ?? 'Social',
      icon: platform?.icon ?? 'link',
      ariaLabel: platform?.ariaLabel ?? 'Social',
    });
  }

  rl.close();
  return entries;
}

async function scrapeSocialLinks(baseUrl) {
  if (VERBOSE) console.log(`\n🔗 Searching for social links on: ${baseUrl}`);

  const allSocialUrls = new Set();
  for (const pagePath of CANDIDATE_PATHS) {
    const url = baseUrl + pagePath;
    const found = await scrapePage(url);
    found.forEach((u) => allSocialUrls.add(u));
    if (allSocialUrls.size > 0) {
      if (VERBOSE)
        console.log(
          `   ✅ Found ${allSocialUrls.size} social link(s) on ${url || '/'}`
        );
      break;
    }
  }

  // Deduplicate by platform key
  const seen = new Set();
  let entries = [...allSocialUrls]
    .map((href) => {
      const platform = detectPlatform(href);
      return platform
        ? {
            key: platform.key,
            href,
            name: platform.name,
            icon: platform.icon,
            ariaLabel: platform.ariaLabel,
          }
        : null;
    })
    .filter(Boolean)
    .filter(({ key }) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (entries.length === 0) {
    if (VERBOSE)
      console.log(
        '\n   ℹ️  Social links are likely rendered via JavaScript on this site.'
      );
    if (VERBOSE)
      console.log(
        '   Firecrawl cannot access JS-rendered content without browser rendering.'
      );
    entries = await promptManualEntry();
  }

  return entries;
}

// ===========================================================================
// CLIENT PROMPT (brand voice scrape + prompt generation)
// ===========================================================================

const CLIENT_PROMPT_CANDIDATE_PATHS = [
  '',
  '/ueber-uns',
  '/über-uns',
  '/about',
  '/leistungen',
  '/services',
  '/kontakt',
  '/contact',
  '/blog',
  '/ratgeber',
];

function compactWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function sanitizeMarkdownForVoice(markdown) {
  if (!markdown) return '';
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^!\[.*?\]\(.*\)$/.test(line))
    .filter((line) => !/^\[(.*?)\]\((.*?)\)$/.test(line))
    .filter((line) => !/^(Datenschutz|Impressum|Cookie|©|\|)$/i.test(line))
    .filter((line) => !/^[-_*]{3,}$/.test(line));

  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const normalized = line.toLowerCase();
    if (normalized.length < 25) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(line);
  }
  return deduped.join('\n');
}

async function scrapePageMarkdown(url) {
  if (VERBOSE) console.log(`   Scraping content: ${url}`);
  try {
    const result = await getFirecrawl().scrape(url, {
      formats: ['markdown'],
      onlyMainContent: true,
    });
    const markdown = result.markdown || result.content || '';
    if (!markdown.trim()) return null;
    return markdown;
  } catch (err) {
    if (VERBOSE) console.log(`   ⚠️  Failed (${err.message})`);
    return null;
  }
}

/** Scrape same-domain links + anchor text; consumed by 06's applyExternalFooterNavAndHeaderCtaLinks as a hallucination-proof candidate list. */
async function scrapeClientDomainLinks(baseUrl) {
  console.log(`\n🔗 Scraping same-domain links from: ${baseUrl}`);
  let html = '';
  try {
    const result = await getFirecrawl().scrape(baseUrl, {
      formats: ['html'],
      onlyMainContent: false,
    });
    html = result.html || result.rawHtml || '';
  } catch (err) {
    console.log(`   ⚠️  Failed to scrape HTML: ${err.message || err}`);
    return [];
  }
  if (!html) {
    console.log('   ⚠️  Empty HTML — no candidate links');
    return [];
  }

  let origin = '';
  let hostname = '';
  try {
    const parsed = new URL(baseUrl);
    origin = parsed.origin;
    hostname = parsed.hostname.replace(/^www\./i, '');
  } catch {
    return [];
  }
  if (!origin) return [];

  // Pattern: <a ... href="..." ...>...</a> — captures href + inner text with tags.
  const linkRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const byUrl = new Map();
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const rawHref = m[1].trim();
    // Strip inner HTML tags, collapse whitespace, trim leading/trailing emoji-ish decoration.
    const rawLabel = m[2]
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (!rawHref) continue;
    if (rawHref.startsWith('#')) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(rawHref)) continue;

    let abs;
    try {
      abs = new URL(rawHref, origin);
    } catch {
      continue;
    }
    // Same-domain only (ignoring www prefix differences).
    const absHost = abs.hostname.replace(/^www\./i, '');
    if (absHost !== hostname) continue;
    // Skip admin / auth / cart pages.
    if (
      /\/(?:wp-admin|wp-login|admin|login|signin|signup|register|logout|cart|checkout|account|my-account)(?:\/|$)/i.test(
        abs.pathname
      )
    ) {
      continue;
    }
    // Require a reasonable label.
    if (!rawLabel || rawLabel.length < 2 || rawLabel.length > 80) continue;
    // Force https (avoid mixed-content) and preserve #fragment (distinct dedupe bucket).
    const normalizedScheme = 'https:';
    const normalizedPath = abs.pathname.replace(/\/+$/, '') || '/';
    const fragment = abs.hash || '';
    const normalizedHost = abs.host;
    const cleanUrl = `${normalizedScheme}//${normalizedHost}${normalizedPath}${abs.search}${fragment}`;
    const key = cleanUrl;

    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { url: cleanUrl, label: rawLabel });
    } else if (rawLabel.length > 0 && rawLabel.length < existing.label.length) {
      // Prefer the shorter label (nav links tend to be concise and precise).
      existing.label = rawLabel;
    }
  }

  const out = Array.from(byUrl.values());
  console.log(`   ✅ Found ${out.length} unique same-domain link(s)`);
  return out;
}

/**
 * @returns {{ samples: Array<{ url: string, content: string }>, corpusMarkdown: string }}
 */
async function scrapeClientPromptCorpus(baseUrl) {
  console.log(`\n🧠 Scraping brand voice pages from: ${baseUrl}`);
  const samples = [];
  const seenChunks = new Set();

  for (const pagePath of CLIENT_PROMPT_CANDIDATE_PATHS) {
    const url = baseUrl + pagePath;
    const markdown = await scrapePageMarkdown(url);
    if (!markdown) continue;

    const cleaned = sanitizeMarkdownForVoice(markdown);
    const normalized = compactWhitespace(cleaned);
    if (normalized.length < 300) {
      if (VERBOSE) console.log('   ↳ skipped (too little useful text)');
      continue;
    }
    const signature = normalized.slice(0, 10000);
    if (seenChunks.has(signature)) {
      if (VERBOSE) console.log('   ↳ skipped (duplicate content)');
      continue;
    }
    seenChunks.add(signature);
    samples.push({ url, content: cleaned });
    if (VERBOSE) console.log(`   ✅ kept (${cleaned.length} chars)`);
  }

  if (samples.length === 0) {
    return { samples: [], corpusMarkdown: '' };
  }

  const corpusMarkdown = samples
    .map(
      (sample, index) =>
        `## Quelle ${index + 1}: ${sample.url}\n\n${sample.content.slice(0, 6000)}`
    )
    .join('\n\n---\n\n');

  return { samples, corpusMarkdown };
}

const TOPICS_JSON_SCHEMA_HINT = `{
  "topics": {
    "coreServices": ["Kurze Stichpunkte zu Angeboten/Leistungen"],
    "trustSignals": ["z.B. Zertifikate, Bewertungen, Transparenz"],
    "localReferences": ["Orte, Region, Standortbezug"],
    "differentiators": ["Was die Marke unterscheidet"],
    "faqIntent": ["Typische Nutzerfragen/Informationsbedarf"]
  },
  "keywords": ["relevante Suchbegriffe aus dem Text"],
  "h1Suggestions": ["3–8 Vorschläge für die Startseiten-H1, je ≤ 60 Zeichen"],
  "subtitleSuggestions": ["3–8 Untertitel passend zu den H1-Ideen, je ≤ 155 Zeichen"],
  "mustCover": ["Inhaltliche Punkte, die neue Texte berücksichtigen sollten"],
  "avoidAngles": ["Ton/Behauptungen vermeiden, die nicht zur Quelle passen"]
}`;

function extractJsonObjectFromModelText(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = codeBlock ? codeBlock[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Normalize and validate topic analysis payload from the model.
 * @returns {object | null}
 */
function validateTopicsPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const topics = raw.topics;
  if (!topics || typeof topics !== 'object') return null;

  const groupKeys = [
    'coreServices',
    'trustSignals',
    'localReferences',
    'differentiators',
    'faqIntent',
  ];
  const strList = (v) =>
    Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];

  const normalized = { topics: {} };
  let topicCount = 0;
  for (const key of groupKeys) {
    const arr = topics[key];
    const list = Array.isArray(arr)
      ? arr.map((s) => String(s).trim()).filter(Boolean)
      : [];
    normalized.topics[key] = list;
    topicCount += list.length;
  }

  normalized.keywords = strList(raw.keywords);
  normalized.h1Suggestions = strList(raw.h1Suggestions);
  normalized.subtitleSuggestions = strList(raw.subtitleSuggestions);
  normalized.mustCover = strList(raw.mustCover);
  normalized.avoidAngles = strList(raw.avoidAngles);

  const hasHeadlines =
    normalized.h1Suggestions.length > 0 ||
    normalized.subtitleSuggestions.length > 0;
  const hasKeywords = normalized.keywords.length > 0;
  if (topicCount === 0 && !hasHeadlines && !hasKeywords) return null;

  return normalized;
}

/**
 * Normalize a keyword string for equivalence comparisons (lowercase, trim,
 * collapse whitespace, treat hyphens/underscores as spaces).
 * Used to decide whether the briefing's "Main Keyword" is meaningfully
 * different from the deploy-domain-derived primary keyword.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKeywordForCompare(value) {
  if (value == null) return '';
  return String(value)
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a "Main Keyword" / "Hauptkeyword" directive from a websiteBriefing
 * string. Recognizes lines like:
 *   "Main Keyword: Schulbegleitung Hannover"
 *   "Hauptkeyword - Inklusive Schulbegleitung"
 *   "Haupt-Keyword: ..."
 * Returns the trimmed value, or null if no such line exists.
 * @param {unknown} briefing
 * @returns {string | null}
 */
function parseMainKeywordFromBriefing(briefing) {
  if (typeof briefing !== 'string') return null;
  const re = /^[\s>*-]*(?:main\s*[- ]?\s*keyword|haupt\s*[- ]?\s*keyword)\s*[:=\-–—]\s*(.+?)\s*$/im;
  const match = briefing.match(re);
  if (!match) return null;
  const value = match[1].trim().replace(/^["'„“”]+|["'„“”]+$/g, '').trim();
  return value || null;
}

/**
 * Derives the primary SEO keyword from a deployDomain (e.g. "schulassistenz.online" → "schulassistenz").
 * Falls back to siteId if no deployDomain is provided.
 * @param {string} [deployDomain]
 * @param {string} [siteId]
 * @returns {string | null}
 */
function derivePrimaryKeywordFromSite(deployDomain, siteId) {
  if (deployDomain) {
    // Strip TLD(s): "schulassistenz.online" → "schulassistenz"
    // Also handle multi-part domains like "schulbegleitung-hannover.de"
    const withoutTld = deployDomain
      .replace(/^https?:\/\//i, '')
      .split('.')
      .slice(0, -1) // remove last segment (TLD)
      .join('-');
    if (withoutTld) return withoutTld;
  }
  return siteId ?? null;
}

/**
 * Messages sent to the model for topic/headline analysis (must stay in sync with analyzeTopicsFromCorpus).
 * @param {string} corpusMarkdown
 * @param {{ deployDomain?: string, siteId?: string, websiteBriefing?: string }} [siteContext]
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildTopicsAnalysisMessages(corpusMarkdown, siteContext = {}) {
  const deployKeyword = derivePrimaryKeywordFromSite(
    siteContext.deployDomain,
    siteContext.siteId
  );

  const briefing =
    typeof siteContext.websiteBriefing === 'string'
      ? siteContext.websiteBriefing.trim()
      : '';
  const briefingMainKeyword = parseMainKeywordFromBriefing(briefing);

  const deployKeywordNorm = normalizeKeywordForCompare(deployKeyword);
  const briefingKeywordNorm = normalizeKeywordForCompare(briefingMainKeyword);
  const briefingKeywordIsDistinct =
    !!briefingMainKeyword && briefingKeywordNorm !== deployKeywordNorm;

  const systemPrompt =
    'Du bist ein SEO- und Content-Stratege. Analysiere Webseiten-Rohtexte und extrahiere Themencluster, Suchintention und konkrete Headline-Ideen. Antworte nur mit gültigem JSON, kein Markdown außerhalb von JSON. Alle Zeichenketten-Werte im JSON (Stichpunkte, Suchbegriffe, Überschriftenvorschläge) müssen auf Deutsch sein — kein Englisch, keine englischen Floskeln.';

  let primaryKeywordHint = '';
  if (deployKeyword && briefingKeywordIsDistinct) {
    primaryKeywordHint = `\nPRIMÄRE KEYWORDS (BEIDE verbindlich – stammen aus zwei Quellen):
- Aus der Deploy-Domain abgeleitet: "${deployKeyword}"
- Aus dem Website-Briefing („Main Keyword"): "${briefingMainKeyword}"
Anforderungen:
- BEIDE Keywords MÜSSEN in "keywords" enthalten sein. Das Briefing-Keyword "${briefingMainKeyword}" steht an Position 1, das Deploy-Domain-Keyword "${deployKeyword}" an Position 2.
- Mindestens eine "h1Suggestions"-Variante UND eine "subtitleSuggestions"-Variante müssen das Briefing-Keyword enthalten.
- Mindestens eine weitere "h1Suggestions"-Variante und eine "subtitleSuggestions"-Variante sollten das Deploy-Domain-Keyword enthalten (sofern es sich natürlich integrieren lässt).
- Baue beide Keywords natürlich in weitere Themen und Vorschläge ein, wo es thematisch passt.\n`;
  } else if (briefingMainKeyword) {
    primaryKeywordHint = `\nPRIMÄRES KEYWORD (aus dem Website-Briefing „Main Keyword"): "${briefingMainKeyword}"
- Dieses Keyword MUSS als erstes Element in "keywords" erscheinen.
- Mindestens eine "h1Suggestions"-Variante und eine "subtitleSuggestions"-Variante MÜSSEN dieses Keyword enthalten.
- Baue es natürlich in weitere Keywords und Themen ein, wo es thematisch passt.\n`;
  } else if (deployKeyword) {
    primaryKeywordHint = `\nPRIMÄRES KEYWORD (aus der Deploy-Domain abgeleitet): "${deployKeyword}"
- Dieses Keyword MUSS als erstes Element in "keywords" erscheinen.
- Mindestens eine "h1Suggestions"-Variante und eine "subtitleSuggestions"-Variante MÜSSEN dieses Keyword enthalten.
- Baue es natürlich in weitere Keywords und Themen ein, wo es thematisch passt.\n`;
  }

  const briefingBlock = briefing
    ? `\nWEBSITE-BRIEFING (verbindlich, höchste Priorität — überschreibt die Webseiten-Texte bei Konflikt):
"""
${briefing}
"""
- Werte Anweisungen aus dem Briefing strikt aus (z. B. Zielgruppen, USP, Tonalität, Themenfokus, regionaler Bezug, Pflichtinhalte).
- "mustCover" muss alle inhaltlichen Vorgaben aus dem Briefing widerspiegeln.
- Wenn das Briefing einer Aussage aus den Webseiten-Texten widerspricht, folge dem Briefing.
- Kopiere das Briefing nicht wörtlich in die Felder; übersetze es in passende Stichpunkte, Keywords und Headline-Varianten.\n`
    : '';

  const userPrompt = `
Analysiere die folgenden Webseiten-Texte (mehrere Quellen). Erkenne, welche Themen die Marke abdeckt und welche Formulierungen für eine neue, hochwertige Website taugen.

Gib AUSSCHLIESSLICH ein einzelnes JSON-Objekt zurück (kein Fließtext davor oder danach). Schema:

${TOPICS_JSON_SCHEMA_HINT}
${primaryKeywordHint}${briefingBlock}
Regeln:
- Alle Inhalte in den JSON-Werten auf Deutsch formulieren (Du-Ansprache in Stichpunkten, wo sinnvoll). Keine englischen Sätze oder Marketing-Anglizismen, außer sie stehen wörtlich in den Quellen und sind markenrelevant.
- "h1Suggestions" und "subtitleSuggestions": jeweils 3–8 Varianten; H1 kurz und knackig (≤ 60 Zeichen), Untertitel ergänzend (≤ 155 Zeichen).
- Nur Inhalte ableiten, die sich aus dem Material stützen lassen; nichts erfinden, was nicht plausibel aus dem Kontext folgt.

WEBSEITEN-TEXTE:
${corpusMarkdown.slice(0, 48000)}
`;

  return { systemPrompt, userPrompt };
}

async function analyzeTopicsFromCorpus(corpusMarkdown, modelName, siteContext = {}) {
  const { systemPrompt, userPrompt } =
    buildTopicsAnalysisMessages(corpusMarkdown, siteContext);

  const completion = await getOpenRouter().chat.completions.create({
    model: modelName,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  log05ExtractAi('topics-analysis', modelName, completion);

  const content = completion.choices?.[0]?.message?.content?.trim() || '';
  let parsed = extractJsonObjectFromModelText(content);
  let validated = validateTopicsPayload(parsed);
  if (validated) return validated;

  const repairCompletion = await getOpenRouter().chat.completions.create({
    model: modelName,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'Du reparierst JSON. Antworte nur mit einem einzigen gültigen JSON-Objekt, das exakt dem geforderten Schema entspricht. Alle Zeichenketten-Werte bleiben oder werden auf Deutsch formuliert.',
      },
      {
        role: 'user',
        content: `Das folgende Modell-Output soll in gültiges JSON umgewandelt werden. Schema:\n${TOPICS_JSON_SCHEMA_HINT}\n\nRohtext:\n${content}`,
      },
    ],
  });

  log05ExtractAi('topics-analysis-repair', modelName, repairCompletion);

  const repairContent =
    repairCompletion.choices?.[0]?.message?.content?.trim() || '';
  parsed = extractJsonObjectFromModelText(repairContent);
  validated = validateTopicsPayload(parsed);
  return validated;
}

/**
 * Remove trailing "## Aufgabe" boilerplate (models sometimes add it despite instructions).
 */
function stripTrailingAufgabeSection(markdown) {
  if (!markdown) return markdown;
  let lastIdx = -1;
  const re = /\n##\s+Aufgabe\b/gi;
  let m;
  while ((m = re.exec(markdown)) !== null) lastIdx = m.index;
  if (lastIdx === -1) {
    const t = markdown.trim();
    if (/^##\s+Aufgabe\b/im.test(t)) return '';
    return markdown.trimEnd();
  }
  let s = markdown.slice(0, lastIdx);
  s = s.replace(/\n---\s*$/, '');
  return s.trimEnd();
}

/**
 * Messages for the brand-voice prompt generator (must stay in sync with generateClientPromptFromCorpus).
 * @param {string} corpus
 * @param {object | null} topicsData
 * @param {{ deployDomain?: string, siteId?: string, websiteBriefing?: string }} [siteContext]
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildClientPromptGenerationMessages(corpus, topicsData, siteContext = {}) {
  const systemPrompt =
    'Du bist ein Senior-Copywriter und Markenstratege. Analysiere Tonalität, Vokabular, Satzlänge, wiederkehrende Aussagen, Werte und CTA-Muster aus Webseiten-Texten. Deine gesamte Ausgabe (Überschriften, Fließtext, Listen, Zitate) ist ausschließlich auf Deutsch — kein Englisch in Erklärungen, Beispielen oder Überschriften.';

  const topicsBlock = topicsData
    ? `

VORANALYSE (Themen & Überschriften — verbindlich in den Prompt einarbeiten, ggf. sprachlich glätten; bei englischen Begriffen in den Daten in natürliches Deutsch überführen):
${JSON.stringify(topicsData, null, 2)}
`
    : '';

  const briefing =
    typeof siteContext.websiteBriefing === 'string'
      ? siteContext.websiteBriefing.trim()
      : '';
  const briefingMainKeyword = parseMainKeywordFromBriefing(briefing);
  const deployKeyword = derivePrimaryKeywordFromSite(
    siteContext.deployDomain,
    siteContext.siteId
  );
  const deployKeywordNorm = normalizeKeywordForCompare(deployKeyword);
  const briefingKeywordNorm = normalizeKeywordForCompare(briefingMainKeyword);
  const briefingKeywordIsDistinct =
    !!briefingMainKeyword && briefingKeywordNorm !== deployKeywordNorm;

  let keywordHint = '';
  if (deployKeyword && briefingKeywordIsDistinct) {
    keywordHint = `\n- Verankere im Prompt zwei primäre Keywords: das Briefing-Keyword "${briefingMainKeyword}" (Priorität 1) und das Deploy-Domain-Keyword "${deployKeyword}" (Priorität 2). Beide sollen in mindestens einer H1- bzw. Untertitel-Idee vorkommen.`;
  } else if (briefingMainKeyword) {
    keywordHint = `\n- Verankere das primäre Keyword "${briefingMainKeyword}" (aus dem Briefing) in mindestens einer H1- und einer Untertitel-Idee.`;
  } else if (deployKeyword) {
    keywordHint = `\n- Verankere das primäre Keyword "${deployKeyword}" (aus der Deploy-Domain abgeleitet) in mindestens einer H1- und einer Untertitel-Idee.`;
  }

  const briefingBlock = briefing
    ? `

WEBSITE-BRIEFING (verbindlich, höchste Priorität — überschreibt das Analyse-Material und die Voranalyse bei Konflikt):
"""
${briefing}
"""
- Arbeite alle inhaltlichen, tonalen und strategischen Vorgaben aus dem Briefing in den finalen Prompt ein (z. B. unter „Inhaltliche Leitplanken“, „Themenlandschaft“, „H1-Ideen“, „Untertitel-Ideen“).
- Kopiere das Briefing nicht wörtlich in den Prompt; übersetze es in konkrete Schreibregeln, Pflichtinhalte und Beispiel-Headlines.
- Wenn das Briefing einer Aussage aus dem Analyse-Material widerspricht, folge dem Briefing.${keywordHint}
`
    : keywordHint
    ? `\n${keywordHint.replace(/^\n- /, '- ')}\n`
    : '';

  const userPrompt = `
Erstelle einen wiederverwendbaren Prompt in deutscher Sprache (Du-Ansprache), der neue Inhalte exakt im Stil der analysierten Marke erzeugt.

WICHTIGE ANFORDERUNGEN:
- Gib ausschließlich den finalen Prompt als Markdown aus. Durchgehend deutsche Sprache: keine englischen Abschnittsüberschriften, keine englischen Beispielsätze (außer zitierte Marken-/Produktbezeichnungen aus den Quellen).
- Struktur muss enthalten:
  - Tonalität, Sprachstil, Markencharakter, Zielgruppe, Schreibregeln, Stil-Beispiele, Anti-Beispiele
  - Zusätzlich diese Überschriften als ####-Ebene (exakt so benannt):
    #### **Themenlandschaft der Marke**
    #### **Inhaltliche Leitplanken**
    #### **H1-Ideen (Startseite)**
    #### **Untertitel-Ideen (Startseite)**
- Unter "Themenlandschaft": strukturierte Bullet-Listen zu Leistungen, Vertrauenssignalen, lokalem Bezug, Alleinstellung und typischem Informationsbedarf (FAQ-Intent).
- Unter "Inhaltliche Leitplanken": klar trennen, was neue Texte unbedingt berücksichtigen sollen vs. was vermieden werden soll.
- H1-Ideen: mehrere konkrete Varianten für die Startseite (≤ 60 Zeichen); Untertitel-Ideen: passende zweite Zeile (≤ 155 Zeichen), zur Auswahl für eine zweite Website.
- Sprache klar, direkt, emotional, einladend und locker-kompetent.
- Vermeide generische Marketing-Floskeln und unnötige Anglizismen.
- Stil-Beispiele sollen erkennbar zur analysierten Marke passen.
- Keinen Abschnitt „## Aufgabe“, keinen Platzhalter „[HIER …]“ und keine „Erstelle Content für:“-Ende-Formulierung anhängen — der Prompt endet mit den inhaltlichen Leitplanken und Beispielen.
${topicsBlock}${briefingBlock}
ANALYSE-MATERIAL:
${corpus}
`;

  return { systemPrompt, userPrompt };
}

async function generateClientPromptFromCorpus(
  corpus,
  modelName,
  topicsData = null,
  siteContext = {}
) {
  if (!corpus.trim()) {
    return '';
  }

  const { systemPrompt, userPrompt } = buildClientPromptGenerationMessages(
    corpus,
    topicsData,
    siteContext
  );

  const completion = await getOpenRouter().chat.completions.create({
    model: modelName,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  log05ExtractAi('client-prompt-generation', modelName, completion, {
    siteId: siteContext.siteId,
    deployDomain: siteContext.deployDomain,
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  return stripTrailingAufgabeSection(raw);
}

function writeTopicsFile(clientName, siteId, topicsData, meta = {}) {
  const siteDir = path.join(projectRoot, 'src', 'data', clientName, siteId);
  const topicsPath = path.join(siteDir, 'topics.json');

  if (!fs.existsSync(siteDir)) {
    fs.mkdirSync(siteDir, { recursive: true });
  }

  if (fs.existsSync(topicsPath)) {
    const backupPath = topicsPath.replace(
      /\.json$/i,
      `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.copyFileSync(topicsPath, backupPath);
    console.log(
      `   💾 Existing topics.json backed up → ${path.relative(projectRoot, backupPath)}`
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    ...meta,
    ...topicsData,
  };

  fs.writeFileSync(topicsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(
    `   ✅ topics.json updated → ${path.relative(projectRoot, topicsPath)}`
  );
}

function writeClientPromptFile(clientName, siteId, promptContent) {
  const siteDir = path.join(projectRoot, 'src', 'data', clientName, siteId);
  const promptPath = path.join(siteDir, 'prompt.md');
  const legacyPromptPath = path.join(siteDir, 'prompt.txt');

  if (!fs.existsSync(siteDir)) {
    fs.mkdirSync(siteDir, { recursive: true });
  }

  if (fs.existsSync(promptPath)) {
    const backupPath = promptPath.replace(
      /\.md$/i,
      `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
    );
    fs.copyFileSync(promptPath, backupPath);
    console.log(
      `   💾 Existing prompt backed up → ${path.relative(projectRoot, backupPath)}`
    );
  }

  // Keep migration clean: if a legacy prompt.txt exists, remove it once prompt.md is written.
  if (fs.existsSync(legacyPromptPath)) {
    fs.unlinkSync(legacyPromptPath);
  }

  fs.writeFileSync(promptPath, promptContent.trim() + '\n', 'utf8');
  console.log(
    `   ✅ prompt.md updated → ${path.relative(projectRoot, promptPath)}`
  );
}

/**
 * Persist scraped corpus and exact OpenRouter messages so a later run can replay or tweak AI steps.
 * Written to src/data/<client>/<siteId>/client-prompt-ai-input.json
 */
function writeClientPromptAiInputFile(clientName, siteId, payload) {
  const siteDir = path.join(projectRoot, 'src', 'data', clientName, siteId);
  const filePath = path.join(siteDir, 'client-prompt-ai-input.json');

  if (!fs.existsSync(siteDir)) {
    fs.mkdirSync(siteDir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    const backupPath = filePath.replace(
      /\.json$/i,
      `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.copyFileSync(filePath, backupPath);
    console.log(
      `   💾 Existing client-prompt-ai-input backed up → ${path.relative(projectRoot, backupPath)}`
    );
  }

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(
    `   ✅ client-prompt-ai-input.json → ${path.relative(projectRoot, filePath)}`
  );
}

// ===========================================================================
// websites.json update helpers
// ===========================================================================

/**
 * Compare clientDomain values reliably (trim, strip scheme/path, trailing dot).
 */
function normalizeClientDomainKey(d) {
  if (d == null) return '';
  return String(d)
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * Turn a domain/host string into a safe folder name under src/data/<client>/.
 */
function slugifyHostForSiteDir(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim();
  s = s.replace(/^https?:\/\//i, '');
  const host = s.split('/')[0].trim().replace(/\.$/, '');
  if (!host || !host.includes('.')) return null;
  return host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\./g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Directory name for site-scoped files (prompt.md, topics.json).
 * Prefer non-empty website.id; otherwise deployDomain, then clientDomain fallbacks.
 */
function resolveSiteFolderId(website, websitesData) {
  const trimmed = String(website.id ?? '').trim();
  if (trimmed) return trimmed;
  return (
    slugifyHostForSiteDir(website.deployDomain) ||
    slugifyHostForSiteDir(website.clientDomain) ||
    slugifyHostForSiteDir(websitesData?.clientDomain) ||
    'site'
  );
}

/**
 * Return all website entries that should be updated for the given scrape domain.
 * If the selected domain matches the top-level clientDomain, treat it as a
 * brand-level source and update every website entry for that client.
 */
function findWebsitesByDomain(websitesData, clientDomain) {
  const topLevel = websitesData.clientDomain;
  const needle = normalizeClientDomainKey(clientDomain);
  if (needle && needle === normalizeClientDomainKey(topLevel)) {
    return websitesData.websites ?? [];
  }
  return (websitesData.websites ?? []).filter((site) => {
    const siteDomain = site.clientDomain ?? topLevel;
    return normalizeClientDomainKey(siteDomain) === needle;
  });
}

/**
 * Merge discovered social links into website.business.social.
 * Keeps existing keys (e.g. whatsappNumber) that aren't overwritten.
 */
function applySocial(website, entries) {
  if (!website.business) website.business = {};
  if (!website.business.social) website.business.social = {};

  for (const entry of entries) {
    website.business.social[entry.key] = entry.href;
  }
}

/**
 * Write the phone number into website.business.phone.
 */
function applyPhone(website, phone) {
  if (!website.business) website.business = {};
  website.business.phone = phone;
}

/**
 * Impressum body is generated from `src/data/_template/legal/impressum-content.json`.
 * Do not persist `blocks` on the impressum page — remove any legacy `blocks` key.
 */
function stripImpressumBlocks(website) {
  const pages = website.pages ?? [];
  const impressumPage = pages.find((p) => p.name === 'impressum');
  if (!impressumPage) {
    console.log(
      '   ⚠️  No impressum page found in this website entry – nothing to strip.'
    );
    return;
  }
  if ('blocks' in impressumPage) delete impressumPage.blocks;
}

// ===========================================================================
// FAVICON (no Firecrawl — plain fetch)
// ===========================================================================

const FAVICON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Resolve https://host for fetching the live site favicon.
 * Prefers home page openGraph.url, then clientDomain (top-level + per-site), then deployDomain.
 * clientDomain is preferred over deployDomain so production/live host wins over preview URLs.
 */
function resolveSiteOrigin(website, websitesData) {
  const home = website.pages?.find((p) => p.name === 'home');
  const ogUrl = home?.metadata?.openGraph?.url;
  if (ogUrl && /^https?:\/\//i.test(ogUrl)) {
    try {
      return new URL(ogUrl).origin;
    } catch {
      /* ignore */
    }
  }
  const tryHost = (raw) => {
    if (raw == null || raw === '') return null;
    const s = String(raw)
      .trim()
      .replace(/^https?:\/\//i, '');
    const host = s.split('/')[0];
    if (!host.includes('.')) return null;
    return `https://${host}`;
  };
  return (
    tryHost(websitesData.clientDomain) ||
    tryHost(website.clientDomain) ||
    tryHost(website.deployDomain) ||
    null
  );
}

function collectFaviconCandidates(html, pageUrl) {
  const candidates = [];
  const linkRe = /<link[^>]+>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const relMatch = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!relMatch || !hrefMatch) continue;
    const rel = relMatch[1].toLowerCase();
    const href = hrefMatch[1].trim();
    if (!href || href.startsWith('data:')) continue;
    if (!/\b(icon|shortcut|apple-touch)/i.test(rel)) continue;
    try {
      const abs = new URL(href, pageUrl).href;
      let priority = 5;
      if (/\bshortcut\s*icon\b/i.test(rel)) priority = 1;
      else if (rel.split(/\s+/).includes('icon') && !/apple-touch/.test(rel))
        priority = 2;
      else if (/mask-icon/.test(rel)) priority = 6;
      else if (/apple-touch-icon/.test(rel)) priority = 4;
      candidates.push({ priority, href: abs });
    } catch {
      /* ignore */
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  const ordered = [];
  const seen = new Set();
  for (const { href } of candidates) {
    if (seen.has(href)) continue;
    seen.add(href);
    ordered.push(href);
  }
  try {
    const fallback = new URL('/favicon.ico', pageUrl).href;
    if (!seen.has(fallback)) ordered.push(fallback);
  } catch {
    /* ignore */
  }
  return ordered;
}

async function fetchBinary(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': FAVICON_UA,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

async function downloadFaviconFromSite(homePageUrl) {
  const res = await fetch(homePageUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': FAVICON_UA,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to load homepage ${homePageUrl}: HTTP ${res.status}`
    );
  }
  const html = await res.text();
  const finalUrl = res.url || homePageUrl;
  const candidates = collectFaviconCandidates(html, finalUrl);

  const errors = [];
  for (const iconUrl of candidates) {
    try {
      const buffer = await fetchBinary(iconUrl);
      if (buffer.length < 32) {
        errors.push(`${iconUrl}: response too small`);
        continue;
      }
      return { buffer, sourceUrl: iconUrl };
    } catch (e) {
      errors.push(`${iconUrl}: ${e.message}`);
    }
  }
  throw new Error(
    `Could not download a favicon. Tried:\n   ${errors.slice(0, 8).join('\n   ')}`
  );
}

async function promptWebsite(enquirer, websitesData) {
  const websites = websitesData.websites ?? [];
  if (websites.length === 0) {
    console.error('❌ No website entries found in websites.json');
    process.exit(1);
  }
  if (websites.length === 1) {
    console.log(`ℹ️  Using website: ${websites[0].id}`);
    return websites[0];
  }
  const { websiteId } = await enquirer.prompt({
    type: 'select',
    name: 'websiteId',
    message: 'Which website?',
    choices: websites.map((w) => w.id),
  });
  return websites.find((w) => w.id === websiteId) ?? websites[0];
}

async function promptBaseUrlIfNeeded(enquirer, website, websitesData) {
  let origin = resolveSiteOrigin(website, websitesData);
  if (origin) {
    console.log(`ℹ️  Resolved site URL: ${origin}`);
    return origin;
  }
  console.log(
    '⚠️  Could not infer a public https URL from openGraph / deployDomain (no hostname with a dot).'
  );
  const { manualUrl } = await enquirer.prompt({
    type: 'input',
    name: 'manualUrl',
    message: 'Enter the website base URL (e.g. https://example.de):',
    validate: (v) => {
      const t = String(v).trim();
      if (!/^https?:\/\//i.test(t))
        return 'Must start with http:// or https://';
      try {
        new URL(t);
        return true;
      } catch {
        return 'Invalid URL';
      }
    },
  });
  try {
    return new URL(manualUrl.trim()).origin;
  } catch {
    console.error('❌ Invalid URL');
    process.exit(1);
  }
}

function parseArgvFlag(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return null;
  const v = arg.slice(prefix.length).trim();
  return v || null;
}

async function faviconMain() {
  console.log('\n🖼️  05-extract-client-data — favicon only\n');

  const cliClient = parseArgvFlag('--client=');
  const cliSite = parseArgvFlag('--site=');
  const cliDomain = parseArgvFlag('--domain=');

  const enquirer = await getEnquirer();

  const clientList = discoverClients();
  let clientName = cliClient;
  if (!clientName) {
    clientName = await promptClient(enquirer, clientList);
  } else if (!clientList.includes(clientName)) {
    console.error(
      `❌ Unknown client "${clientName}". Expected one of: ${clientList.join(', ')}`
    );
    process.exit(1);
  }

  const websitesJsonRelPath = `src/data/${clientName}/websites.json`;
  const websitesJsonPath = path.resolve(projectRoot, websitesJsonRelPath);

  if (!fs.existsSync(websitesJsonPath)) {
    console.error(`❌ websites.json not found at: ${websitesJsonPath}`);
    process.exit(1);
  }

  const websitesData = JSON.parse(fs.readFileSync(websitesJsonPath, 'utf8'));
  const websites = websitesData.websites ?? [];

  // Save to src/data/<client>/favicon.<detected-ext> (content-sniffed — many sites mis-serve ICO/SVG).
  const clientDataDir = path.join(projectRoot, 'src', 'data', clientName);
  if (!fs.existsSync(clientDataDir)) {
    fs.mkdirSync(clientDataDir, { recursive: true });
  }

  /** Save favicon buffer at content-detected extension; delete stale siblings. */
  const saveClientFavicon = (buffer) => {
    const ext = detectFaviconExtension(buffer);
    const targetPath = path.join(clientDataDir, `favicon.${ext}`);
    for (const e of FAVICON_EXTS) {
      const stale = path.join(clientDataDir, `favicon.${e}`);
      if (stale !== targetPath && fs.existsSync(stale)) {
        try {
          fs.unlinkSync(stale);
        } catch {
          /* ignore */
        }
      }
    }
    fs.writeFileSync(targetPath, buffer);
    return targetPath;
  };

  if (cliDomain) {
    const d = cliDomain.replace(/^https?:\/\//i, '').split('/')[0];
    const origin = `https://${d}`;
    console.log(`ℹ️  Using domain: ${origin}`);

    const homePageUrl = new URL('/', origin).href;
    console.log(`\n📥 Fetching favicon via homepage: ${homePageUrl}`);
    const { buffer, sourceUrl } = await downloadFaviconFromSite(homePageUrl);

    const savedPath = saveClientFavicon(buffer);
    console.log(
      `\n✅ Saved favicon → ${path.relative(projectRoot, savedPath)}`
    );
    console.log(`   Source: ${sourceUrl}`);
    console.log(`   Size:   ${buffer.length} bytes`);
    console.log(
      `   (use-client will copy this into public/ on activation, preserving the matching extension)\n`
    );
    return;
  }

  let selectedWebsites = [];

  if (cliSite) {
    const siteIds = cliSite
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of siteIds) {
      const w = websites.find((ws) => ws.id === id);
      if (!w) {
        console.error(
          `❌ No website with id "${id}" in ${websitesJsonRelPath}`
        );
        process.exit(1);
      }
      selectedWebsites.push(w);
    }
    console.log(`ℹ️  Using website(s): ${siteIds.join(', ')}`);
  } else if (websites.length === 0) {
    console.error('❌ No website entries found in websites.json');
    process.exit(1);
  } else if (websites.length === 1) {
    console.log(`ℹ️  Using website: ${websites[0].id}`);
    selectedWebsites = [websites[0]];
  } else {
    const { websiteIds } = await enquirer.prompt({
      type: 'multiselect',
      name: 'websiteIds',
      message: 'Which website(s)? (space to toggle, enter to confirm)',
      choices: websites.map((w) => w.id),
    });
    if (!websiteIds || websiteIds.length === 0) {
      console.error('❌ No websites selected');
      process.exit(1);
    }
    selectedWebsites = websiteIds
      .map((id) => websites.find((w) => w.id === id))
      .filter(Boolean);
  }

  const originsByWebsite = [];
  for (const website of selectedWebsites) {
    const origin = await promptBaseUrlIfNeeded(enquirer, website, websitesData);
    originsByWebsite.push({ website, origin });
  }

  const uniqueOrigins = [...new Set(originsByWebsite.map((o) => o.origin))];
  let saved = false;

  for (const origin of uniqueOrigins) {
    const homePageUrl = new URL('/', origin).href;
    const siteIds = originsByWebsite
      .filter((o) => o.origin === origin)
      .map((o) => o.website.id);

    if (saved) {
      console.log(
        `\n⏭️  Skipping ${siteIds.join(', ')} — same origin as already fetched (${origin})`
      );
      continue;
    }

    console.log(
      `\n📥 Fetching favicon for ${siteIds.join(', ')} via: ${homePageUrl}`
    );

    try {
      const { buffer, sourceUrl } = await downloadFaviconFromSite(homePageUrl);
      const savedPath = saveClientFavicon(buffer);
      saved = true;

      console.log(`✅ Saved → ${path.relative(projectRoot, savedPath)}`);
      console.log(`   Source: ${sourceUrl}`);
      console.log(`   Size:   ${buffer.length} bytes`);
    } catch (err) {
      console.error(`❌ Failed for ${siteIds.join(', ')}: ${err.message}`);
    }
  }

  if (!saved) {
    console.error(
      '\n❌ Could not download a favicon from any of the selected websites.'
    );
  } else {
    console.log(
      `\n   (use-client will copy this into public/ on activation, preserving the matching extension)`
    );
  }

  console.log('');
}

// ===========================================================================
// Download client fonts (Puppeteer → public/fonts + theme.config.json; no Firecrawl)
// Controlled by --download-fonts and flags below.
// Flags: --client= --site= --domain= --fonts-url=|--url= --fonts-json (detection JSON only, no theme write)
// ===========================================================================

const FONT_LOG = '  [fonts]';
const GOOGLE_FONTS_CSS_BASE = 'https://fonts.googleapis.com/css2';
const FONT_HEADING_WEIGHTS = '400;700';
const FONT_BODY_WEIGHTS = '300;400;500;600;700';

const LATIN_UNICODE_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const ASCII_UNICODE_RANGE =
  'U+0020-007E, U+00A0, U+2000-206F, U+20AC, U+2122, U+FEFF, U+FFFD';
const GERMAN_CHARS = 'äöüÄÖÜß';

function buildLatinCharsFromRange() {
  const ranges = LATIN_UNICODE_RANGE.replace(/U\+/g, '')
    .split(',')
    .map((s) => s.trim());
  const chars = [];
  for (const r of ranges) {
    if (r.includes('-')) {
      const [start, end] = r.split('-').map((h) => parseInt(h, 16));
      for (let i = start; i <= end; i++) chars.push(String.fromCodePoint(i));
    } else {
      chars.push(String.fromCodePoint(parseInt(r, 16)));
    }
  }
  return chars.join('');
}

const LATIN_CHARS = buildLatinCharsFromRange();

/**
 * @param {string} domain Hostname or URL prefix
 */
function toFontsUrl(domain) {
  const d = String(domain).trim();
  if (d.startsWith('http://') || d.startsWith('https://')) return d;
  return `https://${d}`;
}

/**
 * Prefer per-site clientDomain, then top-level websites.json clientDomain.
 */
function resolveDomainForFonts(websitesData, website) {
  const top = websitesData.clientDomain;
  const fromSite = website?.clientDomain;
  const raw = (fromSite ?? top ?? '').trim();
  return raw || null;
}

function parseFirstFontFamily(fontFamilyStr) {
  if (!fontFamilyStr || typeof fontFamilyStr !== 'string') return null;
  const first = fontFamilyStr.split(',')[0].trim();
  if (!first) return null;
  const name = first.replace(/^['"]|['"]$/g, '').trim();
  return name || null;
}

function getCollectFontsScript() {
  return function collectFonts() {
    let bodyFont = null;
    try {
      const body = document.body;
      if (body) {
        const ff = window.getComputedStyle(body).fontFamily;
        if (ff) {
          const first = ff
            .split(',')[0]
            .trim()
            .replace(/^['"]|['"]$/g, '');
          if (first) bodyFont = first;
        }
      }
      if (!bodyFont) {
        const p = document.querySelector('p');
        if (p) {
          const ff = window.getComputedStyle(p).fontFamily;
          if (ff) {
            const first = ff
              .split(',')[0]
              .trim()
              .replace(/^['"]|['"]$/g, '');
            if (first) bodyFont = first;
          }
        }
      }
    } catch (_) {}
    let headingFont = null;
    for (const tag of ['h1', 'h2', 'h3']) {
      try {
        const el = document.querySelector(tag);
        if (el) {
          const ff = window.getComputedStyle(el).fontFamily;
          if (ff) {
            const first = ff
              .split(',')[0]
              .trim()
              .replace(/^['"]|['"]$/g, '');
            if (first) {
              headingFont = first;
              break;
            }
          }
        }
      } catch (_) {}
    }
    const normalize = (s) =>
      s
        .replace(/^['"]|['"]$/g, '')
        .trim()
        .toLowerCase();
    const collectFacesFor = (familyWant) => {
      if (!familyWant) return [];
      const want = normalize(familyWant);
      const out = [];
      try {
        for (const sheet of document.styleSheets) {
          let rules = [];
          try {
            rules = sheet.cssRules || sheet.rules || [];
          } catch (_) {}
          for (const rule of rules) {
            if (rule.type !== 5) continue;
            const fontFamily =
              rule.style.getPropertyValue('font-family') ||
              rule.style.fontFamily ||
              '';
            if (!fontFamily) continue;
            const family = normalize(fontFamily.split(',')[0].trim());
            if (family !== want) continue;
            const src =
              rule.style.getPropertyValue('src') || rule.style.src || '';
            const weight = (
              rule.style.getPropertyValue('font-weight') ||
              rule.style.fontWeight ||
              '400'
            ).trim();
            const style = (
              rule.style.getPropertyValue('font-style') ||
              rule.style.fontStyle ||
              'normal'
            ).trim();
            if (src) out.push({ weight, style, src });
          }
        }
      } catch (_) {}
      return out;
    };
    const stylesheetHrefs = [];
    try {
      document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        if (link.href) stylesheetHrefs.push(link.href);
      });
    } catch (_) {}
    return {
      bodyFont,
      headingFont,
      stylesheetHrefs,
      bodyFontFaces: collectFacesFor(bodyFont),
      headingFontFaces: collectFacesFor(headingFont),
    };
  };
}

function getThemeConfigPathForFonts(client) {
  return path.join(projectRoot, 'src', 'data', client, 'theme.config.json');
}

function loadThemeConfigForFonts(client) {
  const p = getThemeConfigPathForFonts(client);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeThemeConfigForFonts(client, theme) {
  const p = getThemeConfigPathForFonts(client);
  fs.writeFileSync(p, stringifyThemeConfig(theme), 'utf-8');
}

function encodeFamilyForUrl(family) {
  return String(family).trim().replace(/\s+/g, '+');
}

async function isGoogleFont(family, role) {
  if (!family || !String(family).trim()) return false;
  const encoded = encodeFamilyForUrl(family);
  const weights = role === 'heading' ? FONT_HEADING_WEIGHTS : FONT_BODY_WEIGHTS;
  const url = `${GOOGLE_FONTS_CSS_BASE}?family=${encoded}:wght@${weights}&display=swap`;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const css = await res.text();
    const needleSingle = `font-family: '${family}'`;
    const needleDouble = `font-family: "${family}"`;
    return (
      css.includes('@font-face') &&
      (css.includes(needleSingle) || css.includes(needleDouble))
    );
  } catch {
    return false;
  }
}

async function buildGoogleFontsUrl(fontEntries) {
  const byFamily = new Map();
  for (const { family, role } of fontEntries) {
    const name = String(family).trim();
    if (!name) continue;
    const valid = await isGoogleFont(name, role);
    if (!valid) continue;
    if (!byFamily.has(name)) byFamily.set(name, new Set());
    byFamily.get(name).add(role);
  }
  const params = [];
  for (const [name, roles] of byFamily) {
    const weightsSet = new Set();
    if (roles.has('body'))
      FONT_BODY_WEIGHTS.split(';').forEach((w) => weightsSet.add(w));
    if (roles.has('heading'))
      FONT_HEADING_WEIGHTS.split(';').forEach((w) => weightsSet.add(w));
    const weights = [...weightsSet].join(';');
    if (weights)
      params.push(`family=${encodeFamilyForUrl(name)}:wght@${weights}`);
  }
  if (params.length === 0) return '';
  return `${GOOGLE_FONTS_CSS_BASE}?${params.join('&')}&display=swap`;
}

function parseFontFacesFromCss(cssText, familyWant) {
  const normalize = (s) =>
    s
      .replace(/^['"]|['"]$/g, '')
      .trim()
      .toLowerCase();
  const want = normalize(familyWant);
  const fontFaces = [];
  const faceRegex = /@font-face\s*\{([^}]+)\}/g;
  let block;
  while ((block = faceRegex.exec(cssText)) !== null) {
    const decl = block[1];
    const familyMatch = decl.match(/font-family\s*:\s*(['"]?)([^;'"]+)\1/);
    if (!familyMatch) continue;
    const family = normalize(familyMatch[2].trim().split(',')[0].trim());
    if (family !== want) continue;
    const srcMatch = decl.match(/src\s*:\s*([^;]+)/);
    if (!srcMatch) continue;
    const weightMatch = decl.match(/font-weight\s*:\s*([^;]+)/);
    const styleMatch = decl.match(/font-style\s*:\s*([^;]+)/);
    fontFaces.push({
      weight: (weightMatch ? weightMatch[1].trim() : '400').replace(
        /["']/g,
        ''
      ),
      style: (styleMatch ? styleMatch[1].trim() : 'normal').replace(
        /["']/g,
        ''
      ),
      src: srcMatch[1].trim(),
    });
  }
  return fontFaces;
}

async function fetchFontFacesFromStylesheets(
  stylesheetHrefs,
  family,
  pageOrigin
) {
  const baseUrl = pageOrigin || 'https://example.com/';
  const allFaces = [];
  for (const href of stylesheetHrefs || []) {
    try {
      const url = href.startsWith('http') ? href : new URL(href, baseUrl).href;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; download-fonts/1.0)',
        },
      });
      if (!res.ok) continue;
      const css = await res.text();
      allFaces.push(...parseFontFacesFromCss(css, family));
    } catch (_) {}
  }
  return allFaces;
}

function parseFontSrc(srcStr) {
  const out = [];
  const urlRegex =
    /url\s*\(\s*(?:(['"])([\s\S]*?)\1|([^'")\s]+))\s*\)\s*(?:format\s*\(\s*['"]?(\w+)['"]?\s*\))?/g;
  let m;
  while ((m = urlRegex.exec(srcStr)) !== null) {
    const raw = (m[2] !== undefined ? m[2] : m[3] || '').trim();
    const format = (m[4] || '').toLowerCase();
    const ext =
      format === 'woff2'
        ? '.woff2'
        : format === 'woff'
          ? '.woff'
          : format === 'truetype' || format === 'ttf'
            ? '.ttf'
            : '.woff2';
    if (raw) out.push({ raw, ext });
  }
  return out;
}

async function subsetToLatinWoff2(fontBuffer) {
  try {
    const subsetFont = (await import('subset-font')).default;
    const chars = LATIN_CHARS + GERMAN_CHARS;
    return await subsetFont(fontBuffer, chars, { targetFormat: 'woff2' });
  } catch (err) {
    console.warn(`${FONT_LOG} Subsetting failed: ${err.message}`);
    return null;
  }
}

async function fontHasGermanGlyphs(fontBuffer) {
  try {
    const subsetFont = (await import('subset-font')).default;
    const [germanOnly, baseline] = await Promise.all([
      subsetFont(fontBuffer, GERMAN_CHARS, { targetFormat: 'woff2' }),
      subsetFont(fontBuffer, 'A', { targetFormat: 'woff2' }),
    ]);
    if (!germanOnly || !baseline) return false;
    return germanOnly.length > baseline.length + 300;
  } catch {
    return false;
  }
}

async function downloadFontFromPageCss(family, fontFaces, pageOrigin, _role) {
  if (!fontFaces || fontFaces.length === 0) return false;
  const baseUrl = pageOrigin || 'https://example.com/';
  const fontDir = path.join(
    projectRoot,
    'public',
    'fonts',
    family.replace(/\s+/g, '-')
  );
  if (!fs.existsSync(fontDir)) fs.mkdirSync(fontDir, { recursive: true });
  const written = [];
  let germanGlyphsDetected = null;
  for (const face of fontFaces) {
    const parts = parseFontSrc(face.src);
    for (const { raw, ext } of parts) {
      const weight =
        face.weight && /^\d+$/.test(face.weight) ? face.weight : '400';
      const style =
        face.style && face.style !== 'normal' ? face.style : 'normal';
      try {
        let originalBuf = null;
        if (raw.startsWith('data:')) {
          const base64Match = raw.match(/data:(?:font\/\w+);base64,(.+)/);
          if (base64Match) originalBuf = Buffer.from(base64Match[1], 'base64');
        } else {
          const fontUrl = raw.startsWith('http')
            ? raw
            : new URL(raw, baseUrl).href;
          const res = await fetch(fontUrl);
          if (res.ok) originalBuf = Buffer.from(await res.arrayBuffer());
        }
        if (!originalBuf) continue;

        if (germanGlyphsDetected === null) {
          germanGlyphsDetected = await fontHasGermanGlyphs(originalBuf);
          if (!germanGlyphsDetected) {
            console.warn(
              `${FONT_LOG} ⚠️  "${family}" does not contain glyphs for German special characters (äöüÄÖÜß).\n` +
                `  The unicode-range in fonts.css will be restricted to ASCII so the browser falls back\n` +
                `  to the next font in the stack for those characters.\n` +
                `  Consider using a font that supports the full Latin-1 Supplement (U+00C0-00FF).`
            );
          }
        }

        const subsetBuf = await subsetToLatinWoff2(originalBuf);
        if (subsetBuf) {
          const filename = `${weight}-${style}-latin.woff2`.replace(/\s/g, '-');
          fs.writeFileSync(path.join(fontDir, filename), subsetBuf);
          written.push({ weight, style, filename, format: 'woff2' });
          const saved = originalBuf.length - subsetBuf.length;
          if (saved > 0)
            console.log(
              `${FONT_LOG}   ${weight} ${style}: ${(originalBuf.length / 1024).toFixed(1)} KB → ${(subsetBuf.length / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB)`
            );
        } else {
          const actualExt = ext || '.woff2';
          const filename = `${weight}-${style}${actualExt}`.replace(/\s/g, '-');
          fs.writeFileSync(path.join(fontDir, filename), originalBuf);
          written.push({
            weight,
            style,
            filename,
            format: actualExt.replace('.', ''),
          });
        }
      } catch (_) {}
    }
  }
  if (written.length > 0) {
    const uniqueByKey = (arr, keyFn) => [
      ...new Map(arr.map((x) => [keyFn(x), x])).values(),
    ];
    const entries = uniqueByKey(written, (x) => x.weight + x.style);
    const unicodeRange =
      germanGlyphsDetected !== false
        ? LATIN_UNICODE_RANGE
        : ASCII_UNICODE_RANGE;

    const cssLines = [
      `/* ${family} - Latin subset, from page CSS (05-extract --download-fonts) */`,
      ...(germanGlyphsDetected === false
        ? [
            `/* ⚠️  German special characters (äöüÄÖÜß) not found in source font.` +
              ` unicode-range restricted to ASCII – browser will fall back for U+00C0-00FF. */`,
          ]
        : []),
      ...entries.map((e) => {
        const display = 'swap';
        const fmt =
          e.format === 'woff2'
            ? 'woff2'
            : e.format === 'woff'
              ? 'woff'
              : 'truetype';
        return [
          `@font-face {`,
          `  font-family: '${family}';`,
          `  font-style: ${e.style};`,
          `  font-weight: ${e.weight};`,
          `  font-display: ${display};`,
          `  src: url('./${e.filename}') format('${fmt}');`,
          `  unicode-range: ${unicodeRange};`,
          `}`,
        ].join('\n');
      }),
    ];
    fs.writeFileSync(
      path.join(fontDir, 'fonts.css'),
      cssLines.join('\n\n') + '\n',
      'utf-8'
    );
    console.log(
      `${FONT_LOG} Downloaded ${family} (Latin subset) to public/fonts/${path.basename(fontDir)}/`
    );
    return true;
  }
  return false;
}

/**
 * Scrape the page, resolve Google vs local fonts, download subsets. Does not touch theme.config.json.
 * @returns {Promise<{ fonts: { body: object|null, heading: object|null }, googleFontsUrl: string, localPaths: string[] }>}
 */
async function detectFontsFromUrl(url) {
  let data = null;
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      data = await page.evaluate(getCollectFontsScript());
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error(`${FONT_LOG}`, err.message || err);
    throw err;
  }

  const bodyFamily =
    parseFirstFontFamily(data.bodyFont) || data.bodyFont || null;
  const headingFamily =
    parseFirstFontFamily(data.headingFont) || data.headingFont || null;
  const stylesheetHrefs = data.stylesheetHrefs || [];

  const fonts = { body: null, heading: null };
  const googleEntries = [];
  const localPaths = [];

  const fallbackBody = 'Arial, Helvetica, sans-serif';
  const fallbackHeading = 'sans-serif';

  if (bodyFamily) {
    const isGoogle = await isGoogleFont(bodyFamily, 'body');
    if (isGoogle) {
      googleEntries.push({ family: bodyFamily, role: 'body' });
      fonts.body = { family: bodyFamily, fallback: fallbackBody };
    } else {
      let faces = data.bodyFontFaces || [];
      if (faces.length === 0 && stylesheetHrefs.length > 0) {
        faces = await fetchFontFacesFromStylesheets(
          stylesheetHrefs,
          bodyFamily,
          url
        );
      }
      if (faces.length > 0) {
        const ok = await downloadFontFromPageCss(
          bodyFamily,
          faces,
          url,
          'body'
        );
        if (ok)
          localPaths.push(
            `/fonts/${bodyFamily.replace(/\s+/g, '-')}/fonts.css`
          );
        fonts.body = { family: bodyFamily, fallback: fallbackBody };
      } else {
        // Non-Google + no @font-face → substitute Inter to avoid broken URL + system fallback.
        console.warn(
          `${FONT_LOG} "${bodyFamily}" is not a Google Font and no loadable @font-face found — falling back to Inter for body.`
        );
        googleEntries.push({ family: 'Inter', role: 'body' });
        fonts.body = { family: 'Inter', fallback: fallbackBody };
      }
    }
  }

  if (headingFamily && headingFamily !== bodyFamily) {
    const isGoogle = await isGoogleFont(headingFamily, 'heading');
    if (isGoogle) {
      googleEntries.push({ family: headingFamily, role: 'heading' });
      fonts.heading = { family: headingFamily, fallback: fallbackHeading };
    } else {
      let faces = data.headingFontFaces || [];
      if (faces.length === 0 && stylesheetHrefs.length > 0) {
        faces = await fetchFontFacesFromStylesheets(
          stylesheetHrefs,
          headingFamily,
          url
        );
      }
      if (faces.length > 0) {
        const ok = await downloadFontFromPageCss(
          headingFamily,
          faces,
          url,
          'heading'
        );
        if (ok)
          localPaths.push(
            `/fonts/${headingFamily.replace(/\s+/g, '-')}/fonts.css`
          );
        fonts.heading = { family: headingFamily, fallback: fallbackHeading };
      } else {
        // Same guardrail as body — substitute Inter.
        console.warn(
          `${FONT_LOG} "${headingFamily}" is not a Google Font and no loadable @font-face found — falling back to Inter for heading.`
        );
        googleEntries.push({ family: 'Inter', role: 'heading' });
        fonts.heading = { family: 'Inter', fallback: fallbackHeading };
      }
    }
  } else if (headingFamily) {
    fonts.heading = { family: headingFamily, fallback: fallbackHeading };
    if (bodyFamily !== headingFamily) {
      const isGoogle = await isGoogleFont(headingFamily, 'heading');
      if (isGoogle) {
        googleEntries.push({ family: headingFamily, role: 'heading' });
      } else {
        let faces = data.headingFontFaces || [];
        if (faces.length === 0 && stylesheetHrefs.length > 0) {
          faces = await fetchFontFacesFromStylesheets(
            stylesheetHrefs,
            headingFamily,
            url
          );
        }
        if (faces.length > 0) {
          const ok = await downloadFontFromPageCss(
            headingFamily,
            faces,
            url,
            'heading'
          );
          if (ok)
            localPaths.push(
              `/fonts/${headingFamily.replace(/\s+/g, '-')}/fonts.css`
            );
        } else {
          console.warn(
            `${FONT_LOG} No @font-face found for heading font "${headingFamily}".`
          );
        }
      }
    } else {
      googleEntries.push({ family: headingFamily, role: 'heading' });
    }
  }

  let googleFontsUrl = '';
  if (googleEntries.length > 0) {
    googleFontsUrl = await buildGoogleFontsUrl(googleEntries);
  }

  return { fonts, googleFontsUrl, localPaths };
}

/**
 * Merge detection result into theme.config.json for the given client folder.
 */
async function writeFontsTheme(clientId, detection) {
  const { fonts, googleFontsUrl, localPaths } = detection;
  const LATIN_FALLBACK = 'Arial, Helvetica, sans-serif';

  let theme = loadThemeConfigForFonts(clientId);
  if (!theme) {
    console.error(
      `${FONT_LOG} Theme config not found at ${getThemeConfigPathForFonts(clientId)}`
    );
    throw new Error('theme.config.json missing');
  }
  if (fonts.body) {
    theme.fonts = theme.fonts || {};
    theme.fonts.body = {
      ...theme.fonts.body,
      ...fonts.body,
      fallback: LATIN_FALLBACK,
    };
  }
  if (fonts.heading) {
    theme.fonts = theme.fonts || {};
    theme.fonts.heading = {
      ...theme.fonts.heading,
      ...fonts.heading,
      fallback: LATIN_FALLBACK,
    };
  }
  // Normalise to fontStylesheetUrls schema (drop legacy googleFontsUrl).
  const urls = [googleFontsUrl, ...localPaths].filter(Boolean);
  if (urls.length > 0) {
    theme.fontStylesheetUrls = urls;
  } else {
    delete theme.fontStylesheetUrls;
  }
  delete theme.googleFontsUrl;
  writeThemeConfigForFonts(clientId, theme);
  console.log(
    `${FONT_LOG} Updated fonts in src/data/${clientId}/theme.config.json`
  );
}

/**
 * Detect fonts from URL and write theme.config.json (full pipeline).
 */
async function runDownloadFontsPipeline(url, clientId) {
  const detection = await detectFontsFromUrl(url);
  await writeFontsTheme(clientId, detection);
}

function printFontsDetectionJson(detection) {
  const fontStylesheetUrls = [];
  if (detection.googleFontsUrl)
    fontStylesheetUrls.push(detection.googleFontsUrl);
  fontStylesheetUrls.push(...detection.localPaths);
  const out = {
    fonts:
      detection.fonts.body || detection.fonts.heading
        ? detection.fonts
        : undefined,
  };
  if (fontStylesheetUrls.length > 0)
    out.fontStylesheetUrls = fontStylesheetUrls;
  else if (detection.googleFontsUrl)
    out.googleFontsUrl = detection.googleFontsUrl;
  console.log(JSON.stringify(out, null, 2));
}

async function downloadFontsMain() {
  console.log('\n🔤 05-extract-client-data — download client fonts\n');

  const cliClient = parseArgvFlag('--client=');
  const cliSite = parseArgvFlag('--site=');
  const cliDomain = parseArgvFlag('--domain=');
  const cliFontsUrl = parseArgvFlag('--fonts-url=') || parseArgvFlag('--url=');
  const fontsJsonOnly = process.argv.includes('--fonts-json');

  const enquirer = await getEnquirer();

  if (fontsJsonOnly && cliFontsUrl) {
    const fontsUrl = toFontsUrl(cliFontsUrl);
    console.log(
      `ℹ️  --fonts-json + explicit URL (no theme write)\n   ${fontsUrl}\n`
    );
    try {
      const detection = await detectFontsFromUrl(fontsUrl);
      printFontsDetectionJson(detection);
    } catch (err) {
      console.error(`❌ ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  const clientList = discoverClients();
  let clientName = cliClient;
  if (!clientName) {
    clientName = await promptClient(enquirer, clientList);
  } else if (!clientList.includes(clientName)) {
    console.error(
      `❌ Unknown client "${clientName}". Expected one of: ${clientList.join(', ')}`
    );
    process.exit(1);
  }

  const websitesJsonRelPath = `src/data/${clientName}/websites.json`;
  const websitesJsonPath = path.resolve(projectRoot, websitesJsonRelPath);

  if (!fs.existsSync(websitesJsonPath)) {
    console.error(`❌ websites.json not found at: ${websitesJsonPath}`);
    process.exit(1);
  }

  const websitesData = JSON.parse(fs.readFileSync(websitesJsonPath, 'utf8'));
  const websites = websitesData.websites ?? [];

  let fontsUrl;
  if (cliFontsUrl) {
    fontsUrl = toFontsUrl(cliFontsUrl);
    console.log(`ℹ️  Using --fonts-url: ${fontsUrl}`);
  } else {
    let domainSource = null;
    if (cliDomain) {
      domainSource = cliDomain.replace(/^https?:\/\//i, '').split('/')[0];
      console.log(`ℹ️  Using domain: ${domainSource}`);
    } else {
      let website = null;
      if (cliSite) {
        website = websites.find((w) => w.id === cliSite);
        if (!website) {
          console.error(
            `❌ No website with id "${cliSite}" in ${websitesJsonRelPath}`
          );
          process.exit(1);
        }
        console.log(`ℹ️  Using website: ${cliSite}`);
      } else if (websites.length === 1) {
        website = websites[0];
        console.log(`ℹ️  Using website: ${website.id}`);
      } else if (websites.length > 1) {
        website = await promptWebsite(enquirer, websitesData);
      }
      domainSource = resolveDomainForFonts(websitesData, website);
    }
    if (!domainSource) {
      console.error(
        `❌ No clientDomain found in ${websitesJsonRelPath} — set clientDomain (top-level or per-site), pass --domain=, or use --fonts-url=`
      );
      process.exit(1);
    }
    fontsUrl = toFontsUrl(domainSource);
  }

  if (fontsJsonOnly) {
    console.log(
      `\n📥 --fonts-json (no theme write) for client "${clientName}": ${fontsUrl}\n`
    );
    try {
      const detection = await detectFontsFromUrl(fontsUrl);
      printFontsDetectionJson(detection);
    } catch (err) {
      console.error(`❌ ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  console.log(
    `\n📥 Downloading fonts from ${fontsUrl} for client "${clientName}"...\n`
  );

  try {
    await runDownloadFontsPipeline(fontsUrl, clientName);
  } catch (err) {
    console.error(`❌ ${err.message || err}`);
    process.exit(1);
  }

  console.log('\n✅ Fonts downloaded successfully.\n');
}

// ===========================================================================
// Extract brand colors
//
// For each of the 4 theme slots (primary / primary-foreground / secondary /
// accent) the cascade resolves in this order:
//   1. Data sheet — values the BA provided in the Excel data sheet (wins
//      unless --force is set; skip the whole flow if all 4 are present)
//   2. DOM — Puppeteer scan of hero CTAs + site-wide button population
//   3. Vision-AI — Gemini via OpenRouter, gated to weak DOM picks
//   4. Derive — WCAG-safe foreground / light-tint secondary / triadic accent
// ===========================================================================

const COLOR_LOG = '  [colors]';

// Puppeteer timing — tuned for heavy theme builders (Fusion/Avada, Elementor,
// WPBakery) that re-apply classes and lazy-mount sections after networkidle.
const PUPPETEER_POST_LOAD_SETTLE_MS = 1500;
const PUPPETEER_SCROLL_STEP_MS = 150;
const PUPPETEER_SCROLL_END_MS = 300;
const PUPPETEER_HOVER_SETTLE_MS = 200;
const PUPPETEER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Site-wide button scan: hue-bucket + scoring weights.
const HUE_BUCKET_DEGREES = 20;
const ABOVE_FOLD_Y_THRESHOLD_PX = 1500;
const SCORE_WEIGHT_ABOVE_FOLD = 3;
const SCORE_WEIGHT_ACTION_WORD = 2;

// Vision sanity bounds for plausible brand primary — rejects pastels and
// near-neutrals often returned from hero-image bleed.
const VISION_PRIMARY_MIN_S = 20;
const VISION_PRIMARY_MIN_L = 15;
const VISION_PRIMARY_MAX_L = 62;

// WCAG AA minimum contrast ratio for text on colored background.
const WCAG_AA_MIN_CONTRAST = 4.5;

// German + English CTA action-words used to boost button-color scores.
const ACTION_WORD_RE =
  /\b(buchen|reservieren|anfragen|kontakt|jetzt|bewerben|book|reserve|contact|get\s+started|sign\s+up|schedule)\b/i;

/** Align with scripts/04-process-excel-data.mjs — theme uses H S L tokens only. */
function normalizeThemeColorValue(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';
  const unwrapped = raw.replace(/^hsla?\((.*)\)$/i, '$1').trim();
  const noCommas = unwrapped.replace(/,/g, ' ');
  const noAlpha = noCommas.replace(/\s*\/\s*[\d.]+%?$/, '').trim();
  const parts = noAlpha.split(/\s+/).filter(Boolean);
  return parts.slice(0, 3).join(' ');
}

function rgbToHslComponents(r, g, b) {
  const rn = Math.max(0, Math.min(255, r)) / 255;
  const gn = Math.max(0, Math.min(255, g)) / 255;
  const bn = Math.max(0, Math.min(255, b)) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        break;
      case gn:
        h = ((bn - rn) / d + 2) / 6;
        break;
      default:
        h = ((rn - gn) / d + 4) / 6;
    }
  }
  return {
    h: h * 360,
    s: s * 100,
    l: l * 100,
  };
}

function formatHslComponents(h, s, l) {
  const hh = Number.isFinite(h) ? Math.round(h * 10) / 10 : 0;
  const ss = Number.isFinite(s) ? Math.round(s * 10) / 10 : 0;
  const ll = Number.isFinite(l) ? Math.round(l * 10) / 10 : 0;
  return `${hh} ${ss}% ${ll}%`;
}

/**
 * Convert browser getComputedStyle color strings to theme HSL component string.
 * @param {string} cssColor
 * @returns {string|null}
 */
function cssColorToThemeHsl(cssColor) {
  const s = String(cssColor ?? '').trim();
  if (!s || s === 'transparent') return null;

  const rgbM = s.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i
  );
  if (rgbM) {
    const a = rgbM[4] != null ? parseFloat(rgbM[4]) : 1;
    if (a < 0.08) return null;
    const {
      h,
      s: sat,
      l,
    } = rgbToHslComponents(
      parseFloat(rgbM[1]),
      parseFloat(rgbM[2]),
      parseFloat(rgbM[3])
    );
    return formatHslComponents(h, sat, l);
  }

  if (/^hsla?\(/i.test(s)) {
    const norm = normalizeThemeColorValue(s);
    return norm || null;
  }

  let hex = s.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const { h, s: sat, l } = rgbToHslComponents(r, g, b);
    return formatHslComponents(h, sat, l);
  }

  return null;
}

function parseHslParts(themeHsl) {
  const parts = String(themeHsl ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1].replace('%', ''));
  const l = parseFloat(parts[2].replace('%', ''));
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l))
    return null;
  return { h, s, l };
}

function hslHueDistance(a, b) {
  if (!a || !b) return 999;
  const d = Math.abs(a.h - b.h);
  return Math.min(d, 360 - d);
}

function isDistinctHsl(a, b, minHue = 12, minSat = 6, minLight = 5) {
  if (!a || !b) return true;
  if (hslHueDistance(a, b) >= minHue) return true;
  if (Math.abs(a.s - b.s) >= minSat) return true;
  if (Math.abs(a.l - b.l) >= minLight) return true;
  return false;
}

function isNeutralOrWeak(themeHsl) {
  const p = parseHslParts(themeHsl);
  if (!p) return true;
  if (p.s < 6 && p.l > 15 && p.l < 88) return true;
  if (p.l >= 94 || p.l <= 7) return true;
  return false;
}

/**
 * Site-wide primary picker — used when the hero scanner returns weak signals.
 * Scans every visible button background, buckets by hue, and scores buckets
 * by frequency + above-fold presence + action-word text.
 * Returns {hsl, source, foregroundCss} for the top-scoring bucket, or null.
 */
function pickPrimaryFromButtonPopulation(siteWideButtonSamples) {
  if (
    !Array.isArray(siteWideButtonSamples) ||
    siteWideButtonSamples.length === 0
  ) {
    return null;
  }

  const enriched = [];
  for (const s of siteWideButtonSamples) {
    const hsl = cssColorToThemeHsl(s.backgroundColor);
    if (!hsl || isNeutralOrWeak(hsl)) continue;
    const parts = parseHslParts(hsl);
    if (!parts) continue;
    enriched.push({
      hsl,
      parts,
      text: s.text || '',
      color: s.color,
      topY: Number.isFinite(s.topY) ? s.topY : Infinity,
    });
  }
  if (enriched.length === 0) return null;

  const buckets = new Map();
  for (const e of enriched) {
    const bucketKey =
      Math.round(e.parts.h / HUE_BUCKET_DEGREES) * HUE_BUCKET_DEGREES;
    const existing = buckets.get(bucketKey);
    if (existing) existing.items.push(e);
    else buckets.set(bucketKey, { key: bucketKey, items: [e] });
  }

  let best = null;
  for (const b of buckets.values()) {
    const count = b.items.length;
    const aboveFold = b.items.some(
      (i) => i.topY < ABOVE_FOLD_Y_THRESHOLD_PX
    );
    const hasActionWord = b.items.some((i) => ACTION_WORD_RE.test(i.text));
    const score =
      count +
      (aboveFold ? SCORE_WEIGHT_ABOVE_FOLD : 0) +
      (hasActionWord ? SCORE_WEIGHT_ACTION_WORD : 0);
    // Representative HSL = bucket item closest to the bucket's mean hue.
    const meanH =
      b.items.reduce((sum, i) => sum + i.parts.h, 0) / b.items.length;
    const rep = b.items
      .slice()
      .sort(
        (a, z) =>
          Math.abs(a.parts.h - meanH) - Math.abs(z.parts.h - meanH)
      )[0];
    const tags = [
      `${count}×`,
      hasActionWord ? '+action' : null,
      aboveFold ? '+aboveFold' : null,
    ]
      .filter(Boolean)
      .join(' ');
    const record = {
      hsl: rep.hsl,
      foregroundCss: rep.color,
      source: `siteWideButtons.bucket[${b.key}°] (${tags})`,
      score,
    };
    if (!best || score > best.score) best = record;
  }
  return best;
}

function pickPrimaryFromStyleSamples(samples, sourcePrefix = 'hero') {
  for (const row of samples) {
    const bg = cssColorToThemeHsl(row.backgroundColor);
    if (bg && !isNeutralOrWeak(bg))
      return {
        hsl: bg,
        source: `${sourcePrefix}.background`,
        foregroundCss: row.color || null,
      };
    const col = cssColorToThemeHsl(row.color);
    if (col && !isNeutralOrWeak(col))
      return {
        hsl: col,
        source: `${sourcePrefix}.color`,
        foregroundCss: row.backgroundColor || null,
      };
    const b = cssColorToThemeHsl(row.borderColor);
    if (b && !isNeutralOrWeak(b))
      return {
        hsl: b,
        source: `${sourcePrefix}.border`,
        foregroundCss: row.color || null,
      };
  }
  return null;
}

function buildLightSecondaryFromPrimary(primaryHsl) {
  const p = parseHslParts(primaryHsl);
  if (!p) return null;
  const s = Math.min(18, Math.max(8, p.s * 0.12 + 6));
  const l = 92;
  return formatHslComponents(p.h, s, l);
}

/**
 * Triadic accent: rotate primary hue by 150° keeping saturation and lightness.
 * Last-resort fallback when no accent candidate is extracted.
 */
function buildTriadicAccentFromPrimary(primaryHsl) {
  const p = parseHslParts(primaryHsl);
  if (!p) return null;
  const h = (p.h + 150) % 360;
  return formatHslComponents(h, p.s, p.l);
}

/**
 * Convert HSL component form ("H S% L%") to sRGB {r, g, b} in [0, 255].
 */
function hslToRgbComponents(themeHsl) {
  const p = parseHslParts(themeHsl);
  if (!p) return null;
  const h = ((p.h % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, p.s / 100));
  const l = Math.max(0, Math.min(1, p.l / 100));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0,
    g1 = 0,
    b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/**
 * WCAG 2.1 relative luminance for an sRGB color in [0, 255].
 */
function relativeLuminance(r, g, b) {
  const toLin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
  );
}

/**
 * WCAG contrast ratio between two HSL component-form colors. Returns 1..21.
 */
function hslContrastRatio(aHsl, bHsl) {
  const a = hslToRgbComponents(aHsl);
  const b = hslToRgbComponents(bHsl);
  if (!a || !b) return 0;
  const la = relativeLuminance(a.r, a.g, a.b);
  const lb = relativeLuminance(b.r, b.g, b.b);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Return a WCAG-safe `primary-foreground` HSL. Prefers the sampled button
 * text color when it meets AA contrast against primary; otherwise falls back
 * to pure white or dark based on primary lightness. Mirrors
 * `ensureAccentForeground` in scripts/dev/sync-theme-to-globals.mjs.
 */
function pickPrimaryForegroundHsl(primaryHsl, foregroundCss) {
  const SAFE_WHITE = '0 0% 100%';
  const SAFE_DARK = '0 0% 7%';
  const pParts = parseHslParts(primaryHsl);
  const fallback =
    pParts && pParts.l < 50 ? SAFE_WHITE : pParts ? SAFE_DARK : SAFE_WHITE;
  const fgHsl = cssColorToThemeHsl(foregroundCss);
  if (!fgHsl) return { hsl: fallback, source: 'derived.wcagSafe' };
  const ratio = hslContrastRatio(primaryHsl, fgHsl);
  if (ratio >= WCAG_AA_MIN_CONTRAST) {
    return { hsl: fgHsl, source: 'heroButton.textColor' };
  }
  return { hsl: fallback, source: 'derived.wcagSafe' };
}

/**
 * Deterministic accent picker. Walks ordered candidate sources (secondary CTAs,
 * nav hover, hero links, accent/highlight/badge classes, nav base) and returns
 * the first HSL that is non-neutral AND distinct from both primary and
 * secondary. Returns null if nothing qualifies — caller then tries AI
 * tie-break or derives via hue rotation.
 */
function pickAccentFromSnapshot({
  snapshot,
  primaryHsl,
  secondaryHsl,
  navHoverHsl,
}) {
  const pParts = parseHslParts(primaryHsl);
  const sParts = parseHslParts(secondaryHsl);

  const qualifies = (hsl) => {
    if (!hsl || isNeutralOrWeak(hsl)) return false;
    const parts = parseHslParts(hsl);
    if (!parts) return false;
    if (pParts && !isDistinctHsl(pParts, parts)) return false;
    if (sParts && !isDistinctHsl(sParts, parts)) return false;
    return true;
  };

  const tryCss = (css, source) => {
    const hsl = cssColorToThemeHsl(css);
    return qualifies(hsl) ? { hsl, source } : null;
  };

  const buttons = snapshot.buttonSamples || [];

  // Step 1: secondary-CTA backgroundColor (skip index 0 = primary)
  for (let i = 1; i < Math.min(6, buttons.length); i++) {
    const r = tryCss(
      buttons[i].backgroundColor,
      `heroButton[${i}].background`
    );
    if (r) return r;
  }
  // Step 2: ghost/outline CTA borderColor, then color
  for (let i = 1; i < Math.min(6, buttons.length); i++) {
    const r = tryCss(buttons[i].borderColor, `heroButton[${i}].border`);
    if (r) return r;
  }
  for (let i = 1; i < Math.min(6, buttons.length); i++) {
    const r = tryCss(buttons[i].color, `heroButton[${i}].color`);
    if (r) return r;
  }
  // Step 3: nav link hover (Puppeteer-captured, already HSL)
  if (navHoverHsl && qualifies(navHoverHsl)) {
    return { hsl: navHoverHsl, source: 'navLink[0].hoverColor' };
  }
  // Step 4: hero <a> link colors
  const extras = snapshot.extraSamples || [];
  for (let i = 0; i < extras.length; i++) {
    const r = tryCss(extras[i].color, `extraSamples[${i}].color`);
    if (r) return r;
  }
  // Step 5: accent/highlight/badge class samples
  const accentClass = snapshot.accentClassSamples || [];
  for (let i = 0; i < accentClass.length; i++) {
    const r1 = tryCss(
      accentClass[i].backgroundColor,
      `accentClassSample[${i}].background`
    );
    if (r1) return r1;
    const r2 = tryCss(
      accentClass[i].color,
      `accentClassSample[${i}].color`
    );
    if (r2) return r2;
  }
  // Step 6: nav link base color
  const nav = snapshot.navSamples || [];
  for (let i = 0; i < nav.length; i++) {
    const r = tryCss(nav[i].color, `navLink[${i}].color`);
    if (r) return r;
  }

  return null;
}

/**
 * Flatten every candidate accent source into a {hsl, source}[] for AI
 * tie-break. Includes only well-formed HSL values but applies NO qualification
 * — AI gets the raw candidate list + primary + secondary and decides.
 */
function buildAccentCandidates({ snapshot, navHoverHsl }) {
  const out = [];
  const pushCss = (css, source) => {
    const hsl = cssColorToThemeHsl(css);
    if (hsl) out.push({ hsl, source });
  };
  const buttons = snapshot.buttonSamples || [];
  for (let i = 1; i < Math.min(6, buttons.length); i++) {
    pushCss(buttons[i].backgroundColor, `heroButton[${i}].background`);
    pushCss(buttons[i].borderColor, `heroButton[${i}].border`);
    pushCss(buttons[i].color, `heroButton[${i}].color`);
  }
  if (navHoverHsl) out.push({ hsl: navHoverHsl, source: 'navLink[0].hoverColor' });
  for (const ex of snapshot.extraSamples || []) pushCss(ex.color, 'extraSamples.color');
  for (const ac of snapshot.accentClassSamples || []) {
    pushCss(ac.backgroundColor, 'accentClassSample.background');
    pushCss(ac.color, 'accentClassSample.color');
  }
  for (const nv of snapshot.navSamples || []) pushCss(nv.color, 'navLink.color');
  return out;
}

function getCollectHeroColorsScript() {
  return function collectHeroColors() {
    function visible(el) {
      if (!el || el.nodeType !== 1) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        parseFloat(cs.opacity) === 0
      )
        return false;
      return (
        r.width >= 28 &&
        r.height >= 14 &&
        r.bottom > 0 &&
        r.top < window.innerHeight
      );
    }

    function scoreHero(el) {
      if (!el) return -1;
      const r = el.getBoundingClientRect();
      const area =
        Math.min(r.width, window.innerWidth) *
        Math.min(r.height, window.innerHeight * 0.75);
      const topScore = Math.max(
        0,
        window.innerHeight * 0.55 - Math.max(0, r.top)
      );
      return area * 0.4 + topScore * 200;
    }

    const heroSelectors = [
      '[class*="hero" i]',
      '[id*="hero" i]',
      'section[class*="banner" i]',
      'header',
      'main section',
      'section',
    ];
    let hero = null;
    let best = -1;
    for (const sel of heroSelectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const sc = scoreHero(el);
          if (sc > best) {
            best = sc;
            hero = el;
          }
        }
      } catch (_) {}
    }
    if (!hero) hero = document.body;

    const clickable = [];
    try {
      for (const el of hero.querySelectorAll(
        'a, button, [role="button"], input[type="submit"], input[type="button"]'
      )) {
        if (visible(el)) clickable.push(el);
      }
    } catch (_) {}

    const buttonSamples = clickable.slice(0, 10).map((el) => {
      const cs = getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        borderColor: cs.borderColor,
      };
    });

    const extraSamples = [];
    for (const tag of ['h1', 'h2', 'h3']) {
      const el = hero.querySelector(tag);
      if (el && visible(el)) {
        const cs = getComputedStyle(el);
        extraSamples.push({
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
        });
      }
    }
    try {
      let n = 0;
      for (const el of hero.querySelectorAll('a')) {
        if (n >= 8) break;
        if (!visible(el)) continue;
        const cs = getComputedStyle(el);
        extraSamples.push({
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
        });
        n++;
      }
    } catch (_) {}
    try {
      const hcs = getComputedStyle(hero);
      extraSamples.push({
        backgroundColor: hcs.backgroundColor,
        color: hcs.color,
        borderColor: hcs.borderColor,
      });
    } catch (_) {}

    let sublineColor = null;
    const h1 = hero.querySelector('h1') || document.querySelector('h1');
    if (h1) {
      const next = h1.nextElementSibling;
      if (next && (next.tagName === 'P' || next.tagName === 'DIV')) {
        if (visible(next)) sublineColor = getComputedStyle(next).color;
      }
      const lead = hero.querySelector(
        'p.lead, p[class*="subtitle" i], p[class*="Subline" i], [class*="subtitle" i]'
      );
      if (lead && visible(lead)) sublineColor = getComputedStyle(lead).color;
    }

    // Nav links: capture base color + mark the first for Puppeteer :hover sampling.
    const navSamples = [];
    let firstNavLink = null;
    try {
      const navRoots = document.querySelectorAll(
        'nav, header, [class*="nav" i]'
      );
      const seen = new Set();
      for (const root of navRoots) {
        for (const el of root.querySelectorAll('a')) {
          if (seen.has(el)) continue;
          if (!visible(el)) continue;
          seen.add(el);
          const cs = getComputedStyle(el);
          navSamples.push({
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            borderColor: cs.borderColor,
          });
          if (!firstNavLink) firstNavLink = el;
          if (navSamples.length >= 8) break;
        }
        if (navSamples.length >= 8) break;
      }
    } catch (_) {}
    if (firstNavLink) firstNavLink.setAttribute('data-extract-nav-link', '1');

    // Elements whose class hints at an accent role.
    const accentClassSamples = [];
    try {
      for (const el of document.querySelectorAll(
        '[class*="accent" i], [class*="highlight" i], [class*="badge" i]'
      )) {
        if (!visible(el)) continue;
        const cs = getComputedStyle(el);
        accentClassSamples.push({
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          borderColor: cs.borderColor,
        });
        if (accentClassSamples.length >= 10) break;
      }
    } catch (_) {}

    // Site-wide button population (not clipped to viewport) — used when the
    // hero scanner returns weak signals. Below-the-fold CTAs often hold the
    // real brand color on text-heavy hero designs.
    const rendered = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const cs = getComputedStyle(el);
      if (
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        parseFloat(cs.opacity) === 0
      )
        return false;
      const r = el.getBoundingClientRect();
      return r.width >= 28 && r.height >= 14;
    };
    const siteWideButtonSamples = [];
    try {
      const seen = new WeakSet();
      const selectors = [
        'button',
        'a.btn',
        'a[class*="button" i]',
        '[class*="btn-" i]',
        '[role="button"]',
        '.elementor-button',
        '.fusion-button',
        '[class*="wp-block-button" i]',
      ];
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (!rendered(el)) continue;
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            siteWideButtonSamples.push({
              text: (el.textContent || '').trim().slice(0, 60),
              backgroundColor: cs.backgroundColor,
              color: cs.color,
              borderColor: cs.borderColor,
              topY: Math.round(rect.top + window.scrollY),
            });
            if (siteWideButtonSamples.length >= 40) break;
          }
        } catch (_) {}
        if (siteWideButtonSamples.length >= 40) break;
      }
    } catch (_) {}

    const first = clickable[0];
    if (first) first.setAttribute('data-extract-hero-btn', '1');

    return {
      heroTag: hero.tagName,
      buttonCount: clickable.length,
      buttonSamples,
      extraSamples,
      sublineColor,
      hasFirstButton: !!first,
      navSamples,
      accentClassSamples,
      hasFirstNavLink: !!firstNavLink,
      siteWideButtonSamples,
    };
  };
}

/**
 * @returns {Promise<object>}
 */
async function detectBrandColorsFromUrl(pageUrl) {
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    // Realistic User-Agent — some WP themes (notably Fusion/Avada) detect
    // headless Chrome and serve a reduced version that omits theme scripts.
    await page.setUserAgent(PUPPETEER_UA);
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 25000 });

    // Let theme-builder JS finalize button classes after networkidle.
    await new Promise((r) => setTimeout(r, PUPPETEER_POST_LOAD_SETTLE_MS));

    // Scroll through the page to force lazy-mounted sections to render.
    try {
      await page.evaluate(
        async (stepMs, endMs) => {
          const delay = (ms) => new Promise((r) => setTimeout(r, ms));
          const h = document.body.scrollHeight;
          const step = window.innerHeight * 0.8;
          for (let y = 0; y < h; y += step) {
            window.scrollTo(0, y);
            await delay(stepMs);
          }
          window.scrollTo(0, 0);
          await delay(endMs);
        },
        PUPPETEER_SCROLL_STEP_MS,
        PUPPETEER_SCROLL_END_MS
      );
    } catch (_) {}

    const snapshot = await page.evaluate(getCollectHeroColorsScript());

    let hoverBackground = null;
    if (snapshot.hasFirstButton) {
      try {
        const handle = await page.$('[data-extract-hero-btn="1"]');
        if (handle) {
          await handle.hover();
          await new Promise((r) => setTimeout(r, PUPPETEER_HOVER_SETTLE_MS));
          hoverBackground = await page.evaluate(() => {
            const el = document.querySelector('[data-extract-hero-btn="1"]');
            return el ? getComputedStyle(el).backgroundColor : null;
          });
        }
      } catch (_) {}
    }

    // Hover first nav link (step 3 of accent cascade) to capture hover-color.
    let navHoverColor = null;
    if (snapshot.hasFirstNavLink) {
      try {
        const navHandle = await page.$('[data-extract-nav-link="1"]');
        if (navHandle) {
          await navHandle.hover();
          await new Promise((r) => setTimeout(r, PUPPETEER_HOVER_SETTLE_MS));
          navHoverColor = await page.evaluate(() => {
            const el = document.querySelector('[data-extract-nav-link="1"]');
            return el ? getComputedStyle(el).color : null;
          });
        }
      } catch (_) {}
    }

    await page.evaluate(() => {
      const btn = document.querySelector('[data-extract-hero-btn="1"]');
      if (btn) btn.removeAttribute('data-extract-hero-btn');
      const link = document.querySelector('[data-extract-nav-link="1"]');
      if (link) link.removeAttribute('data-extract-nav-link');
    });

    // Viewport screenshot for the Vision tier. Buffer.from(...) is required
    // because newer puppeteer returns a Uint8Array whose .toString('base64')
    // silently produces a comma-separated byte string, not valid base64.
    let screenshotBase64 = null;
    try {
      const raw = await page.screenshot({ type: 'png', fullPage: false });
      screenshotBase64 = Buffer.from(raw).toString('base64');
    } catch (err) {
      console.warn(`${COLOR_LOG} Screenshot capture failed: ${err.message}`);
    }

    // PRIMARY — hero CTA → site-wide buttons → hero heading → subline fallback.
    let primaryPick = pickPrimaryFromStyleSamples(
      snapshot.buttonSamples,
      'heroButton'
    );
    if (!primaryPick) {
      primaryPick = pickPrimaryFromButtonPopulation(
        snapshot.siteWideButtonSamples || []
      );
    }
    if (!primaryPick) {
      primaryPick = pickPrimaryFromStyleSamples(
        snapshot.extraSamples || [],
        'hero'
      );
    }
    if (!primaryPick) {
      const fallback = cssColorToThemeHsl(snapshot.sublineColor);
      if (fallback && !isNeutralOrWeak(fallback)) {
        primaryPick = {
          hsl: fallback,
          source: 'subline.fallback',
          foregroundCss: null,
        };
      }
    }

    // If DOM primary extraction fails, DO NOT throw — return a detection with
    // primary: null so the caller can fall through to Vision / data-sheet tiers.
    // The final cascade in resolveColorsCascade throws only if every tier fails
    // to deliver a usable primary.
    if (!primaryPick) {
      console.warn(
        `${COLOR_LOG} DOM: no brand primary detected. Will try Vision / data-sheet tiers.`
      );
      return {
        pageUrl,
        primary: null,
        primarySource: 'dom:failed',
        primaryForeground: null,
        primaryForegroundSource: 'dom:failed',
        secondary: null,
        secondarySource: 'dom:failed',
        accent: null,
        accentSource: 'dom:failed',
        hoverBackgroundRaw: hoverBackground,
        sublineColorRaw: snapshot.sublineColor,
        navHoverColorRaw: navHoverColor,
        screenshotBase64,
        snapshot: {
          heroTag: snapshot.heroTag,
          buttonCount: snapshot.buttonCount,
          navLinkCount: (snapshot.navSamples || []).length,
          accentClassCount: (snapshot.accentClassSamples || []).length,
        },
      };
    }

    const primaryHsl = primaryPick.hsl;
    const primaryParts = parseHslParts(primaryHsl);
    const hoverHsl = cssColorToThemeHsl(hoverBackground);
    const sublineHsl = cssColorToThemeHsl(snapshot.sublineColor);
    const navHoverHsl = cssColorToThemeHsl(navHoverColor);

    // ── PRIMARY-FOREGROUND ────────────────────────────────────────────────
    const primaryForegroundPick = pickPrimaryForegroundHsl(
      primaryHsl,
      primaryPick.foregroundCss
    );

    // ── SECONDARY (existing logic, preserved) ──────────────────────────────
    const secondaryCandidates = [];
    if (hoverHsl)
      secondaryCandidates.push({
        hsl: hoverHsl,
        source: 'heroButton.hoverBackground',
      });
    if (sublineHsl)
      secondaryCandidates.push({ hsl: sublineHsl, source: 'hero.sublineText' });
    for (const row of snapshot.buttonSamples.slice(1, 6)) {
      const bg = cssColorToThemeHsl(row.backgroundColor);
      if (bg)
        secondaryCandidates.push({
          hsl: bg,
          source: 'heroButton.background.alt',
        });
    }

    let secondaryHsl = null;
    let secondarySource = null;

    if (
      hoverHsl &&
      !isNeutralOrWeak(hoverHsl) &&
      isDistinctHsl(primaryParts, parseHslParts(hoverHsl))
    ) {
      secondaryHsl = hoverHsl;
      secondarySource = 'heroButton.hoverBackground';
    } else if (
      sublineHsl &&
      !isNeutralOrWeak(sublineHsl) &&
      isDistinctHsl(primaryParts, parseHslParts(sublineHsl))
    ) {
      secondaryHsl = sublineHsl;
      secondarySource = 'hero.sublineText';
    } else {
      for (const c of secondaryCandidates) {
        if (!c.hsl || isNeutralOrWeak(c.hsl)) continue;
        const pp = parseHslParts(c.hsl);
        if (pp && isDistinctHsl(primaryParts, pp)) {
          secondaryHsl = c.hsl;
          secondarySource = c.source;
          break;
        }
      }
    }

    if (!secondaryHsl) {
      secondaryHsl = buildLightSecondaryFromPrimary(primaryHsl);
      secondarySource = 'derived.lightTintFromPrimary';
    }

    if (secondaryHsl && isNeutralOrWeak(secondaryHsl)) {
      secondaryHsl = buildLightSecondaryFromPrimary(primaryHsl);
      secondarySource = 'derived.lightTintFromPrimary';
    }

    const secondaryAmbiguous =
      secondaryHsl &&
      primaryParts &&
      parseHslParts(secondaryHsl) &&
      !isDistinctHsl(primaryParts, parseHslParts(secondaryHsl));

    if (secondaryAmbiguous && OPENROUTER_API_KEY) {
      const aiSecondary = await pickColorWithAi({
        role: 'secondary',
        pageUrl,
        primaryHsl,
        candidates: secondaryCandidates.filter((c) => c.hsl),
      });
      if (aiSecondary) {
        secondaryHsl = aiSecondary.hsl;
        secondarySource = `openRouter:${aiSecondary.reason || 'tieBreak'}`;
      }
    }

    // ── ACCENT ─────────────────────────────────────────────────────────────
    let accentPick = pickAccentFromSnapshot({
      snapshot,
      primaryHsl,
      secondaryHsl,
      navHoverHsl,
    });

    if (!accentPick && OPENROUTER_API_KEY) {
      const accentCandidates = buildAccentCandidates({
        snapshot,
        navHoverHsl,
      });
      if (accentCandidates.length > 0) {
        const aiAccent = await pickColorWithAi({
          role: 'accent',
          pageUrl,
          primaryHsl,
          secondaryHsl,
          candidates: accentCandidates,
        });
        if (aiAccent) {
          accentPick = {
            hsl: aiAccent.hsl,
            source: `openRouter:${aiAccent.reason || 'accentTieBreak'}`,
          };
        }
      }
    }

    if (!accentPick) {
      const derived = buildTriadicAccentFromPrimary(primaryHsl);
      if (derived) {
        accentPick = { hsl: derived, source: 'derived.triadicFromPrimary' };
      }
    }

    return {
      pageUrl,
      primary: primaryHsl,
      primarySource: primaryPick.source,
      primaryForeground: primaryForegroundPick.hsl,
      primaryForegroundSource: primaryForegroundPick.source,
      secondary: secondaryHsl,
      secondarySource,
      accent: accentPick ? accentPick.hsl : null,
      accentSource: accentPick ? accentPick.source : null,
      hoverBackgroundRaw: hoverBackground,
      sublineColorRaw: snapshot.sublineColor,
      navHoverColorRaw: navHoverColor,
      screenshotBase64,
      snapshot: {
        heroTag: snapshot.heroTag,
        buttonCount: snapshot.buttonCount,
        navLinkCount: (snapshot.navSamples || []).length,
        accentClassCount: (snapshot.accentClassSamples || []).length,
        siteWideButtonCount: (snapshot.siteWideButtonSamples || []).length,
      },
    };
  } finally {
    await browser.close();
  }
}

/** OpenRouter tie-breaker when the deterministic picker is ambiguous. */
async function pickColorWithAi({
  role,
  pageUrl,
  primaryHsl,
  secondaryHsl,
  candidates,
}) {
  if (!OPENROUTER_API_KEY) return null;
  try {
    const client = getOpenRouter();
    const model =
      process.env.OPENROUTER_MODEL_COLOR_EXTRACT ||
      OPENROUTER_CLIENT_PROMPT_MODEL;
    const payload = JSON.stringify(
      { pageUrl, primaryHsl, secondaryHsl, candidates },
      null,
      2
    );
    const roleLabel = role === 'accent' ? 'Akzentfarbe' : 'sekundäre Markenfarbe';
    const systemPrompt =
      role === 'accent'
        ? `Du wählst eine Akzentfarbe für eine Website. Die Akzentfarbe muss deutlich von der Primär- und Sekundärfarbe unterscheidbar sein und wird für hervorgehobene Elemente (z.B. Badges, Highlights, sekundäre CTAs) verwendet. Antworte nur mit gültigem JSON: {"hsl":"H S% L%","reason":"kurz"} oder {"hsl":null} wenn unklar. HSL-Werte wie im Theme-Format (zwei Dezimalstellen bei Prozenten möglich).`
        : `Du wählst eine sekundäre Markenfarbe für eine Website. Antworte nur mit gültigem JSON: {"hsl":"H S% L%","reason":"kurz"} oder {"hsl":null} wenn unklar. HSL-Werte wie im Theme-Format (zwei Dezimalstellen bei Prozenten möglich).`;
    const userPrompt =
      role === 'accent'
        ? `Primärfarbe (HSL): ${primaryHsl}\nSekundärfarbe (HSL): ${secondaryHsl || '(keine)'}\n\nKandidaten für ${roleLabel}:\n${payload}`
        : `Primärfarbe (HSL): ${primaryHsl}\n\nKandidaten:\n${payload}`;
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    log05ExtractAi(`color-tie-break:${role}`, model, completion, { pageUrl });
    const text = completion.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || !parsed.hsl) return null;
    const rawHsl = String(parsed.hsl).trim();
    let norm = '';
    if (/^hsla?\(/i.test(rawHsl)) norm = normalizeThemeColorValue(rawHsl);
    else
      norm =
        normalizeThemeColorValue(`hsl(${rawHsl})`) ||
        normalizeThemeColorValue(rawHsl);
    if (!norm) return null;
    return { hsl: norm, reason: parsed.reason };
  } catch (err) {
    console.warn(
      `${COLOR_LOG} OpenRouter ${role} tie-break failed: ${err.message}`
    );
    return null;
  }
}

// Gemini 2.0 Flash Lite — ~$0.0001 per extraction. Set OPENROUTER_MODEL_COLOR_VISION
// to `google/gemma-3-27b-it:free` for a zero-cost (rate-limited) alternative.
const OPENROUTER_COLOR_VISION_MODEL =
  process.env.OPENROUTER_MODEL_COLOR_VISION ||
  'google/gemini-2.0-flash-lite-001';

/** DOM primary is "weak" when it came from a fallback source, not a real CTA button. */
function isDomPrimaryWeak(detection) {
  if (!detection || !detection.primary) return true;
  const src = detection.primarySource || '';
  if (src === 'dom:failed' || src === 'subline.fallback') return true;
  return !/^(heroButton|siteWideButtons)\./.test(src);
}

/**
 * Vision tier — asks an OpenRouter vision model to identify the 4 theme
 * colors from a viewport screenshot. Returns {primary?, primaryForeground?,
 * secondary?, accent?, sources} or null on any error.
 */
async function fetchGeminiVisionColors(pageUrl, screenshotBase64) {
  if (!OPENROUTER_API_KEY) return null;
  if (!screenshotBase64) return null;
  try {
    const client = getOpenRouter();
    const model = OPENROUTER_COLOR_VISION_MODEL;
    const systemPrompt = `You are a brand-identity expert analyzing a website homepage screenshot to identify 4 theme colors.

CRITICAL — what IS a brand color vs what is NOT:
✓ The LOGO's ink colors (ignore the white/transparent paper behind it)
✓ The NAVIGATION BAR's background or text color when it's clearly branded (not plain white)
✓ The colors used on primary BUTTONS / CTAs (e.g. "Contact us", "Book now")
✓ Underline / link accent colors in the navbar
✗ Photos in the hero (landscape, people, products) — these are content, NOT the brand
✗ The body background (usually white/off-white/neutral gray)
✗ Headline text that is just dark gray/black for readability
✗ Stock-photo colors from hero imagery

TYPICAL BRAND PRIMARY CHARACTERISTICS:
- Saturation usually >= 30% (vivid, not washed-out)
- Lightness usually 25%-55% (not a pastel tint, not near-black)
- Shows up in MULTIPLE places (logo + button + navbar accent)

Identify:
1. primary: the dominant brand color visible across logo + buttons + navbar. If the logo is a single color, that IS the primary.
2. primary-foreground: the text color that goes ON TOP of primary-colored buttons (must have >=4.5:1 WCAG contrast with primary). Usually pure white or pure near-black.
3. secondary: a softer/lighter brand color used for subtle backgrounds, hover states, or section backgrounds. Often a lighter tint of primary.
4. accent: a DIFFERENT highlight color used for badges, callouts, or secondary CTAs. MUST have a distinctly different hue from primary.

If the homepage shows only ONE brand color (e.g. all elements use the same primary), set accent to a complementary triadic color (+120° hue from primary).

Return ONLY valid JSON, no prose, no markdown fences:
{"primary":"H S% L%","primary-foreground":"H S% L%","secondary":"H S% L%","accent":"H S% L%"}

H: hue 0-360 (numeric, no unit). S and L: 0-100 WITH % suffix.
Example: "primary":"328 85% 46%"

If you CANNOT see the role on this page, omit that key. Never guess or return a near-neutral gray.`;

    const userMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Homepage of ${pageUrl}. Identify the 4 brand theme colors per the schema.`,
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${screenshotBase64}`,
          },
        },
      ],
    };

    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        userMessage,
      ],
    });

    log05ExtractAi('color-vision', model, completion, { pageUrl });
    const text = completion.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(
        `${COLOR_LOG} Vision: response contained no JSON block. Model: ${model}. Response: ${text.slice(0, 200)}`
      );
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.warn(`${COLOR_LOG} Vision: JSON parse failed: ${err.message}`);
      return null;
    }

    const normalize = (raw) => {
      if (!raw || typeof raw !== 'string') return null;
      const s = raw.trim();
      if (/^hsla?\(/i.test(s)) return normalizeThemeColorValue(s);
      return (
        normalizeThemeColorValue(`hsl(${s})`) ||
        normalizeThemeColorValue(s) ||
        null
      );
    };

    // Reject vision primaries that look like hero-photo tints rather than
    // real brand colors (pastels, near-blacks, or near-grays).
    const isPlausibleBrandPrimary = (hsl) => {
      const p = parseHslParts(hsl);
      if (!p) return false;
      if (p.l > VISION_PRIMARY_MAX_L) return false;
      if (p.l < VISION_PRIMARY_MIN_L) return false;
      if (p.s < VISION_PRIMARY_MIN_S) return false;
      return true;
    };

    const out = { sources: {} };
    const primary = normalize(parsed.primary);
    if (primary && !isNeutralOrWeak(primary) && isPlausibleBrandPrimary(primary)) {
      out.primary = primary;
      out.sources.primary = `vision:${model}`;
    } else if (primary) {
      console.warn(
        `${COLOR_LOG} Vision primary ${primary} rejected (implausible — likely hero-photo tint).`
      );
    }
    const primaryFg = normalize(
      parsed['primary-foreground'] || parsed.primaryForeground
    );
    if (primaryFg) {
      // primary-foreground IS allowed to be pure white/black (no neutral check)
      out.primaryForeground = primaryFg;
      out.sources.primaryForeground = `vision:${model}`;
    }
    const secondary = normalize(parsed.secondary);
    if (secondary && !isNeutralOrWeak(secondary)) {
      out.secondary = secondary;
      out.sources.secondary = `vision:${model}`;
    }
    const accent = normalize(parsed.accent);
    if (accent && !isNeutralOrWeak(accent)) {
      out.accent = accent;
      out.sources.accent = `vision:${model}`;
    }

    const filled = ['primary', 'primaryForeground', 'secondary', 'accent'].filter(
      (k) => out[k]
    );
    if (filled.length === 0) {
      console.warn(
        `${COLOR_LOG} Vision returned no usable colors (all neutral/invalid). Response: ${text.slice(0, 200)}`
      );
      return null;
    }

    console.log(
      `   🔭 ${COLOR_LOG} Vision filled: ${filled.join(', ')} via ${model}`
    );
    return out;
  } catch (err) {
    const body = err?.response?.data
      ? JSON.stringify(err.response.data).slice(0, 500)
      : err?.error
        ? JSON.stringify(err.error).slice(0, 500)
        : '';
    console.warn(
      `${COLOR_LOG} Vision call failed: ${err.message}${body ? ` | body: ${body}` : ''}`
    );
    return null;
  }
}

/**
 * Inspect theme.config.json for colors already supplied by the data sheet
 * (process-excel phase) and classify each of the 4 slots as filled or missing.
 */
function classifyExcelColors(existingThemeColors) {
  const slots = ['primary', 'primary-foreground', 'secondary', 'accent'];
  const fromSheet = {};
  const missing = [];
  for (const s of slots) {
    const v = existingThemeColors?.[s];
    if (typeof v === 'string' && v.trim() && parseHslParts(v.trim())) {
      fromSheet[s] = v.trim();
    } else {
      missing.push(s);
    }
  }
  return { fromSheet, missing, allFilled: missing.length === 0 };
}

/**
 * Resolve each theme slot via the cascade:
 *   Data sheet → DOM → Vision → Derive
 *
 * Data-sheet values supplied by BAs always win (tier 1) unless opts.force is
 * set, in which case they're demoted to a last-resort fallback before derive.
 * Throws if every tier fails to produce a usable primary.
 */
function resolveColorsCascade({
  detection,
  vision,
  existingThemeColors,
  force = false,
}) {
  const sources = {};
  const out = {};

  // A value is "usable" if it parses as valid HSL AND is not neutral/weak.
  // Exception: primary-foreground IS allowed to be pure-white/pure-black, so
  // we check it with isUsableHslAny instead.
  const isUsableHsl = (v) => {
    if (!v || typeof v !== 'string') return false;
    if (!v.trim()) return false;
    if (parseHslParts(v) === null) return false;
    if (isNeutralOrWeak(v)) return false;
    return true;
  };
  const isUsableHslAny = (v) => {
    if (!v || typeof v !== 'string') return false;
    if (!v.trim()) return false;
    return parseHslParts(v) !== null;
  };

  // Data-sheet values supplied by BAs (via process-excel phase). These win at
  // tier 1 unless --force is set — see call sites in extractColorsMain.
  const sheetPrimary = isUsableHsl(existingThemeColors?.primary)
    ? existingThemeColors.primary
    : null;
  const sheetPf = isUsableHslAny(existingThemeColors?.['primary-foreground'])
    ? existingThemeColors['primary-foreground']
    : null;
  const sheetSecondary = isUsableHsl(existingThemeColors?.secondary)
    ? existingThemeColors.secondary
    : null;
  const sheetAccent = isUsableHsl(existingThemeColors?.accent)
    ? existingThemeColors.accent
    : null;

  const domPrimarySource = detection.primarySource || 'dom:null';
  const domPrimaryUsable =
    typeof detection.primary === 'string' &&
    detection.primary.length > 0 &&
    isUsableHsl(detection.primary);

  // "Strong" DOM primary = from an actual CTA button (hero or site-wide).
  // Weak sources (heading text, subline fallback) let Vision override.
  const domPrimaryStrong =
    domPrimaryUsable &&
    (/^heroButton\./.test(domPrimarySource) ||
      /^siteWideButtons\./.test(domPrimarySource));
  const domPrimaryWeakButUsable = domPrimaryUsable && !domPrimaryStrong;

  // PRIMARY — Sheet → DOM-strong → Vision → DOM-weak → Sheet-fallback → throw.
  if (!force && sheetPrimary) {
    out.primary = sheetPrimary;
    sources.primary = 'sheet';
  } else if (domPrimaryStrong) {
    out.primary = detection.primary;
    sources.primary = `dom:${domPrimarySource}`;
  } else if (vision?.primary && isUsableHsl(vision.primary)) {
    out.primary = vision.primary;
    sources.primary = vision.sources.primary;
  } else if (domPrimaryWeakButUsable) {
    out.primary = detection.primary;
    sources.primary = `dom:${domPrimarySource}`;
  } else if (sheetPrimary) {
    out.primary = sheetPrimary;
    sources.primary = 'sheet';
  } else {
    throw new Error(
      `${COLOR_LOG} All tiers failed to deliver a usable primary color. ` +
        `DOM: ${detection.primary || 'null'} (${domPrimarySource}); ` +
        `Vision: ${vision?.primary || 'none'}; ` +
        `Sheet: ${existingThemeColors?.primary || 'empty'}.`
    );
  }
  const primaryHsl = out.primary;

  // PRIMARY-FOREGROUND — Sheet (if contrast passes) → DOM → Vision → derive.
  const passesContrast = (fgHsl) =>
    isUsableHslAny(fgHsl) &&
    hslContrastRatio(primaryHsl, fgHsl) >= WCAG_AA_MIN_CONTRAST;

  if (!force && sheetPf && passesContrast(sheetPf)) {
    out['primary-foreground'] = sheetPf;
    sources['primary-foreground'] = 'sheet';
  } else if (
    detection.primaryForeground &&
    passesContrast(detection.primaryForeground)
  ) {
    out['primary-foreground'] = detection.primaryForeground;
    sources['primary-foreground'] = `dom:${detection.primaryForegroundSource}`;
  } else if (
    vision?.primaryForeground &&
    passesContrast(vision.primaryForeground)
  ) {
    out['primary-foreground'] = vision.primaryForeground;
    sources['primary-foreground'] = vision.sources.primaryForeground;
  } else if (sheetPf && passesContrast(sheetPf)) {
    out['primary-foreground'] = sheetPf;
    sources['primary-foreground'] = 'sheet';
  } else {
    const fg = pickPrimaryForegroundHsl(primaryHsl, null);
    out['primary-foreground'] = fg.hsl;
    sources['primary-foreground'] = `derived:${fg.source}`;
  }

  // SECONDARY — Sheet → DOM-real → Vision → Sheet-fallback → derive.
  // Derived fallback always uses the WINNING primary (which may be sheet-supplied
  // and differ from DOM's primary), not DOM's pre-derived value.
  const domSecondary = detection.secondary;
  const domSecondaryDerived =
    detection.secondarySource === 'derived.lightTintFromPrimary' ||
    detection.secondarySource === 'dom:failed';
  if (!force && sheetSecondary) {
    out.secondary = sheetSecondary;
    sources.secondary = 'sheet';
  } else if (domSecondary && !domSecondaryDerived && isUsableHsl(domSecondary)) {
    out.secondary = domSecondary;
    sources.secondary = `dom:${detection.secondarySource}`;
  } else if (vision?.secondary && isUsableHsl(vision.secondary)) {
    out.secondary = vision.secondary;
    sources.secondary = vision.sources.secondary;
  } else if (sheetSecondary) {
    out.secondary = sheetSecondary;
    sources.secondary = 'sheet';
  } else {
    out.secondary = buildLightSecondaryFromPrimary(primaryHsl);
    sources.secondary = 'derived:lightTintFromPrimary';
  }

  // ACCENT — Sheet → DOM-strong → Vision → DOM-navHover → Sheet-fallback → derive.
  const domAccent = detection.accent;
  const domAccentSource = detection.accentSource || '';
  const domAccentDerived =
    domAccentSource === 'derived.triadicFromPrimary' ||
    domAccentSource === 'dom:failed';
  const domAccentIsNavHover = /^navLink\[/.test(domAccentSource);
  const domAccentStrong =
    domAccent &&
    !domAccentDerived &&
    !domAccentIsNavHover &&
    isUsableHsl(domAccent);

  if (!force && sheetAccent) {
    out.accent = sheetAccent;
    sources.accent = 'sheet';
  } else if (domAccentStrong) {
    out.accent = domAccent;
    sources.accent = `dom:${domAccentSource}`;
  } else if (vision?.accent && isUsableHsl(vision.accent)) {
    out.accent = vision.accent;
    sources.accent = vision.sources.accent;
  } else if (domAccent && !domAccentDerived && isUsableHsl(domAccent)) {
    // DOM nav-hover is usually a real brand color even if weak.
    out.accent = domAccent;
    sources.accent = `dom:${domAccentSource}`;
  } else if (sheetAccent) {
    out.accent = sheetAccent;
    sources.accent = 'sheet';
  } else {
    out.accent = buildTriadicAccentFromPrimary(primaryHsl);
    sources.accent = 'derived:triadicFromPrimary';
  }

  // Post-cascade distinctness check: if extraction-picked accent collides with
  // primary or secondary, fall back to triadic derive. Sheet-supplied accents
  // are trusted as-is even if they collide (BA intent).
  const primaryParts = parseHslParts(out.primary);
  const secondaryParts = parseHslParts(out.secondary);
  const accentParts = parseHslParts(out.accent);
  const accentCollidesWithPrimary =
    primaryParts && accentParts && !isDistinctHsl(primaryParts, accentParts);
  const accentCollidesWithSecondary =
    secondaryParts && accentParts && !isDistinctHsl(secondaryParts, accentParts);
  if (
    (accentCollidesWithPrimary || accentCollidesWithSecondary) &&
    sources.accent !== 'sheet' &&
    !sources.accent.startsWith('derived:')
  ) {
    out.accent = buildTriadicAccentFromPrimary(primaryHsl);
    sources.accent = `derived:triadicFromPrimary (was ${sources.accent}, collided with ${accentCollidesWithPrimary ? 'primary' : 'secondary'})`;
  }

  return { colors: out, sourcesByKey: sources };
}

/**
 * Resolve and write the 4 theme colors for a client. Data-sheet values win
 * at tier 1 unless opts.force is set (which re-extracts every slot).
 */
function writeThemeColorsWithFallback(clientName, detection, opts = {}) {
  const { vision = null, force = false } = opts;
  const themePath = getThemeConfigPathForFonts(clientName);
  if (!fs.existsSync(themePath)) {
    console.error(`❌ ${COLOR_LOG} theme.config.json not found: ${themePath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(themePath, 'utf-8');
  const theme = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  const existingColors = theme.colors || {};

  const { colors: resolved, sourcesByKey } = resolveColorsCascade({
    detection,
    vision,
    existingThemeColors: existingColors,
    force,
  });

  if (!parseHslParts(resolved.primary) || isNeutralOrWeak(resolved.primary)) {
    throw new Error(
      `${COLOR_LOG} Primary sanity check failed: ${resolved.primary} is neutral/weak.`
    );
  }
  const fgRatio = hslContrastRatio(
    resolved.primary,
    resolved['primary-foreground']
  );
  if (fgRatio < WCAG_AA_MIN_CONTRAST) {
    const fg = pickPrimaryForegroundHsl(resolved.primary, null);
    resolved['primary-foreground'] = fg.hsl;
    sourcesByKey['primary-foreground'] =
      `sanitized:wcagSafe (was ratio=${fgRatio.toFixed(2)})`;
  }

  const backupPath = themePath.replace(
    /\.json$/i,
    `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.copyFileSync(themePath, backupPath);
  console.log(`   💾 theme backup → ${path.relative(projectRoot, backupPath)}`);

  if (!theme.colors) theme.colors = {};
  theme.colors.primary = resolved.primary;
  theme.colors['primary-foreground'] = resolved['primary-foreground'];
  theme.colors.secondary = resolved.secondary;
  theme.colors.accent = resolved.accent;
  if (!theme._meta) theme._meta = {};
  theme._meta.colorsAutoExtractedAt = new Date().toISOString();
  theme._meta.colorsSources = sourcesByKey;

  fs.writeFileSync(themePath, stringifyThemeConfig(theme), 'utf-8');
  console.log(
    `   ✅ ${COLOR_LOG} Updated colors in ${path.relative(projectRoot, themePath)}`
  );
  console.log(`   📋 Sources:`);
  for (const k of ['primary', 'primary-foreground', 'secondary', 'accent']) {
    console.log(`      ${k.padEnd(20)} ${resolved[k]}  ← ${sourcesByKey[k]}`);
  }
}

function printColorsDetectionJson(detection) {
  console.log(JSON.stringify(detection, null, 2));
}

async function extractColorsMain() {
  console.log('\n🎨 05-extract-client-data — extract brand colors\n');

  const cliClient = parseArgvFlag('--client=');
  const cliSite = parseArgvFlag('--site=');
  const cliDomain = parseArgvFlag('--domain=');
  const cliColorsUrl =
    parseArgvFlag('--colors-url=') || parseArgvFlag('--url=');
  const colorsJsonOnly = process.argv.includes('--colors-json');
  const force = process.argv.includes('--force');
  const skipVision = process.argv.includes('--skip-vision');
  const forceVision = process.argv.includes('--force-vision');

  if (!OPENROUTER_API_KEY && !skipVision) {
    console.log(
      `ℹ️  ${COLOR_LOG} OPENROUTER_API_KEY not set — Vision tier skipped.`
    );
  }

  const enquirer = await getEnquirer();

  // Remove the ~200KB screenshot blob from detection before printing JSON.
  const sanitizeDetection = (d) => {
    if (!d) return d;
    const { screenshotBase64, ...rest } = d;
    return {
      ...rest,
      screenshotCaptured: !!screenshotBase64,
    };
  };

  // JSON-only mode: run the full cascade and print inputs + resolved output
  // without writing theme.config.json. `existingThemeColors` lets the preview
  // respect data-sheet values the same way a real write would.
  const runJsonOnly = async (url, domain, existingThemeColors = {}) => {
    const detection = await detectBrandColorsFromUrl(url);

    const shouldRunVision =
      !skipVision &&
      !!OPENROUTER_API_KEY &&
      (forceVision || isDomPrimaryWeak(detection));
    let vision = null;
    if (shouldRunVision) {
      if (isDomPrimaryWeak(detection)) {
        console.log(
          `\n   🔭 DOM primary weak (${detection.primarySource}) → invoking Gemini Flash vision...`
        );
      } else {
        console.log(
          `\n   🔭 --force-vision → invoking Gemini Flash vision...`
        );
      }
      vision = await fetchGeminiVisionColors(url, detection.screenshotBase64);
    }

    let cascade = null;
    try {
      cascade = resolveColorsCascade({
        detection,
        vision,
        existingThemeColors,
        force,
      });
    } catch (err) {
      cascade = { error: err.message };
    }
    printColorsDetectionJson({
      detection: sanitizeDetection(detection),
      vision,
      cascade,
    });
  };

  if (colorsJsonOnly && cliColorsUrl) {
    const url = toFontsUrl(cliColorsUrl);
    const domain = cliColorsUrl.replace(/^https?:\/\//i, '').split('/')[0];
    console.log(`ℹ️  --colors-json + explicit URL\n   ${url}\n`);
    try {
      await runJsonOnly(url, domain);
    } catch (err) {
      console.error(`❌ ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  const clientList = discoverClients();
  let clientName = cliClient;
  if (!clientName) {
    clientName = await promptClient(enquirer, clientList);
  } else if (!clientList.includes(clientName)) {
    console.error(
      `❌ Unknown client "${clientName}". Expected one of: ${clientList.join(', ')}`
    );
    process.exit(1);
  }

  // Theme is client-level (not per-site). Check data-sheet classification
  // before doing any per-site resolution so an allFilled client can skip the
  // whole flow without prompting for site selection.
  const themePath = getThemeConfigPathForFonts(clientName);
  let existingThemeColors = {};
  if (fs.existsSync(themePath)) {
    try {
      const existingTheme = JSON.parse(
        fs.readFileSync(themePath, 'utf-8').replace(/^\s*\/\/.*$/gm, '')
      );
      existingThemeColors = existingTheme.colors || {};
    } catch (_) {}
  }
  const sheetClassification = classifyExcelColors(existingThemeColors);

  if (sheetClassification.allFilled && !force && !colorsJsonOnly) {
    console.log(
      `\n✅ ${COLOR_LOG} All 4 colors already present in theme.config.json from data sheet — skipping live-site extraction.\n`
    );
    for (const [key, value] of Object.entries(sheetClassification.fromSheet)) {
      console.log(`   ${key.padEnd(20)} ${value}  ← sheet`);
    }
    console.log(`\n   Pass --force to re-extract anyway.\n`);
    return;
  }

  const websitesJsonRelPath = `src/data/${clientName}/websites.json`;
  const websitesJsonPath = path.resolve(projectRoot, websitesJsonRelPath);

  if (!fs.existsSync(websitesJsonPath)) {
    console.error(`❌ websites.json not found at: ${websitesJsonPath}`);
    process.exit(1);
  }

  const websitesData = JSON.parse(fs.readFileSync(websitesJsonPath, 'utf8'));
  const websites = websitesData.websites ?? [];

  let colorsUrl;
  let colorsDomain;
  if (cliColorsUrl) {
    colorsUrl = toFontsUrl(cliColorsUrl);
    colorsDomain = cliColorsUrl.replace(/^https?:\/\//i, '').split('/')[0];
    console.log(`ℹ️  Using --colors-url: ${colorsUrl}`);
  } else {
    let domainSource = null;
    if (cliDomain) {
      domainSource = cliDomain.replace(/^https?:\/\//i, '').split('/')[0];
      console.log(`ℹ️  Using domain: ${domainSource}`);
    } else {
      let website = null;
      if (cliSite) {
        website = websites.find((w) => w.id === cliSite);
        if (!website) {
          console.error(
            `❌ No website with id "${cliSite}" in ${websitesJsonRelPath}`
          );
          process.exit(1);
        }
        console.log(`ℹ️  Using website: ${cliSite}`);
      } else if (websites.length === 1) {
        website = websites[0];
        console.log(`ℹ️  Using website: ${website.id}`);
      } else if (websites.length > 1) {
        website = await promptWebsite(enquirer, websitesData);
      }
      domainSource = resolveDomainForFonts(websitesData, website);
    }
    if (!domainSource) {
      console.error(
        `❌ No clientDomain found in ${websitesJsonRelPath} — set clientDomain (top-level or per-site), pass --domain=, or use --colors-url=`
      );
      process.exit(1);
    }
    colorsUrl = toFontsUrl(domainSource);
    colorsDomain = domainSource;
  }

  if (colorsJsonOnly) {
    console.log(
      `\n📥 --colors-json (no theme write) for client "${clientName}": ${colorsUrl}\n`
    );
    try {
      await runJsonOnly(colorsUrl, colorsDomain, existingThemeColors);
    } catch (err) {
      console.error(`❌ ${err.message || err}`);
      process.exit(1);
    }
    return;
  }

  if (Object.keys(sheetClassification.fromSheet).length > 0 && !force) {
    console.log(
      `\nℹ️  ${COLOR_LOG} Using data sheet for: ${Object.keys(sheetClassification.fromSheet).join(', ')}`
    );
    console.log(
      `   Extracting from live site for: ${sheetClassification.missing.join(', ')}\n`
    );
  }

  console.log(
    `📥 Extracting colors from ${colorsUrl} for client "${clientName}"...\n`
  );

  try {
    const detection = await detectBrandColorsFromUrl(colorsUrl);
    console.log(
      `   DOM Primary:             ${detection.primary || '(none)'} (${detection.primarySource})`
    );
    console.log(
      `   DOM Primary-foreground:  ${detection.primaryForeground || '(none)'} (${detection.primaryForegroundSource})`
    );
    console.log(
      `   DOM Secondary:           ${detection.secondary || '(none)'} (${detection.secondarySource})`
    );
    console.log(
      `   DOM Accent:              ${detection.accent || '(none)'} (${detection.accentSource})`
    );

    // Tier 2 — Vision (gated: only fires when DOM primary is weak, unless
    // --force-vision is passed). Skipped entirely with --skip-vision.
    let vision = null;
    const shouldRunVision =
      !skipVision &&
      !!OPENROUTER_API_KEY &&
      (forceVision || isDomPrimaryWeak(detection));
    if (shouldRunVision) {
      if (isDomPrimaryWeak(detection)) {
        console.log(
          `\n   🔭 DOM primary is weak (${detection.primarySource}) → invoking Gemini Flash vision...`
        );
      } else {
        console.log(
          `\n   🔭 --force-vision → invoking Gemini Flash vision...`
        );
      }
      vision = await fetchGeminiVisionColors(
        colorsUrl,
        detection.screenshotBase64
      );
      if (vision) {
        if (vision.primary)
          console.log(
            `   Vision Primary:          ${vision.primary} (${vision.sources.primary})`
          );
        if (vision.primaryForeground)
          console.log(
            `   Vision Primary-fg:       ${vision.primaryForeground} (${vision.sources.primaryForeground})`
          );
        if (vision.secondary)
          console.log(
            `   Vision Secondary:        ${vision.secondary} (${vision.sources.secondary})`
          );
        if (vision.accent)
          console.log(
            `   Vision Accent:           ${vision.accent} (${vision.sources.accent})`
          );
      }
    }

    writeThemeColorsWithFallback(clientName, detection, {
      force,
      vision,
    });
  } catch (err) {
    console.error(`❌ ${err.message || err}`);
    process.exit(1);
  }

  console.log('\n✅ Brand colors written successfully.\n');
}

// ===========================================================================
// Main
// ===========================================================================

async function main(options = {}) {
  const mode = options.mode ?? 'impressum';
  const runCoreExtraction = mode === 'impressum';
  const shouldGenerateClientPrompt = mode === 'client-prompt';

  if (!FIRECRAWL_API_KEY) {
    console.error('❌ FIRECRAWL_API_KEY not found. Set it in .env.local');
    process.exit(1);
  }

  if (shouldGenerateClientPrompt && !OPENROUTER_API_KEY) {
    console.error('❌ OPENROUTER_API_KEY not found. Set it in .env.local');
    process.exit(1);
  }

  console.log('\n🚀 05-extract-client-data\n');

  const cliClient = parseArgvFlag('--client=');
  const cliDomain = parseArgvFlag('--domain=');
  const cliSite = parseArgvFlag('--site=');
  const cliModel = parseArgvFlag('--model=');

  const enquirer = await getEnquirer();

  // ── Pick client ──────────────────────────────────────────────────────────
  const clients = discoverClients();
  let clientName = cliClient;
  if (!clientName) {
    clientName = await promptClient(enquirer, clients);
  } else if (!clients.includes(clientName)) {
    console.error(
      `❌ Unknown client "${clientName}". Expected one of: ${clients.join(', ')}`
    );
    process.exit(1);
  }

  const websitesJsonRelPath = `src/data/${clientName}/websites.json`;
  const websitesJsonPath = path.resolve(projectRoot, websitesJsonRelPath);

  if (!fs.existsSync(websitesJsonPath)) {
    console.error(`❌ websites.json not found at: ${websitesJsonPath}`);
    process.exit(1);
  }

  const websitesRaw = fs.readFileSync(websitesJsonPath, 'utf8');
  const websitesData = JSON.parse(websitesRaw);
  const websites = websitesData.websites ?? [];

  let selectedWebsite = null;
  if (cliSite) {
    selectedWebsite = websites.find((w) => w.id === cliSite) ?? null;
    if (!selectedWebsite) {
      console.error(
        `❌ No website with id "${cliSite}" in ${websitesJsonRelPath}`
      );
      process.exit(1);
    }
  }

  // ── Pick client domain ───────────────────────────────────────────────────
  let clientDomain;
  if (cliDomain) {
    clientDomain = cliDomain.replace(/^https?:\/\//i, '').split('/')[0];
  } else if (selectedWebsite) {
    clientDomain = (
      selectedWebsite.clientDomain ??
      websitesData.clientDomain ??
      ''
    ).trim();
    if (!clientDomain) {
      clientDomain = await promptDomain(enquirer, websitesData);
    }
  } else {
    clientDomain = await promptDomain(enquirer, websitesData);
  }

  const rawBaseUrl = `https://${clientDomain}`.replace(/\/$/, '');
  const matchingWebsites = selectedWebsite
    ? [selectedWebsite]
    : findWebsitesByDomain(websitesData, clientDomain);

  if (matchingWebsites.length === 0) {
    console.error(
      `❌ No matching websites found for domain "${clientDomain}".`
    );
    process.exit(1);
  }

  console.log(`\n   Client        : ${clientName}`);
  console.log(`   Domain        : ${rawBaseUrl}`);
  console.log(
    `   Websites      : ${matchingWebsites
      .map((w) => resolveSiteFolderId(w, websitesData))
      .join(', ')}`
  );
  console.log(`   websites.json : ${websitesJsonRelPath}\n`);

  if (runCoreExtraction) {
    // ── Scrape once ────────────────────────────────────────────────────────
    const [impressumResult, socialEntries] = await Promise.all([
      scrapeImpressum(rawBaseUrl),
      scrapeSocialLinks(rawBaseUrl),
    ]);

    // ── Apply to all matching website entries ──────────────────────────────
    const impressumSections = impressumResult?.sections ?? null;
    const phone = impressumResult?.phone ?? null;
    const blocks = impressumSections?.length
      ? sectionsToBlocks(impressumSections)
      : null;

    // Location address — written only when different from imprint (else renderers fall back).
    const imprintAddress =
      matchingWebsites[0]?.business?.legalAddress ??
      matchingWebsites[0]?.business?.address ??
      null;
    const locationAddress = await scrapeLocationAddress(
      rawBaseUrl,
      imprintAddress
    );

    for (const website of matchingWebsites) {
      stripImpressumBlocks(website);
      if (phone) {
        applyPhone(website, phone);
      }
      if (socialEntries.length > 0) {
        applySocial(website, socialEntries);
      }
      if (locationAddress) {
        applyLocationAddress(website, locationAddress);
      }
    }

    if (locationAddress) {
      console.log(
        `✅ Location address: "${locationAddress.street}, ${locationAddress.postalCode} ${locationAddress.city}" applied to ${matchingWebsites.length} website(s)`
      );
    } else {
      console.log(
        'ℹ️  Location address: none detected or identical to legal/imprint address — getDisplayAddress falls back to empty; add business.locationAddress or set legalAddress only in Impressum data.'
      );
    }

    if (blocks) {
      console.log(
        `\nℹ️  Impressum: scraped ${impressumSections.length} section(s) (${blocks.length} blocks) — not written to websites.json (rendered from legal/impressum-content.json).`
      );
    } else {
      console.log(
        '\n⚠️  Impressum: no data extracted from live page (phone/social/address still applied if found).'
      );
    }

    if (phone) {
      console.log(
        `✅ Phone: "${phone}" applied to ${matchingWebsites.length} website(s)`
      );
    } else {
      console.log('⚠️  Phone: not found – business.phone unchanged');
    }

    if (socialEntries.length > 0) {
      console.log(
        `✅ Social links: ${socialEntries.length} platform(s) applied to ${matchingWebsites.length} website(s)`
      );
      socialEntries.forEach(({ name, href }) =>
        console.log(`   ${name.padEnd(14)} ${href}`)
      );
    } else {
      console.log('⚠️  Social links: nothing found – social unchanged');
    }
  }

  if (shouldGenerateClientPrompt) {
    const model = cliModel || OPENROUTER_CLIENT_PROMPT_MODEL;
    console.log(`\n🧾 Generating client prompt with model: ${model}`);
    const { corpusMarkdown } = await scrapeClientPromptCorpus(rawBaseUrl);
    // Scrape same-domain link graph for 06's footer-nav + header-CTA AI-assign.
    let clientDomainLinks = [];
    try {
      clientDomainLinks = await scrapeClientDomainLinks(rawBaseUrl);
    } catch (err) {
      console.log(
        `   ⚠️  clientDomainLinks scrape failed: ${err.message || err}`
      );
    }
    if (!corpusMarkdown.trim()) {
      console.log(
        '⚠️  Client prompt: no suitable text corpus found – prompt.md unchanged'
      );
    } else {
      // Process every website in the client's websites.json from the SAME
      // shared corpus, but tailor topics.json + prompt.md per unique
      // websiteBriefing + deploy-domain combination. ai-input.json is only
      // written for the user-selected (matchingWebsites) entries.
      const matchingFolderIds = new Set(
        matchingWebsites.map((w) => resolveSiteFolderId(w, websitesData))
      );

      // Build per-site descriptors with their effective siteContext.
      const siteDescriptors = (websites.length > 0
        ? websites
        : matchingWebsites
      ).map((website) => {
        const siteDirId = resolveSiteFolderId(website, websitesData);
        const briefing =
          typeof website.websiteBriefing === 'string'
            ? website.websiteBriefing.trim()
            : '';
        const deployDomain = String(website.deployDomain ?? '').trim();
        const siteContext = {
          deployDomain: deployDomain || undefined,
          siteId: String(website.id ?? '').trim() || siteDirId,
          websiteBriefing: briefing || undefined,
        };
        return {
          website,
          siteDirId,
          siteContext,
          isMatching: matchingFolderIds.has(siteDirId),
        };
      });

      // Group sites by an equivalence key so each unique briefing/deploy
      // combination only triggers a single pair of model calls.
      const variantGroups = new Map();
      for (const desc of siteDescriptors) {
        const key = JSON.stringify({
          briefing: desc.siteContext.websiteBriefing ?? '',
          deployKw: normalizeKeywordForCompare(
            derivePrimaryKeywordFromSite(
              desc.siteContext.deployDomain,
              desc.siteContext.siteId
            )
          ),
          briefingKw: normalizeKeywordForCompare(
            parseMainKeywordFromBriefing(desc.siteContext.websiteBriefing)
          ),
        });
        if (!variantGroups.has(key)) variantGroups.set(key, []);
        variantGroups.get(key).push(desc);
      }

      console.log(
        `\n🧩 ${siteDescriptors.length} site(s) → ${variantGroups.size} unique briefing variant(s)`
      );

      let groupIndex = 0;
      for (const [, group] of variantGroups) {
        groupIndex += 1;
        const representative = group[0];
        const groupContext = representative.siteContext;
        const groupBriefing = groupContext.websiteBriefing ?? '';
        const groupBriefingKeyword = parseMainKeywordFromBriefing(groupBriefing);
        const deployKeyword = derivePrimaryKeywordFromSite(
          groupContext.deployDomain,
          groupContext.siteId
        );
        const targets = group.map((d) => d.siteDirId).join(', ');

        console.log(
          `\n── Variant ${groupIndex}/${variantGroups.size} → ${group.length} site folder(s): ${targets}`
        );
        if (deployKeyword) {
          console.log(`   Deploy-domain keyword : "${deployKeyword}"`);
        }
        if (groupBriefingKeyword) {
          console.log(`   Briefing main keyword : "${groupBriefingKeyword}"`);
        }
        if (groupBriefing) {
          console.log(
            `   Briefing applied      : ${
              groupBriefing.length > 120
                ? groupBriefing.slice(0, 117) + '…'
                : groupBriefing
            }`
          );
        } else {
          console.log('   Briefing applied      : (none)');
        }

        let topicsData = null;
        console.log('   📊 Analyzing topics & headline ideas…');
        try {
          topicsData = await analyzeTopicsFromCorpus(
            corpusMarkdown,
            model,
            groupContext
          );
          if (!topicsData) {
            console.log(
              '   ⚠️  Topic analysis: model output could not be validated – topics.json skipped'
            );
          }
        } catch (err) {
          console.log(
            `   ⚠️  Topic analysis failed: ${err.message || err} – topics.json skipped`
          );
        }

        let promptContent = '';
        try {
          promptContent = await generateClientPromptFromCorpus(
            corpusMarkdown,
            model,
            topicsData,
            groupContext
          );
        } catch (err) {
          console.log(
            `   ⚠️  Client prompt generation failed: ${err.message || err}`
          );
        }

        const topicsMessages = buildTopicsAnalysisMessages(
          corpusMarkdown,
          groupContext
        );
        const generationMessages = buildClientPromptGenerationMessages(
          corpusMarkdown,
          topicsData,
          groupContext
        );

        const sharedAiInput = {
          version: 1,
          generatedAt: new Date().toISOString(),
          clientId: clientName,
          sourceBaseUrl: rawBaseUrl,
          model,
          scrapedCorpusMarkdown: corpusMarkdown,
          // Candidate list consumed by 06's applyExternalFooterNavAndHeaderCtaLinks — AI must pick verbatim from this list.
          clientDomainLinks,
          websiteBriefing: groupBriefing || null,
          briefingMainKeyword: groupBriefingKeyword || null,
          deployDomainKeyword: deployKeyword || null,
          topicsData,
          topicsAnalysis: {
            temperature: 0.2,
            systemPrompt: topicsMessages.systemPrompt,
            userPrompt: topicsMessages.userPrompt,
          },
          clientPromptGeneration: {
            temperature: 0.4,
            systemPrompt: generationMessages.systemPrompt,
            userPrompt: generationMessages.userPrompt,
          },
          clientPromptModelOutput: promptContent.trim() || null,
        };

        // Write ai-input.json only for user-selected sites.
        for (const desc of group) {
          if (!desc.isMatching) continue;
          if (!String(desc.website.id ?? '').trim()) {
            console.log(
              `   ℹ️  websites.json has empty id — using folder "${desc.siteDirId}" (set "id" to match an existing site directory if needed)`
            );
          }
          writeClientPromptAiInputFile(clientName, desc.siteDirId, {
            ...sharedAiInput,
            siteId: desc.siteDirId,
          });
        }

        if (!promptContent.trim()) {
          console.log(
            '   ⚠️  Client prompt: model returned empty output – prompt.md unchanged for this variant'
          );
          continue;
        }

        for (const desc of group) {
          writeClientPromptFile(clientName, desc.siteDirId, promptContent);
          if (topicsData) {
            writeTopicsFile(clientName, desc.siteDirId, topicsData, {
              clientId: clientName,
              siteId: desc.siteDirId,
              sourceBaseUrl: rawBaseUrl,
              model,
              websiteBriefing: groupBriefing || null,
              briefingMainKeyword: groupBriefingKeyword || null,
              deployDomainKeyword: deployKeyword || null,
            });
          }
        }
      }
    }
  }

  if (runCoreExtraction) {
    // ── Write back ─────────────────────────────────────────────────────────
    const backupPath = websitesJsonPath.replace('.json', '.backup.json');
    fs.writeFileSync(backupPath, websitesRaw, 'utf8');
    console.log(
      `\n💾 Backup saved → ${path.relative(projectRoot, backupPath)}`
    );

    fs.writeFileSync(
      websitesJsonPath,
      JSON.stringify(websitesData, null, 2) + '\n',
      'utf8'
    );
    console.log(`✅ websites.json updated → ${websitesJsonRelPath}\n`);
  } else {
    console.log('\nℹ️  websites.json unchanged (client prompt mode)\n');
  }
}

const isFaviconMode =
  process.argv.includes('--favicon') || process.argv.includes('--favicon-only');
const isClientPromptMode = process.argv.includes('--client-prompt');
const isDownloadFontsMode =
  process.argv.includes('--download-fonts') || process.argv.includes('--fonts');
const isExtractColorsMode = process.argv.includes('--extract-colors');
const isScrapeLinksMode = process.argv.includes('--scrape-links');
const VERBOSE =
  process.argv.includes('--verbose') || process.argv.includes('-v');

async function chooseExtractionModeInteractive() {
  const enquirer = await getEnquirer();
  const { extractionMode } = await enquirer.prompt({
    type: 'select',
    name: 'extractionMode',
    message: 'What do you want to do?',
    choices: [
      { name: 'impressum', message: 'Update Impressum + social data' },
      { name: 'favicon', message: 'Pull favicon' },
      { name: 'download-fonts', message: 'Download client fonts' },
      {
        name: 'extract-colors',
        message: 'Extract primary/secondary brand colors',
      },
      {
        name: 'scrape-links',
        message:
          'Scrape same-domain links (for footer nav + header CTA AI-assign)',
      },
      { name: 'client-prompt', message: 'Generate client prompt' },
    ],
  });
  return extractionMode;
}

/** --scrape-links mode: merge same-domain links into existing client-prompt-ai-input.json as `clientDomainLinks`. Safe re-run, no prompt regen. */
async function scrapeLinksMain() {
  console.log('\n🔗 05-extract-client-data — scrape same-domain links only\n');

  const cliClient = parseArgvFlag('--client=');
  const cliSite = parseArgvFlag('--site=');
  const cliDomain = parseArgvFlag('--domain=');
  const enquirer = await getEnquirer();

  const clientList = discoverClients();
  let clientName = cliClient;
  if (!clientName) {
    clientName = await promptClient(enquirer, clientList);
  } else if (!clientList.includes(clientName)) {
    console.error(
      `❌ Unknown client "${clientName}". Expected one of: ${clientList.join(', ')}`
    );
    process.exit(1);
  }

  const websitesJsonRelPath = `src/data/${clientName}/websites.json`;
  const websitesJsonPath = path.resolve(projectRoot, websitesJsonRelPath);
  if (!fs.existsSync(websitesJsonPath)) {
    console.error(`❌ websites.json not found at: ${websitesJsonPath}`);
    process.exit(1);
  }
  const websitesData = JSON.parse(fs.readFileSync(websitesJsonPath, 'utf8'));
  const websites = websitesData.websites ?? [];
  if (websites.length === 0) {
    console.error('❌ No website entries found in websites.json');
    process.exit(1);
  }

  // Pick which site(s) to update.
  let selectedWebsites = [];
  if (cliSite) {
    const siteIds = cliSite
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of siteIds) {
      const w = websites.find((ws) => ws.id === id);
      if (!w) {
        console.error(
          `❌ No website with id "${id}" in ${websitesJsonRelPath}`
        );
        process.exit(1);
      }
      selectedWebsites.push(w);
    }
  } else if (websites.length === 1) {
    selectedWebsites = [websites[0]];
  } else {
    const { websiteIds } = await enquirer.prompt({
      type: 'multiselect',
      name: 'websiteIds',
      message: 'Which website(s)? (space to toggle, enter to confirm)',
      choices: websites.map((w) => w.id),
    });
    if (!websiteIds || websiteIds.length === 0) {
      console.error('❌ No websites selected');
      process.exit(1);
    }
    selectedWebsites = websiteIds
      .map((id) => websites.find((w) => w.id === id))
      .filter(Boolean);
  }

  // Resolve a homepage URL. Reuse the same priority promptBaseUrlIfNeeded uses.
  const originOverride = cliDomain
    ? `https://${cliDomain.replace(/^https?:\/\//i, '').split('/')[0]}`
    : null;

  for (const website of selectedWebsites) {
    const origin =
      originOverride ??
      (await promptBaseUrlIfNeeded(enquirer, website, websitesData));
    const homePageUrl = new URL('/', origin).href;
    console.log(
      `\n🌐 [${website.id}] scraping ${homePageUrl} for same-domain links`
    );

    let links = [];
    try {
      links = await scrapeClientDomainLinks(homePageUrl);
    } catch (err) {
      console.error(
        `❌ [${website.id}] scrape failed: ${err.message || err}`
      );
      continue;
    }

    // Merge into existing client-prompt-ai-input.json for this site.
    const siteDir = path.join(
      projectRoot,
      'src',
      'data',
      clientName,
      website.id
    );
    if (!fs.existsSync(siteDir)) {
      fs.mkdirSync(siteDir, { recursive: true });
    }
    const inputPath = path.join(siteDir, 'client-prompt-ai-input.json');

    let payload;
    if (fs.existsSync(inputPath)) {
      try {
        payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      } catch (err) {
        console.warn(
          `   ⚠️  existing client-prompt-ai-input.json is invalid JSON — recreating: ${err.message}`
        );
        payload = {};
      }
    } else {
      payload = {
        version: 1,
        clientId: clientName,
        siteId: website.id,
      };
    }
    payload.clientDomainLinks = links;
    payload.clientDomainLinksScrapedAt = new Date().toISOString();
    payload.sourceBaseUrl = payload.sourceBaseUrl || origin;

    fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(
      `   ✅ ${path.relative(projectRoot, inputPath)} updated (${links.length} link(s))`
    );
  }

  console.log(
    `\n✨ Done. Next: \`pnpm 06-generate-website --client=${clientName} --prompt=src/data/${clientName}/<site>/prompt.md --skip-excel\` to fill footer nav + header CTA links.\n`
  );
}

async function bootstrap() {
  if (isFaviconMode) {
    await faviconMain();
    return;
  }
  if (isDownloadFontsMode) {
    await downloadFontsMain();
    return;
  }
  if (isExtractColorsMode) {
    await extractColorsMain();
    return;
  }
  if (isScrapeLinksMode) {
    await scrapeLinksMain();
    return;
  }
  if (isClientPromptMode) {
    await main({ mode: 'client-prompt' });
    return;
  }

  const mode = await chooseExtractionModeInteractive();
  if (mode === 'favicon') {
    await faviconMain();
    return;
  }
  if (mode === 'download-fonts') {
    await downloadFontsMain();
    return;
  }
  if (mode === 'extract-colors') {
    await extractColorsMain();
    return;
  }
  if (mode === 'scrape-links') {
    await scrapeLinksMain();
    return;
  }
  if (mode === 'client-prompt') {
    await main({ mode: 'client-prompt' });
    return;
  }
  await main({ mode: 'impressum' });
}

bootstrap().catch((err) => {
  console.error('❌', err.message || err);
  process.exit(1);
});
