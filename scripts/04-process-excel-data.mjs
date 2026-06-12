/**
 * Process client data from Excel (.xlsx) files and patch websites.json.
 *
 * Reads Excel files from the Google Drive download folder and/or the
 * client's src/data/<client>/ directory. Each row is matched against
 * website entries in websites.json by the Domain column (compared with
 * deployDomain / clientDomain). Updates: websites[].id from Site ID column,
 * contact email/phone, Calendly
 * link, WhatsApp (cleaned digits on `business.social.whatsappNumber` and
 * `https://wa.me/{digits}` on the WhatsApp header item — standard template: `header.links[3].href`
 * when that slot is `type: "whatsapp"`, plus any other `header.links` entry with `type: "whatsapp"`).
 * Rows without a usable
 * WhatsApp number cause any `type: "whatsapp"` header link with empty href/url to be
 * removed. social URLs, Impressum legal fields,
 * Google Maps Place ID → `websites[].business.googlePlacesId`, and languages.
 * Client Name → `websites[].business.name` and `websites[].business.brandName`.
 * Impressum firm name (and optional "Legal name" column) → `websites[].business.legalName`.
 * Optional Impressum columns (`Impressum - Registergericht`, `… HRB Nummer`, `… UST-ID`,
 * `… Vertreten durch`) → `business.registergericht`, `hrbNummer`, `ustId`, `vertreter`
 * only when the cell is non-empty; missing or blank cells do not overwrite existing JSON.
 * Hero CTA buttons → `pages[].hero.buttons` on the home page (matched by `name: "home"`,
 *   else first page): columns "Hero Button 1 Text/Link" and "Hero Button 2 Text/Link".
 *   Both text and link must be non-empty for a button to be kept; an empty second button
 *   omits the second entry so only one button renders.
 *
 * Also updates `supportedLanguages` in language.config.json when a
 * Languages column is present.
 *
 * Usage:
 *   pnpm 04-process-excel-data                          # process all xlsx files
 *   pnpm 04-process-excel-data --client=caralingua      # specific client
 *   pnpm 04-process-excel-data --dry-run                # preview without writing
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { stringifyThemeConfig } from './lib/theme-config-disk.mjs';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let client = null;
  let dryRun = false;
  let verbose = false;

  for (const a of args) {
    if (a.startsWith('--client=')) {
      client = a.slice('--client='.length).trim() || null;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--verbose' || a === '-v') {
      verbose = true;
    }
  }
  // dry-run is a preview mode — always show verbose output so you can see what would change
  return { client, dryRun, verbose: verbose || dryRun };
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c])
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive a site folder slug from a deploy domain by stripping the public suffix.
 * Matches the convention used by 03-organize-drive-assets which strips the
 * "site-" prefix from Drive folder names (e.g. site-eisdiele-suedstadt → eisdiele-suedstadt).
 * e.g. "eisdiele-suedstadt.de" → "eisdiele-suedstadt"
 *      "logopaedie-duesseldorf.com" → "logopaedie-duesseldorf"
 *      "hout-bay-guest-house.co.za" → "hout-bay-guest-house"
 */
function slugifyDomainWithoutTld(domain) {
  if (!domain) return '';
  const hostname = String(domain)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.$/, '');

  // Handle common multi-part public suffixes (ccTLD + second-level domain),
  // e.g. *.co.za, *.com.au, *.org.uk. Without this, we would only strip the
  // last label ("za") and keep "co" as part of the slug, producing wrong ids.
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 1) return slugify(hostname);

  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];

  const COMMON_SLD = new Set([
    'ac',
    'co',
    'com',
    'edu',
    'gov',
    'net',
    'org',
  ]);

  const isCcTld = last.length === 2;
  const shouldStripTwo =
    parts.length >= 3 && isCcTld && COMMON_SLD.has(secondLast);

  const baseParts = shouldStripTwo
    ? parts.slice(0, -2)
    : parts.slice(0, -1);

  return slugify(baseParts.join('.'));
}

function clientFolderSlug(clientId) {
  const websitesPath = path.join(
    ROOT,
    'src',
    'data',
    clientId,
    'websites.json'
  );
  try {
    const data = JSON.parse(fs.readFileSync(websitesPath, 'utf-8'));
    return data.clientName ? slugify(data.clientName) : clientId;
  } catch {
    return clientId;
  }
}

function discoverClientDirs() {
  const dataDir = path.join(ROOT, 'src', 'data');
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && e.name !== 'current' && !e.name.startsWith('.')
    )
    .map((e) => e.name);
}

