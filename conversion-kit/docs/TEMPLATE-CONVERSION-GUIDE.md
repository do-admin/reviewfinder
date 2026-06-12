# Template.Location Repository: Architecture and Conversion Guide

## Purpose

This document describes the complete architecture, patterns, and features of the `template.location` repository — a multi-client, multi-website Astro template. The goal is to provide enough detail for another AI to convert any existing React repository into this same structure.

- **Greenfield / new client in this repo:** run **`pnpm onboard-client`** (see §15) so client folders, Drive assets, AI-generated `websites.json` entries, theme sync, and optional translation/programmatic/reviews run in the correct order. Use **`pnpm 01-create-client`** / **`pnpm 06-generate-website`** only when you need a single step.
- **Migrate an existing React (or other) codebase into this template:** follow **§16 Conversion Instructions** end-to-end (analysis-first); do not rely on `onboard-client` alone, because route and component inventory drives the data model.

**When implementing a conversion:** use the **Conversion Todo List** in §16 to track progress; mark each item with `[x]` as you complete it.

---

## 1. High-Level Architecture

The repository is an **Astro 4** static site generator with **React 19** components, **Tailwind CSS 4**, and **Radix UI**. It is designed to:

- Serve as a **template for many different clients** (one repo instance per client)
- Build **multiple websites per client** from a single codebase
- Drive **all content from JSON data files** — nothing is hardcoded in page files
- Support **multi-language** with automated AI translation
- Support **programmatic location pages** (city/district/suburb pages)
- Provide **theming** (colors + fonts) per client via config
- Include a **text editor** for inline content editing
- Include **scripts** for automation (translation, font downloading, content generation, deployment)

### Tech Stack

- **Framework**: Astro 4 (static output mode) with `@astrojs/react`
- **UI**: React 19, Radix UI, Tailwind CSS 4, `tailwindcss-animate`, shadcn-style primitives under `src/components/ui/`
- **Language**: TypeScript 5
- **Package Manager**: pnpm
- **Deployment**: **Cloudflare R2** (primary static deploy via `pnpm build:deploy`) and **Vercel** (`vercel.json` / CLI optional)
- **Notable dependencies** (automation / content): `xlsx`, `html-react-parser`, `@aws-sdk/client-s3`, `@mendable/firecrawl-js`, `openai` (dev), `googleapis` (dev), `puppeteer` (dev), `dotenv`, `enquirer` / `inquirer`, `gray-matter`; dev CSS helper `tw-animate-css`

---

## 2. Directory Structure

```
template.location/
  astro.config.mjs          # site URL fallback (SITE_URL, DEPLOY_DOMAIN, websites.json domains)
  tsconfig.json             # @/* -> ./src/*, @/data/* -> ./src/data/current/*
  tailwind.config.ts        # CSS variable-based theming (HSL)
  postcss.config.mjs        # @tailwindcss/postcss
  eslint.config.mjs         # ESLint flat config
  components.json           # shadcn-style component config
  vercel.json               # Optional Vercel deployment
  package.json              # Scripts and dependencies

  src/
    data/                   # Per-client data folders
      <client-id>/          # One folder per client (e.g. nicezeit)
        websites.json       # PRIMARY: default language (may include top-level client + sectionIds)
        websites-<lang>.json
        theme.config.json
        language.config.json
        programmatic-locations-input.json   # Optional: programmatic SEO locations
        programmaticData.json               # Generated programmatic page bodies
        internalLinks.json                  # Optional: related links for RelatedLinks component
        <site-id>/            # Per-website subfolder (Drive / prompts / extras)
          faq.json, faq-xxl.json, partners.json, prompt.md, topics.json
          grounding.md, *.xlsx, etc.
      current/              # Symlink to active client (gitignored)

    components/             # React (data-driven sections + ui/)
    layouts/                # BaseLayout, PageContent
    pages/                  # Astro routes (see §6)
    lib/                    # page-data, language, theme, schema-org, global-schema,
                            # programmatic-data, internal-links, trust-data, utils
    types/                  # page.ts (WebsiteData, ResolvedPageData, legal, ratgeber, FAQ XXL)
    styles/                 # globals.css (@theme + :root; sync-theme writes overrides)
    utils/                  # Shared utilities
    content/                # Astro content collections (e.g. ratgeber/*.md + config.ts)

  scripts/                  # Pipeline scripts
    dev/                    # dev-with-prompt.mjs, sync-theme-to-globals.mjs, build-deploy-cf.mjs, master.ts
    translation/            # translate-data.ts, add-language.ts
    prompts/                # e.g. grounding generation prompt markdown
    *.ts / *.mjs            # Numbered steps, onboard-client, generate-*, etc.

  conversion-kit/           # Lovable → scaffold migration, Ralph PRD, audit (see §16)
  googleDrive/              # Drive sync output / staging (per project usage)
  text-editor/              # Inline editor, apply-edits, llm.txt helpers
  public/                   # Static assets, llm.txt (`public/images/` gitignored — generated/synced)
  docs/                     # This guide and related docs
```

**Per-site data**: Under `src/data/<client-id>/<site-id>/`, optional JSON/Markdown/XLSX files back AI prompts, FAQs, partners, grounding pages, and Excel-driven patches — keep paths aligned with `websites.json` and scripts that read them.

---

## 3. Multi-Client System

### 3.1 Client Switching (`scripts/use-client.ts`)

Each client has a folder under `src/data/<client-id>/`. The active client is determined by a symlink:

```
src/data/current/ -> src/data/<client-id>/
```

**Command**: `pnpm use-client <client-id>` creates this symlink and, by default, writes **`CLIENT_ID`**, **`SITE_ID`**, and **`DEPLOY_DOMAIN`** (plus related fields) into **`.env.local`** so dev/build pick the right site and canonical URL.

The `@/data` path alias (in both `tsconfig.json` and `astro.config.mjs`) resolves to `src/data/current/`, so all imports like `import data from '@/data/websites.json'` automatically use the active client's data.

`src/data/current/` is **gitignored** — each deployment/dev environment sets its own active client.

### 3.2 Environment Variables

- `SITE_ID` / `CLIENT_ID` — which website entry to render from `websites.json`
- `SITE_URL` — canonical base URL for Astro `site` (sitemap, absolute URLs)
- `DEPLOY_DOMAIN` — optional; used by `astro.config.mjs` `getFallbackSiteUrl()` and post-build sitemap when `SITE_URL` is unset (also aligns with `use-client` output)
- `KITA_ID` / `PAGE_ID` — some `[lang]` pages read these for defaults in dev (see page files)

`astro.config.mjs` resolves the public site URL in order: `process.env.SITE_URL`, else `DEPLOY_DOMAIN`, else domains from `src/data/current/websites.json` (`deployDomain` / `clientDomain` / top-level `clientDomain`).

---

## 4. Data Model (`websites.json`)

This is the **single source of truth** for all website content. The file lives at `src/data/<client>/websites.json`. The structure of this file is **NOT fixed** — it must be derived by the converting AI from analyzing the source repository.

### 4.1 Top-Level Structure

The loader accepts two shapes (see `WebsitesFile` in `src/types/page.ts`):

1. **Bare array** — `[ { ...WebsiteData }, ... ]` (legacy / minimal).
2. **Object with metadata** (typical for Drive / multi-site clients):

```json
{
  "driveFolderId": "<optional Google Drive folder id>",
  "clientName": "Display Name",
  "clientDomain": "example.com",
  "sectionIds": [
    { "id": "hero", "visible": true },
    { "id": "info", "visible": true }
  ],
  "websites": [
    {
      "/* WebsiteData — see below */"
    }
  ]
}
```

