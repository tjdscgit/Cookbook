// scripts/convert-flavorish.mjs
// One-off migration: a Flavorish export folder -> a JSON payload the app's importer can push
// to Airtable.
//
// Run:  node scripts/convert-flavorish.mjs <export-dir> [out.json]
//
// The export is already structured — every ingredient carries {quantity, unit_of_measure,
// description} alongside its raw text — so this is mostly a field rename. cookbook-units'
// parseIngredient is used only as the fallback for the lines the export left unparsed, and to
// split "onion, finely chopped" into item + note the way the rest of the app expects.
//
// Nothing here talks to Airtable. The output is a plain file; the app's Settings > Import reads
// it, so the credentials never leave the browser.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Units = require(path.join(import.meta.dirname, "..", "cookbook-units.js"));

const srcDir = process.argv[2];
const outFile = process.argv[3] || path.join(import.meta.dirname, "..", "flavorish-import.json");
if (!srcDir) {
  console.error("usage: node scripts/convert-flavorish.mjs <export-dir> [out.json]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------
// A group header ("For the sauce:") is a row in its own right in the export, not a property of
// the rows beneath it. It applies to everything that follows until the next header, which is
// exactly the `group` field the app's schema wants.
function convertIngredients(rows) {
  const out = [];
  let group = "";
  let n = 0;
  for (const row of rows.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))) {
    const text = String(row.text || "").trim();
    if (!text) continue;
    if (row.is_group_header) {
      group = text.replace(/[:：]\s*$/, "").replace(/^for the\s+/i, "").trim();
      group = group ? group[0].toUpperCase() + group.slice(1) : "";
      continue;
    }
    // parseIngredient does the item/note split and the "((Note 1))" footnote convention. Where
    // the export already knows the quantity and unit, those win — they came from the source
    // site's structured data rather than from re-reading a string.
    const parsed = Units.parseIngredient(preClean(text));
    const qty = row.quantity != null ? Number(row.quantity) : parsed.qty;
    const qtyMax = row.quantity2 != null ? Number(row.quantity2) : parsed.qtyMax;
    const unit = row.unit_of_measure ? String(row.unit_of_measure) : parsed.unit;

    // The export's `description` is the text minus the leading quantity, so re-running the
    // parser on it recovers a clean item/note split without the number getting in the way.
    const fromDesc = row.description ? Units.parseIngredient(preClean(String(row.description))) : null;
    const useDesc = fromDesc && fromDesc.item && fromDesc.qty == null;
    let item = useDesc ? fromDesc.item : parsed.item;
    let note = useDesc ? fromDesc.note : parsed.note;

    // The export leaves its unit glued to the front of `description` about half the time
    // ("/ 1 lb lamb mince", "tablespoon canola oil"). Strip a leading copy of the known unit.
    if (unit) item = stripLeadingUnit(item, unit);
    item = item.replace(/^[\/\-–,\s]+/, "").trim();
    if (!item) item = parsed.item || text;

    out.push({
      id: `i${++n}`,
      qty: Number.isFinite(qty) ? qty : null,
      qtyMax: Number.isFinite(qtyMax) ? qtyMax : null,
      unit: unit || "",
      item,
      note: note || "",
      group,
      // Same rule the clipper uses: an amount that isn't a number, or reads as a seasoning
      // direction, must not multiply when servings change.
      scalable: !(qty == null && /to taste|to serve|for (greasing|frying|dusting|brushing|drizzling)|pinch|as needed|garnish/i.test(text)),
    });
  }
  return out;
}

