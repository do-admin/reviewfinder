/**
 * Adds a new language to the template by updating the central config.
 *
 * - Adds the code to supportedLanguages in src/data/language.config.json
 * - If present, adds the code to translation.targetLanguages in the same file
 *
 * Optionally runs translate-data to generate websites-{lang}.json from the default language.
 * Does NOT edit src/lib/language.ts (you may add LANGUAGE_CONFIG there for display names).
 *
 * Usage: pnpm add-language              (interactive: asks which language)
 *    or: pnpm add-language <code>        e.g. pnpm add-language fr
 *    or: pnpm add-language --lang=fr
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import inquirer from 'inquirer';

const DEFAULT_CLIENT = 'current';
const DATA_DIR = path.join(
  process.cwd(),
  'src',
  'data',
  process.env.CLIENT_ID || DEFAULT_CLIENT
);
const LANGUAGE_CONFIG_PATH = path.join(DATA_DIR, 'language.config.json');

/** Validate language code (BCP 47) and return canonical code, or null if invalid. */
function validateLanguageCode(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length < 2 || trimmed.length > 8) return null;
  try {
    const canonical = Intl.getCanonicalLocales(trimmed);
    if (canonical.length === 0) return null;
    return canonical[0].toLowerCase();
  } catch {
    return null;
  }
}

/** Get full language name in English for a valid BCP 47 code. */
function getLanguageDisplayName(code: string): string {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

function parseArgs(): string | null {
  const langArg = process.argv.find((a) => a.startsWith('--lang='));
  if (langArg) {
    const code = langArg.replace('--lang=', '').trim().toLowerCase();
    return code.length >= 2 && code.length <= 3 ? code : null;
  }
  const positional = process.argv[2];
  if (positional && /^[a-z]{2,3}$/i.test(positional)) {
    return positional.toLowerCase();
  }
  return null;
}

type LanguageConfig = {
  defaultLanguage?: string;
  supportedLanguages?: string[];
  description?: string;
  translation?: {
    sourceFile?: string;
    targetLanguages?: string[];
    openRouter?: unknown;
    skipKeys?: string[];
  };
};

function getSourceLanguage(): string {
  if (!fs.existsSync(LANGUAGE_CONFIG_PATH)) return 'de';
  const raw = fs.readFileSync(LANGUAGE_CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as LanguageConfig;
  return config.defaultLanguage ?? 'de';
}

async function main(): Promise<void> {
  let code: string | null = parseArgs();

  if (!code) {
    const { languageCode } = await inquirer.prompt<{ languageCode: string }>([
      {
        type: 'input',
        name: 'languageCode',
        message:
          'Which language do you want to add? (enter a 2–3 letter code, e.g. fr, es, de)',
        validate: (input: string) => {
          const canonical = validateLanguageCode(input);
          if (!canonical)
            return 'Please enter a valid language code (e.g. fr for French, es for Spanish).';
          return true;
        },
      },
    ]);
    code =
      validateLanguageCode(languageCode) ?? languageCode.trim().toLowerCase();
  } else {
    const canonical = validateLanguageCode(code);
    if (!canonical) {
      console.error(
        `Invalid language code: "${code}". Use a valid BCP 47 code (e.g. fr, es).`
      );
      process.exit(1);
    }
    code = canonical;
  }

  const languageName = getLanguageDisplayName(code);
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Add language: ${languageName} (${code}). Continue?`,
      default: true,
    },
  ]);
  if (!confirmed) {
    console.log('Cancelled.');
    process.exit(0);
  }

  console.log(`\nAdding language: ${languageName} (${code})\n`);

  if (fs.existsSync(LANGUAGE_CONFIG_PATH)) {
    const raw = fs.readFileSync(LANGUAGE_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as LanguageConfig;
    let updated = false;

    // supportedLanguages
    const supportedList = config.supportedLanguages ?? [];
    if (!supportedList.includes(code)) {
      supportedList.push(code);
      config.supportedLanguages = supportedList;
      updated = true;
      console.log(`Added "${code}" to supportedLanguages in language.config.json`);
    } else {
      console.log(`"${code}" already in supportedLanguages (language.config.json)`);
    }

    // translation.targetLanguages (optional)
    if (config.translation && Array.isArray(config.translation.targetLanguages)) {
      const targetList = config.translation.targetLanguages;
      if (!targetList.includes(code)) {
        targetList.push(code);
        config.translation.targetLanguages = targetList;
        updated = true;
        console.log(`Added "${code}" to translation.targetLanguages in language.config.json`);
      } else {
        console.log(`"${code}" already in translation.targetLanguages`);
      }
    }

    if (updated) {
      fs.writeFileSync(
        LANGUAGE_CONFIG_PATH,
        JSON.stringify(config, null, 2) + '\n'
      );
    }
  } else {
    console.warn('language.config.json not found, skipping');
  }

  const sourceLang = getSourceLanguage();
  const { runTranslate } = await inquirer.prompt<{ runTranslate: boolean }>([
    {
      type: 'confirm',
      name: 'runTranslate',
      message: `Run translation now from ${sourceLang} to ${code}? (Creates websites-${code}.json via OpenRouter; requires OPENROUTER_API_KEY in .env.local)\n\x1b[31mNote: This will incur API costs. Use sparingly!\x1b[0m`,
      default: true,
    },
  ]);

  if (runTranslate) {
    console.log(`\nRunning: pnpm translate-data --lang=${code} --sites=all\n`);
    const result = spawnSync(
      'pnpm',
      ['translate-data', '--lang=' + code, '--sites=all'],
      {
        stdio: 'inherit',
        shell: true,
        cwd: process.cwd(),
      }
    );
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  const knownCodes = ['de', 'en', 'sq', 'uk', 'tr', 'ar', 'hi'];
  const needsLanguageTs = !knownCodes.includes(code);

  console.log('');
  const steps: string[] = [];
  if (needsLanguageTs) {
    steps.push(
      `In src/lib/language.ts, add "${code}" to LANGUAGE_CONFIG (name, nativeName, flag, locale, hreflang, direction) for display in language switchers.`
    );
  }
  if (!runTranslate) {
    steps.push(
      `Generate website data: pnpm translate-data --lang=${code} (creates websites-${code}.json; requires OPENROUTER_API_KEY in .env.local)`
    );
  }
  steps.push('Run pnpm build and verify the new language.');

  if (steps.length > 0) {
    console.log('Next steps:');
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }
}

main();
