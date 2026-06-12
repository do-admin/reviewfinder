This is a multi-client, multi-website Astro template for building location-based sites.

**For converting another React repository to this structure**, see [docs/TEMPLATE-CONVERSION-GUIDE.md](docs/TEMPLATE-CONVERSION-GUIDE.md) — a comprehensive architecture and conversion guide for AI or human implementers.

## Data layout (per-client)

Website and language data are organised **per client** under `src/data/<client-id>/` (e.g. `src/data/stadtkueken/`). Each client folder contains:

- `websites.json`, `websites-{lang}.json`
- `language.config.json`
- `cities.json`
- `theme.config.json` (colors and fonts; see [Theme](#theme-colors--fonts))

The app and build always use a single **active client** via `src/data/current/`, which is a symlink (or copy) pointing to the chosen client folder. **You must run this once after clone (and whenever you switch client):**

```bash
pnpm use-client stadtkueken
```

- **Without `CLIENT_ID`:** Scripts and the app use `src/data/current/` (whatever client you set with `pnpm use-client <client-id>`).
- **With `CLIENT_ID`:** Set `CLIENT_ID` to target a specific client folder, e.g. `CLIENT_ID=stadtkueken pnpm translate-data`. The deploy script sets `current` from `CLIENT_ID` before building.

Default client id is `stadtkueken`. `src/data/current/` is gitignored.

## Theme (colors & fonts)

Site-wide colors and fonts are configured **per client** in **`src/data/<client>/theme.config.json`** (e.g. `src/data/current/theme.config.json` after `pnpm use-client stadtkueken`). Edit the active client’s theme config to change:

- **`colors`** – Optional. Single object for all color overrides. Use **semantic keys** (`primary`, `primary-foreground`, `accent`, `background`, `foreground`, `card`, `muted`, `destructive`, `border`, `input`, `ring`, `radius`, etc.) in **HSL component form** (e.g. `"328 85% 46%"`) so they map to `--primary`, `--accent`, etc. Any other key is emitted as `--color-<key>` and can use any CSS color value.
- **`fonts`** – **`body`** = body text, **`heading`** = headings. Each has `family` and `fallback`. Any font name works: for **system fonts** (e.g. Times New Roman) set `family` and set **`googleFontsUrl`** to `""` so no stylesheet is loaded; for **web fonts** set `googleFontsUrl` to the stylesheet URL that loads those families.
- **`googleFontsUrl`** – URL for the font stylesheet (e.g. Google Fonts). Omit or set to `""` for system fonts only.

When you run `pnpm use-client <client-id>`, the app loads that client’s `theme.config.json`. **Before dev**, colors from the active client’s theme are synced into `src/styles/globals.css` (semantic keys only): run `pnpm sync-theme` manually, or rely on `pnpm dev`, which runs `sync-theme` first via `predev`. After changing the config, restart the dev server or rebuild. See `src/lib/theme.ts` for the loader and `src/styles/globals.css` for the design tokens.

### Scraping colors from a website

You can seed `colors` (primary, secondary, accent and their foregrounds) from an existing website using a headless browser. The script samples computed styles from header, nav, links, buttons and headings, then infers primary/secondary/accent in HSL component form.

**First time:** Install the browser used by the script (if you see “Could not find Chrome”):

```bash
pnpm exec puppeteer browsers install chrome
```

**Usage:**

```bash
pnpm scrape-colors https://example.com
```

Prints suggested `colors` JSON to stdout. To merge into the active client’s theme config:

```bash
pnpm scrape-colors https://example.com --write
```

To merge into a specific client folder (e.g. `src/data/nicezeit/theme.config.json`) without switching the active client:

```bash
pnpm scrape-colors https://example.com --write --client=nicezeit
```

After `--write`, run `pnpm sync-theme` (or restart `pnpm dev`) so `globals.css` is updated.

### Downloading fonts from a website

You can detect body and heading fonts from a live URL and either use Google Fonts (no download) or download non-Google fonts, subset them to Latin (woff2), and update the client’s theme config.

**Prerequisites**

- Same as scrape-colors: if the script can’t find Chrome, run:
  ```bash
  pnpm exec puppeteer browsers install chrome
  ```
- Dependencies (`subset-font`, `puppeteer`) are installed with `pnpm install`.

**Steps to run**

1. **From `websites.json` domain (interactive client / site):**

   ```bash
   pnpm download-fonts
   ```
   Same as `pnpm 05-extract-website:fonts`. Resolves the scrape URL from `clientDomain` and updates `theme.config.json`.

2. **Explicit URL + client:**

   ```bash
   pnpm download-fonts -- --fonts-url=https://example.com --client=nicezeit
   ```

   Fonts go under `public/fonts/<FamilyName>/`; theme: `src/data/nicezeit/theme.config.json`.

3. **Detect only (JSON to stdout, no theme write):**

   ```bash
   pnpm download-fonts -- --fonts-json --fonts-url=https://example.com
   ```

**What the script does**

- Opens the URL in headless Chrome and detects body font (from `document.body` or first `p`) and heading font (first `h1`/`h2`/`h3`).
- For each font: if it’s a **Google Font**, it adds it to the combined Google Fonts URL (no local files). If **not**, it fetches `@font-face` from the page’s CSS, downloads each face, subsets to **Latin** (covers German ä ö ü ß) with `subset-font`, and writes **woff2** files plus a `fonts.css` with `unicode-range` and `font-display: optional` (headings) or `swap` (body).
- When not using `--fonts-json`, merges `fonts.body`, `fonts.heading`, and either `googleFontsUrl` or `fontStylesheetUrls` into the client’s `theme.config.json` (implementation: `scripts/05-extract-client-data.mjs --download-fonts`).

**After updating the theme**

- If you use `pnpm dev`, the layout already loads fonts from the theme (Google URL or `/fonts/.../fonts.css`). Run `pnpm sync-theme` or restart `pnpm dev` so `globals.css` reflects any theme changes.

### Pulling files from Google Drive

Images, documents, and the client data Excel sheet are pulled from Google Drive using a service account.

#### One-time setup (per repo)

1. **Google Cloud:** Create a project, enable the **Google Drive API**, create a **Service Account**, download its JSON key. Save the key as `google-drive-credentials.json` in the repo root (gitignored).
2. **Share the folder:** In Google Drive, share the client's root Drive folder with the service account email (e.g. `xxx@project.iam.gserviceaccount.com`) as **Viewer**.
3. **Config:** Edit `scripts/pull-from-google-drive.config.json` — shared settings only (credentials path, output dirs, extra files to download):
   ```json
   {
     "credentialsPath": "google-drive-credentials.json",
     "siteFolderPrefix": "site-",
     "outputBaseDir": "googleDrive",
     "extraFiles": ["data.xlsx"],
     "extraFilesOutputDir": "googleDrive"
   }
   ```

#### Per-client setup (⚠️ required for each new client)

Set `driveFolderId` at the top level of the client's **`src/data/<client>/websites.json`**:

```json
{
  "driveFolderId": "<Google Drive root folder ID>",
  "sectionIds": [...],
  "websites": [...]
}
```

The folder ID is the long string in the Google Drive URL:
`https://drive.google.com/drive/folders/`**`1VhDVolLL-IQloGi3PcMJ99YiroTMCoCe`**

The script auto-discovers all clients that have this field set — no changes to the config file are needed when adding a new client.

#### Usage

```bash
pnpm 02-pull-assets                     # pull all site-* image folders (+ data.xlsx)
pnpm 02-pull-assets --client=nicezeit   # pull only the nicezeit client
pnpm pull-data                       # pull only data.xlsx (client data sheet)
```

When multiple clients have a `driveFolderId` configured and no `--client` flag is given, the script prompts you to pick one interactively.

After pulling, the script offers to run `pnpm organize-assets` which moves files into the correct `public/images/` paths and applies the Excel data to `websites.json` and `language.config.json`.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Translation service

Website data is stored in the **active client** folder (e.g. `src/data/current/` after `pnpm use-client stadtkueken`) as `websites.json` and `websites-{lang}.json`. To (re)generate translations from the source file using **OpenRouter** and **Gemini 3.0 Pro Preview**:

1. Ensure the active client is set: `pnpm use-client stadtkueken` (or set `CLIENT_ID` when running scripts).
2. Create or edit `.env.local` and set:
   ```bash
   OPENROUTER_API_KEY=your_openrouter_api_key
   ```
3. Adjust `src/data/<client>/language.config.json` (e.g. `src/data/current/language.config.json`) if needed: the optional **`translation`** section (sourceFile, targetLanguages, openRouter, skipKeys) controls the translate script. If `translation.targetLanguages` is omitted, the script translates to all `supportedLanguages` except `defaultLanguage`.
4. Run:
   ```bash
   pnpm translate-data           # all target languages from config
   pnpm translate-data --lang=en # only English
   pnpm translate-data --lang=uk,tr
   ```

Output is written to the active client’s folder (e.g. `src/data/current/websites-{lang}.json`). The script translates each website object in sequence and adds a short delay between API calls.

## Languages

Which languages the site uses is controlled by **`src/data/<client>/language.config.json`** (e.g. `src/data/current/language.config.json` after `pnpm use-client`):

- **`defaultLanguage`**: Used for `websites.json` (no suffix) and as hreflang `x-default`.
- **`supportedLanguages`**: List of language codes that get `[lang]` routes and website data. Only these codes are used for static paths, language switchers, and `getPageData` / website lookup.

To enable only German and English, set `"supportedLanguages": ["de", "en"]` and ensure `websites.json` and `websites-en.json` exist in the client folder. Add or remove codes to match the `websites-{lang}.json` files you have.

## Google Reviews

To refresh Google Reviews in the page data JSON files (no database):

1. Set `GOOGLE_PLACES_API_KEY` in `.env.local`.
2. Ensure the active client is set (`pnpm use-client stadtkueken`). For each website in that client’s `websites.json`, set `business.googlePlacesId` to its Google Place ID where reviews should be fetched.
3. Run:
   ```bash
   pnpm fetch-google-reviews                    # fetch reviews for all pages that have a place ID
   pnpm fetch-google-reviews --page-id=kita-putte-wandsbek   # only this page
   ```
   Place IDs are read from the client’s `websites.json`; the script fetches from the Google Places API and updates `reviews.reviewData` in that client’s `websites.json` and all `websites-*.json` for the matching pages.

## Metadata

### Schema.org Data

Organization and WebSite schema data is configured per page via `metadata.schema` in each website’s first page in the active client’s `websites.json` (e.g. `src/data/current/websites.json`). If the company has service offerings, add a `hasOfferCatalog` to the organization schema:

```json
"hasOfferCatalog": {
  "name": "Service Offerings",
  "itemListElement": [
    { "name": "Service A", "description": "Description of service A", "url": "/services/a" },
    { "name": "Service B", "description": "Description of service B" }
  ]
}
```

The catalog is optional and will only be included in the JSON-LD output when present.