- **`sectionIds`**: array of **`SectionConfig`** objects `{ "id": "<SectionId>", "visible": boolean }` — **not** a plain string array. Which **`id`** values are valid depends on the target template (the JSON above uses illustrative IDs only). Use that template’s section list or types — do not copy IDs from a different template. Defaults for visibility merge with per-site `sectionVisibility`.
- **`websites`**: array of website entries; each entry is one deployable site (location, brand, etc.).
- **`clientDomain`** (top-level): optional; used when resolving canonical host if a site omits `deployDomain` / `clientDomain`.

### 4.2 WebsiteData Object (AI-Determined)

The converting AI must determine this structure by performing the following analysis:

**Phase 1 — Inventory all pages and routes** in the source repository. For each page, catalog:

- The page name/route
- All visible text content (headings, paragraphs, labels, button text, alt text, etc.)
- All images and their contexts
- Any structured data (FAQs, team members, pricing tiers, etc.)
- Metadata (title, description, OG tags, etc.)

**Phase 2 — Separate content into two layers:**

**Layer 1 — Global site chrome** (content shared across ALL pages of a website):

Core fields (adapt names to the source repo; this template’s types expect at least):

- `id`: unique website id
- **`deployDomain`** / **`clientDomain`**: public site host(s); `deployDomain` is preferred for production URL resolution
- `googleTagId`: GA/GTM (may be empty)
- **`business`**: rich object — typically `name`, `brandName`, optional `legalName`, `location` (city/district/neighborhood), `address`, `phone`, `email`, structured **`openingHours`** (`short` / `detailed` / `display`), **`contactPerson`**, optional **`bookingUrl`**, **`social`** (e.g. instagram, facebook, `whatsappNumber`), optional tax/company fields, **`googlePlacesId`** (reviews + maps)
- **`sectionVisibility`**: optional `Partial<Record<SectionId, boolean>>` — overrides default visibility from top-level `sectionIds`
- `header`: logo URLs, optional `logoWidth`, **`links`**: `HeaderNavLink[]` (`label`, `href`, optional `type`: `link` | `button` | `whatsapp`, `visible`, `message`, `ariaLabel`)
- `contact`, `footer`, `cookie`, `notFound`, `trust`, `disclaimer`, `index`, `cityExample`, **`common`**: chrome / shared copy as needed
- **`impressumBacklink`**: optional block for imprint backlink sections

Any other content that appears on every page (e.g. trust badges) should also be extracted to Layer 1.

**Layer 2 — Pages** (array of page objects):

Each page in the source repo becomes an entry in the `pages` array. The template defines several **page shapes** (`AnyPageData`):

- **Main marketing page** (`PageData`): `name`, `metadata`, section props — `hero`, `info`, `gallery`, `team`, `map`, `reviews`, `faq`, etc.
- **Legal / blocks pages** (`LegalPageData`): `name` is `impressum` | `datenschutz` | `ueber-uns`, plus `pageTitle`, `metadata`, **`blocks`**: `LegalContentBlock[]`
- **Ratgeber listing** (`RatgeberPageData`): `name: "ratgeber"`, listing hero, `sections`, `labels`, `schema` — pairs with `src/content/ratgeber/*.md`
- **FAQ XXL page** (`FaqXxlPageData`): `name: "faq"`, hero, **`faqDataFile`** pointing to JSON (e.g. loaded from per-site `faq-xxl.json`)

**Legal blocks** (`LegalContentBlock`): `type` is `heading` | `paragraph` | **`image`**. Headings use `text` and optional `level`. Paragraphs prefer **`parts`** using **`LegalInlinePart`** — inline nodes use **`value`** (not `text`) for `text` / `strong` / `em` / `link` (`link` uses `value` + `href`). Image blocks use `src`, `alt`, optional `width` / `height`.

Example (abbreviated):

```json
{
  "name": "datenschutz",
  "pageTitle": "Datenschutz",
  "blocks": [
    { "type": "heading", "level": 2, "text": "Section Title" },
    {
      "type": "paragraph",
      "parts": [
        { "type": "text", "value": "Regular text " },
        { "type": "strong", "value": "bold text" },
        { "type": "link", "value": "link text", "href": "https://..." }
      ]
    }
  ]
}
```

**Phase 3 — Extract ALL hardcoded text.** Walk through every component and page file in the source repo. Any string that appears in JSX/TSX must be moved into `websites.json`. This includes:

- Headings, paragraphs, labels
- Button text, link text
- Placeholder text, aria labels
- Alt text on images
- Error messages, empty state messages
- Any text in conditionals or ternaries

### 4.3 Type Definitions (`src/types/page.ts`)

Mirror `websites.json` in TypeScript. Structural types in this repo include:

- `WebsiteData`, `WebsitesFile` (array **or** object with `sectionIds` / `websites` / client metadata)
- `SectionConfig`, `SectionId`, `SectionVisibility`
- `PageData`, `RatgeberPageData`, `FaqXxlPageData`, `LegalPageData`, `AnyPageData`
- `ResolvedPageData` — merged website + page for components (includes `sectionVisibility`, optional `programmatic`, legal snippets `datenschutz` / `impressum` / `ueberUns` when resolved)
- `LegalContentBlock`, `LegalInlinePart`, `PageMetadata`
- `BusinessInfo` and related (address, opening hours, social, etc.)
- `SrcPathFn`, `SrcPathCityFn` — Hero Factory JSON paths

**Per-site files** referenced from JSON (e.g. `faqDataFile`, glob-loaded `faq.json`) should stay path-consistent under `src/data/<client>/<site-id>/`.

---

## 5. Page Data Resolution (`src/lib/page-data.ts`)

### 5.1 Data Loading

Uses `import.meta.glob` to load all `websites*.json` files at build time. For each language, it loads the corresponding file (`websites.json` for default, `websites-<lang>.json` for others). Falls back to default language if a translation file is missing.

### 5.2 Key Functions

- **`loadPageContext(websiteId, language, options?)`** — returns **`PageContext | null`**: `{ pageData, clientDomain, srcPath, languageConfig, alternates }`. Uses **`getPageClientDomain(pageData)`** for absolute `https://host` links (not a bare hostname field named `domain`).
- **`getResolvedPageData(websiteId, pageName, language)`** — merges website + selected page into **`ResolvedPageData`**: copies chrome fields, resolves **`sectionVisibility`** from default `sectionIds` (SectionConfig[]) merged with `website.sectionVisibility`, maps legal pages by **`page.name`** into `impressum` / `datenschutz` / `ueberUns` block fields when applicable.
- **`getWebsite`**, **`getPage`** — direct accessors for JSON entries.
- **`getStrings` / `getUiStrings`**, **`t(key, context, params?)`** — dot-key string map and translation with `{param}` replacement; fallback to default language.
- **`getWebsiteIndex`**, **`getPageIndexInWebsite`** — indices for Hero Factory paths.
- **`createSrcPath(websiteIndex, pageIndexInWebsite, language)`** — returns a function `(fragment) => string`. Fragments whose first segment is in the shared list (`header`, `footer`, `cookie`, `notFound`, `trust`, `disclaimer`, `common`, `index`, `cityExample`, **`business`**) map to `data/current/websites*.json#<websiteIndex>.<fragment>`; other fragments use `...#<websiteIndex>.pages.<pageIndex>.<fragment>`.

**Related modules**

