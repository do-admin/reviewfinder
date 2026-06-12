/**
 * Master script — interactive menu to run any individual script
 * from the onboarding pipeline (and beyond).
 *
 * Usage:
 *   pnpm master
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import enquirer from 'enquirer';

const { Select, MultiSelect } = enquirer as unknown as {
  Select: new (opts: {
    name: string;
    message: string;
    choices: Array<
      | { name: string; message: string; hint: string; role?: undefined }
      | {
          role: 'separator';
          message: string;
          name?: undefined;
          hint?: undefined;
        }
    >;
  }) => { run: () => Promise<string> };
  MultiSelect: new (opts: {
    name: string;
    message: string;
    hint?: string;
    choices: Array<{ name: string; message: string; hint: string }>;
  }) => { run: () => Promise<string[]> };
};

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'src', 'data');

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function getClients(): string[] {
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

function getDriveClients(): string[] {
  const driveDir = path.join(ROOT, 'googleDrive');
  if (!fileExists(driveDir)) return [];
  return fs
    .readdirSync(driveDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function getSiteIds(clientId: string): string[] {
  const p = path.join(DATA_DIR, clientId, 'websites.json');
  if (!fileExists(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const websites: Array<{ id?: string }> = Array.isArray(raw)
      ? raw
      : (raw.websites ?? []);
    return websites.map((w) => w.id).filter((id): id is string => !!id);
  } catch {
    return [];
  }
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\n✗ Command failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log('\n✓ Done');
}

async function selectFrom(message: string, items: string[]): Promise<string> {
  const prompt = new Select({
    name: 'value',
    message,
    choices: items.map((i) => ({ name: i, message: i, hint: '' })),
  });
  return prompt.run();
}

async function pickClient(message = 'Which client?'): Promise<string> {
  const clients = getClients();
  if (clients.length === 0) {
    console.error('No client folders with websites.json found in src/data/.');
    process.exit(1);
  }
  return selectFrom(message, clients);
}

async function pickSite(
  clientId: string,
  message = 'Which site?'
): Promise<string> {
  const sites = getSiteIds(clientId);
  if (sites.length === 0) {
    console.error(`No sites found in src/data/${clientId}/websites.json.`);
    process.exit(1);
  }
  if (sites.length === 1) return sites[0];
  return selectFrom(message, sites);
}

/** Space toggles, enter confirms. At least one website required. */
async function pickWebsites(
  clientId: string,
  message = 'Which website(s) should be translated?'
): Promise<string[]> {
  const sites = getSiteIds(clientId);
  if (sites.length === 0) {
    console.error(`No sites found in src/data/${clientId}/websites.json.`);
    process.exit(1);
  }
  if (sites.length === 1) return [sites[0]];
  const selected = await new MultiSelect({
    name: 'siteIds',
    message,
    hint: '(space toggles, enter confirms)',
    choices: sites.map((s) => ({ name: s, message: s, hint: '' })),
  }).run();
  if (!Array.isArray(selected) || selected.length === 0) {
    console.error('Select at least one website.');
    process.exit(1);
  }
  return selected;
}

interface ActionDef {
  name: string;
  label: string;
  hint: string;
  run: () => Promise<void>;
}

