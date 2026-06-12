/**
 * Loads AI system/user prompt text from scripts/prompts/website-ai-prompts.md.
 * Sections are delimited by <<<SECTION:name>>> ... (newline) [optional spaces/tabs] <<<END>>>.
 * Placeholders {{VAR}} are filled via interpolateAiPrompt / buildAiPrompt.
 */

import fs from 'fs';
import path from 'path';

const PROMPTS_FILE = path.join(
  __dirname,
  '..',
  'prompts',
  'website-ai-prompts.md'
);

let sectionCache: Map<string, string> | null = null;

function loadSections(): Map<string, string> {
  if (sectionCache) return sectionCache;
  const raw = fs.readFileSync(PROMPTS_FILE, 'utf8');
  const map = new Map<string, string>();
  const re = /<<<SECTION:([\w-]+)>>>\s*\n([\s\S]*?)\n[ \t]*<<<END>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    map.set(m[1], m[2].replace(/\r\n/g, '\n').trimEnd());
  }
  if (map.size === 0) {
    throw new Error(
      `No prompt sections found in ${PROMPTS_FILE} (expected <<<SECTION:name>>> ... <<<END>>>)`
    );
  }
  sectionCache = map;
  return map;
}

/** @internal — tests can clear cache after rewriting the file */
export function clearAiPromptCache(): void {
  sectionCache = null;
}

export function getAiPromptSection(section: string): string {
  const map = loadSections();
  const body = map.get(section);
  if (body === undefined) {
    throw new Error(
      `Missing AI prompt section "${section}" in website-ai-prompts.md (available: ${[...map.keys()].sort().join(', ')})`
    );
  }
  return body;
}

export function interpolateAiPrompt(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(
        `Missing placeholder value for {{${key}}} in AI prompt template`
      );
    }
    return vars[key];
  });
}

export function buildAiPrompt(
  section: string,
  vars: Record<string, string>
): string {
  return interpolateAiPrompt(getAiPromptSection(section), vars);
}

export function buildProtectedPathsBlockForAi(paths: string[]): string {
  const bullets = paths.map((p) => `  • ${p}`).join('\n');
  const body = buildAiPrompt('protected-paths-block', {
    PATH_BULLETS: bullets,
  });
  // Match legacy join([ '', ...parts, '' ]) — leading/trailing newlines for chunk/full-generation prompts
  return `\n${body}\n`;
}