- `src/lib/internal-links.ts` — **`getRelatedLinks(pageType, slug, siteId?)`** from optional `internalLinks.json`
- `src/lib/trust-data.ts` — **`injectTrustLogos`**, **`normalizeTrustLogos`** for partner/trust blocks
- `src/lib/utils.ts` — **`cn`**, **`createSlug`**

### 5.3 Usage in Pages

Typical `[lang]` pages:

```astro
const ctx = loadPageContext(preferredId, language, { pageName: 'impressum', pathSuffix: '/impressum' });
const { pageData, clientDomain, srcPath, languageConfig, alternates } = ctx;
```

Pass `pageData` into layouts/components. Content comes from data — not hardcoded in JSX.

---

## 6. Routing and Pages

### 6.1 Route Discovery and Mapping

The converting AI must analyze the source repository to discover all existing pages/routes. The route structure in the new Astro repo will be derived from what exists, wrapped in the `[lang]/` prefix pattern.

**Always present (typical template routes):**

```
/                          -> Redirect to /<defaultLanguage> (index.astro)
/404                       -> Not found (404.astro)
/robots.txt                -> robots.txt.ts (dynamic)
```

**Under `[lang]/` (language-prefixed):**

```
/[lang]/                   -> Homepage ([lang]/index.astro) — PageContent
/[lang]/datenschutz        -> Privacy (legal blocks)
/[lang]/impressum          -> Imprint (legal blocks)
/[lang]/ueber-uns          -> About (legal blocks via UeberUnsContent)
/[lang]/faq                -> Large FAQ page (FaqXxlContent + optional faq-xxl JSON)
/[lang]/grounding          -> GEO grounding doc (grounding.md → MarkdownRenderer)
/[lang]/ratgeber           -> Ratgeber / blog listing (content collection)
/[lang]/ratgeber/[slug]    -> Article detail
/[lang]/[city]             -> Programmatic location pages (PageContent + programmatic)
```

**Outside `[lang]/` (exceptions beyond index / 404):**

- `city-example/berlin.astro` — static demo route (optional)

**Discovered from source repo** (add as needed): services, contact-only routes, etc. — still place content pages under `[lang]/` when they participate in i18n.

The AI must:

1. List every page/route in the source repo
2. Map each to a `[lang]/...` route in the new Astro structure
3. Determine if each page is a "section-based page" (uses PageContent with toggleable sections) or a "standalone page" (custom layout, like legal pages)
4. Create the corresponding `.astro` file for each

### 6.2 Static Path Generation

All pages use `getStaticPaths()` to generate paths for each supported language:

```typescript
export function getStaticPaths() {
  return SUPPORTED_LANGUAGES.map((lang) => ({ params: { lang } }));
}
```

Dynamic pages (like blog articles or programmatic pages) additionally iterate over their content entries.

### 6.3 Page File Layout — Mostly Under `[lang]`

**Language-specific routes live under `src/pages/[lang]/`.** Root-level exceptions:

- `index.astro` — redirect to `/<defaultLanguage>`
- `404.astro` — not found
- `robots.txt.ts` — robots.txt
- Optional demos (e.g. `city-example/*.astro`) — not i18n-prefixed by design

Everything else that should be translated / hreflang-aware goes under `[lang]/` (legal, ratgeber, programmatic cities, grounding, FAQ XXL, etc.).

### 6.4 Layouts

- **BaseLayout.astro**: Document shell — `<html lang dir>`, meta/SEO (title, description, canonical, robots, OG, Twitter), **`alternates`**, theme CSS vars + font preloads/stylesheets, global JSON-LD (`SchemaOrg`), optional FAQ payload for schema, optional hero image preload, **`ConditionalTextEditor`** wrapping the main slot. Props include `siteUrl`, `faq`, `heroImage`, etc.
- **`BaseLayout.astro`**: Document shell, metadata, `CookieBanner` (`client:load`), `ConditionalTextEditor` slot, **`FloatingLanguageSwitcher`** (`client:visible`, outside the text-editor React tree on every page using this layout).
- **PageContent.astro**: Section stack for homepage/programmatic pages — **Header**, conditional sections (**Hero**, **CityIntro**, **CityLocalDescription**, **Info**, **Gallery**, **Team**, **FAQ**, **GoogleReviews**, **MapSection**, **Contact**, **NearbyLinks**, **RelatedLinks**, **TrustBlock**), **Footer**. Controlled by **`pageData.sectionVisibility`**. Pass precomputed **`srcPaths`** / **`srcPathCity`** from `.astro` parents (see §11.5).

**Note:** Any route that uses **`BaseLayout`** gets cookie banner and floating language switcher. Minimal pages (e.g. root `index.astro` redirect stub) that do not use `BaseLayout` need their own handling if you want chrome there.

---

## 7. Theming System

### 7.1 Theme Config (`theme.config.json`)

```json
{
  "colors": {
    "primary": "328 85% 46%",
    "primary-foreground": "0 0% 100%",
    "secondary": "328 10% 92%",
    "accent": "169 62% 64%",
    "destructive": "0 84% 45%",
    "hero-h1": "0 0% 100%"
  },
  "fonts": {
    "body": { "family": "Rubik", "fallback": "Arial, Helvetica, sans-serif" },
    "heading": {
      "family": "Caveat",
      "fallback": "Arial, Helvetica, sans-serif"
    }
  },
  "fontStylesheetUrls": [
    "https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;600;700&display=swap"
  ]
}
```

Colors use **HSL component form** (no `hsl()` wrapper) for compatibility with Tailwind's `hsl(var(--x))` pattern.

### 7.2 Theme Syncing (`scripts/dev/sync-theme-to-globals.mjs`)

**`pnpm sync-theme`** runs `scripts/dev/sync-theme-to-globals.mjs`. It reads `src/data/current/theme.config.json` and updates semantic colors / font links in **`src/styles/globals.css`**. **`pnpm dev`** must invoke **`scripts/dev/dev-with-prompt.mjs`** via the root **`dev`** script (see §13); that script can prompt for client/site, run **`use-client`**, sync theme, then start Astro.

### 7.3 Theme helpers (`src/lib/theme.ts`)

Exports include **`getThemeConfig`**, **`getThemeCssVars`**, **`getThemeFontStylesheetUrls`**, **`getThemeFontsUrl`**, **`getThemeFontPreloadUrls`** (local `/fonts/.../fonts.css` → woff2 preload).

### 7.4 CSS Architecture (`src/styles/globals.css`)

- `@import 'tailwindcss'` and **`@theme { ... }`** mapping semantic CSS variables to Tailwind v4 color utilities
- **`:root`** defaults (comment notes sync from `theme.config.json` via `pnpm sync-theme`)
- RTL rules, animations, utilities

### 7.5 Tailwind Config

`tailwind.config.ts` — CSS variable-based palette (including sidebar tokens used by some UI), **`tailwindcss-animate`**, extended fonts/keyframes.

---

## 8. Internationalization (i18n)

### 8.1 Language Config (`language.config.json`)

```json
{
  "defaultLanguage": "de",
  "supportedLanguages": ["de"],
  "description": "Central config for languages and optional AI translation.",
  "translation": {
    "sourceFile": "websites.json",
    "targetLanguages": [],
    "openRouter": {
      "model": "google/gemini-3-pro-preview",
      "baseUrl": "https://openrouter.ai/api/v1"
    },
    "skipKeys": [
      "id",
      "heroPageId",
      "clientDomain",
      "googleTagId",
      "url",
      "link",
      "image",
      "src",
      "email",
      "telephone",
      "phoneNumber",
      "postalCode",
      "bookingUrl",
      "mapEmbedUrl",
      "googlePlacesId",
      "languageCode",
      "latitude",
      "longitude",
      "card1Icon",
      "card2Icon",
      "card3Icon",
      "width",
      "height",
      "publishTime",
      "name",
      "icbm",
      "position",
      "region",
      "addressCountry"
    ]
  }
}
```