const actionDefs: ActionDef[] = [
  {
    name: 'onboard',
    label: 'Run full onboarding pipeline',
    hint: 'runs all phases (1–6) to fully onboard a new client',
    run: async () => {
      run('pnpm', [
        'exec',
        'tsx',
        'scripts/onboard-client.ts',
        '--skip-polish',
        '--skip-translate',
        '--skip-reviews',
      ]);
    },
  },
  {
    name: 'create-client',
    label: '01 - Create a new client',
    hint: 'scaffold folder, websites.json, theme, language & fonts',
    run: async () => {
      run('pnpm', ['exec', 'tsx', 'scripts/01-create-client.ts']);
    },
  },
  {
    name: 'pull-assets',
    label: '02 - Pull assets from Google Drive',
    hint: "download images & files from the client's Drive folder",
    run: async () => {
      const clientId = await pickClient();
      run('pnpm', [
        'exec',
        'node',
        '--no-warnings=punycode',
        'scripts/02-pull-from-google-drive.mjs',
        `--client=${clientId}`,
      ]);
    },
  },
  {
    name: 'validate-drive-assets',
    label: 'Validate Drive assets',
    hint: 'check folder structure, file naming & completeness of pulled assets',
    run: async () => {
      const clients = getClients();
      const allOption = '(all clients)';
      const choices = clients.length > 1 ? [allOption, ...clients] : clients;
      const picked =
        clients.length === 0
          ? allOption
          : clients.length === 1
            ? clients[0]
            : await selectFrom('Which client?', choices);
      const args = ['exec', 'node', 'scripts/validate-drive-assets.mjs'];
      if (picked !== allOption) args.push(`--client=${picked}`);
      run('pnpm', args);
    },
  },
  {
    name: 'organize-assets',
    label: '03 - Organize downloaded assets',
    hint: 'sort & rename pulled Drive assets into the expected structure',
    run: async () => {
      const driveClients = getDriveClients();
      if (driveClients.length === 0) {
        console.error('No client folders found in googleDrive/.');
        process.exit(1);
      }
      const clientId =
        driveClients.length === 1
          ? driveClients[0]
          : await selectFrom('Which client?', driveClients);
      run('pnpm', [
        'exec',
        'node',
        'scripts/03-organize-drive-assets.mjs',
        `--client=${clientId}`,
      ]);
    },
  },
  {
    name: 'process-excel',
    label: '04 - Process Excel data',
    hint: 'parse Excel spreadsheets from client assets into JSON',
    run: async () => {
      const clientId = await pickClient();
      run('pnpm', [
        'exec',
        'node',
        'scripts/04-process-excel-data.mjs',
        `--client=${clientId}`,
      ]);
    },
  },
  {
    name: 'extract-client-data',
    label: '05 - Extract client data',
    hint: 'choose between favicon fetch or master prompt generation',
    run: async () => {
      const extractChoices = [
        {
          name: 'favicon',
          message: 'Fetch favicon',
          hint: 'download favicon to public/favicon.ico',
        },
        {
          name: 'master-prompt',
          message: 'Generate master prompt',
          hint: 'scrape subpages and create prompt.md',
        },
      ];

      const extractPrompt = new Select({
        name: 'extractMode',
        message: 'What should be extracted?',
        choices: extractChoices,
      });

      const extractMode = await extractPrompt.run();
      if (extractMode === 'favicon') {
        run('pnpm', ['run', 'extract-favicon']);
        return;
      }

      run('pnpm', ['run', '05-extract-website:client-prompt']);
    },
  },
  {
    name: 'generate-website',
    label: '06 - Generate website',
    hint: 'generate website content from prompt.md',
    run: async () => {
      run('pnpm', ['exec', 'tsx', 'scripts/06-generate-website.ts']);
    },
  },
  {
    name: 'fetch-reviews',
    label: '07 - Fetch Google reviews',
    hint: 'pull Google Places reviews for locations with a googlePlacesId',
    run: async () => {
      const clientId = await pickClient();
      run('pnpm', ['exec', 'tsx', 'scripts/07-fetch-google-reviews.ts'], {
        CLIENT_ID: clientId,
      });
    },
  },
  {
    name: 'fetch-place-hero-address',
    label: 'Fetch Place address (hero + locationAddress)',
    hint: 'Google Places: formattedAddress → home.hero card2 + business.locationAddress (needs googlePlacesId + API key)',
    run: async () => {
      const clientId = await pickClient('Which client for the Place address?');
      const siteId = await pickSite(
        clientId,
        'Which site should get the address from Google Places?'
      );
      run('pnpm', [
        'run',
        'fetch-place-hero-address',
        '--',
        `--client-id=${clientId}`,
        `--site-id=${siteId}`,
      ]);
    },
  },
  {
    name: 'refine-website-data',
    label: '08 - Refine website data',
    hint: 'fill missing copy, validate links/images, AI content review (websites.json)',
    run: async () => {
      const clientId = await pickClient();
      run('pnpm', [
        'run',
        '08-refine-website-data',
        '--',
        `--client-id=${clientId}`,
      ]);
    },
  },
  {
    name: 'update-po-data',
    label: 'Update PO data',
    hint: 'pull all assets from Google Drive, then process Excel data into JSON',
    run: async () => {
      const clientId = await pickClient();
      run('pnpm', [
        'exec',
        'node',
        '--no-warnings=punycode',
        'scripts/update-po-data.mjs',
        `--client=${clientId}`,
      ]);
    },
  },
  {
    name: 'use-client',
    label: 'Activate client (use-client)',
    hint: 'switch active client by copying data into src/data/current/',
    run: async () => {
      const clientId = await pickClient();
      const siteId = await pickSite(clientId);
      run('pnpm', ['exec', 'tsx', 'scripts/use-client.ts', clientId, siteId]);
    },
  },
  {
    name: 'translate-data',
    label: 'Translate data',
    hint: 'translate website content into additional languages via AI',
    run: async () => {
      const clientId = await pickClient();
      const websiteIds = await pickWebsites(clientId);
      const allSites = getSiteIds(clientId);
      const args = ['exec', 'tsx', 'scripts/translation/translate-data.ts'];
      args.push(`--sites=${websiteIds.join(',')}`);
      run('pnpm', args, {
        CLIENT_ID: clientId,
      });
    },
  },
  {
    name: 'optimize-website-content',
    label: 'Optimize website content (AI)',
    hint: 'optimize copy fields for one website entry in websites.json',
    run: async () => {
      const clientId = await pickClient();
      run('pnpm', ['run', 'optimize-website-content', `--client=${clientId}`]);
    },
  },
  {
    name: 'generate-llm-txt',
    label: '(AI) llm.txt generation',
    hint: 'requires OPENROUTER_API_KEY; writes src/data/<client>/<site>/llm.txt + public/llm.txt',
    run: async () => {
      run('pnpm', ['run', 'generate-llm-txt']);
    },
  },
  {
    name: 'generate-grounding',
    label: '(AI) grounding page generation',
    hint: 'Ontology V2: one src/data/<client>/grounding.md for all sites + websites.json entries (OPENROUTER_API_KEY)',
    run: async () => {
      run('pnpm', ['run', 'generate-grounding']);
    },
  },
  {
    name: 'parallel-ai-pipeline',
    label: '09 - Generate llm.txt, grounding, internal links, translation',
    hint: 'translate-data first, then parallel: llm.txt, grounding, internal-links (pick client + site for llm.txt only)',
    run: async () => {
      const clientId = await pickClient();
      const siteId = await pickSite(
        clientId,
        'Which site for llm.txt? (grounding is once per client)'
      );
      run('pnpm', [
        'run',
        'parallel-ai-pipeline',
        '--',
        `--client=${clientId}`,
        `--site=${siteId}`,
      ]);
    },
  },
  {
    name: 'generate-internal-links',
    label: 'Generate internal links',
    hint: 'extract keywords and create cross-page internal links for SEO',
    run: async () => {
      run('pnpm', ['run', 'generate-internal-links']);
    },
  },
  {
    name: 'clone-website',
    label: 'Clone a website',
    hint: 'duplicate an existing website entry to use as a starting point',
    run: async () => {
      run('pnpm', ['exec', 'tsx', 'scripts/clone-website.ts']);
    },
  },
  {
    name: 'add-language',
    label: 'Add a language',
    hint: 'add a new language to the config and create translated content',
    run: async () => {
      run('pnpm', ['exec', 'tsx', 'scripts/add-language.ts']);
    },
  },
  {
    name: 'download-fonts',
    label: 'Download fonts',
    hint: 'download & subset Google Fonts from the theme config',
    run: async () => {
      run('pnpm', [
        'exec',
        'node',
        'scripts/05-extract-client-data.mjs',
        '--download-fonts',
      ]);
    },
  },
  {
    name: 'build-deploy',
    label: 'Build & deploy (Cloudflare)',
    hint: 'build the static site and deploy to Cloudflare Pages',
    run: async () => {
      run('node', ['scripts/dev/build-deploy-cf.mjs']);
    },
  },
];

