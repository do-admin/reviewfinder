# Lovable React → Astro conversion kit

Self-contained scripts and reference material for migrating a **Lovable/Vite React** repo into a **`template-scaffold`** Astro project, then running **Ralph-style** one-task-per-session Claude loops and a **final audit**.

## Contents

| File | Purpose |
|------|---------|
| `migrate-lovable-to-scaffold.mjs` | Copy scaffold → `--dest`, merge `src/components` + pages, emit `[lang]` Astro routes |
| `lib/react-to-astro-migrate.mjs` | Shared mechanical transforms (used by migrate) |
| `generate-ralph-conversion.mjs` | Writes `prd.md`, `PROMPT.md`, `activity.md`, `CHECKS.md` in the **target** repo |
| `ralph-convert.sh` | Runs `claude -p "$(cat PROMPT.md)"` in a loop until `<promise>COMPLETE</promise>` |
| `audit-conversion.mjs` | Final repo-wide audit prompt (large model; set `CLAUDE_AUDIT_MODEL`, default `opus-4.6`) |
| `vendor/ralph-wiggum-reference.sh` | Upstream Ralph Wiggum loop reference (same idea as `tools/helpers/ralph/ralph.sh`) |

Generated **in the migrated Astro repo** (not in this folder): `prd.md`, `PROMPT.md`, `activity.md`, `CHECKS.md`, `.claude-audit-prompt.md` (from audit).

## Auto-copied into `--dest`

`migrate-lovable-to-scaffold.mjs` **automatically copies** the runtime scripts (`generate-ralph-conversion.mjs`, `ralph-convert.sh`, `audit-conversion.mjs`, `README.md`) into `<dest>/conversion-kit/` so you can run everything from inside the migrated repo without reaching back to `template.location`.

## Copy into another repository manually

If you need the kit elsewhere (e.g. a CI pipeline or a standalone project):

1. Copy the entire `conversion-kit/` directory into your repo (e.g. repo root: `./conversion-kit/`).
2. Run scripts with `node` / `bash` using paths relative to that copy, or add npm/pnpm scripts that point at `conversion-kit/...`.
3. Set **`CONVERSION_TEMPLATE_SCAFFOLD`** to the absolute path of `template-scaffold` if auto-detection fails (see below).

### Default `template-scaffold` path

If `--scaffold` is omitted, the migrate script tries, in order:

1. Environment variable **`CONVERSION_TEMPLATE_SCAFFOLD`**
2. `<conversion-kit>/../../template-scaffold` (matches `hero-pages/template.location/conversion-kit` layout)
3. `<conversion-kit>/../template-scaffold` (if the kit sits next to `template-scaffold` in the same parent folder)

## Typical flow

```bash
# 1) Mechanical migration + Ralph files in destination
node conversion-kit/migrate-lovable-to-scaffold.mjs \
  --src-repo /path/to/lovable-repo \
  --dest /path/to/new-astro-repo \
  --scaffold /path/to/template-scaffold \
  --generate-ralph

# 2) Everything else runs from inside --dest (scripts are already there)
cd /path/to/new-astro-repo
pnpm use-client <client-id>                                     # if applicable
node conversion-kit/generate-ralph-conversion.mjs --dest .       # (re)generate PRD
bash conversion-kit/ralph-convert.sh 25 .                        # Ralph loop

# 3) Final audit
node conversion-kit/audit-conversion.mjs --dest .
```

## `template.location` integration

In the monorepo, `hero-pages/template.location/package.json` exposes the same entry points via `pnpm` (e.g. `migrate:lovable-to-scaffold`). Those commands run these files under `template.location/conversion-kit/`.

See also `docs/MIGRATE-LOVABLE-RALPH.md` in `template.location`.