**Scripts:** implementation lives in **`scripts/translation/translate-data.ts`** and **`scripts/translation/add-language.ts`**; **`pnpm translate-data`** / **`pnpm add-language`** invoke them (see `package.json`).

### 8.2 Language System (`src/lib/language.ts`)

- Reads config from `language.config.json`
- Exports `SUPPORTED_LANGUAGES`, `DEFAULT_LANGUAGE`
- Provides `LANGUAGE_CONFIG` metadata (name, nativeName, flag, locale, hreflang, direction)
- Supports RTL languages (Arabic, etc.)

### 8.3 Translation Workflow

1. **Add language**: `pnpm add-language fr` — updates `language.config.json`
2. **Translate**: `pnpm translate-data --lang=fr` — uses OpenRouter + Gemini to translate `websites.json` to `websites-fr.json`
3. **Build**: Astro generates paths for all supported languages

### 8.4 Hreflang / Alternates

`loadPageContext` generates `alternates` map (`{ 'x-default': url, 'en': url, ... }`) passed to `BaseLayout` which renders `<link rel="alternate" hreflang="..." href="...">` tags.

### 8.5 Language Switcher

`FloatingLanguageSwitcher` component (React, client-side) detects current language from URL path, shows dropdown with flags and native names, switches by navigating to `/<newLang>/...`.

---

## 9. Programmatic Pages

### 9.1 Location Input (`programmatic-locations-input.json`)

```json
[{ "name": "Hamburg-Eidelstedt", "type": "suburb", "region": "Hamburg" }]
```

### 9.2 Content Generation (`scripts/generate-programmatic-content.mjs`)

- Reads locations input and business info from `websites.json`
- With `OPENROUTER_API_KEY`: uses LLM to generate unique metadata, hero, intro, localDescription, directions per location
- Without API key: generates template-based content
- Outputs `programmaticData.json`

### 9.3 Programmatic Data (`src/lib/programmatic-data.ts`)

Provides: `getAllPages()`, `getPageData(slug)`, `getNearbyPages(slug)`, `getPageIndex(slug)`, `getDataPath(fragment, index)`. Deprecated aliases: `getCityData`, `getAllCities`, `getCityIndex`, `getCityDataPath` (prefer the `getPage*` names).

### 9.4 City Page Route (`[lang]/[city].astro`)

- Generates static paths for all languages x all locations
- Merges programmatic data (hero, metadata, directions) with base website data
- Builds per-city Schema.org (LocalBusiness + BreadcrumbList)
- Renders via `PageContent` with `programmatic` prop

---

## 10. Schema.org / Structured Data

### 10.1 Configuration

Schema entries are defined in `metadata.schema` within `websites.json`. The schema types used are **determined by analyzing the source repo** and what structured data is appropriate for the business type:

```json
"schema": [
  { "id": "organization", "schemaType": "Organization", "data": { } },
  { "id": "website", "schemaType": "WebSite", "data": { } }
]
```

Organization and WebSite schemas are always present. Additional schemas (LocalBusiness, Service, Product, FAQPage, BreadcrumbList, etc.) are added based on the nature of the business and pages.

### 10.2 Implementation (Fixed — Copy from Template)

These files implement the schema system and should be adapted from the template:

- `src/lib/schema-org.ts` — **`buildSchemaJsonLd`**, **`buildSchemaJsonLdMultiple`**, **`getSchemaData`**. Supports Organization, WebSite, Article, **Donation**, FAQ / FAQPage variants, **Course**, **LearningResource**, BreadcrumbList, LocalBusiness, Product, Person, Place, and passthrough/custom types.
- `src/lib/global-schema.ts` — reads **default** `websites.json`, resolves active site by `SITE_ID` / URL / first entry, uses **`deployDomain` / `clientDomain` / top-level `clientDomain`** for site URL when building Organization + WebSite JSON-LD.
- `src/components/SchemaOrg.astro` — renders `<script type="application/ld+json">` for prebuilt + page-level schemas + optional FAQ.

The converting AI should determine which schema types are appropriate for the source repo's business type and populate the `metadata.schema` array accordingly.

---

## 11. Components (AI-Determined)

Most section components are **data-driven** — they take **`ResolvedPageData`** (or focused props such as **`programmatic`** slices) and read copy from JSON. A few utilities (**MarkdownRenderer**, link lists) take content strings or arrays; keep strings in data files, not inline in `.astro`, where possible.

### 11.1 Component Discovery

The converting AI must analyze the source repository to identify all components. For each component:

1. **Identify it** — find all React/JSX components in the source repo
2. **Catalog its content** — list all hardcoded strings, images, and data it displays
3. **Convert it** — rewrite it to accept `pageData` as a prop and read all content from there
4. **Add srcPath** — add `data-hero-factory-src-path` attributes to all editable text elements

### 11.2 Shell and shared UI (template baseline)

- **Header** — `pageData`, `language`, `srcPath`; embeds **LanguageSwitcher**
- **Footer** — `pageData`, `language`, `srcPath`; uses **`Word`** helper for editable strings
- **CookieBanner** — consent + gtag; language from URL
- **FloatingLanguageSwitcher** — floating control from current path
- **Heading** — semantic levels, variants; **prefer over raw `<h1>`–`<h6>`** for new/edited code
- **Word** — polymorphic wrapper; pass **`dataHeroFactorySrcPath`** (maps to `data-hero-factory-src-path` in the DOM)
- **ImpressumContent** / **DatenschutzContent** / **UeberUnsContent** — render `LegalContentBlock[]`
- **SchemaOrg.astro** — JSON-LD output
- **`src/components/ui/*`** — shadcn/Radix primitives (button, card, accordion, dialog, input, label, tooltip)

### 11.3 PageContent sections (this repo)

Used on homepage / programmatic city pages: **Hero** (optional **`srcPathCity`** for programmatic copy), **CityIntro**, **CityLocalDescription**, **Info**, **Gallery**, **Team** (optional `isSeparateTeamPage`), **FAQ**, **GoogleReviews**, **MapSection** (required **`isSeparatePage`** flag), **Contact**, **NearbyLinks**, **RelatedLinks**, **TrustBlock**.

### 11.4 Other routes

- **FaqXxlContent** — large FAQ from grouped JSON
- **MarkdownRenderer** — long-form HTML/Markdown-like content (e.g. grounding page)
- **AITranslationDisclaimer** — banner when viewing AI-translated UI
- **SmoothScrollButton**, **PageLayout** — small utilities

**Heading discipline:** Many sections use **`Heading`**; **Hero** / **Team** / **NearbyLinks** / **RelatedLinks** / **MarkdownRenderer** may still use raw headings — align with your Heading rule when touching those files.

### 11.5 Component conversion pattern

```tsx
interface MyComponentProps {
  pageData: ResolvedPageData;
  language?: string;
  srcPath?: (fragment: string) => string;
}

export function MyComponent({ pageData, language, srcPath }: MyComponentProps) {
  const j = srcPath ?? (() => '');
  return (
    <section>
      <Heading level={2} data-hero-factory-src-path={j('mySection.heading')}>
        {pageData.mySection.heading}
      </Heading>
      <p data-hero-factory-src-path={j('mySection.description')}>
        {pageData.mySection.description}
      </p>
    </section>
  );
}
```

