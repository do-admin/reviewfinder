# Lovable React → Astro (scaffold) + Ralph iterative conversion

This workflow migrates a **Lovable / Vite React** repository into a copy of **`template-scaffold`**, then uses **Ralph-style** one-task-per-session Claude runs to finish the data-driven conversion.

## Prerequisites

- **pnpm** on PATH
- **Claude Code CLI** (`claude`) for Ralph loops and the final audit
- Paths to:
  - **Source repo**: Lovable project (e.g. `hero-pages/template.directory/lovable.*`)
  - **template-scaffold**: `hero-pages/template-scaffold`
  - **Destination**: empty folder or use `--force` to replace

## Step 1 — Mechanical migration

From `template.location` root:

```bash
pnpm migrate:lovable-to-scaffold -- \
  --src-repo /abs/path/to/lovable-repo \
  --dest /abs/path/to/output-astro-repo \
  --scaffold /abs/path/to/template-scaffold \
  --generate-ralph
```

Options:

| Flag | Meaning |
|------|---------|
| `--force` | Overwrite `--dest` if it exists |
| `--skip-install` | Skip `pnpm install` in destination |
| `--skip-pages` | Only copy scaffold + components; skip Astro page generation |
| `--generate-ralph` | Write `prd.md`, `PROMPT.md`, `activity.md`, `CHECKS.md` into `--dest` |

This step:

1. Copies **template-scaffold** → `--dest`
2. Merges `src/components` from the Lovable repo (with React→Astro string transforms)
3. Copies `public/` and `src/assets/` when present
4. Generates `src/pages/[lang]/*.astro` routes from `src/pages/*.tsx` (plus dynamic stubs for `RatgeberArticle`, `KitaDetail`)

Shared logic lives in **`conversion-kit/lib/react-to-astro-migrate.mjs`**. Copy the whole **`conversion-kit/`** folder if you need the scripts in another repository ([conversion-kit/README.md](./../conversion-kit/README.md)).

## Step 2 — Client data symlink (in destination)

Match **[TEMPLATE-CONVERSION-GUIDE.md](../conversion-kit/docs/TEMPLATE-CONVERSION-GUIDE.md)**: point `src/data/current` at your client folder (e.g. `src/data/nicezeit`).

```bash
cd /path/to/output-astro-repo
pnpm use-client <client-id>
```

## Step 3 — Ralph iterative tasks

In the **destination** repo (after `generate-ralph`):

```bash
cd /path/to/output-astro-repo
pnpm ralph:convert -- 25 .
```

Or from `template.location` with explicit dest:

```bash
cd /path/to/template.location
pnpm ralph:convert -- 25 /path/to/output-astro-repo
```

Each iteration runs **one** `claude -p "$(cat PROMPT.md)"` call (fresh session). The loop stops when Claude prints `<promise>COMPLETE</promise>`.

Edit **`PROMPT.md`** / **`prd.md`** in the destination if you need stricter rules.

## Step 4 — Final completeness audit (large model)

```bash
cd /path/to/template.location
pnpm audit:conversion -- --dest /path/to/output-astro-repo
```

Optional:

```bash
export CLAUDE_AUDIT_MODEL=opus-4.6
```

If your CLI uses a different flag for model selection, run the generated prompt manually:

```bash
cat .claude-audit-prompt.md   # inside --dest
```

## Conventions enforced by generated prompts

- **Headings**: `@/components/blocks/Heading` only (no raw `<h1>`–`<h6>` in app code).
- **Copy**: `@/components/blocks/Word` for user-visible text; `dataHeroFactorySrcPath` where editing applies.
- **Data**: `websites.json` + `sectionIds` aligned with `PageContent.astro` / `sectionVisibility`.
- **Legal**: `impressum` and `datenschutz` entries in `pages[]`.

## AI block registry (copy with 06 / 08 / clone scripts)

The **`template.location`** pipeline batches AI work (fill blanks, content-quality review, clone) using **`scripts/ai-block-registry.json`** plus **`scripts/lib/ai-block-registry.ts`**. If you copy **`06-generate-website.ts`**, **`08-refine-website-data.ts`**, or **`clone-website.ts`** into another repo (including a post–Ralph destination), copy those two assets as well and keep them in sync.

- **`blocks[]`**: each block references **`pageName`** (must equal `pages[].name` in `websites.json`) and optional **`propertyPath`** (e.g. `hero`, `metadata`). Order defines batch order.
- **`pageAliasToSlimRoot`**: maps a page **`name`** to the **clone slim** key when they differ (in this template, `ueber-uns` → `ueberUns`). Omit entries where the name already matches (`home`, `faq`, …).
- Paths not matched by the registry are still processed via legacy **`groupPathsBySections`** batches.
- **`AI_BLOCK_REGISTRY`**: optional env var pointing to an alternate JSON file (absolute or repo-relative).

Full field list and fork notes: **[TEMPLATE-CONVERSION-GUIDE.md §13.1](../conversion-kit/docs/TEMPLATE-CONVERSION-GUIDE.md)**.

## Scripts reference (template.location)

All commands run files under **`conversion-kit/`** (see [conversion-kit/README.md](./../conversion-kit/README.md)). `scripts/*` are thin wrappers for backward compatibility.

| pnpm command | Underlying script (`conversion-kit/`) |
|--------------|----------------------------------------|
| `pnpm migrate:lovable-to-scaffold` | `migrate-lovable-to-scaffold.mjs` — mechanical copy + routes |
| `pnpm generate:ralph-conversion` | `generate-ralph-conversion.mjs` — PRD / PROMPT / activity / CHECKS |
| `pnpm ralph:convert` | `ralph-convert.sh` — Ralph loop |
| `pnpm audit:conversion` | `audit-conversion.mjs` — final large-model audit prompt |

## See also

- [TEMPLATE-CONVERSION-GUIDE.md](../conversion-kit/docs/TEMPLATE-CONVERSION-GUIDE.md) — full architecture (incl. §13.1 AI block registry)
- [SCRIPTS.md](./SCRIPTS.md) — other automation
- [conversion-kit/README.md](./../conversion-kit/README.md) — copy the kit into another repository