async function resolveClient(clientArg) {
  const clientDirs = discoverClientDirs();

  if (clientDirs.length === 0) {
    console.warn('  No client folders found in src/data/.');
    return null;
  }

  if (clientArg) {
    if (!clientDirs.includes(clientArg)) {
      console.warn(
        `  Client "${clientArg}" not found in src/data/. Available: ${clientDirs.join(', ')}`
      );
      return null;
    }
    return clientArg;
  }

  if (clientDirs.length === 1) {
    console.log(`  Using client: ${clientDirs[0]}`);
    return clientDirs[0];
  }

  try {
    await import('enquirer');
  } catch {
    const { spawnSync } = await import('child_process');
    spawnSync('pnpm', ['add', '-D', 'enquirer'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  }
  const { default: enquirer } = await import('enquirer');
  const { selected } = await enquirer.prompt({
    type: 'select',
    name: 'selected',
    message: 'Which client do you want to process Excel data for?',
    choices: clientDirs,
  });
  return selected;
}

// ---------------------------------------------------------------------------
// Excel column mapping
// ---------------------------------------------------------------------------

const EXCEL_COLUMN_MAP = {
  // Client-level metadata (new columns — populate websitesData root + theme)
  'client domain': 'clientDomain',
  'client id': 'clientId',
  'client name': 'clientName',
  'drive folder id': 'driveFolderId',
  // Optional — filled automatically by `pnpm 05-extract-website:colors` when
  // left blank. Any cell that IS filled here wins over auto-extraction for
  // its slot (BA override). See scripts/05-extract-client-data.mjs cascade.
  //
  // Only two PO-facing colors: Brand (primary) and Akzent (accent).
  // primary-foreground / accent-foreground are auto-derived by
  // sync-theme-to-globals.mjs from WCAG luminance. `secondary` is no longer
  // PO-controlled — the template renders without it.
  'farbe - brand (buttons)': 'colorPrimary',
  'color - brand (buttons)': 'colorPrimary',
  'farbe - akzent (highlights)': 'colorAccent',
  'color - accent (highlights)': 'colorAccent',
  // Legacy headers (still read from older client xlsx files).
  'farbe - primary': 'colorPrimary',
  'color - primary': 'colorPrimary',
  'farbe - accent': 'colorAccent',
  'color - accent': 'colorAccent',
  'farbe - primary vordergrund (schriftfarbe)': 'colorPrimaryForeground',
  'color - primary foreground': 'colorPrimaryForeground',
  'farbe - secondary': 'colorSecondary',
  'color - secondary': 'colorSecondary',

  // Per-website columns
  domain: 'domain',
  'site id': 'siteId',
  'website id': 'siteId',
  id: 'siteId',
  'contact email': 'contactEmail',
  'contact telephone': 'contactTelephone',
  'calendly link': 'calendlyLink',
  'whatsapp number': 'whatsappNumber',
  'impressum - firmenname': 'legalName',
  'legal name': 'legalName',
  'impressum - straße': 'street',
  'impressum - strasse': 'street',
  'impressum - plz': 'postalCode',
  'impressum - ort': 'city',
  'impressum - registergericht': 'registergericht',
  'impressum - hrb nummer': 'hrbNummer',
  'impressum - ust-id': 'ustId',
  'impressum - vertreten durch': 'vertreter',
  // Note: 'backlink variant' column is intentionally unmapped — the field was
  // retired (no reader anywhere in the app; `impressumBacklink.{title,link}`
  // captures the canonical backlink data via the two columns below).
  'backlink title': 'backlinkTitle',
  'backlink url': 'backlinkUrl',
  'ga tracking id': 'gaTrackingId',
  'google maps place id': 'googleMapsPlaceId',
  languages: 'languages',
  'facebook url': 'facebookUrl',
  'instagram url': 'instagramUrl',
  'hero button 1 text': 'heroButton1Text',
  'hero button 1 link': 'heroButton1Link',
  'hero button 2 text': 'heroButton2Text',
  'hero button 2 link': 'heroButton2Link',
  'content briefing': 'websiteBriefing',
};

const THEME_COLOR_KEYS = new Set([
  'colorPrimary',
  'colorPrimaryForeground',
  'colorSecondary',
  'colorAccent',
]);

// ---------------------------------------------------------------------------
// Impressum placeholder resolution
// ---------------------------------------------------------------------------

/**
 * Maps `{PLACEHOLDER}` tokens that appear in Impressum / Datenschutz blocks
 * to getter functions that extract the corresponding value from `business`.
 */
const IMPRESSUM_PLACEHOLDER_MAP = {
  '{LEGAL_NAME}': (b) => b.legalName,
  '{CONTACT_PERSON_NAME}': (b) => b.vertreter,
  '{ADDRESS_STREET}': (b) => b.legalAddress?.street,
  '{ADDRESS_POSTAL_CODE}': (b) => b.legalAddress?.postalCode,
  '{ADDRESS_CITY}': (b) => b.legalAddress?.city,
  '{PHONE}': (b) => b.phone,
  '{EMAIL}': (b) => b.email,
  '{UST_ID}': (b) => b.ustId,
  '{REGISTERGERICHT}': (b) => b.registergericht,
  '{HRB_NUMMER}': (b) => b.hrbNummer,
};

/**
 * Recursively walk all string values in `obj` and replace known
 * `{PLACEHOLDER}` tokens using data from `business`.
 * Mutates `obj` in place; returns `true` if anything changed.
 */
function fillPlaceholders(obj, business) {
  if (!obj || typeof obj !== 'object') return false;
  let changed = false;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      let newVal = val;
      for (const [token, getter] of Object.entries(IMPRESSUM_PLACEHOLDER_MAP)) {
        if (newVal.includes(token)) {
          const replacement = String(getter(business) ?? '').trim();
          if (replacement) {
            newVal = newVal.split(token).join(replacement);
          }
        }
      }
      if (newVal !== val) {
        obj[key] = newVal;
        changed = true;
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (fillPlaceholders(item, business)) changed = true;
      }
    } else if (val && typeof val === 'object') {
      if (fillPlaceholders(val, business)) changed = true;
    }
  }
  return changed;
}

const PLACEHOLDER_PATTERN = /\{[A-Z][A-Z0-9_]*\}/g;
/** Non-global version for boolean checks (avoids `.lastIndex` state issues). */
const PLACEHOLDER_PATTERN_TEST = /\{[A-Z][A-Z0-9_]*\}/;

/**
 * Return true if any string value nested inside `obj` still contains an
 * unfilled `{PLACEHOLDER}` token.
 */
function hasUnfilledPlaceholder(obj) {
  if (typeof obj === 'string') return PLACEHOLDER_PATTERN_TEST.test(obj);
  if (!obj || typeof obj !== 'object') return false;
  return Object.values(obj).some(hasUnfilledPlaceholder);
}

/**
 * Walk all `blocks` arrays in `obj` recursively and remove:
 *   - any block that still contains an unfilled `{PLACEHOLDER}` token, and
 *   - the heading block that immediately precedes it (which would be orphaned).
 *
 * Mutates `obj` in place; returns `true` if any blocks were removed.
 */
function pruneBlocksWithUnfilledPlaceholders(obj) {
  if (!obj || typeof obj !== 'object') return false;
  let changed = false;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (pruneBlocksWithUnfilledPlaceholders(item)) changed = true;
    }
    return changed;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (key === 'blocks' && Array.isArray(val)) {
      const pruned = [];
      for (const block of val) {
        if (hasUnfilledPlaceholder(block)) {
          // Remove this block; also pop the preceding heading if present.
          if (
            pruned.length > 0 &&
            pruned[pruned.length - 1].type === 'heading'
          ) {
            pruned.pop();
          }
          changed = true;
        } else {
          pruned.push(block);
        }
      }
      if (changed) obj[key] = pruned;
    } else if (val && typeof val === 'object') {
      if (pruneBlocksWithUnfilledPlaceholders(val)) changed = true;
    }
  }

  return changed;
}

/**
 * Scan all string values in `websitesData` for unfilled `{PLACEHOLDER}`
 * tokens and print each one in red so the operator knows which Excel columns
 * are missing.
 */