Programmatic pages: pass **`srcPathCity`** (**`SrcPathCityFn`**) to **Hero** for city-scoped JSON paths.

### 11.6 Text editor integration

Same as before: **`data-hero-factory-src-path`** on editable nodes; paths like `data/current/websites.json#0.pages.0.hero.h1`.

**PageContent / Astro:** do not pass **`srcPath` functions** into Astro templates — precompute **`srcPaths: Record<string, string>`** in the parent `.astro` file and pass that object into `PageContent` / section components.

---

## 12. Text Editor System (`text-editor/`)

Inline editing stack (Hero Factory / API integration):

- **`components/TextEditorWrapper.tsx`** — `?editor` mode; editable nodes with `data-hero-factory-src-path` or `herokit-id`
- **`components/SEOEditorModal.tsx`** — SEO / metadata editing
- **`components/safe-html-renderer.ts`** — safe HTML render helper
- **`lib/component-text-editor.ts`**, **`lib/seo-metadata-editor.ts`**, **`lib/types.ts`**
- **`database/schema.sql`** — PostgreSQL schema for pending edits
- **`scripts/`** — `apply-edits.js`, `add-stable-ids.ts`, `remove-stable-ids.ts`, `generate-sitemap.mjs`, `generate-llm-txt.mjs`, `generate-static.mjs`, `build-and-deploy.mjs`, `deploy-static.mjs`, `config.mjs`, **`multi-page-config.json`**

Repo root also exposes **`pnpm generate-llm-txt`** → `text-editor/scripts/generate-llm-txt.mjs`. The **`text-editor/README.md`** may describe extra paths; verify against the tree when copying.

---

## 13. Scripts

**`package.json` — required `dev` script:** The resulting project must set the root dev command exactly to:

```json
"dev": "node scripts/dev/dev-with-prompt.mjs"
```

so `pnpm dev` runs the prompt → **`use-client`** → theme sync → Astro dev server (do not point **`dev`** at `astro dev` alone).

| File (under `scripts/` unless noted) | Command                                             | Purpose                                                                         |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `dev/dev-with-prompt.mjs`            | `pnpm dev`                                          | Prompt client/site (optional), `use-client`, sync theme, Astro dev              |
| `dev/sync-theme-to-globals.mjs`      | `pnpm sync-theme`                                   | Write `theme.config.json` → `globals.css`                                       |
| `dev/build-deploy-cf.mjs`            | `pnpm build:deploy`                                 | Build + deploy to Cloudflare R2 / Workers                                       |
| `dev/master.ts`                      | `pnpm master`                                       | Interactive menu for pipeline scripts                                           |
| `translation/translate-data.ts`      | `pnpm translate-data`                               | AI-translate `websites.json` → `websites-<lang>.json`                           |
| `translation/add-language.ts`        | `pnpm add-language`                                 | Add language to `language.config.json`                                          |
| `use-client.ts`                      | `pnpm use-client`                                   | Symlink `src/data/current`, update `.env.local`                                 |
| `01-create-client.ts`                | `pnpm 01-create-client`                             | Scaffold client folder from template                                            |
| `02-pull-from-google-drive.mjs`      | `pnpm 02-pull-assets`                               | Pull from Google Drive                                                          |
| `03-organize-drive-assets.mjs`       | `pnpm 03-organize-assets`                           | Map Drive files into expected paths                                             |
| `04-process-excel-data.mjs`          | `pnpm 04-process-excel-data`                        | Patch `websites.json` / language config from `.xlsx`                            |
| `05-extract-client-data.mjs`         | `pnpm download-fonts`, `pnpm extract-favicon`, etc. | Firecrawl scrape, fonts, favicon, colors, `--client-prompt` — see script header |
| `06-generate-website.ts`             | `pnpm 06-generate-website`                          | AI website entry from `prompt.md` / stdin (`OPENROUTER_MODEL_WEBSITE_GEN`)                 |
| `clone-website.ts`                   | `pnpm clone-website`                                | Clone site entry for new location                                               |
| `improve-copy.ts`                    | `pnpm improve-copy`                                 | AI copy pass on one site                                                        |
| `07-fetch-google-reviews.ts`         | `pnpm 07-fetch-google-reviews`                      | Places API → `websites.json`                                                    |
| `generate-programmatic-content.mjs`  | `pnpm generate-programmatic-content`                | `programmaticData.json` from locations input                                    |
| `generate-grounding.mjs`             | `pnpm generate-grounding`                           | `grounding.md` per site (GEO)                                                   |
| `generate-internal-links.mjs`        | `pnpm generate-internal-links`                      | `internalLinks.json`                                                            |
| `generate-sitemap-from-dist.mjs`     | (after `pnpm build`)                                | Sitemap from `dist/`                                                            |
| `validate-drive-assets.mjs`          | `pnpm validate-drive-assets`                        | Validate `googleDrive/` layout                                                  |
| `onboard-client.ts`                  | `pnpm onboard-client`                               | Full onboarding pipeline                                                        |

### 13.1 AI block registry (`scripts/ai-block-registry.json`)

**Purpose:** Defines how **`06-generate-website.ts`**, **`08-refine-website-data.ts`** (content-quality step), and **`clone-website.ts`** split work into **ordered blocks** (e.g. `home.hero`, `faq.metadata`) instead of one batch per non-home page. Forks with a different `websites.json` shape should **edit or replace** this file rather than changing TypeScript.

- **`blocks[]`**: Each entry has an **`id`**, **`pageName`** (must match `pages[].name` in `websites.json`), optional **`propertyPath`** (dot path under that page), optional **`isArrayRoot`** + **`batchSize`** for array subtrees (e.g. Über-uns `blocks`), and optional **`promptSection`** (a `clone-block-*` section from `scripts/prompts/website-ai-prompts.md` — appended as extra guidance for 06/08).
- **`pageAliasToSlimRoot`**: Maps page names to **clone slim** keys when they differ (this template: `"ueber-uns"` → `"ueberUns"`). Clone still uses slim `blockPath` strings internally; other scripts resolve **`pages[i]`** via **`pageName`**.
- **Unmatched paths**: After registry blocks run, any remaining fillable paths are batched with the legacy **`groupPathsBySections`** behavior so nothing is dropped if the JSON drifts.
- **Override path:** Set **`AI_BLOCK_REGISTRY`** to an absolute or repo-relative JSON path to experiment without overwriting the default file.
- **Missing / invalid file:** Clone falls back to a built-in block list; 06/08 fall back to **`groupPathsBySections`** only.

**Conversion / Ralph:** `pnpm migrate:lovable-to-scaffold`, `pnpm generate:ralph-conversion`, `pnpm ralph:convert`, `pnpm audit:conversion` run scripts under **[conversion-kit/](../conversion-kit/README.md)** (`migrate-lovable-to-scaffold.mjs`, etc.).

---

## 14. Deployment

### Cloudflare R2 (primary in this template)

- **`pnpm build:deploy`** → `scripts/dev/build-deploy-cf.mjs` — static output + R2 / Workers (see script for env vars)

### Vercel

- **`vercel.json`** present — optional deploy via Vercel CLI or dashboard (`vercel` dev dependency)

### Build

- **`pnpm build`** runs `astro build` then **`scripts/generate-sitemap-from-dist.mjs`** (post-build sitemap; avoids relying on `@astrojs/sitemap` internals)

### Environment variables (common)