type SectionName = 'Website Onboarding' | 'Other';

const sections: Array<{ title: SectionName; actions: string[] }> = [
  {
    title: 'Website Onboarding',
    actions: [
      'onboard',
      'create-client',
      'pull-assets',
      'organize-assets',
      'process-excel',
      'extract-client-data',
      'generate-website',
      'fetch-reviews',
      'fetch-place-hero-address',
      'refine-website-data',
      'parallel-ai-pipeline',
    ],
  },
  {
    title: 'Other',
    actions: [
      'update-po-data',
      'use-client',
      'validate-drive-assets',
      'download-fonts',
      'translate-data',
      'optimize-website-content',
      'generate-llm-txt',
      'generate-grounding',
      'generate-internal-links',
      'clone-website',
      'add-language',
      'build-deploy',
    ],
  },
];

function buildChoices() {
  const choices: Array<
    | { name: string; message: string; hint: string }
    | { role: 'separator'; message: string }
  > = [];

  for (const section of sections) {
    choices.push({ role: 'separator', message: `── ${section.title} ──` });
    for (const actionName of section.actions) {
      const def = actionDefs.find((a) => a.name === actionName);
      if (!def) continue;
      choices.push({
        name: def.name,
        message: def.label,
        hint: `— ${def.hint}`,
      });
    }
  }

  return choices;
}

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Master Script — Choose an action to run                ║
╚══════════════════════════════════════════════════════════╝
`);

  const prompt = new Select({
    name: 'action',
    message: 'What would you like to do?',
    choices: buildChoices(),
  });

  const actionName = await prompt.run();

  const selected = actionDefs.find((a) => a.name === actionName);
  if (!selected) {
    console.error('Unknown action.');
    process.exit(1);
  }

  console.log(`\n▶ Running: ${selected.label}\n`);
  await selected.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