function reportUnfilledPlaceholders(websitesData, dryRun) {
  const RED = '\x1b[31m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';

  const unfilled = [];

  function scan(node, path) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const child = node[key];
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === 'string') {
        const matches = [...child.matchAll(PLACEHOLDER_PATTERN)];
        for (const m of matches) {
          unfilled.push({ placeholder: m[0], path: childPath, value: child });
        }
      } else if (child && typeof child === 'object') {
        scan(child, childPath);
      }
    }
  }

  scan(websitesData, '');

  if (unfilled.length === 0) return;

  const prefix = dryRun ? '[DRY-RUN] ' : '';
  console.log(
    `\n${RED}${BOLD}  ${prefix}⚠  ${unfilled.length} unfilled placeholder(s) — populate the matching Excel column(s):${RESET}`
  );
  const seen = new Set();
  for (const { placeholder, path, value } of unfilled) {
    const dedupKey = `${placeholder}::${path}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    console.log(
      `${RED}  • ${BOLD}${placeholder}${RESET}${RED}  →  ${path}${RESET}`
    );
    if (value !== placeholder) {
      console.log(`${RED}    context: "${value}"${RESET}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Excel processing
// ---------------------------------------------------------------------------

function normalizeThemeColorValue(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';

  // Keep only the inside of hsl()/hsla() wrappers.
  const unwrapped = raw.replace(/^hsla?\((.*)\)$/i, '$1').trim();

  // Convert comma notation to space notation and drop alpha channel if present.
  const noCommas = unwrapped.replace(/,/g, ' ');
  const noAlpha = noCommas.replace(/\s*\/\s*[\d.]+%?$/, '').trim();
  const parts = noAlpha.split(/\s+/).filter(Boolean);

  // Theme colors use H S L components only.
  return parts.slice(0, 3).join(' ');
}

function normaliseDomain(d) {
  if (!d) return '';
  return String(d)
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

/**
 * Normalise a raw "Client Domain" value from Excel into bare `hostname.tld`
 * format: strips scheme, www prefix, path, and trailing dot.
 */
function normalizeClientDomain(d) {
  if (!d) return '';
  return String(d)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.$/, '');
}

function normalizeHeroButtonLink(rawLink) {
  const value = String(rawLink ?? '').trim();
  if (!value) return '';

  const withoutSpaces = value.replace(/\s+/g, '');
  if (!withoutSpaces) return '';

  // In-page anchors and same-site paths (do not prefix with https://)
  if (/^#/.test(withoutSpaces)) {
    return withoutSpaces;
  }
  if (withoutSpaces.startsWith('/') && !withoutSpaces.startsWith('//')) {
    return withoutSpaces;
  }

  if (/^mailto:/i.test(withoutSpaces)) {
    const email = withoutSpaces.slice('mailto:'.length);
    return email ? `mailto:${email}` : '';
  }

  if (/^tel:/i.test(withoutSpaces)) {
    const phone = normalizePhoneToE164(withoutSpaces.slice('tel:'.length));
    return phone ? `tel:${phone}` : '';
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(withoutSpaces)) {
    return `mailto:${withoutSpaces}`;
  }

  // URL check MUST come before the phone-candidate guess. URL inputs (Google Maps
  // directions links etc.) routinely contain digits + "+" signs (URL-encoded spaces
  // in query strings); without this guard, the phone-candidate strip below would
  // pluck the digits out and falsely produce `tel:+49...` from a real https:// URL.
  if (/^https?:\/\//i.test(withoutSpaces)) {
    return withoutSpaces;
  }

  const phoneCandidate = withoutSpaces.replace(/[^\d+]/g, '');
  const digitCount = (phoneCandidate.match(/\d/g) || []).length;
  if (digitCount >= 6 && /^[+\d][\d+]*$/.test(phoneCandidate)) {
    return `tel:${normalizePhoneToE164(phoneCandidate)}`;
  }

  return `https://${withoutSpaces}`;
}

/**
 * Home page entry for hero (and similar) updates — prefer `name: "home"`, else first page.
 */
function getHomePage(site) {
  const pages = site.pages ?? [];
  const home = pages.find(
    (p) => p && typeof p === 'object' && p.name === 'home'
  );
  return home ?? pages[0];
}

function normalizeStreetValue(rawStreet) {
  return String(rawStreet ?? '')
    .trim()
    .replace(/ß/g, 'ss');
}

/**
 * Normalize a phone number to E.164 format.
 * Handles German numbers: strips spaces/parens/hyphens, converts leading 0 to +49.
 * Also strips leading/trailing quote characters that Excel sometimes wraps around
 * numbers stored as text (e.g. "+49 172 5813431 → +49 172 5813431).
 */
function normalizePhoneToE164(rawPhone) {
  const trimmed = String(rawPhone ?? '').trim().replace(/^["']+|["']+$/g, '');
  if (!trimmed) return '';
  let digits = trimmed.replace(/[\s\-()\/]/g, '');
  if (digits.startsWith('00')) {
    digits = '+' + digits.slice(2);
  } else if (digits.startsWith('0') && !digits.startsWith('+')) {
    digits = '+49' + digits.slice(1);
  } else if (
    !digits.startsWith('+') &&
    digits.startsWith('49') &&
    digits.length >= 11
  ) {
    digits = '+' + digits;
  }
  if (!digits.startsWith('+')) {
    digits = '+49' + digits;
  }
  return digits.replace(/[^\d+]/g, '');
}

/**
 * Format an E.164 phone number for human-readable display with spaces.
 * Keeps the machine value (tel: href, business.phone) untouched — only used
 * for UI labels and button text.
 *
 * Rules (German-centric but works for any E.164):
 *   +49 172 5813431  →  +49 172 5813431   (mobile: CC + 3-digit prefix + rest)
 *   +49 30 12345678  →  +49 30 12345678   (landline: CC + area + subscriber)
 *   +27 21 7901234   →  +27 21 7901234
 *
 * Strategy: split after country code (+XX or +XXX), then split the national
 * number into a short prefix (3 digits for mobiles, 2 for short area codes)
 * and the remainder. Falls back to the raw value if it doesn't start with "+".
 */
function formatPhoneForDisplay(e164) {
  const s = String(e164 ?? '').trim();
  if (!s.startsWith('+')) return s;

  // Strip the "+" and split into digits only
  const digits = s.slice(1).replace(/\D/g, '');

  // Determine country-code length: +1 (1), +49/+27/+44 (2), +359 (3)
  // Simple heuristic: known 1-digit CCs are just "1" (NANP).
  let ccLen = 2;
  if (digits.startsWith('1')) ccLen = 1;
  else if (digits.length >= 3 && /^(35[0-9]|36[0-9]|37[0-9]|38[0-9]|39[0-9]|420|421|423|500|590|596|597|598|599|6[0-9]{2}|7[0-9]{2}|800|808|850|852|853|855|856|880|886|960|961|962|963|964|965|966|967|968|970|971|972|973|974|975|976|977|992|993|994|995|996|998)/.test(digits)) ccLen = 3;

  const cc = digits.slice(0, ccLen);
  const national = digits.slice(ccLen);

  if (!national) return s;

  // For the national part: use a 3-digit prefix for German/most mobiles,
  // 2-digit for short area codes (national part ≤ 9 digits total).
  const prefixLen = national.length <= 9 ? 2 : 3;
  const prefix = national.slice(0, prefixLen);
  const rest = national.slice(prefixLen);

  return rest ? `+${cc} ${prefix} ${rest}` : `+${cc} ${prefix}`;
}

/**
 * Digits-only international number for https://wa.me/{digits} (no "+" prefix).
 * Accepts a phone string or a pasted wa.me / api.whatsapp.com URL.
 */
function whatsAppNumberToWaMeDigits(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const waMe = s.match(/(?:https?:\/\/)?(?:www\.)?wa\.me\/\+?(\d+)/i);
  if (waMe) return waMe[1];
  const waPhoneParam = s.match(/[?&]phone=\+?(\d+)/i);
  if (waPhoneParam) return waPhoneParam[1];
  const e164 = normalizePhoneToE164(s);
  if (!e164) return '';
  return e164.replace(/^\+/, '');
}

/** Prefer `href`, then legacy `url`. */
function headerLinkHrefOrUrl(link) {
  if (!link || typeof link !== 'object') return '';
  if (typeof link.href === 'string') return link.href;
  if (typeof link.url === 'string') return link.url;
  return '';
}

/**
 * Drop `header.links` items with type `whatsapp` and no URL (no Excel / invalid number).
 * @returns {boolean} true if `header.links` would change or was changed
 */
function pruneEmptyWhatsappHeaderLinks(site, dryRun) {
  const header = site.header;
  if (!header || typeof header !== 'object' || !Array.isArray(header.links)) {
    return false;
  }
  const links = header.links;
  const next = [];
  let removed = 0;
  for (let i = 0; i < links.length; i++) {
    const item = links[i];
    if (!item || typeof item !== 'object') {
      next.push(item);
      continue;
    }
    const typeRaw =
      typeof item.type === 'string' ? item.type.toLowerCase() : '';
    const target = headerLinkHrefOrUrl(item).trim();
    if (typeRaw === 'whatsapp' && !target) {
      removed++;
      continue;
    }
    next.push(item);
  }
  if (removed === 0) return false;
  if (!dryRun) {
    header.links = next;
  }
  return true;
}

/**
 * Read an xlsx file and return an array of row objects keyed by the internal
 * names defined in EXCEL_COLUMN_MAP. Rows that carry no useful data are skipped.
 */
function readExcelClientData(xlsxPath) {
  try {
    const workbook = XLSX.readFile(xlsxPath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    return rows
      .map((raw) => {
        const mapped = {};
        for (const [rawKey, rawVal] of Object.entries(raw)) {
          const normKey = String(rawKey).trim().toLowerCase();
          const internalKey = EXCEL_COLUMN_MAP[normKey];
          if (internalKey) {
            const normalizedValue = THEME_COLOR_KEYS.has(internalKey)
              ? normalizeThemeColorValue(rawVal)
              : String(rawVal ?? '').trim();
            mapped[internalKey] = normalizedValue;
          }
        }
        return mapped;
      })
      .filter(
        (r) =>
          r.domain ||
          r.siteId ||
          r.clientDomain ||
          r.clientName ||
          r.colorPrimary ||
          r.colorAccent
      );
  } catch (e) {
    console.warn(`  Could not read Excel file ${xlsxPath}: ${e.message}`);
    return [];
  }
}

/**
 * Apply a single Excel row's data to a matching website entry object (mutates).
 * @param {string} [clientNameFallback] - Client Name from sheet-level metadata when the row has no Client Name cell.
 */
function applyRowToWebsite(row, site, websites = [], clientNameFallback = '') {
  if (row.domain) site.deployDomain = row.domain;

  // Only update the id when the Excel has an explicit Site ID column, or when
  // the entry has no id yet. Never overwrite an existing id with a domain-derived
  // slug — existing ids must stay in sync with the folder names produced by
  // 03-organize-drive-assets (which strips the "site-" prefix but not the TLD).
  if (row.siteId) {
    site.id = slugify(row.siteId);
  } else if (!String(site.id ?? '').trim()) {
    // New entry with no id: derive from domain without TLD so it matches the
    // Drive folder convention (site-eisdiele-suedstadt → eisdiele-suedstadt).
    site.id = slugifyDomainWithoutTld(row.domain);
  }

  const b = site.business || {};
  const addr = b.legalAddress || b.address || {};
  const social = b.social || {};

  const clientNameForBusiness = String(
    row.clientName || clientNameFallback || ''
  ).trim();
  if (clientNameForBusiness) {
    b.name = clientNameForBusiness;
    b.brandName = clientNameForBusiness;
  }

  if (row.contactEmail) b.email = row.contactEmail;
  if (row.contactTelephone)
    b.phone = normalizePhoneToE164(row.contactTelephone);
  if (row.calendlyLink) b.bookingUrl = row.calendlyLink;

  if (row.legalName) b.legalName = row.legalName;
  if (row.street) {
    addr.street = normalizeStreetValue(row.street);
  }
  if (row.postalCode) addr.postalCode = row.postalCode;
  if (row.city) addr.city = row.city;
  // Optional legal fields: only patch when Excel provides a non-empty value (do not wipe JSON).
  if (row.registergericht !== undefined && String(row.registergericht).trim()) {
    b.registergericht = String(row.registergericht).trim();
  }
  if (row.hrbNummer !== undefined && String(row.hrbNummer).trim()) {
    b.hrbNummer = String(row.hrbNummer).trim();
  }
  if (row.ustId !== undefined && String(row.ustId).trim()) {
    b.ustId = String(row.ustId).trim();
  }
  if (row.vertreter !== undefined && String(row.vertreter).trim()) {
    b.vertreter = String(row.vertreter).trim();
  }

  social.facebook =
    typeof row.facebookUrl === 'string' ? row.facebookUrl.trim() : '';
  social.instagram =
    typeof row.instagramUrl === 'string' ? row.instagramUrl.trim() : '';
  if (row.whatsappNumber) {
    const waDigits = whatsAppNumberToWaMeDigits(row.whatsappNumber);
    if (waDigits) {
      social.whatsappNumber = waDigits;
      const waHref = `https://wa.me/${waDigits}`;
      const links = site.header?.links;
      if (Array.isArray(links)) {
        // Template order: [0] nav, [1] nav, [2] CTA button, [3] WhatsApp — set href explicitly
        // so JSON matches the wa.me contract even when other tooling reads `header.links[3]`.
        const waSlot = links[3];
        if (waSlot && typeof waSlot === 'object') {
          const slotType = String(waSlot.type || '').toLowerCase();
          if (slotType === 'whatsapp') {
            waSlot.href = waHref;
            if (typeof waSlot.url === 'string') delete waSlot.url;
          }
        }
        for (const link of links) {
          if (
            link &&
            typeof link === 'object' &&
            String(link.type || '').toLowerCase() === 'whatsapp'
          ) {
            link.href = waHref;
            if (typeof link.url === 'string') delete link.url;
            break;
          }
        }
      }
    }
  }

  b.legalAddress = addr;
  if (b.address) {
    delete b.address;
  }
  b.social = social;
  // Same field as `src/data/_template/websites.json` → websites[].business.googlePlacesId
  if (row.googleMapsPlaceId) {
    b.googlePlacesId = String(row.googleMapsPlaceId).trim();
  }
  site.business = b;

  if (row.gaTrackingId) site.googleTagId = String(row.gaTrackingId).trim();
  if (row.websiteBriefing)
    site.websiteBriefing = String(row.websiteBriefing).trim();

  // Populate footer contact links from phone / email
  if (b.phone || b.email) {
    if (!site.footer) site.footer = {};
    if (!site.footer.contact)
      site.footer.contact = { label: 'Kontakt', links: [] };
    const contactLinks = site.footer.contact.links;
    if (Array.isArray(contactLinks)) {
      for (const cl of contactLinks) {
        if (
          typeof cl.link === 'string' &&
          cl.link.startsWith('tel:') &&
          b.phone
        ) {
          cl.link = `tel:${b.phone}`;
          // Human-readable number: formatted with spaces for display (e.g. +49 172 5813431).
          cl.linkLabel = formatPhoneForDisplay(b.phone);
        }
        if (
          typeof cl.link === 'string' &&
          cl.link.startsWith('mailto:') &&
          b.email
        ) {
          cl.link = `mailto:${b.email}`;
          cl.linkLabel = b.email;
        }
      }
    }
  }

  if (row.backlinkTitle || row.backlinkUrl) {
    // Guarded, per-field assignment so template-only fields on
    // `impressumBacklink` (notably `headingTitle`, the fixed German legal
    // heading "Konzept, Design und technische Umsetzung") survive Excel syncs.
    // The previous object-replacement form dropped `headingTitle` on every run.
    if (!site.impressumBacklink) site.impressumBacklink = {};
    if (row.backlinkTitle) site.impressumBacklink.title = row.backlinkTitle;
    if (row.backlinkUrl) site.impressumBacklink.link = row.backlinkUrl;
  }

  // Regression guard: the Impressum renderer silently omits the <h2> when
  // impressumBacklink.headingTitle is empty (see src/pages/[lang]/impressum.astro).
  // Warn whenever a site has a configured backlink (title/link) but has lost
  // its headingTitle so we catch future pipeline regressions (template drift,
  // out-of-band edits, etc.) without having to eyeball rendered pages.
  if (
    site.impressumBacklink &&
    (site.impressumBacklink.title || site.impressumBacklink.link) &&
    !site.impressumBacklink.headingTitle
  ) {
    const siteLabel =
      site.id ||
      site.deployDomain ||
      site.clientDomain ||
      clientNameFallback ||
      '<unknown site>';
    console.warn(
      `  ${siteLabel}: impressumBacklink has title/link but no headingTitle — the Impressum <h2> "Konzept, Design und technische Umsetzung" will be silently omitted in the render.`
    );
  }

  if (
    row.heroButton1Text ||
    row.heroButton1Link ||
    row.heroButton2Text ||
    row.heroButton2Link
  ) {
    const homePage = getHomePage(site);
    if (homePage && typeof homePage === 'object') {
      if (!homePage.hero) homePage.hero = {};
      const existingButtons = Array.isArray(homePage.hero.buttons)
        ? homePage.hero.buttons
        : [];
      const normalizedButtons = [];

      const btn1Text = String(row.heroButton1Text ?? '').trim().replace(/^["']+|["']+$/g, '');
      const btn1Link = normalizeHeroButtonLink(row.heroButton1Link);
      if (btn1Text && btn1Link) {
        normalizedButtons.push({
          text: btn1Text,
          link: btn1Link,
          variant: existingButtons[0]?.variant || 'primary',
        });
      }

      const btn2Text = String(row.heroButton2Text ?? '').trim().replace(/^["']+|["']+$/g, '');
      const btn2Link = normalizeHeroButtonLink(row.heroButton2Link);
      // If the button text itself looks like a phone number, format it for display.
      const btn2DisplayText =
        btn2Link.startsWith('tel:')
          ? formatPhoneForDisplay(normalizePhoneToE164(btn2Text)) || btn2Text
          : btn2Text;
      if (btn2Text && btn2Link) {
        normalizedButtons.push({
          text: btn2DisplayText,
          link: btn2Link,
          variant: existingButtons[1]?.variant || 'outline',
        });
      }

      homePage.hero.buttons = normalizedButtons;

      if (btn1Text && btn1Link) {
        const headerLinks = site.header?.links;
        if (Array.isArray(headerLinks)) {
          for (const link of headerLinks) {
            if (link && link.type === 'button') {
              link.label = btn1Text;
              link.href = btn1Link;
              break;
            }
          }
        }
      }
    }
  }
}

/**
 * Find every xlsx file in `dir` (non-recursive, top level only).
 */
function findXlsxFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.toLowerCase().endsWith('.xlsx') &&
        !e.name.startsWith('.') &&
        // Skip template/example files — they contain placeholder data
        !e.name.toLowerCase().includes('template')
    )
    .map((e) => path.join(dir, e.name));
}

/**
 * Discover site subdirectories inside a base directory.
 */
function discoverSiteFolders(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

function buildExcelSearchContext(clientId) {
  const clientDataDir = path.join(ROOT, 'src', 'data', clientId);
  const driveClientDir = path.join(
    ROOT,
    'googleDrive',
    clientFolderSlug(clientId)
  );
  const onboardingDir = path.join(ROOT, 'googleDrive', '.onboarding');
  const searchDirs = [];

  if (fs.existsSync(driveClientDir)) {
    searchDirs.push(driveClientDir);
    const siteFolders = discoverSiteFolders(driveClientDir);
    for (const slug of siteFolders) {
      searchDirs.push(path.join(driveClientDir, slug));
    }
  }

  searchDirs.push(clientDataDir);

  if (fs.existsSync(onboardingDir)) {
    searchDirs.push(onboardingDir);
  }

  return { clientDataDir, driveClientDir, onboardingDir, searchDirs };
}

/**
 * Find the first Excel row that matches a target website id.
 * Matching precedence:
 *   1) exact "Site ID" match (slugified)
 *   2) domain-derived id match (domain without TLD, slugified)
 * Search order mirrors processExcelFiles input order (Drive first, then local fallback).
 */
export function findExcelRowForSiteId(clientId, targetSiteId) {
  const wantedId = slugify(String(targetSiteId || '').trim());
  if (!clientId || !wantedId) return null;

  const { searchDirs } = buildExcelSearchContext(clientId);
  const xlsxFiles = searchDirs.flatMap(findXlsxFiles);
  if (xlsxFiles.length === 0) return null;

  // Deduplicate while preserving first-seen order (Drive precedence remains intact).
  const uniqueFiles = [...new Set(xlsxFiles.map((f) => fs.realpathSync(f)))];
  let fallbackMatch = null;

  for (const xlsxFile of uniqueFiles) {
    const rows = readExcelClientData(xlsxFile);
    for (const row of rows) {
      const rowSiteId = slugify(String(row.siteId || '').trim());
      if (rowSiteId && rowSiteId === wantedId) {
        return row;
      }

      const rowDomainId = slugifyDomainWithoutTld(row.domain);
      if (!fallbackMatch && rowDomainId && rowDomainId === wantedId) {
        fallbackMatch = row;
      }
    }
  }

  return fallbackMatch;
}

/**
 * List per-website domains found in client Excel files.
 * Uses the same discovery order as processExcelFiles:
 * Drive client folder (and site subfolders) first, then src/data fallback.
 * Returns de-duplicated rows in first-seen order.
 */
export function listExcelDomainsForClient(clientId) {
  if (!clientId) return [];
  const { searchDirs } = buildExcelSearchContext(clientId);
  const xlsxFiles = searchDirs.flatMap(findXlsxFiles);
  if (xlsxFiles.length === 0) return [];

  const uniqueFiles = [...new Set(xlsxFiles.map((f) => fs.realpathSync(f)))];
  const seen = new Set();
  const out = [];

  for (const xlsxFile of uniqueFiles) {
    const rows = readExcelClientData(xlsxFile);
    for (const row of rows) {
      const domain = normalizeClientDomain(row.domain);
      if (!domain) continue;
      // Skip obvious placeholder examples from templates.
      if (/^e\.g\./i.test(domain) || /example/i.test(domain)) continue;
      if (!domain.includes('.')) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);

      const siteIdFromRow = slugify(String(row.siteId || '').trim());
      out.push({
        domain,
        siteId: siteIdFromRow || slugifyDomainWithoutTld(domain),
      });
    }
  }

  return out;
}

/**
 * Process all xlsx files found in `searchDirs`, match their rows against the
 * websites array inside `websitesJsonPath`, and write back an updated file.
 *
 * Client-level columns (Client Domain, Client Name, Drive Folder ID, colors)
 * are applied to the root fields of websites.json and to theme.config.json.
 *
 * Also updates `supportedLanguages` in language.config.json when a
 * Languages column is present.
 *
 * Returns `{ excelRowUpdates, headerPruneChanged }` for logging and save logic.
 */
function processExcelFiles(
  searchDirs,
  websitesJsonPath,
  languageConfigPath,
  themeConfigPath,
  dryRun,
  rootMetaDirs = null,
  verbose = false
) {
  const emptyResult = () => ({
    excelRowUpdates: 0,
    headerPruneChanged: false,
  });

  if (!websitesJsonPath || !fs.existsSync(websitesJsonPath))
    return emptyResult();

  const xlsxFiles = searchDirs.flatMap(findXlsxFiles);
  if (xlsxFiles.length === 0) return emptyResult();

  // Deduplicate by resolved path in case the same file is found from multiple dirs
  const uniqueFiles = [...new Set(xlsxFiles.map((f) => fs.realpathSync(f)))];

  let websitesData;
  try {
    websitesData = JSON.parse(fs.readFileSync(websitesJsonPath, 'utf-8'));
  } catch (e) {
    console.warn(`  Could not parse websites.json: ${e.message}`);
    return emptyResult();
  }

  const websites = websitesData.websites ?? [];
  let updatedCount = 0;
  const collectedLanguages = new Set();

  // Client-level metadata — collected from all rows; first non-empty value wins
  const clientMeta = {
    clientDomain: null,
    clientName: null,
    driveFolderId: null,
    colorPrimary: null,
    colorPrimaryForeground: null,
    colorSecondary: null,
    colorAccent: null,
  };

  // First "Client Name" cell from any row in any sheet (site subfolder xlsx included).
  let anyRowClientName = '';

  for (const xlsxFile of uniqueFiles) {
    const rows = readExcelClientData(xlsxFile);
    if (rows.length === 0) continue;

    if (verbose)
      console.log(
        `\n  Excel: ${path.relative(ROOT, xlsxFile)} (${rows.length} row(s))`
      );

    // Only top-level client dirs (not site subdirs or .onboarding) contribute to
    // root-level metadata like clientDomain, clientName, driveFolderId, colors.
    const xlsxDir = path.dirname(path.resolve(xlsxFile));
    const isRootMetaSource =
      !rootMetaDirs || rootMetaDirs.some((d) => path.resolve(d) === xlsxDir);

    for (const row of rows) {
      const cellClientName = String(row.clientName || '').trim();
      if (cellClientName && !anyRowClientName) {
        anyRowClientName = cellClientName;
      }
      const clientNameFallbackForRow =
        cellClientName ||
        String(clientMeta.clientName || '').trim() ||
        anyRowClientName;

      // Collect client-level metadata (first non-empty occurrence wins)
      if (isRootMetaSource) {
        for (const key of Object.keys(clientMeta)) {
          if (!clientMeta[key] && row[key]) clientMeta[key] = row[key];
        }
      }

      if (row.languages) {
        row.languages
          .split(/[,;]+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((l) => collectedLanguages.add(l));
      }

      // Per-website matching uses the "Domain" column (→ deployDomain).
      // "Client Domain" is the root-level clientDomain and not used for matching.
      const perWebsiteDomain = row.domain;
      if (!perWebsiteDomain) continue;

      const normDomain = normaliseDomain(perWebsiteDomain);

      // 1. Exact domain match
      // Prefer the Excel-provided clientDomain (already collected above) over the
      // stale websites.json value so matching works even on a fresh run.
      const topLevelDomain =
        (clientMeta.clientDomain
          ? normalizeClientDomain(clientMeta.clientDomain)
          : null) ?? websitesData.clientDomain;
      let match = websites.find(
        (s) =>
          normaliseDomain(s.deployDomain) === normDomain ||
          normaliseDomain(s.clientDomain ?? topLevelDomain) === normDomain
      );

      // 2. Fallback: site id appears in the domain or vice versa.
      // Guard: only use this match when the candidate has no existing deployDomain
      // (or has exactly the same one) — prevents overwriting a real entry via a
      // spurious single-character id substring match (e.g. "e" inside every id).
      if (!match) {
        const candidate = websites.find(
          (s) =>
            normDomain.includes(s.id) || s.id.includes(normDomain.split('.')[0])
        );
        if (candidate) {
          const existingNorm = normaliseDomain(candidate.deployDomain);
          if (existingNorm && existingNorm !== normDomain) {
            // console.warn(
            //   `  [Excel] Skipping id-match: "${perWebsiteDomain}" matched "${candidate.id}" but it already has deployDomain "${candidate.deployDomain}".`
            // );
          } else {
            match = candidate;
            if (verbose)
              console.log(
                `  [Excel] Domain "${perWebsiteDomain}" matched by id "${match.id}".`
              );
          }
        }
      }

      // 3. Last resort: only one website entry → apply unconditionally
      if (!match && websites.length === 1) {
        match = websites[0];
        if (verbose)
          console.log(
            `  [Excel] Domain "${perWebsiteDomain}" unmatched — applying to sole entry "${match.id}".`
          );
      }

      if (!match) {
        // console.warn(
        //   `  [Excel] No match for domain "${perWebsiteDomain}" — per-website data not applied.`
        // );
        continue;
      }

      if (dryRun) {
        if (verbose)
          console.log(
            `  [DRY-RUN] Would update website "${match.id}" from Excel row (domain: ${perWebsiteDomain})`
          );
      } else {
        applyRowToWebsite(row, match, websites, clientNameFallbackForRow);
        if (verbose)
          console.log(
            `  ✓ Updated website "${match.id}" (domain: ${perWebsiteDomain})`
          );
        updatedCount++;
      }
    }
  }

  // Client Name may appear on a row without Domain; after all rows/files,
  // sync business.name / business.brandName from collected client metadata.
  let businessNamesFromClientMeta = false;
  const resolvedClientName = String(
    clientMeta.clientName || anyRowClientName || ''
  ).trim();
  if (resolvedClientName) {
    if (dryRun) {
      if (verbose)
        console.log(
          `\n  [DRY-RUN] Would set business.name and business.brandName → "${resolvedClientName}" for ${websites.length} website(s)`
        );
    } else {
      for (const site of websites) {
        if (!site.business) site.business = {};
        site.business.name = resolvedClientName;
        site.business.brandName = resolvedClientName;
      }
      businessNamesFromClientMeta = true;
      if (verbose)
        console.log(
          `\n  ✓ Set business.name and business.brandName → "${resolvedClientName}" (${websites.length} website(s))`
        );
    }
  }

  // Drop WhatsApp header slots with no href (Excel had no usable WhatsApp number).
  let headerPruneChanged = false;
  for (const site of websites) {
    if (pruneEmptyWhatsappHeaderLinks(site, dryRun)) {
      headerPruneChanged = true;
      const id = String(site.id ?? '?').trim() || '?';
      if (dryRun) {
        if (verbose)
          console.log(
            `  [DRY-RUN] Would remove empty WhatsApp header link(s) from website "${id}"`
          );
      } else {
        if (verbose)
          console.log(
            `  ✓ Removed empty WhatsApp header link(s) from website "${id}"`
          );
      }
    }
  }

  // --- Apply client-level metadata to websites.json root fields ---
  let rootMetaChanged = false;
  const rootFieldMap = {
    clientDomain: 'clientDomain',
    clientName: 'clientName',
    driveFolderId: 'driveFolderId',
  };
  for (const [metaKey, jsonKey] of Object.entries(rootFieldMap)) {
    if (clientMeta[metaKey]) {
      // clientDomain must be stored as bare hostname.tld (no scheme, no www, no path)
      const value =
        metaKey === 'clientDomain'
          ? normalizeClientDomain(clientMeta[metaKey])
          : clientMeta[metaKey];
      if (!value) continue;
      if (dryRun) {
        if (verbose)
          console.log(
            `\n  [DRY-RUN] Would set websites.json.${jsonKey} → "${value}"`
          );
      } else if (websitesData[jsonKey] !== value) {
        websitesData[jsonKey] = value;
        rootMetaChanged = true;
        if (verbose)
          console.log(`  ✓ Set websites.json.${jsonKey} → "${value}"`);
      }
    }
  }

  // --- Fill {PLACEHOLDER} tokens in page blocks from business data ---
  let placeholderFillCount = 0;
  for (const site of websites) {
    if (!site.business) continue;
    if (dryRun) {
      // Clone to test without mutating
      const clone = JSON.parse(JSON.stringify(site));
      fillPlaceholders(clone, clone.business);
      pruneBlocksWithUnfilledPlaceholders(clone);
      const wouldChange = JSON.stringify(clone) !== JSON.stringify(site);
      if (wouldChange) {
        if (verbose)
          console.log(
            `  [DRY-RUN] Would fill placeholders / prune empty blocks in website "${site.id ?? '?'}"`
          );
        placeholderFillCount++;
      }
    } else {
      const filled = fillPlaceholders(site, site.business);
      const pruned = pruneBlocksWithUnfilledPlaceholders(site);
      if (filled || pruned) {
        if (verbose)
          console.log(
            `  ✓ Filled placeholders / pruned empty blocks in website "${site.id ?? '?'}"`
          );
        placeholderFillCount++;
      }
    }
  }

  // Report any remaining unfilled placeholders (always, so operator knows what's missing)
  reportUnfilledPlaceholders(websitesData, dryRun);

  if (
    !dryRun &&
    (updatedCount > 0 ||
      placeholderFillCount > 0 ||
      rootMetaChanged ||
      businessNamesFromClientMeta ||
      headerPruneChanged)
  ) {
    fs.writeFileSync(
      websitesJsonPath,
      JSON.stringify(websitesData, null, 2) + '\n',
      'utf-8'
    );
    if (verbose)
      console.log(`\n  ✓ Saved to ${path.relative(ROOT, websitesJsonPath)}`);
  }

  // --- Apply colors to theme.config.json ---
  const hasColors =
    clientMeta.colorPrimary ||
    clientMeta.colorPrimaryForeground ||
    clientMeta.colorSecondary ||
    clientMeta.colorAccent;

  if (hasColors && themeConfigPath && fs.existsSync(themeConfigPath)) {
    if (dryRun) {
      if (verbose) {
        console.log('\n  [DRY-RUN] Would update theme.config.json colors:');
        if (clientMeta.colorPrimary)
          console.log(`  primary            → "${clientMeta.colorPrimary}"`);
        if (clientMeta.colorPrimaryForeground)
          console.log(
            `  primary-foreground → "${clientMeta.colorPrimaryForeground}"`
          );
        if (clientMeta.colorSecondary)
          console.log(`  secondary          → "${clientMeta.colorSecondary}"`);
        if (clientMeta.colorAccent)
          console.log(`  accent             → "${clientMeta.colorAccent}"`);
      }
    } else {
      try {
        const themeConfig = JSON.parse(
          fs.readFileSync(themeConfigPath, 'utf-8')
        );
        if (!themeConfig.colors) themeConfig.colors = {};
        // Write only non-empty Excel values. Empty cells leave existing
        // theme.config.json values untouched so the colors extraction step
        // can fill them from the live site.
        const writeIfNonEmpty = (themeKey, value) => {
          if (typeof value === 'string' && value.trim().length > 0) {
            themeConfig.colors[themeKey] = value;
          }
        };
        // When the PO provides a new base color, drop any stale derived
        // foreground so sync-theme-to-globals.mjs recomputes it from WCAG
        // luminance. Explicit foreground column values still win (legacy).
        if (clientMeta.colorPrimary && !clientMeta.colorPrimaryForeground) {
          delete themeConfig.colors['primary-foreground'];
        }
        if (clientMeta.colorAccent) {
          delete themeConfig.colors['accent-foreground'];
        }
        writeIfNonEmpty('primary', clientMeta.colorPrimary);
        writeIfNonEmpty(
          'primary-foreground',
          clientMeta.colorPrimaryForeground
        );
        writeIfNonEmpty('secondary', clientMeta.colorSecondary);
        writeIfNonEmpty('accent', clientMeta.colorAccent);
        fs.writeFileSync(
          themeConfigPath,
          stringifyThemeConfig(themeConfig),
          'utf-8'
        );
        if (verbose)
          console.log(
            '\n  ✓ Updated colors in theme.config.json (non-empty cells only)'
          );
      } catch (e) {
        console.warn(`  Could not update theme.config.json: ${e.message}`);
      }
    }
  }

  // --- Update language.config.json supportedLanguages ---
  if (
    collectedLanguages.size > 0 &&
    languageConfigPath &&
    fs.existsSync(languageConfigPath)
  ) {
    const langs = [...collectedLanguages];
    if (dryRun) {
      if (verbose)
        console.log(
          `\n  [DRY-RUN] Would set supportedLanguages to ${JSON.stringify(langs)} in ${path.relative(ROOT, languageConfigPath)}`
        );
    } else {
      try {
        const langConfig = JSON.parse(
          fs.readFileSync(languageConfigPath, 'utf-8')
        );
        langConfig.supportedLanguages = langs;
        const defaultLang = langConfig.defaultLanguage ?? 'de';
        const targetLangs = langs.filter((l) => l !== defaultLang);
        if (langConfig.translation) {
          langConfig.translation.targetLanguages = targetLangs;
        }
        fs.writeFileSync(
          languageConfigPath,
          JSON.stringify(langConfig, null, 2) + '\n',
          'utf-8'
        );
        if (verbose) {
          console.log(
            `\n  ✓ Updated supportedLanguages → ${JSON.stringify(langs)} in ${path.relative(ROOT, languageConfigPath)}`
          );
          console.log(
            `  ✓ Updated targetLanguages → ${JSON.stringify(targetLangs)}`
          );
        }
      } catch (e) {
        console.warn(`  Could not update language.config.json: ${e.message}`);
      }
    }
  }

  return {
    excelRowUpdates: updatedCount,
    headerPruneChanged,
    placeholderFillCount,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const { client, dryRun, verbose } = parseArgs();

  const activeClient = await resolveClient(client);
  if (!activeClient) {
    console.error('  No client selected. Exiting.');
    process.exit(1);
  }

  const clientDataDir = path.join(ROOT, 'src', 'data', activeClient);
  const websitesJsonPath = path.join(clientDataDir, 'websites.json');

  if (!fs.existsSync(websitesJsonPath)) {
    console.error(
      `  websites.json not found at ${path.relative(ROOT, websitesJsonPath)}`
    );
    process.exit(1);
  }

  const languageConfigPath = path.join(clientDataDir, 'language.config.json');
  const themeConfigPath = path.join(clientDataDir, 'theme.config.json');

  // Build list of directories to search for xlsx files.
  // IMPORTANT: Google Drive folder is processed FIRST so its data takes precedence
  // over the local src/data copy (which may be a stale/incorrectly-formatted backup).
  // Order:
  //   1. Google Drive client folder (googleDrive/<client-slug>/)  ← authoritative
  //   2. Site subdirectories within the Drive folder
  //   3. Client data dir (src/data/<client>/)                     ← local fallback
  //   4. Onboarding temp folder (googleDrive/.onboarding/)        ← pre-flight pull
  const { driveClientDir, searchDirs } = buildExcelSearchContext(activeClient);

  if (dryRun) {
    console.log('  DRY RUN — no files will be written.\n');
  }

  if (verbose) {
    console.log(`  Client: ${activeClient}`);
    console.log(`  Searching for .xlsx files in:`);
    for (const dir of searchDirs) {
      const rel = path.relative(ROOT, dir);
      const exists = fs.existsSync(dir);
      console.log(`  ${exists ? '✓' : '✗'} ${rel}`);
    }
  }

  // Only top-level client dirs contribute to root metadata (clientDomain etc.)
  const rootMetaDirs = [clientDataDir];
  if (fs.existsSync(driveClientDir)) rootMetaDirs.push(driveClientDir);

  const { excelRowUpdates, headerPruneChanged, placeholderFillCount } =
    processExcelFiles(
      searchDirs,
      websitesJsonPath,
      languageConfigPath,
      themeConfigPath,
      dryRun,
      rootMetaDirs,
      verbose
    );

  console.log('\n' + '═'.repeat(60));
  const summaryParts = [];
  if (excelRowUpdates > 0) {
    summaryParts.push(`${excelRowUpdates} website(s) updated from Excel`);
  }
  if (placeholderFillCount > 0) {
    summaryParts.push(
      `placeholders filled in ${placeholderFillCount} website(s)`
    );
  }
  if (headerPruneChanged) {
    summaryParts.push('empty WhatsApp header link(s) removed');
  }
  if (summaryParts.length > 0) {
    console.log(`  Done. ${summaryParts.join('; ')}.`);
  } else if (dryRun) {
    console.log('  Done (dry run).');
  } else {
    console.log('  Done. No matching Excel files found or no updates needed.');
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export { applyRowToWebsite };