- `SITE_ID` / `CLIENT_ID` — active website
- `SITE_URL` — canonical base (also `DEPLOY_DOMAIN` fallback in config)
- `DEPLOY_DOMAIN` — deploy host when `SITE_URL` unset
- `OPENROUTER_API_KEY` — translation / generation
- `OPENROUTER_MODEL_WEBSITE_GEN` — model for `06-generate-website.ts`
- `FIRECRAWL_API_KEY` — `05-extract-client-data` / onboarding extract
- `GOOGLE_PLACES_API_KEY` — reviews
- Cloudflare: `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_ENDPOINT`, optional `CLOUDFLARE_R2_BUCKET_NAME`, `CLOUDFLARE_WORKER_NAME`

---

## 15. Client onboarding (single command)

For **new clients and websites** inside this repository (not full React→Astro conversions), use the orchestrated pipeline so scripts run in the correct order.

### Command

```bash
pnpm onboard-client
pnpm onboard-client --help
```

### What it runs (phases)

| Phase               | Scripts                                                                                                                                                                                           | Purpose                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Create**       | `01-create-client.ts`                                                                                                                                                                             | Creates `src/data/<client-id>/` with starter JSON + theme + language + `programmaticData.json`; font download via `pnpm download-fonts` / `05-extract-client-data --download-fonts` |
| **2. Assets**       | `02-pull-from-google-drive.mjs` → `03-organize-drive-assets.mjs`                                                                                                                                  | Pull Drive → place assets; skipped if credentials missing                                                                                                                           |
| **2b. Excel**       | `04-process-excel-data.mjs` (when `.xlsx` present)                                                                                                                                                | Patch `websites.json` / `language.config.json` from spreadsheet                                                                                                                     |
| **3. Extract**      | `05-extract-client-data.mjs`                                                                                                                                                                      | Firecrawl / favicon / fonts / colors / `--client-prompt`; needs `FIRECRAWL_API_KEY` for scrape modes                                                                                |
| **4. Generate**     | `06-generate-website.ts`                                                                                                                                                                          | AI entries from each `**/prompt.md` (and related inputs). Skipped if no API key or no prompt folders                                                                                |
| **5. Activate**     | `use-client.ts` + `scripts/dev/sync-theme-to-globals.mjs`                                                                                                                                         | Symlink `current`, write `.env.local` (`CLIENT_ID`, `SITE_ID`, `DEPLOY_DOMAIN`, …), sync CSS                                                                                        |
| **6. Enhancements** | `translation/translate-data.ts`, optional `generate-programmatic-content.mjs`, `07-fetch-google-reviews.ts`, optional `generate-llm-txt`, `generate-grounding.mjs`, `generate-internal-links.mjs` | Translate, programmatic SEO pages, reviews, llm.txt, grounding, internal links — each gated on keys / input files                                                                   |

Use **`pnpm master`** for an interactive menu that wraps many of these steps.

### CLI flags

| Flag                  | Meaning                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--client-id=`        | Client folder under `src/data/`                                                                                                               |
| `--client-name=`      | Display name (phase 1)                                                                                                                        |
| `--drive-folder-id=`  | Google Drive root folder id (phase 1 + pull)                                                                                                  |
| `--client-domain=`    | Domain for fonts / context (phase 1)                                                                                                          |
| `--site-id=`          | Website id for `use-client` in phase 5 (default: first site in `websites.json`)                                                               |
| `--skip-create`       | Skip phase 1 (client folder must already exist)                                                                                               |
| `--skip-assets`       | Skip phase 2                                                                                                                                  |
| `--skip-extract`      | Skip phase 3                                                                                                                                  |
| `--skip-generate`     | Skip phase 4                                                                                                                                  |
| `--skip-translate`    | Skip `translate-data` in phase 6                                                                                                              |
| `--skip-programmatic` | Skip programmatic content generation in phase 6                                                                                               |
| `--skip-reviews`      | Skip `fetch-google-reviews` in phase 6                                                                                                        |
| `--only=<phase>`      | Run a single phase: `create`, `assets`, `extract`, `generate`, `activate`, or `enhancements`. Implies `--skip-create` unless `--only=create`. |

### Prerequisites

- **Phase 2:** `google-drive-credentials.json` (repo root) and `scripts/pull-from-google-drive.config.json`; Drive shared with the service account.
- **Phase 3:** `FIRECRAWL_API_KEY` in `.env.local`.
- **Phase 4:** `OPENROUTER_API_KEY` in `.env.local`; at least one `src/data/<client-id>/<site>/prompt.md` (see script — `prompt.txt` may still appear in older docs).
- **Phase 6 (translate):** `OPENROUTER_API_KEY`.
- **Phase 6 (programmatic):** Non-empty `programmatic-locations-input.json` for that client.
- **Phase 6 (reviews):** `GOOGLE_PLACES_API_KEY` and `business.googlePlacesId` on each website in `websites.json`.

Missing optional prerequisites cause that sub-step to be skipped with a console warning, not a hard failure (except phase 1 `create-client` failure, which stops the run).

### Examples

```bash
# Interactive: prompts for new client fields or existing client when skipping create
pnpm onboard-client

# Existing client: run everything except creating the folder
pnpm onboard-client --skip-create --client-id=haus-zum-wald

# Only pull and organize assets
pnpm onboard-client --only=assets --client-id=nicezeit

