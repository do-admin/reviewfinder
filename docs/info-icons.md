# Info section — dynamic Lucide icons

The [Info](../src/components/Info.tsx) section renders **six** icons. Each icon is chosen in `websites.json` (and `websites-{lang}.json` for translated copies) on the `index` page’s `info` object.

## Fields

- **`info.activities.icon`**, **`info.nutrition.icon`**, **`info.garden.icon`** — one icon per highlight card.
- **`info.valueIcons`** — three keys matching the value columns:
  - `mindfulness`
  - `nature`
  - `participation`

## Naming

Use **PascalCase** names exactly as exported from [`lucide-react`](https://www.npmjs.com/package/lucide-react) (same as on [lucide.dev](https://lucide.dev/icons/), but use the **React** export name, e.g. `UtensilsCrossed` not `utensils-crossed`).

If a name is missing or invalid, the component falls back to the previous template defaults (Leaf, Utensils, Sprout, Heart, Sun, Users).

## Template

See `info` in [src/data/_template/websites.json](../src/data/_template/websites.json): empty `icon` / `valueIcons` strings are valid placeholders for AI or authors to fill in.
