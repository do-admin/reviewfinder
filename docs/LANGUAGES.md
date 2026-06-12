# Language flow

## Data layout (per-client)

Language config and website JSON files live under **per-client** folders: `src/data/<client-id>/` (e.g. `src/data/stadtkueken/`). The app and scripts use the **active client** via `src/data/current/`, which must point to one of these folders.

**Before dev or build**, run once (and when switching client):

```bash
pnpm use-client stadtkueken
```

Scripts (e.g. `translate-data`, `add-language`, `fetch-google-reviews`) read and write the active client’s folder. With `CLIENT_ID` set they use that client folder directly; otherwise they use `current`. See README for full details.

## Config (single source of truth)

**`src/data/<client>/language.config.json`** (e.g. `src/data/current/language.config.json` after `pnpm use-client`)

- **`defaultLanguage`** — Used as `hreflang` x-default and as fallback when a translation is missing. Also used as the source language for the translate script.
- **`supportedLanguages`** — Which languages get `[lang]` routes and which page JSON files are used.
- **`translation`** (optional) — Script-only settings for `pnpm translate-data`: `sourceFile`, `targetLanguages`, `openRouter`, `skipKeys`. If `targetLanguages` is omitted, the script translates to all `supportedLanguages` except `defaultLanguage`.

Change this file to enable or disable languages. Only codes listed in `supportedLanguages` are built and loaded.

## Flow

1. **`src/lib/language.ts`**
   - Reads `language.config.json` and exports:
   - `DEFAULT_LANGUAGE`, `SUPPORTED_LANGUAGES`
   - `LANGUAGE_CONFIG` (labels, locale, hreflang, direction for switchers and SEO)
2. **Routes**
   - Astro `[lang]` routes (e.g. `/[lang]/[city].astro`) use `SUPPORTED_LANGUAGES` to generate one URL per language (e.g. `/de/...`, `/en/...`).
3. **Website data**
   - **`src/lib/page-data.ts`** loads JSON via Vite’s `import.meta.glob('/src/data/current/websites*.json')` (the active client folder):
   - **Default language** → `websites.json`
   - **Other languages** → `websites-{lang}.json` (e.g. `websites-en.json`)
   - Only files that exist are bundled. If a language has no file (or load fails), that language falls back to default-language data.

## Adding a new language

You can do it manually or use the helper script, then generate translations.

### Option A: Helper script (recommended)

From the project root:

```bash
pnpm add-language fr
```

This will:

- Add `fr` to `supportedLanguages` in the active client’s `src/data/<client>/language.config.json` (e.g. `src/data/current/language.config.json`).
- If the config has a `translation` section with `targetLanguages`, add `fr` there too.
- Print the remaining manual steps (see below).

### Option B: Manual steps

1. **Enable the language in config**
   - In the active client’s **`src/data/<client>/language.config.json`** (e.g. `src/data/current/language.config.json`), add the new code to the `supportedLanguages` array (e.g. `"fr"`).

2. **Register the language in code** (only if the code is not yet in `LANGUAGE_CONFIG`)
   - In **`src/lib/language.ts`**:
     - Add an entry in `LANGUAGE_CONFIG` with `name`, `nativeName`, `flag`, `locale`, `hreflang`, and `direction` (`'ltr'` or `'rtl'`). (Supported languages come from config; this is only for display in switchers.)

3. **Add or generate page data**
   - **Option 3a – Translate from source (recommended)**  
     - In the active client’s **`src/data/<client>/language.config.json`**, ensure the language is in `supportedLanguages`. If you use the optional `translation.targetLanguages` array, add the new code there too.
     - Set `OPENROUTER_API_KEY` in `.env.local`, then run:
       ```bash
       pnpm translate-data --lang=fr
       ```
     - This creates/overwrites **`src/data/<client>/websites-fr.json`** (e.g. `src/data/current/websites-fr.json`) from the source file (e.g. `websites.json`).
   - **Option 3b – No translation**  
     - Create **`src/data/<client>/websites-{lang}.json`** yourself, or leave it missing; the site will fall back to default-language data for that language.

4. **Rebuild**
   - Run `pnpm build` and verify the new `[lang]` routes and content.

### Translation script reference

The **`translate-data`** script reads the active client’s **`src/data/<client>/language.config.json`** (e.g. `src/data/current/language.config.json`):

- **Source language** — `defaultLanguage` from the config.
- **`translation`** (optional section):
  - **`sourceFile`** — Source JSON (e.g. `websites.json`). Defaults to `websites.json` if omitted.
  - **`targetLanguages`** — Codes to translate to; output files are `websites-{lang}.json` (or `websites.json` for the default language code). If omitted, the script uses all `supportedLanguages` except `defaultLanguage`.
  - **`openRouter`** — Model and base URL for the API.
  - **`skipKeys`** — Top-level keys whose string values are not translated (IDs, URLs, etc.).

**Usage:**

```bash
# Ensure active client is set (e.g. pnpm use-client stadtkueken)
# Translate to all target languages (from translation.targetLanguages or supportedLanguages \ defaultLanguage)
pnpm translate-data

# Translate only to one or more languages
pnpm translate-data --lang=fr
pnpm translate-data --lang=fr,es
```

Requires **`OPENROUTER_API_KEY`** in `.env.local`. The script calls OpenRouter (e.g. Gemini) and writes the translated JSON under the active client’s folder (e.g. `src/data/current/`).

## File mapping

| Language role | JSON file (under active client, e.g. `src/data/current/`) |
| ------------- | --------------------------------------------------------- |
| Default       | `websites.json`                                           |
| Other         | `websites-{lang}.json`                                    |