# Only AI generation for all prompt.md folders
pnpm onboard-client --only=generate --client-id=my-client --skip-create
```

After onboarding, use **`pnpm dev`** (runs `dev-with-prompt.mjs` — can prompt for client/site) or **`pnpm use-client`** then **`pnpm sync-theme`** + **`pnpm dev`** as needed; run **`pnpm build`** before deploy.

---

## 16. Conversion Instructions

To convert an existing React repository to this template structure, follow these steps in order. The process is **analysis-first** — you must understand the source repo before building.

**Automated starter (Lovable/Vite → `template-scaffold` copy + Ralph PRD):** see [MIGRATE-LOVABLE-RALPH.md](./MIGRATE-LOVABLE-RALPH.md) and the self-contained **[conversion-kit/README.md](../conversion-kit/README.md)** folder (`migrate-lovable-to-scaffold.mjs`, generated `prd.md` / `PROMPT.md`, `ralph-convert.sh`, `audit-conversion.mjs`; copy `conversion-kit/` into another repo to run the same flow).

### Conversion Todo List

Use this checklist to track progress. Mark items with `[x]` when done.

#### Phase A: Analysis (Read-Only — Do NOT Write Code Yet)

- [ ] **A1** — Inventory the source repository (pages/routes, components, hardcoded text, site chrome, theme, structured data, business type)
- [ ] **A2** — Design the `websites.json` structure (`sectionIds` as **`SectionConfig[]`**, optional client-level metadata, WebsiteData shape, `pages` array incl. legal / ratgeber / FAQ XXL as needed, legal blocks with **`value`** inline parts)
- [ ] **A3** — Design the type definitions (`src/types/page.ts` and derived types)

#### Phase B: Scaffolding

- [ ] **B1** — Initialize Astro project (Astro 4, React, path aliases, Tailwind 4, dependencies)
- [ ] **B2** — Create data files (`src/data/<client-id>/`, websites.json, theme.config.json, language.config.json)
- [ ] **B3** — Implement core lib (page-data.ts, language.ts, theme.ts, global-schema.ts, schema-org.ts; programmatic-data, internal-links, trust-data, utils as in template) and content collections if needed (`src/content/config.ts`, e.g. ratgeber)
- [ ] **B4** — Create type definitions (`src/types/page.ts`)
- [ ] **B5** — Create styles (globals.css, tailwind.config.ts)

#### Phase C: Page and Component Conversion

- [ ] **C1** — Create layouts (BaseLayout.astro, PageContent.astro)
- [ ] **C2** — Create always-present pages (index.astro, 404.astro, robots.txt.ts, [lang]/datenschutz, [lang]/impressum; plus [lang]/ueber-uns, [lang]/faq, [lang]/grounding, [lang]/ratgeber, [lang]/ratgeber/[slug] if required)
- [ ] **C3** — Create discovered pages (all [lang]/ routes from inventory)
- [ ] **C4** — Convert all components (data-driven props, no hardcoded text, srcPath, Heading component)
- [ ] **C5** — Create shell + section components (Heading, Word, Header, Footer, CookieBanner, FloatingLanguageSwitcher, LanguageSwitcher, PageContent sections, ImpressumContent, DatenschutzContent, UeberUnsContent, FaqXxlContent, MarkdownRenderer, SchemaOrg, `ui/*` as needed)

#### Phase D: Scripts and Tooling

- [ ] **D1** — Copy all required scripts from sharedScripts into `scripts/`
- [ ] **D2** — Set up text editor (copy text-editor/, integrate in BaseLayout)
- [ ] **D3** — Configure deployment (`.gitignore` incl. `public/images/`, package.json scripts, Cloudflare R2 and/or Vercel)

#### Phase E: Verification

- [ ] **E1** — Run `pnpm use-client <client-id>` and `pnpm dev`; verify theme and site render
- [ ] **E2** — Verify every page uses content from websites.json (no hardcoded text)
- [ ] **E3** — Verify text editor (`?editor`) works on editable elements
- [ ] **E4** — Run `pnpm build`; verify static generation for all languages

---

### Phase A: Analysis (Read-Only — Do NOT Write Code Yet)

#### Step A1: Inventory the Source Repository

Thoroughly analyze the source React repo:

1. **List all pages/routes** — every page the app serves, their URLs, and their purpose
2. **List all components** — every React component, what it renders, and what props it takes
3. **Catalog all hardcoded text** — walk through every JSX file and extract every string literal that appears in the UI (headings, paragraphs, button labels, alt text, aria labels, placeholder text, error messages, etc.)
4. **Identify the site chrome** — what content appears on every page (header, footer, cookie banner, etc.)
5. **Identify the theme** — colors used (convert to HSL component form), fonts loaded, any design tokens
6. **Identify structured data** — any existing Schema.org markup, meta tags, OG tags
7. **Identify the business type** — what kind of business is this? (used for choosing Schema.org types)

#### Step A2: Design the `websites.json` Structure

Based on the analysis:

1. **Define sectionIds** — array of **`{ id, visible }`** (`SectionConfig`) for each distinct homepage/main-page section
2. **Define the WebsiteData shape** — Layer 1 (global chrome) and Layer 2 (pages array) fields, named descriptively based on what the source repo actually contains
3. **Define the pages array** — one entry per page, with `name`, `pageTitle`, `metadata`, and section-specific content fields
4. **Ensure legal pages** use the standardized `blocks` format with **`LegalInlinePart.value`** (always required: datenschutz, impressum; add `ueber-uns` / FAQ XXL / ratgeber page entries as needed)
5. **Write the complete `websites.json`** with all extracted hardcoded text filled in

#### Step A3: Design the Type Definitions

Based on the `websites.json` structure:

1. Create TypeScript types that mirror the JSON exactly
2. Include all mandatory structural types (WebsiteData, PageData, RatgeberPageData, FaqXxlPageData, LegalPageData, ResolvedPageData, WebsitesFile, SectionConfig, SectionId, SectionVisibility, LegalContentBlock, LegalInlinePart, PageMetadata)
3. Add component-specific types derived from what sections the source repo has

### Phase B: Scaffolding (Fixed Structure — Same for Every Conversion)

#### Step B1: Initialize Astro Project

- Set up Astro 4 with `@astrojs/react`, static output mode
- Configure `tsconfig.json` with `@/*` and `@/data/*` path aliases
- Configure `astro.config.mjs` with the `@/data` Vite alias pointing to `src/data/current`
- Set up Tailwind CSS 4 with PostCSS, using CSS variable-based theming
- Install dependencies: `@astrojs/react`, `react`, `react-dom`, `@radix-ui/react-accordion`, `@radix-ui/react-dialog`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate`

#### Step B2: Create Data Files

- Create `src/data/<client-id>/` folder
- Write `websites.json` (from Step A2)
- Write `theme.config.json` with colors (HSL component form) and fonts extracted from source repo
- Write `language.config.json` with default and supported languages

#### Step B3: Implement Core Lib (Adapt from Template)

These files follow the same pattern for every conversion — adapt from the template:

- `src/lib/page-data.ts`: Data loading via `import.meta.glob`, `loadPageContext()`, `getResolvedPageData()`, `t()` function. Adapt the `getResolvedPageData()` merge logic to match the new `WebsiteData` shape.
- `src/lib/language.ts`: Copy as-is from template (generic language config system)
- `src/lib/theme.ts`: Copy as-is from template (generic theme loading)
- `src/lib/global-schema.ts`: Copy as-is from template (generic schema extraction)
- `src/lib/schema-org.ts`: Copy as-is from template (generic JSON-LD builder)
- `src/lib/programmatic-data.ts`: Only if the source repo has programmatic pages
- `src/lib/internal-links.ts`, `src/lib/trust-data.ts`, `src/lib/utils.ts`: As in template when using related features

#### Step B4: Create Type Definitions

- Write `src/types/page.ts` with all types from Step A3

#### Step B5: Create Styles

- Write `src/styles/globals.css` with Tailwind v4 import, `@theme` token mapping, `:root` CSS variables, font-family rules, RTL support
- Write `tailwind.config.ts` with CSS variable-based color definitions

### Phase C: Page and Component Conversion

#### Step C1: Create Layouts

- `BaseLayout.astro`: HTML shell with meta tags, OG/Twitter, canonical, alternates, theme CSS, fonts, global Schema.org, text editor. Adapt from template.
- `BaseLayout.astro`: `CookieBanner` + `FloatingLanguageSwitcher` + main slot. Adapt from template.
- `PageContent.astro`: Section-based page body. **The sections listed here are determined by Step A1.** Each section from the source repo's homepage gets a conditional render block controlled by `sectionVisibility`.

#### Step C2: Create Always-Present Pages

**Most content pages live under `[lang]/`** — see §6.3. Root of `src/pages/`: `index.astro`, `404.astro`, `robots.txt.ts`, optional non-i18n demos.

- `index.astro`: Root-level redirect to default language (copy from template)
- `404.astro`: Not found page at root (copy from template)
- `[lang]/datenschutz.astro`: Privacy policy with BaseLayout + legal blocks content (adapt from template)
- `[lang]/impressum.astro`: Imprint with BaseLayout + legal blocks content (adapt from template)
- Add as needed: `[lang]/ueber-uns.astro`, `[lang]/faq.astro`, `[lang]/grounding.astro`, `[lang]/ratgeber.astro`, `[lang]/ratgeber/[slug].astro`, `robots.txt.ts`

#### Step C3: Create Discovered Pages

For each page found in Step A1 that is not a legal page:

- Create `[lang]/<page-name>.astro` (or `[lang]/<folder>/...` for nested routes — all under `[lang]/` per §6.3)
- Use `loadPageContext(preferredId, language, { pageName: '<page-name>', pathSuffix: '/<page-name>' })`
- If it's a section-based page (like the homepage), use `PageContent`
- If it's a standalone page, render Header + custom content + Footer directly

#### Step C4: Convert Components

For each component identified in Step A1:

1. **Rewrite props** — accept `pageData: ResolvedPageData` and optionally `language`, `srcPath`
2. **Replace all hardcoded text** — read from `pageData.<sectionName>.<fieldName>` instead
3. **Add `data-hero-factory-src-path`** — on every editable text element, using `srcPath` to generate the JSON path. For PageContent and Astro components, add `data-hero-factory-src-path` back to editable elements using a **precomputed `srcPaths` object** (see §11.5) to avoid esbuild parse errors with template literals.
4. **Replace raw heading tags** — use the `Heading` component with appropriate `level` prop
5. **Preserve the visual design** — the component should look identical, just data-driven

#### Step C5: Create Always-Present Components

Copy/adapt from template:

- `Heading.tsx` (reusable heading with levels/variants)
- `Header.tsx` (adapt navigation structure to match source repo)
- `Footer.tsx` (adapt footer structure to match source repo)
- `CookieBanner.tsx` (adapt text)
- `FloatingLanguageSwitcher.tsx` (copy as-is)
- `LanguageSwitcher.tsx` (copy as-is)
- `ImpressumContent.tsx` (copy as-is — renders LegalContentBlock[])
- `DatenschutzContent.tsx` (copy as-is — wraps ImpressumContent)
- `UeberUnsContent.tsx`, `FaqXxlContent.tsx`, `MarkdownRenderer.tsx`, section components (Hero, Contact, …), `Word.tsx`, `ui/*` as needed
- `SchemaOrg.astro` (copy as-is)

### Phase D: Scripts and Tooling

#### Step D1: Copy All Required Scripts from sharedScripts

**Source folder (canonical path):**

```
/Users/norman/Library/CloudStorage/GoogleDrive-ndilthey@gmail.com/Shared drives/Hero Pages/Product/Hero Pages/Templates/sharedScripts
```

> **Note:** Path may vary by machine (Google Drive sync location). Use the `sharedScripts` folder from the Hero Pages Templates product. Do **not** copy scripts from an existing template repo — always use this canonical source to ensure you have the latest versions.

**This template’s layout:** place **`sync-theme-to-globals.mjs`** and **`build-deploy-cf.mjs`** under **`scripts/dev/`**; place **`translate-data.ts`** and **`add-language.ts`** under **`scripts/translation/`**; keep numbered scripts and **`onboard-client.ts`** at **`scripts/`** root. Align **`package.json`** commands with §13.

**Quick copy (from project root — adjust destinations to match the tree above):**

```bash
SHARED_SCRIPTS="/Users/norman/Library/CloudStorage/GoogleDrive-ndilthey@gmail.com/Shared drives/Hero Pages/Product/Hero Pages/Templates/sharedScripts"
mkdir -p scripts/dev scripts/translation
cp "$SHARED_SCRIPTS"/use-client.ts "$SHARED_SCRIPTS"/06-generate-website.ts "$SHARED_SCRIPTS"/05-extract-client-data.mjs "$SHARED_SCRIPTS"/02-pull-from-google-drive.mjs scripts/
cp "$SHARED_SCRIPTS"/sync-theme-to-globals.mjs "$SHARED_SCRIPTS"/build-deploy-cf.mjs scripts/dev/
cp "$SHARED_SCRIPTS"/translate-data.ts "$SHARED_SCRIPTS"/add-language.ts scripts/translation/
cp "$SHARED_SCRIPTS"/pull-from-google-drive.config.example.json scripts/pull-from-google-drive.config.json
# Optional: generate-programmatic-content.mjs, 07-fetch-google-reviews.ts → scripts/
```

See §13 for the full script list and npm script names.

**Mandatory** (typical): `use-client.ts`, `scripts/dev/sync-theme-to-globals.mjs`, `scripts/translation/translate-data.ts`, `scripts/translation/add-language.ts`, `06-generate-website.ts`, `05-extract-client-data.mjs`, `02-pull-from-google-drive.mjs`, `scripts/dev/build-deploy-cf.mjs`, pull config example.

**Optional** (feature-dependent): `generate-programmatic-content.mjs`, `07-fetch-google-reviews.ts`, `generate-grounding.mjs`, `generate-internal-links.mjs`, etc.

#### Step D2: Set Up Text Editor

- Copy `text-editor/` directory from template
- Integrate `ConditionalTextEditor` in `BaseLayout.astro`
- Verify all editable elements have `data-hero-factory-src-path` attributes

#### Step D3: Configure Deployment

- Create `.gitignore` (ignore `src/data/current/`, **`public/images/`**, credentials, env files, dist, .astro, node_modules)
- Configure all scripts in `package.json`
- Set up deployment: **`pnpm build:deploy`** → `scripts/dev/build-deploy-cf.mjs` and/or Vercel

### Phase E: Verification

1. Run `pnpm use-client <client-id>` to set active client
2. Run `pnpm dev` — verify theme syncs and site renders correctly
3. Verify every page renders with content from `websites.json` (no hardcoded text)
4. Verify all text is editable via `?editor` URL parameter
5. Run `pnpm build` — verify static generation succeeds
6. Verify all Astro pages generate for each supported language

---

## 17. Critical Rules

1. **NO hardcoded content in pages/components** — everything comes from `websites.json` (and linked JSON/MD per-site files). The AI must extract every string from the source repo into data.
2. **All text is translatable** — loaded per-language from `websites-<lang>.json`
3. **Theme is configurable** — colors and fonts from `theme.config.json`, synced to CSS variables (`pnpm sync-theme` → `scripts/dev/sync-theme-to-globals.mjs`)
4. **Sections are toggleable** — top-level **`sectionIds`** (`SectionConfig[]`: `id` + `visible`) plus per-site **`sectionVisibility`** overrides control what renders
5. **Components are reusable** — same component works for any client/website
6. **Schema.org is data-driven** — defined in `metadata.schema` within `websites.json`; builder supports extended types (see §10)
7. **Text editor integration** — editable copy uses `data-hero-factory-src-path` (or **`Word`** / `dataHeroFactorySrcPath`)
8. **Static generation** — pages use `getStaticPaths()` where dynamic; `pnpm build` runs post-build **sitemap** generation
9. **Client isolation** — `src/data/current/` symlink (or equivalent) ensures clean separation; **`use-client`** updates `.env.local` (`SITE_ID`, `CLIENT_ID`, `DEPLOY_DOMAIN`, …)
10. **Analysis first** — the converting AI MUST fully analyze the source repo before writing any code. The `websites.json` structure, type definitions, pages, and components are all derived from what exists in the source repo.
11. **Language-prefixed routes** — most content pages live under **`src/pages/[lang]/`**. Root-level exceptions include **`index.astro`**, **`404.astro`**, **`robots.txt.ts`**, and optional demos (e.g. `city-example/`). See §6.3.
12. **`loadPageContext` returns `clientDomain`** — not `domain`; use it for absolute URLs and alternates.
13. **Per-site assets** — optional `src/data/<client>/<site-id>/` files (`faq.json`, `faq-xxl.json`, `prompt.md`, `grounding.md`, …) must stay consistent with paths referenced in `websites.json`.
14. **Content collections** — ratgeber/blog-style content uses `src/content/` + `getCollection`; keep frontmatter aligned with `src/content/config.ts`.