// Two conventions the source sites use that parseIngredient can't be expected to know about.
function preClean(s) {
  return String(s)
    // "500g/ 1 lb lamb mince" — the imperial equivalent, printed for American readers. The
    // metric amount is already captured in qty/unit, so the alternate is pure noise here.
    .replace(/^\s*\/\s*[\d.,/\s¼½¾⅓⅔⅛⅜⅝⅞]+\s*(lb|lbs|oz|ounces?|pounds?|inch(?:es)?|cups?|tbsp|tsp|ml|g|kg)\b\.?\s*/i, "")
    .replace(/^\s*\//, "")
    // "garlic cloves (, crushed using a garlic press)" — a paren opening straight onto a comma
    // is always a preparation note, never part of the name.
    .replace(/\(\s*,\s*/g, "((")
    .replace(/\s{2,}/g, " ")
    // "150 g (1/2 cup) self-raising flour" — the alternate measure. Once the leading quantity is
    // stripped the paren sits in front of the name, where it reads as part of it; as a note it
    // stays available without cluttering the ingredient line.
    .replace(/^\s*\(([^()]+)\)\s*(?=\S)/, "(($1)) ")
    .trim();
}

function stripLeadingUnit(item, unit) {
  const u = String(unit).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return item.replace(new RegExp(`^\\s*${u}e?s?\\b\\.?\\s*`, "i"), "").trim();
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
// Same header convention as ingredients. `ingredientIds` is the link that drives the app's
// per-step ingredient display, and the export has no equivalent — it's inferred here by the same
// strict word-overlap rule the clipper uses, because wiring "salt" into every step reads worse
// than wiring nothing.
function convertSteps(rows, ingredients) {
  const out = [];
  let group = "";
  let n = 0;
  for (const row of rows.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))) {
    const text = String(row.text || "").trim();
    if (!text) continue;
    if (row.is_group_header) {
      group = text.replace(/[:：]\s*$/, "").trim();
      continue;
    }
    // Some sources cram a whole method into one row. Split on blank lines only — splitting on
    // every sentence would shred steps that legitimately run to three sentences.
    for (const part of text.split(/\n\s*\n|\r\n\s*\r\n/).map((s) => s.trim()).filter(Boolean)) {
      out.push({ id: `s${++n}`, text: part, ingredientIds: matchIngredients(part, ingredients), group });
    }
  }
  return out;
}

function matchIngredients(stepText, ingredients) {
  const hay = " " + stepText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
  const hits = [];
  for (const ing of ingredients) {
    const words = String(ing.item || "").toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.some((w) => hay.includes(` ${w} `) || hay.includes(` ${w}s `))) hits.push(ing.id);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------
function convert(doc) {
  const r = doc.recipe || {};
  const ingredients = convertIngredients(doc.ingredients || []);
  const steps = convertSteps(doc.instructions || [], ingredients);

  const prep = minutes(r.prep_time_hours, r.prep_time_minutes);
  const cook = minutes(r.cook_time_hours, r.cook_time_minutes);

  return {
    name: clean(r.title) || "Untitled",
    description: clean(r.description),
    servings: Number(r.servings) > 0 ? Number(r.servings) : 4,
    servingUnit: "servings",
    prepMinutes: prep,
    // A source that gave only a total time is more useful recorded as cook time than dropped.
    cookMinutes: cook != null ? cook : (prep == null ? minutes(r.total_time_hours, r.total_time_minutes) : null),
    ingredients,
    steps,
    notes: clean(r.notes),
    sourceUrl: r.source_url || "",
    sourceType: r.source_url ? "Website" : "Manual",
    photoUrl: r.image_url || "",
    tags: tagsFor(r),
    collections: (doc.collections || []).filter((c) => typeof c === "string"),
    favourite: (doc.collections || []).includes("Faves"),
    // These came out of a cookbook the user was already using, so they belong in Cookbook
    // rather than To Try.
    tried: true,
  };
}

// Cuisine and category are the two keywords worth keeping — the raw `keywords` list is SEO
// noise ("kofta kebabs", "lamb mince recipe") that would swamp the tag filter.
function tagsFor(r) {
  const tags = [];
  for (const v of [].concat(r.cuisine || [], r.category || [])) {
    const t = clean(v);
    if (t && t.length < 24 && !tags.includes(t)) tags.push(t);
  }
  return tags;
}

function minutes(h, m) {
  const total = (Number(h) || 0) * 60 + (Number(m) || 0);
  return total > 0 ? total : null;
}

function clean(v) {
  return String(v == null ? "" : v)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const files = fs.readdirSync(path.join(srcDir, "recipes")).filter((f) => f.endsWith(".json"));
const recipes = [];
const dupes = [];

for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(srcDir, "recipes", f), "utf8"));
  const recipe = convert(doc);

  // The export contains a handful of true duplicates — the same recipe saved twice. Keep
  // whichever copy carries more detail rather than importing both.
  const key = recipe.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seen = recipes.findIndex((x) => x._key === key);
  if (seen !== -1) {
    const weight = (x) => x.ingredients.length + x.steps.length;
    if (weight(recipe) > weight(recipes[seen])) {
      dupes.push(`${recipe.name} (kept the fuller copy)`);
      recipe._key = key;
      recipes[seen] = recipe;
    } else {
      dupes.push(`${recipe.name} (dropped the thinner copy)`);
    }
    continue;
  }
  recipe._key = key;
  recipes.push(recipe);
}

for (const r of recipes) delete r._key;
recipes.sort((a, b) => a.name.localeCompare(b.name));

const collections = [...new Set(recipes.flatMap((r) => r.collections))];
const payload = { version: 1, source: "flavorish", exported: new Date().toISOString(), collections, recipes };
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

console.log(`${recipes.length} recipes -> ${outFile}`);
console.log(`collections: ${collections.join(", ")}`);
if (dupes.length) console.log(`duplicates resolved:\n  ${dupes.join("\n  ")}`);
const thin = recipes.filter((r) => r.ingredients.length < 3 || r.steps.length < 2);
if (thin.length) console.log(`thin (worth a look):\n  ${thin.map((r) => `${r.name} — ${r.ingredients.length} ing, ${r.steps.length} steps`).join("\n  ")}`);
