/**
 * Creates a new client folder with all required configuration files.
 *
 * Prompts the user for client-specific information (clientId, clientName, driveFolderId, clientDomain)
 * and creates the folder structure under src/data/<clientId>/.
 * websites.json is copied from src/data/_template/websites.json with client fields applied.
 *
 * Usage:
 *   pnpm 01-create-client
 *
 * Non-interactive (for scripting):
 *   pnpm 01-create-client --client-id=my-client --client-name="My Client" --drive-folder-id=abc123 --client-domain=example.com
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THEME_COLORS_DOC: string[] = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'lib', 'theme-colors-doc.json'),
    'utf-8'
  )
) as string[];

const DATA_ROOT = path.join(process.cwd(), 'src', 'data');
const TEMPLATE_WEBSITES_JSON = path.join(
  DATA_ROOT,
  '_template',
  'websites.json'
);

const DEFAULT_THEME = {
  $colorsDoc: THEME_COLORS_DOC,
  colors: {
    primary: '328 85% 46%',
    'primary-foreground': '0 0% 100%',
    secondary: '328 10% 92%',
    accent: '169 62% 64%',
  },
  fonts: {
    body: { family: 'Rubik', fallback: 'Arial, Helvetica, sans-serif' },
    heading: { family: 'Caveat', fallback: 'Arial, Helvetica, sans-serif' },
  },
  fontStylesheetUrls: [
    'https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;600;700&family=Caveat:wght@400;700&display=swap',
  ],
  customCss: {
    faqHeading: 'text-2xl font-bold',
  },
};

const DEFAULT_LANGUAGE_CONFIG = {
  defaultLanguage: 'de',
  supportedLanguages: ['de'],
  description:
    'Central config for the location template. defaultLanguage: hreflang x-default and fallback. supportedLanguages: which [lang] routes and website data (websites.json, websites-{lang}.json) are used. translation: optional settings for pnpm translate-data. routeSlugs: optional per-locale URL segments for shared pages.',
  routeSlugs: {
    datenschutz: { de: 'datenschutz' },
    impressum: { de: 'impressum' },
    'ueber-uns': { de: 'ueber-uns' },
    faq: { de: 'faq' },
    grounding: { de: 'wissensgrundlage', en: 'grounding' },
  },
  translation: {
    sourceFile: 'websites.json',
    targetLanguages: ['en', 'sq', 'uk', 'tr', 'ar', 'hi', 'it', 'fr'],
    openRouter: {
      model: process.env.OPENROUTER_MODEL_WEBSITE_GEN,
      baseUrl: 'https://openrouter.ai/api/v1',
    },
    skipKeys: [
      'id',
      'heroPageId',
      'clientDomain',
      'googleTagId',
      'url',
      'link',
      'image',
      'src',
      'email',
      'telephone',
      'phoneNumber',
      'postalCode',
      'bookingUrl',
      'mapEmbedUrl',
      'googlePlacesId',
      'languageCode',
      'latitude',
      'longitude',
      'card1Icon',
      'card2Icon',
      'card3Icon',
      'width',
      'height',
      'publishTime',
      'name',
      'icbm',
      'position',
      'region',
      'addressCountry',
      'routeSlugs',
    ],
  },
};

function getExistingClients(): string[] {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs.readdirSync(DATA_ROOT).filter((f) => {
    const p = path.join(DATA_ROOT, f);
    return fs.statSync(p).isDirectory() && f !== 'current' && f !== '_template';
  });
}

function isValidClientId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length >= 2;
}

function parseArgs(): {
  clientId: string | null;
  clientName: string | null;
  driveFolderId: string | null;
  clientDomain: string | null;
} {
  const args = process.argv.slice(2);
  let clientId: string | null = null;
  let clientName: string | null = null;
  let driveFolderId: string | null = null;
  let clientDomain: string | null = null;

  for (const arg of args) {
    if (arg.startsWith('--client-id=')) {
      clientId = arg.replace('--client-id=', '').trim();
    } else if (arg.startsWith('--client-name=')) {
      clientName = arg.replace('--client-name=', '').trim();
    } else if (arg.startsWith('--drive-folder-id=')) {
      driveFolderId = arg.replace('--drive-folder-id=', '').trim();
    } else if (arg.startsWith('--client-domain=')) {
      clientDomain = arg.replace('--client-domain=', '').trim();
    }
  }

  return { clientId, clientName, driveFolderId, clientDomain };
}

async function main(): Promise<void> {
  const existingClients = getExistingClients();
  const {
    clientId: argClientId,
    clientName: argClientName,
    driveFolderId: argDriveFolderId,
    clientDomain: argClientDomain,
  } = parseArgs();

  let clientId: string;
  let clientName: string;
  let driveFolderId: string;
  let clientDomain: string;

  if (argClientId) {
    // Non-interactive path: only clientId is required; the rest are populated
    // later by 04-process-excel-data.mjs and can be omitted here.
    clientId = argClientId;
    clientName = argClientName ?? '';
    driveFolderId = argDriveFolderId ?? '';
    clientDomain = argClientDomain ?? '';
  } else {
    const answers = await inquirer.prompt<{ clientId: string }>([
      {
        type: 'input',
        name: 'clientId',
        message: 'Client ID (folder name, kebab-case, e.g. my-new-client):',
        default: argClientId ?? undefined,
        validate: (input: string) => {
          if (!input.trim()) return 'Client ID is required.';
          if (!isValidClientId(input.trim())) {
            return 'Use kebab-case only (lowercase letters, numbers, hyphens).';
          }
          if (existingClients.includes(input.trim())) {
            return `Client "${input.trim()}" already exists.`;
          }
          if (['current', '_template'].includes(input.trim())) {
            return 'This name is reserved.';
          }
          return true;
        },
        filter: (input: string) => input.trim().toLowerCase(),
      },
    ]);

    clientId = answers.clientId;
    clientName = argClientName ?? '';
    driveFolderId = argDriveFolderId ?? '';
    clientDomain = argClientDomain ?? '';
  }

  if (existingClients.includes(clientId)) {
    console.error(
      `\nError: Client "${clientId}" already exists at src/data/${clientId}/`
    );
    process.exit(1);
  }

  const clientDir = path.join(DATA_ROOT, clientId);
  fs.mkdirSync(clientDir, { recursive: true });

  if (!fs.existsSync(TEMPLATE_WEBSITES_JSON)) {
    console.error(
      `\nError: Template not found: ${path.relative(process.cwd(), TEMPLATE_WEBSITES_JSON)}`
    );
    process.exit(1);
  }

  const parsed = JSON.parse(
    fs.readFileSync(TEMPLATE_WEBSITES_JSON, 'utf8')
  ) as Record<string, unknown>;
  const { clientName: _tName, clientDomain: _tDomain, ...rest } = parsed;
  const websitesFromTemplate = {
    driveFolderId,
    clientName,
    clientDomain,
    ...rest,
  };

  fs.writeFileSync(
    path.join(clientDir, 'websites.json'),
    JSON.stringify(websitesFromTemplate, null, 2) + '\n'
  );

  fs.writeFileSync(
    path.join(clientDir, 'language.config.json'),
    JSON.stringify(DEFAULT_LANGUAGE_CONFIG, null, 2) + '\n'
  );

  fs.writeFileSync(
    path.join(clientDir, 'theme.config.json'),
    JSON.stringify(DEFAULT_THEME, null, 2) + '\n'
  );

  console.log(
    `\n✓ Created client "${clientName || clientId}" at src/data/${clientId}/`
  );
  console.log('\nFiles created:');
  console.log('  - websites.json (from _template/websites.json)');
  console.log('  - language.config.json');
  console.log('  - theme.config.json');

  console.log('\nNext step:');
  console.log(
    '  1. 02 — Pull assets from Google Drive: pnpm 02-pull-assets --client=' +
      clientId
  );
}

main();
