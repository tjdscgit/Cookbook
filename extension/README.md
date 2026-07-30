# Cookbook Clipper (Chrome extension)

Clips the recipe on the page you're looking at straight into your Cookbook. Runs in the page's own
context, so it reads `schema.org/Recipe` JSON-LD directly — no CORS problem, no proxy relay, none of
the flakiness the main app's website-clipping route works around.

## Install (unpacked — this isn't on the Chrome Web Store)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this `extension/` folder.
4. Click the puzzle-piece icon in the toolbar, pin **Cookbook Clipper**.

## Set up

Right-click the toolbar icon → **Options** (or open it from the popup the first time). Same two
things as the main app:

- Airtable personal access token, scoped to your Cookbook base
- Base id (`app...`)
- Optionally an Anthropic API key — only used when a page has *no* JSON-LD recipe data, so Claude
  reads the page text instead. Skip it and those pages just won't clip.

Credentials live in the extension's own storage, isolated from every other site and from the main
app's. Set them again here even if you've already set them in the web app.

## Use it

Open a recipe page, click the toolbar icon, click **Clip this page**. Most recipe sites publish
JSON-LD, so this is instant and free. If a page has none and you've added an Anthropic key, it falls
back to Claude on the page's text. Either way you get a small preview — name, servings, ingredient
and step counts — before anything is written. **Save to Cookbook** writes it to Airtable directly;
nothing is saved without that click.

## Why some files are duplicated

`lib/cookbook-units.js` and `lib/cookbook-data.js` are byte-identical copies of the ones in the
parent app. Chrome extensions can only load files from inside their own folder, so there's no way to
share them by reference without a build step — and this project deliberately has none. If you change
the scaling engine or the Airtable layer in the main app, copy the file here again.
