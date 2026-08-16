# Cookbook — Firestore schema

The app addresses collections and fields **by name**, so these names must match exactly. Rename one
and you must change the matching entry in the `F` map at the top of [cookbook-data.js](cookbook-data.js).

Nothing here needs creating in advance. Unlike Airtable, Firestore has no schema to set up — a
collection springs into existence the first time a document is written to it. Create the database,
publish [firestore.rules](firestore.rules), and the app does the rest.

## Why this replaced Airtable

Airtable's free plan caps API calls at **1,000 per month**. A cookbook that reloads whenever you
open it reaches that on its own, and the cap is not a rate limit — it doesn't clear by waiting. The
practical ceiling had nothing to do with how many recipes you had.

Firestore's free tier is 50,000 reads and 20,000 writes **per day**. A full load of a 51-recipe
cookbook costs about 51 reads.

## What changed in the data model

Under Airtable, ingredients and steps were **JSON strings** stuffed into long-text fields, because
the free plan capped a base at 1,000 records and one record per ingredient would have limited the
cookbook to roughly 45 recipes. That constraint is gone: they are now real nested arrays of objects,
and a document is close to a literal serialisation of the app-side recipe object.

`parseRecipe` still runs the old JSON strings through `safeParseJson`, so a document carried over
from the Airtable era reads correctly and is rewritten in the new shape on its next save.

Photos also changed. Airtable fetched an image URL and stored its own copy; Firestore stores the URL
as given, so a recipe photo stays hotlinked from wherever it was clipped. Simpler and free, at the
cost of a photo that can vanish if the source site takes it down. Firebase Cloud Storage would fix
that but requires a billing account, which this app deliberately avoids.

---

## Collection: `recipes`

Document id: auto-generated.

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `description` | string | |
| `photoUrl` | string | Written only by `setPhotoFromUrl`, never by a normal save |
| `sourceUrl` | string | |
| `sourceType` | string | One of `Website`, `Photo`, `Social`, `Manual` |
| `servings` | integer | The serving count the stored amounts refer to |
| `servingUnit` | string | "servings", "slices", "cookies" |
| `prepMinutes` | integer \| null | |
| `cookMinutes` | integer \| null | |
| `collectionIds` | array of string | Document ids from `collections` |
| `favourite` | boolean | |
| `tried` | boolean | True = shown in "Cookbook"; false = "To Try" |
| `tags` | array of string | |
| `ingredients` | array of map | See below |
| `steps` | array of map | See below |
| `notes` | string | Your own notes |

Saves pass an **update mask** naming exactly these fields, so anything you add to a document by hand
in the Firestore console survives a save from the app.

### `ingredients`

```jsonc
[
  { "id": "i1", "qty": 225, "qtyMax": null, "unit": "g",
    "item": "unsalted butter", "note": "softened", "group": "Cake", "scalable": true },
  { "id": "i4", "qty": null, "qtyMax": null, "unit": "pinch",
    "item": "salt", "note": "", "group": "Cake", "scalable": false }
]
```

- `id` — referenced by steps. Must be unique within the recipe.
- `qtyMax` — the upper end of a range: "2–3 tbsp" is `qty: 2, qtyMax: 3`.
- `group` — a sub-recipe heading ("For the sauce"), or `""`.
- `scalable: false` — this amount does not multiply when servings change. Used for pinches,
  "to taste", and "oil for greasing".

### `steps`

```jsonc
[
  { "id": "s1", "text": "Cream the butter and sugar until pale.",
    "ingredientIds": ["i1", "i2"], "group": "Cake" }
]
```

`ingredientIds` is what drives the per-step ingredient display — the reason this app exists. An id
listed here that doesn't exist in `ingredients` is ignored rather than rendered blank.

---

## Collection: `collections`

Document id: auto-generated.

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `emoji` | string | Optional |
| `order` | integer | Sort order in the filter bar |
| `description` | string | Optional |

The link is one-directional: a recipe holds `collectionIds`, and a collection knows nothing about
its recipes. Airtable maintained a reciprocal link field automatically; Firestore does not, and the
app never needed it.

---

## Collection: `mealPlans`

**Document id is the week's Monday** as `YYYY-MM-DD`. That is the one real design change from the
Airtable version: loading a week is now a single get by key, with no query, no index, and no
`filterByFormula`. Saving upserts, so a week that has never been planned needs no separate create.

| Field | Type | Notes |
|---|---|---|
| `weekStarting` | string | Same as the document id, stored again for legibility |
| `plan` | map | |
| `notes` | string | |

```jsonc
{
  "2026-07-27": {
    "Dinner": [ { "recipeId": "aB3xK9…", "servings": 8 } ],
    "Lunch":  [ { "recipeId": "cD7mP2…", "servings": 2 } ]
  }
}
```

Meal keys are `Breakfast`, `Lunch`, `Dinner`.

---

## Collection: `shoppingLists`

Document id: auto-generated.

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `weekStarting` | string | Optional — links the list to a planned week |
| `items` | array of map | |
| `done` | boolean | |

```jsonc
[
  { "id": "x1", "name": "self-raising flour", "qty": 7.5, "unit": "cup",
    "aisle": "Baking", "checked": false, "manual": false,
    "fromRecipes": ["aB3xK9…"] }
]
```

`manual: true` marks an item you typed in yourself. Those survive when the list is regenerated from
the planner; generated items are replaced.

---

## Security

The project id and web API key in the browser are **public identifiers, not secrets** — they name
the project and grant nothing. What guards the data is being signed in, plus the rules in
[firestore.rules](firestore.rules), which restrict every document to one account's uid.

This is a better arrangement than the Airtable token it replaced. That token *was* a secret, it sat
in `localStorage`, and anyone who got it held full read/write access to the base.
