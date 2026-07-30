// cookbook-data.js
// SYNCED COPY — identical to ../../cookbook-data.js (see the note at the top of lib/cookbook-units.js
// for why). The extension only actually calls creds()/hasCreds()/setCreds()/createRecipe() out of
// this file, but kept whole rather than trimmed so the two copies never structurally diverge.
//
// The only file that knows Airtable exists.
//
// Everything above this layer works with plain app-side objects — a recipe is {id, name,
// ingredients:[...], steps:[...]}, not an Airtable record. Keeping the translation in one place is
// the same discipline the farm planner uses for its atFetch/atCreate/atPatch/atDelete boundary, and
// it's what made swapping that app's backend a contained change rather than a rewrite.
//
// Tables are addressed by NAME, not by table id. That means the base can be created by hand in the
// Airtable UI and this file works immediately, with no id-discovery step and nothing to paste
// beyond the base id itself.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root.CookbookUnits);
  } else {
    root.CookbookData = factory(root.CookbookUnits);
  }
})(typeof self !== "undefined" ? self : this, function (Units) {
  "use strict";

  const API = "https://api.airtable.com/v0";

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------
  // Field names are the exact strings in Airtable. Rename a field there and you change it here —
  // one edit, one place. They read as human labels rather than snake_case ids so the base stays
  // legible when you open it directly in Airtable.
  const T = {
    recipes: "Recipes",
    collections: "Collections",
    mealPlans: "Meal Plans",
    shoppingLists: "Shopping Lists",
  };

  const F = {
    // Recipes
    name: "Name",
    description: "Description",
    photo: "Photo",
    sourceUrl: "Source URL",
    sourceType: "Source Type",
    servings: "Servings",
    servingUnit: "Serving Unit",
    prepMinutes: "Prep Minutes",
    cookMinutes: "Cook Minutes",
    collections: "Collections",
    favourite: "Favourite",
    tags: "Tags",
    ingredientsJson: "Ingredients JSON",
    stepsJson: "Steps JSON",
    notes: "Notes",
    // Collections
    colName: "Name",
    colEmoji: "Emoji",
    colOrder: "Order",
    colDescription: "Description",
    // Meal Plans
    weekStarting: "Week Starting",
    planJson: "Plan JSON",
    planNotes: "Notes",
    // Shopping Lists
    listName: "Name",
    listWeek: "Week Starting",
    itemsJson: "Items JSON",
    listDone: "Done",
  };

  // ---------------------------------------------------------------------------
  // Credentials
  // ---------------------------------------------------------------------------
  // Same trust model as the farm planner's Airtable PAT: stored in this browser only, never
  // proxied through a server we control, never sent anywhere but api.airtable.com and
  // api.anthropic.com. The user pastes them once into the settings dialog.
  const K = {
    pat: "cookbook_airtable_pat",
    base: "cookbook_airtable_base",
    anthropic: "cookbook_anthropic_key",
    system: "cookbook_unit_system",
    ui: "cookbook_ui",
  };

  let PAT = localStorage.getItem(K.pat) || "";
  let BASE = localStorage.getItem(K.base) || "";
  let AKEY = localStorage.getItem(K.anthropic) || "";

  function creds() { return { pat: PAT, base: BASE, anthropic: AKEY }; }
  function hasCreds() { return Boolean(PAT && BASE); }
  function hasAiKey() { return Boolean(AKEY); }

  function setCreds({ pat, base, anthropic }) {
    if (pat !== undefined) { PAT = pat.trim(); localStorage.setItem(K.pat, PAT); }
    if (base !== undefined) { BASE = normaliseBaseId(base); localStorage.setItem(K.base, BASE); }
    if (anthropic !== undefined) { AKEY = anthropic.trim(); localStorage.setItem(K.anthropic, AKEY); }
  }

  // Accepts whatever the user pastes — a bare id, or a full Airtable URL copied from the address
  // bar (https://airtable.com/appXXXX/tblYYYY/viwZZZZ) — and keeps only the base id.
  function normaliseBaseId(v) {
    const s = String(v || "").trim();
    const m = s.match(/app[A-Za-z0-9]{14}/);
    return m ? m[0] : s;
  }

  function getUnitSystem() { return localStorage.getItem(K.system) || "metric"; }
  function setUnitSystem(name) {
    localStorage.setItem(K.system, name);
    if (Units) Units.setSystem(name);
  }
  if (Units) Units.setSystem(getUnitSystem());

  // ---------------------------------------------------------------------------
  // REST plumbing
  // ---------------------------------------------------------------------------
  // Airtable allows 5 requests/second per base and answers a burst with a 429 plus a 30-second
  // penalty — far more disruptive than simply pacing ourselves. Every call funnels through this
  // queue so a bulk save can't trip it.
  const MIN_GAP_MS = 220;   // ~4.5 req/s, comfortably under the limit
  let chain = Promise.resolve();
  function throttle(fn) {
    const run = chain.then(fn);
    chain = run.then(() => sleep(MIN_GAP_MS), () => sleep(MIN_GAP_MS));
    return run;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function headers() {
    return { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" };
  }

  function url(table, qs) {
    const u = new URL(`${API}/${BASE}/${encodeURIComponent(table)}`);
    if (qs) for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function request(href, opts) {
    if (!hasCreds()) throw new Error("No Airtable credentials. Open settings ⚙ and paste your token and base id.");
    const r = await throttle(() => fetch(href, opts));
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      if (r.status === 401) throw new Error("Airtable rejected the token (401). Check it under settings ⚙.");
      if (r.status === 403) throw new Error("Airtable denied access (403). The token may lack access to this base, or need the data.records scopes.");
      if (r.status === 404) throw new Error("Airtable returned 404 — check the base id, and that the table names match the schema exactly.");
      if (r.status === 422) throw new Error(`Airtable rejected the data (422). Usually a field name mismatch. ${body.slice(0, 200)}`);
      if (r.status === 429) throw new Error("Airtable rate limit hit (429). Wait 30 seconds and try again.");
      throw new Error(`Airtable returned ${r.status}. ${body.slice(0, 200)}`);
    }
    return r.status === 204 ? null : r.json();
  }

  // Fetches every record in a table, following Airtable's offset pagination.
  async function fetchAll(table, qs) {
    let records = [], offset;
    do {
      const params = Object.assign({ pageSize: "100" }, qs || {});
      if (offset) params.offset = offset;
      const j = await request(url(table, params), { headers: headers() });
      records = records.concat(j.records || []);
      offset = j.offset;
    } while (offset);
    return records;
  }

  // Airtable caps writes at 10 records per request, so these chunk automatically.
  async function createRecords(table, fieldsList) {
    const out = [];
    for (const chunk of chunks(fieldsList, 10)) {
      const j = await request(url(table), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ records: chunk.map((fields) => ({ fields })), typecast: true }),
      });
      out.push(...(j.records || []));
    }
    return out;
  }

  async function updateRecords(table, updates) {
    const out = [];
    for (const chunk of chunks(updates, 10)) {
      const j = await request(url(table), {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ records: chunk, typecast: true }),
      });
      out.push(...(j.records || []));
    }
    return out;
  }

  async function deleteRecords(table, ids) {
    for (const chunk of chunks(ids, 10)) {
      const u = new URL(`${API}/${BASE}/${encodeURIComponent(table)}`);
      for (const id of chunk) u.searchParams.append("records[]", id);
      await request(u.toString(), { method: "DELETE", headers: headers() });
    }
  }

  function chunks(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Recipe translation
  // ---------------------------------------------------------------------------
  // Ingredients and steps live as JSON in long-text fields. That's the deliberate trade that keeps
  // one recipe to one Airtable record: normalised into their own tables, a single recipe would
  // cost ~20 records and the free tier's 1,000-record ceiling would cap the cookbook at about 45
  // recipes. Denormalised, 1,000 recipes fit. The cost is that you can't edit an individual
  // ingredient in Airtable's grid — the app is the editing surface.
  function safeParseJson(text, fallback) {
    if (!text) return fallback;
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) || (v && typeof v === "object") ? v : fallback;
    } catch {
      // A hand-edited field that's no longer valid JSON must not take the whole recipe list down.
      return fallback;
    }
  }

  function parseRecipe(rec) {
    const f = rec.fields || {};
    const photo = Array.isArray(f[F.photo]) && f[F.photo].length ? f[F.photo][0] : null;
    return {
      id: rec.id,
      name: f[F.name] || "Untitled",
      description: f[F.description] || "",
      photoUrl: photo ? photo.url : "",
      photoThumb: photo && photo.thumbnails ? (photo.thumbnails.large || photo.thumbnails.small || {}).url || photo.url : (photo ? photo.url : ""),
      sourceUrl: f[F.sourceUrl] || "",
      sourceType: f[F.sourceType] || "Manual",
      servings: Number(f[F.servings]) || 1,
      servingUnit: f[F.servingUnit] || "servings",
      prepMinutes: f[F.prepMinutes] != null ? Number(f[F.prepMinutes]) : null,
      cookMinutes: f[F.cookMinutes] != null ? Number(f[F.cookMinutes]) : null,
      collectionIds: f[F.collections] || [],
      favourite: Boolean(f[F.favourite]),
      tags: f[F.tags] || [],
      ingredients: normaliseIngredients(safeParseJson(f[F.ingredientsJson], [])),
      steps: normaliseSteps(safeParseJson(f[F.stepsJson], [])),
      notes: f[F.notes] || "",
    };
  }

  // Guarantees every ingredient has a stable id, because steps reference ingredients by id and a
  // missing one would silently break the per-step ingredient display — the app's whole point.
  function normaliseIngredients(list) {
    if (!Array.isArray(list)) return [];
    return list.map((raw, idx) => {
      const ing = typeof raw === "string" && Units ? Units.parseIngredient(raw) : Object.assign({}, raw);
      return {
        id: ing.id || `i${idx + 1}`,
        qty: ing.qty != null ? Number(ing.qty) : null,
        qtyMax: ing.qtyMax != null ? Number(ing.qtyMax) : null,
        unit: ing.unit || "",
        item: ing.item || "",
        note: ing.note || "",
        group: ing.group || "",
        scalable: ing.scalable !== false,
      };
    });
  }

  function normaliseSteps(list) {
    if (!Array.isArray(list)) return [];
    return list.map((raw, idx) => {
      const st = typeof raw === "string" ? { text: raw } : Object.assign({}, raw);
      return {
        id: st.id || `s${idx + 1}`,
        text: st.text || "",
        ingredientIds: Array.isArray(st.ingredientIds) ? st.ingredientIds : [],
        group: st.group || "",
      };
    });
  }

  // Back to Airtable field shape. Only writes fields we own — anything you add by hand in Airtable
  // is left untouched.
  function recipeToFields(r) {
    const fields = {};
    fields[F.name] = r.name || "Untitled";
    fields[F.description] = r.description || "";
    fields[F.sourceUrl] = r.sourceUrl || "";
    fields[F.sourceType] = r.sourceType || "Manual";
    fields[F.servings] = Number(r.servings) || 1;
    fields[F.servingUnit] = r.servingUnit || "servings";
    fields[F.prepMinutes] = r.prepMinutes != null && r.prepMinutes !== "" ? Number(r.prepMinutes) : null;
    fields[F.cookMinutes] = r.cookMinutes != null && r.cookMinutes !== "" ? Number(r.cookMinutes) : null;
    fields[F.collections] = r.collectionIds || [];
    fields[F.favourite] = Boolean(r.favourite);
    fields[F.tags] = r.tags || [];
    fields[F.ingredientsJson] = JSON.stringify(r.ingredients || [], null, 0);
    fields[F.stepsJson] = JSON.stringify(r.steps || [], null, 0);
    fields[F.notes] = r.notes || "";
    // An attachment field is only writable by URL. Setting it from a photo the user just took
    // needs an upload host we don't have, so photo writes are handled separately (see setPhoto).
    return fields;
  }

  // ---------------------------------------------------------------------------
  // Public data operations
  // ---------------------------------------------------------------------------
  async function loadAll() {
    const [recipeRecs, collectionRecs] = await Promise.all([
      fetchAll(T.recipes),
      fetchAll(T.collections).catch(() => []),   // a cookbook with no collections table still works
    ]);
    return {
      recipes: recipeRecs.map(parseRecipe),
      collections: collectionRecs.map(parseCollection).sort((a, b) => (a.order || 0) - (b.order || 0)),
    };
  }

  function parseCollection(rec) {
    const f = rec.fields || {};
    return {
      id: rec.id,
      name: f[F.colName] || "Untitled",
      emoji: f[F.colEmoji] || "",
      order: Number(f[F.colOrder]) || 0,
      description: f[F.colDescription] || "",
    };
  }

  async function createRecipe(recipe) {
    const [rec] = await createRecords(T.recipes, [recipeToFields(recipe)]);
    return parseRecipe(rec);
  }

  async function updateRecipe(recipe) {
    const [rec] = await updateRecords(T.recipes, [{ id: recipe.id, fields: recipeToFields(recipe) }]);
    return parseRecipe(rec);
  }

  async function deleteRecipe(id) { await deleteRecords(T.recipes, [id]); }

  // Favourite toggling is its own call so the list view can flip a star without serialising and
  // rewriting the whole recipe (and without risking clobbering a concurrent edit elsewhere).
  async function setFavourite(id, on) {
    const [rec] = await updateRecords(T.recipes, [{ id, fields: { [F.favourite]: Boolean(on) } }]);
    return parseRecipe(rec);
  }

  // Attachment fields accept a publicly reachable URL; Airtable then fetches and stores a copy.
  // A photo taken on the phone has no URL, so clipping keeps the image locally and this is used
  // only when a recipe was clipped from a page that already hosts its image.
  async function setPhotoFromUrl(id, imageUrl) {
    const [rec] = await updateRecords(T.recipes, [{ id, fields: { [F.photo]: imageUrl ? [{ url: imageUrl }] : [] } }]);
    return parseRecipe(rec);
  }

  async function createCollection(name, emoji, order) {
    const [rec] = await createRecords(T.collections, [{
      [F.colName]: name, [F.colEmoji]: emoji || "", [F.colOrder]: order || 0,
    }]);
    return parseCollection(rec);
  }

  // --- meal plans -------------------------------------------------------------
  // One record per week, keyed by the Monday. Per-meal records would cost ~1,100 records a year
  // and blow the free-tier ceiling on their own; per-week costs 52.
  async function loadWeek(weekStartIso) {
    const recs = await fetchAll(T.mealPlans, {
      filterByFormula: `DATESTR({${F.weekStarting}}) = '${weekStartIso}'`,
    });
    if (!recs.length) return { id: null, weekStarting: weekStartIso, plan: {}, notes: "" };
    const f = recs[0].fields || {};
    return {
      id: recs[0].id,
      weekStarting: f[F.weekStarting] || weekStartIso,
      plan: safeParseJson(f[F.planJson], {}),
      notes: f[F.planNotes] || "",
    };
  }

  async function saveWeek(week) {
    const fields = {
      [F.weekStarting]: week.weekStarting,
      [F.planJson]: JSON.stringify(week.plan || {}),
      [F.planNotes]: week.notes || "",
    };
    if (week.id) {
      const [rec] = await updateRecords(T.mealPlans, [{ id: week.id, fields }]);
      return Object.assign({}, week, { id: rec.id });
    }
    const [rec] = await createRecords(T.mealPlans, [fields]);
    return Object.assign({}, week, { id: rec.id });
  }

  // --- shopping lists ---------------------------------------------------------
  async function loadShoppingLists() {
    const recs = await fetchAll(T.shoppingLists);
    return recs.map((rec) => {
      const f = rec.fields || {};
      return {
        id: rec.id,
        name: f[F.listName] || "Shopping list",
        weekStarting: f[F.listWeek] || "",
        items: safeParseJson(f[F.itemsJson], []),
        done: Boolean(f[F.listDone]),
      };
    });
  }

  async function saveShoppingList(list) {
    const fields = {
      [F.listName]: list.name || "Shopping list",
      [F.listWeek]: list.weekStarting || null,
      [F.itemsJson]: JSON.stringify(list.items || []),
      [F.listDone]: Boolean(list.done),
    };
    if (list.id) {
      const [rec] = await updateRecords(T.shoppingLists, [{ id: list.id, fields }]);
      return Object.assign({}, list, { id: rec.id });
    }
    const [rec] = await createRecords(T.shoppingLists, [fields]);
    return Object.assign({}, list, { id: rec.id });
  }

  async function deleteShoppingList(id) { await deleteRecords(T.shoppingLists, [id]); }

  // Confirms the base is reachable and the table names match, so settings can tell the user what's
  // wrong immediately instead of failing later on a real operation.
  async function testConnection() {
    const missing = [];
    for (const table of [T.recipes, T.collections, T.mealPlans, T.shoppingLists]) {
      try {
        await request(url(table, { pageSize: "1" }), { headers: headers() });
      } catch (e) {
        if (/404/.test(e.message)) missing.push(table);
        else throw e;
      }
    }
    if (missing.length) throw new Error(`Connected, but these tables are missing or misnamed: ${missing.join(", ")}`);
    return true;
  }

  return {
    T, F, K,
    creds, hasCreds, hasAiKey, setCreds, normaliseBaseId,
    getUnitSystem, setUnitSystem,
    loadAll, testConnection,
    createRecipe, updateRecipe, deleteRecipe, setFavourite, setPhotoFromUrl,
    createCollection,
    loadWeek, saveWeek,
    loadShoppingLists, saveShoppingList, deleteShoppingList,
    parseRecipe, recipeToFields, normaliseIngredients, normaliseSteps, safeParseJson,
  };
});
