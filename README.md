# Cookbook

A recipe app for phone and desktop. Recipes scale to any serving size, and the method shows each
ingredient *and its amount* beside the step that uses it — so you're not scrolling back to the
ingredient list with wet hands.

Vanilla HTML/CSS/JS. No build step, no `npm install`, no framework. Data lives in Airtable.

## Setup

**1. Create the Airtable base.** Make an empty base called `Cookbook`, then create the four tables
described in [cookbook-schema.md](cookbook-schema.md): `Recipes`, `Collections`, `Meal Plans`,
`Shopping Lists`. Names must match exactly.

**2. Create a token** at [airtable.com/create/tokens](https://airtable.com/create/tokens) with the
`data.records:read`, `data.records:write` and `schema.bases:read` scopes, granted access to the
Cookbook base.

**3. Open the app** and paste the token and base id into Settings ⚙. "Test connection" tells you
immediately if a table name is wrong.

**4. Optional — an Anthropic API key.** Only needed to clip recipes from **photos** and **social
posts**. Website clipping and manual entry work without it. Roughly 5–6¢ per photo.

## Running it

```bash
npx -y serve -l 8935 .
```

Then open <http://localhost:8935>. For the real thing, push to a GitHub repo and enable Pages — it
installs to a phone or desktop home screen from there and works offline for reading.

## Tests

```bash
node cookbook-units.test.js
```

Covers the scaling engine: fraction parsing and formatting, ingredient parsing, serving scaling,
non-scaling amounts, and shopping-list aggregation. No test framework — deliberately, so it stays
runnable with nothing installed.

## Regenerating the icons

```bash
node scripts/make-icons.mjs
```

Writes real PNGs with no dependencies. Edit the two hex constants at the top to re-tint them.

## Files

| File | What it does |
|---|---|
| `index.html` | App shell and all markup |
| `cookbook.css` | Theming (light + dark) and layout |
| `cookbook-units.js` | Ingredient parsing, serving scaling, shopping-list aggregation |
| `cookbook-data.js` | The only file that knows Airtable exists |
| `cookbook-clip.js` | Clipping from websites, photos and pasted text |
| `cookbook-plan.js` | Weekly planner and shopping-list rendering |
| `cookbook-ui.js` | State, navigation and every view |
| `sw.js` | Service worker — network-first, `no-store` |

## Notes on measurements

Defaults to **Australian** measures: 1 tbsp = 20 ml, 1 cup = 250 ml. The US tablespoon is 15 ml, so
a recipe using 4 tbsp of raising agent is a third out if the wrong system is assumed. There's a US
toggle in Settings.

Recipes always **display** the units they were written in — conversion happens only when combining
amounts onto a shopping list.
