# Client Onboarding Guide

## A) New Client — From Scratch

### Prerequisites

- `.env.local` with API keys (`OPENROUTER_API_KEY`, optionally `FIRECRAWL_API_KEY`, `GOOGLE_PLACES_API_KEY`) - fetch from passwords view in herokit.
- Google Drive credentials (`google-drive-credentials.json`) if pulling assets from Drive - fetch from passwords view in herokit
- Client's Google Drive folder shared with the service account (done)

### Steps

**1. Run the full onboarding pipeline**

```bash
pnpm onboard-client
```

This runs all 6 phases interactively. You'll be prompted for:

- **Drive Folder ID** (from the Google Drive folder URL)
- **Client Domain** (e.g. `my-client.com`)

**Or non-interactive:**

```bash
pnpm onboard-client \
  --client-id=my-client \
  --client-name="My Client Inc" \
  --drive-folder-id=abc123 \
  --client-domain=my-client.com
```

### What the pipeline does

| Phase           | What happens                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Create       | Scaffolds `src/data/<clientId>/` with `websites.json`, `theme.config.json`, `language.config.json`, downloads fonts                             |
| 2. Assets       | Pulls images/files from Google Drive, organizes them, processes Excel data                                                                      |
| 3. Extract      | Scrapes Impressum + social links via Firecrawl, fetches favicon, optional `prompt.md` + `topics.json` generation (`pnpm extract-client-prompt`) |
| 4. Generate     | Runs AI generation for each site that has a `prompt.md` (fallback: `prompt.txt`)                                                                |
| 5. Activate     | Runs `use-client` + `sync-theme` to make this client active                                                                                     |
| 6. Enhancements | Translates data, generates programmatic content, fetches Google reviews                                                                         |

### Skipping phases

If something fails or isn't needed, skip individual phases:

```bash
pnpm onboard-client --skip-assets --client-id=my-client
```

Or run a single phase:

```bash
pnpm onboard-client --only=extract --client-id=my-client
```

**2. Verify locally**

```bash
pnpm dev
```

Select the new client/site when prompted. Check the site at `http://localhost:4321`.

**3. Build & Deploy**

```bash
pnpm build:deploy
```

---

## B) New Website for an Existing Client

Use this when a client already has a folder in `src/data/<clientId>/` and you need to add another location/site.

### Option 1: Clone an existing site (recommended)

```bash
pnpm clone-website
```

Interactive prompts will ask you to:

1. Pick the client
2. Pick the source site to clone from
3. Enter the new site ID

The AI updates location-specific fields (address, SEO text, map, coordinates) while keeping brand-level fields (name, navigation, legal) intact.

Requires `OPENROUTER_API_KEY` in `.env.local`.

**Non-interactive:**

```bash
pnpm clone-website --client=my-client --source=location-a --id=location-b --prompt=src/data/my-client/location-b/prompt.md
```

### Option 2: Generate from a prompt file

1. Create a folder `src/data/<clientId>/<new-site-id>/`
2. Add a `prompt.md` describing the new location (optional: `topics.json` from `pnpm extract-client-prompt`)
3. Run:

```bash
pnpm 06-generate-website
```

### After creating the new site

**Activate it:**

```bash
pnpm use-client <clientId> <newSiteId>
```

**Run enhancements (optional):**

```bash
pnpm translate-data              # translations
pnpm fetch-google-reviews        # Google reviews
pnpm generate-programmatic-content  # city/location pages
pnpm generate-llm-txt            # llm.txt for AI
```

**Verify locally:**

```bash
pnpm dev
```

**Deploy:**

```bash
pnpm build:deploy
```

---

## Quick Reference

| Task                         | Command                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Interactive menu             | `pnpm master`                                                                                                 |
| Full onboarding (new client) | `pnpm onboard-client`                                                                                         |
| Create client folder only    | `pnpm 01-create-client`                                                                                       |
| Clone a site                 | `pnpm clone-website`                                                                                          |
| Switch active client/site    | `pnpm use-client <clientId> <siteId>`                                                                         |
| Start dev server             | `pnpm dev`                                                                                                    |
| Build + deploy               | `pnpm build:deploy`                                                                                           |
| Pull Drive assets            | `pnpm 02-pull-assets --client=<id>`                                                                           |
| Scrape colors from website   | `pnpm scrape-colors https://example.com --write --client=<id>`                                                |
| Download fonts from website  | `pnpm download-client-fonts -- --client=<id>` or `pnpm download-fonts -- --fonts-url=https://… --client=<id>` |
