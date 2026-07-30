# Cookbook — Airtable schema

The app addresses tables **by name**, so these names must match exactly. Field names likewise —
rename one in Airtable and you must change the matching entry in the `F` map at the top of
[cookbook-data.js](cookbook-data.js).

## Why ingredients and steps are JSON

Airtable's free plan allows **1,000 records per base**. Normalised — one record per ingredient and
one per step — a single recipe would cost roughly 20 records, capping the cookbook at about **45
recipes**. Stored as JSON on the recipe record, one recipe costs **one record**, so 1,000 recipes
fit comfortably.

The trade-off is real and worth knowing: you can't edit an individual ingredient from Airtable's
grid view. The app is the editing surface. Everything you'd actually want to browse in Airtable —
names, collections, favourites, notes, photos — stays as proper fields.

If you ever outgrow this, Airtable Team raises the ceiling to 50,000 records and the JSON fields can
be split into real tables then.

---

## Table: `Recipes`

| Field | Type | Notes |
|---|---|---|
| `Name` | Single line text | **Primary field** |
| `Description` | Long text | |
| `Photo` | Attachment | |
| `Source URL` | URL | |
| `Source Type` | Single select | Options: `Website`, `Photo`, `Social`, `Manual` |
| `Servings` | Number (integer) | The serving count the stored amounts refer to |
| `Serving Unit` | Single line text | "servings", "slices", "cookies" |
| `Prep Minutes` | Number (integer) | |
| `Cook Minutes` | Number (integer) | |
| `Collections` | Link to `Collections` | Allow linking to multiple |
| `Favourite` | Checkbox | |
| `Tried` | Checkbox | Ticked = shown in the "Cookbook" section; unticked = "To Try" |
| `Tags` | Multiple select | Start empty; the app writes new options as needed |
| `Ingredients JSON` | Long text | See below |
| `Steps JSON` | Long text | See below |
| `Notes` | Long text | Your own notes |

### `Ingredients JSON`

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

### `Steps JSON`

```jsonc
[
  { "id": "s1", "text": "Cream the butter and sugar until pale.",
    "ingredientIds": ["i1", "i2"], "group": "Cake" }
]
```

`ingredientIds` is what drives the per-step ingredient display — the reason this app exists. An id
listed here that doesn't exist in `Ingredients JSON` is ignored rather than rendered blank.

---

## Table: `Collections`

| Field | Type | Notes |
|---|---|---|
| `Name` | Single line text | **Primary field** |
| `Emoji` | Single line text | Optional |
| `Order` | Number (integer) | Sort order in the filter bar |
| `Description` | Long text | Optional |

The reciprocal `Recipes` link field is created automatically by Airtable when you add the
`Collections` link on the Recipes table.

---

## Table: `Meal Plans`

One record per **week**, not per meal. Per-meal records would cost ~1,100 records a year and
exhaust the free tier on their own; per-week costs 52.

| Field | Type | Notes |
|---|---|---|
| `Week Starting` | Date (ISO, `YYYY-MM-DD`) | **Primary field.** Always a Monday |
| `Plan JSON` | Long text | |
| `Notes` | Long text | |

```jsonc
{
  "2026-07-27": {
    "Dinner": [ { "recipeId": "recXXXXXXXXXXXXXX", "servings": 8 } ],
    "Lunch":  [ { "recipeId": "recYYYYYYYYYYYYYY", "servings": 2 } ]
  }
}
```

Meal keys are `Breakfast`, `Lunch`, `Dinner`.

---

## Table: `Shopping Lists`

| Field | Type | Notes |
|---|---|---|
| `Name` | Single line text | **Primary field** |
| `Week Starting` | Date | Optional — links the list to a planned week |
| `Items JSON` | Long text | |
| `Done` | Checkbox | |

```jsonc
[
  { "id": "x1", "name": "self-raising flour", "qty": 7.5, "unit": "cup",
    "aisle": "Baking", "checked": false, "manual": false,
    "fromRecipes": ["recXXXXXXXXXXXXXX"] }
]
```

`manual: true` marks an item you typed in yourself. Those survive when the list is regenerated from
the planner; generated items are replaced.

---

## Token scopes

Create a token at [airtable.com/create/tokens](https://airtable.com/create/tokens) with:

- `data.records:read`
- `data.records:write`
- `schema.bases:read`

and grant it access to the Cookbook base specifically.
