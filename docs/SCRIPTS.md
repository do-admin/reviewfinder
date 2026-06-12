# Scripts Reference

Quick reference for all scripts in the `scripts/` directory. Run via `pnpm <command>`.

## Master & Onboarding

| Command                 | Script                | Description                                                                                                                                                                                           |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm master`           | `master.ts`           | Interactive CLI menu that lists all available actions and runs the selected command.                                                                                                                  |
| `pnpm onboard-client`   | `onboard-client.ts`   | Runs the full client onboarding pipeline: create client, pull Drive assets, extract data, generate website, apply theme, and optional translations/reviews. Supports flags to skip or isolate phases. |
| `pnpm 01-create-client` | `01-create-client.ts` | Scaffolds `src/data/<clientId>/` with default config files (`websites.json`, `theme.config.json`, `language.config.json`).                                                                            |

## Website Generation

| Command                         | Script                        | Description                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm 06-generate-website`      | `06-generate-website.ts`      | Uses an LLM (via OpenRouter) to generate a new website entry in `websites.json` from a prompt, using an existing entry as a structural template.                                                                                               |
| `pnpm clone-website`            | `clone-website.ts`            | Duplicates an existing `websites.json` entry into a new site, using an LLM to update location-specific fields while preserving shared structure.                                                                                               |
| `pnpm optimize-website-content` | `optimize-website-content.ts` | Optimizes copy-only fields for one website entry in `websites.json` via OpenRouter (default Claude Opus), creates a backup, and writes updates in place. Field selection is driven by `src/data/<client>/content-optimization.allowlist.json`. |

## Development

| Command           | Script                      | Description                                                                                                                                 |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`        | `dev-with-prompt.mjs`       | Prompts for client/site, runs `use-client`, then starts the Astro dev server.                                                               |
| `pnpm use-client` | `use-client.ts`             | Sets the active client by symlinking data into `src/data/current` and writing `CLIENT_ID`, `SITE_ID`, `DEPLOY_DOMAIN` to `.env.local`.      |
| `pnpm sync-theme` | `sync-theme-to-globals.mjs` | Reads `theme.config.json` and writes semantic color/font CSS variables into `src/styles/globals.css`. Runs automatically before `pnpm dev`. |

## Google Drive Assets

| Command                      | Script                                       | Description                                                                                     |
| ---------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm 02-pull-assets`        | `02-pull-from-google-drive.mjs`              | Downloads files from Google Drive using a service account. Supports `--excel-only` mode.        |
| `pnpm pull-data`             | `02-pull-from-google-drive.mjs --excel-only` | Downloads only Excel files from Google Drive.                                                   |
| `pnpm organize-assets`       | `03-organize-drive-assets.mjs`               | Maps downloaded Drive files into the paths expected by `websites.json` and `public/`.           |
| `pnpm validate-drive-assets` | `validate-drive-assets.mjs`                  | Validates Drive folder layout and naming conventions; can trigger a pull if assets are missing. |

## Data Extraction & Processing

| Command                       | Script                                       | Description                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm 05-extract-client-data` | `05-extract-client-data.mjs`                 | Scrapes a live site via Firecrawl to fill Impressum and social fields in `websites.json`. Supports optional `--client-prompt` mode to generate `prompt.md` and `topics.json` from multiple subpages.            |
| `pnpm extract-client-prompt`  | `05-extract-client-data.mjs --client-prompt` | Scrapes brand-relevant subpages, analyzes topics/headlines (JSON), then writes `src/data/<client>/<siteId>/prompt.md` and `topics.json` via OpenRouter (model: `--model=` or `OPENROUTER_MODEL_CLIENT_PROMPT`). |
| `pnpm extract-favicon`        | `05-extract-client-data.mjs --favicon`       | Fetches the favicon from the homepage and saves it to `public/favicon.ico`.                                                                                                                                     |
| `pnpm 04-process-excel-data`  | `04-process-excel-data.mjs`                  | Reads `.xlsx` files from Drive, matches rows to sites by domain, and patches `websites.json` with contacts, socials, legal fields, etc.                                                                         |
| `pnpm 07-fetch-google-reviews` | `07-fetch-google-reviews.ts`                 | Calls the Google Places API using `business.googlePlacesId` and merges review data into the home page’s `reviews.reviewData` in `websites.json`.                                                              |

## Translation & Languages

| Command               | Script              | Description                                                                                             |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm add-language`   | `add-language.ts`   | Adds a language to `language.config.json` and can trigger translation to create `websites-<lang>.json`. |
| `pnpm translate-data` | `translate-data.ts` | Translates `websites.json` to target languages via OpenRouter, outputting per-language JSON files.      |

## Build & Deploy

| Command             | Script                                         | Description                                                                |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm build`        | Astro build + `generate-sitemap-from-dist.mjs` | Builds the site and generates `dist/sitemap.xml` from the static output.   |
| `pnpm build:deploy` | `build-deploy-cf.mjs`                          | Builds the site and deploys to Cloudflare (R2 upload + worker/KV routing). |

## Content Generation

| Command                              | Script                              | Description                                                                                                               |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm generate-programmatic-content` | `generate-programmatic-content.mjs` | Generates `programmaticData.json` for location pages from `programmatic-locations-input.json` using an LLM or a template. |
| `pnpm generate-llm-txt`              | `generate-llm-txt.mjs`              | Builds `public/llm.txt` — an AI-oriented site summary for LLM consumption — using OpenRouter.                             |

## Lovable / React → Astro (Ralph migration)

Canonical implementation: **`conversion-kit/`** (copy that folder into any repo). See [conversion-kit/README.md](../conversion-kit/README.md). Files under `scripts/` delegate to the kit.

| Command                            | Script (under `conversion-kit/`)  | Description                                                                                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm migrate:lovable-to-scaffold` | `migrate-lovable-to-scaffold.mjs` | Copies `template-scaffold` into a destination folder, merges a Lovable/Vite repo (`src/`, `public/`), and generates Astro pages under `[lang]/`. Optional `--generate-ralph` writes `prd.md`, `PROMPT.md`, `activity.md`. See [MIGRATE-LOVABLE-RALPH.md](./MIGRATE-LOVABLE-RALPH.md). |
| `pnpm generate:ralph-conversion`   | `generate-ralph-conversion.mjs`   | (Re)generates Ralph PRD/PROMPT/activity in an existing migrated project.                                                                                                                                                                                                              |
| `pnpm ralph:convert`               | `ralph-convert.sh`                | Runs `claude -p "$(cat PROMPT.md)"` in a loop until `<promise>COMPLETE</promise>` or max iterations. Pass args after `--` (e.g. `pnpm ralph:convert -- 25 /path/to/dest`).                                                                                                            |
| `pnpm audit:conversion`            | `audit-conversion.mjs`            | Final completeness audit via Claude (default model `opus-4.6`, override with `CLAUDE_AUDIT_MODEL`).                                                                                                                                                                                   |

## Utilities

| Command               | Script                                        | Description                                                                                                                           |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm download-fonts` | `05-extract-client-data.mjs --download-fonts` | Detects fonts from a URL and updates `theme.config.json`; use `--fonts-url=` / `--client=` etc. See script header.                    |
| `pnpm scrape-colors`  | `scrape-website-colors.mjs`                   | Scrapes colors from a website for theme configuration.                                                                                |
| —                     | `reactToAstro.mjs`                            | Deprecated stub — prints how to run `pnpm migrate:lovable-to-scaffold` (see [conversion-kit/README.md](../conversion-kit/README.md)). |
