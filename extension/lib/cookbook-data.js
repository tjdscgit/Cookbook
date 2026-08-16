// cookbook-data.js
// SYNCED COPY — identical to ../../cookbook-data.js (see the note at the top of lib/cookbook-units.js
// for why). The extension only actually calls creds()/hasCreds()/setCreds()/createRecipe() out of
// this file, but kept whole rather than trimmed so the two copies never structurally diverge.
//
// The only file that knows Firestore exists.
//
// Everything above this layer works with plain app-side objects — a recipe is {id, name,
// ingredients:[...], steps:[...]}, not a database record. Keeping the translation in one place is
// the same discipline the farm planner uses for its atFetch/atCreate/atPatch/atDelete boundary, and
// it is what made replacing Airtable here a one-file change rather than a rewrite.
//
// Why not Airtable any more: the free plan caps API calls at 1,000 per month, and a cookbook that
// reloads on every visit reaches that on its own. The cap is not a rate limit — it does not clear
// by waiting — so it was a wall rather than something to pace around.
//
// Why the REST API and not the Firebase SDK: this app has no build step and no bundler, and the
// service worker only caches same-origin files. Pulling the SDK from a CDN would put a
// third-party script on the critical path and break offline loading. The REST API is plain fetch,
// which is what the rest of this file was already doing.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root.CookbookUnits);
  } else {
    root.CookbookData = factory(root.CookbookUnits);
  }
})(typeof self !== "undefined" ? self : this, function (Units) {
  "use strict";

  const FS = "https://firestore.googleapis.com/v1";
  const IDENTITY = "https://identitytoolkit.googleapis.com/v1";
  const SECURETOKEN = "https://securetoken.googleapis.com/v1";

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------
  // Collection names, and the field names inside a document. Unlike the Airtable version these are
  // camelCase rather than human labels: nobody browses raw Firestore documents the way you'd browse
  // an Airtable grid, so matching the app-side object shape is worth more than being pretty in a
  // console. The names are identical to the app-side keys, which is what keeps the translation
  // functions below almost trivial.
  const T = {
    recipes: "recipes",
    collections: "collections",
    mealPlans: "mealPlans",
    shoppingLists: "shoppingLists",
  };

  const F = {
    name: "name",
    description: "description",
    photoUrl: "photoUrl",
    sourceUrl: "sourceUrl",
    sourceType: "sourceType",
    servings: "servings",
    servingUnit: "servingUnit",
    prepMinutes: "prepMinutes",
    cookMinutes: "cookMinutes",
    collectionIds: "collectionIds",
    favourite: "favourite",
    tried: "tried",
    tags: "tags",
    ingredients: "ingredients",
    steps: "steps",
    notes: "notes",
    colName: "name",
    colEmoji: "emoji",
    colOrder: "order",
    colDescription: "description",
    weekStarting: "weekStarting",
    plan: "plan",
    planNotes: "notes",
    listName: "name",
    listWeek: "weekStarting",
    items: "items",
    listDone: "done",
  };

  // ---------------------------------------------------------------------------
  // Credentials
  // ---------------------------------------------------------------------------
  // Better than the Airtable arrangement it replaces. A Firebase project id and web API key are
  // public by design — they identify the project, they do not grant anything — so the value sitting
  // in localStorage is no longer a secret that would hand someone the whole cookbook. What grants
  // access is being signed in, and a security rule on the server restricts every document to the
  // one account that owns it. The password itself is never stored: sign-in exchanges it once for a
  // refresh token, and that is what persists.
  const K = {
    project: "cookbook_fb_project",
    apiKey: "cookbook_fb_api_key",
    refresh: "cookbook_fb_refresh",
    email: "cookbook_fb_email",
    uid: "cookbook_fb_uid",
    anthropic: "cookbook_anthropic_key",
    system: "cookbook_unit_system",
    ui: "cookbook_ui",
  };

  // This project's own config, checked in deliberately. Both values are public identifiers — the
  // API key names the project and grants nothing, which is why Firebase ships it in page source on
  // every web app it hosts. Access comes from signing in, and firestore.rules restricts every
  // document to one uid. Hardcoding them means a new device only has to sign in, rather than typing
  // a 39-character key on a phone keyboard. Settings still overrides them if you ever repoint the
  // app at a different project.
  const DEFAULTS = {
    project: "roseberry-cookbook",
    apiKey: "AIzaSyAwhWYz_8n648MVRyAX-rRqG0Cam3txXr4",
  };

  let PROJECT = localStorage.getItem(K.project) || DEFAULTS.project;
  let APIKEY = localStorage.getItem(K.apiKey) || DEFAULTS.apiKey;
  let REFRESH = localStorage.getItem(K.refresh) || "";
  let EMAIL = localStorage.getItem(K.email) || "";
  let UID = localStorage.getItem(K.uid) || "";
  let AKEY = localStorage.getItem(K.anthropic) || "";

  // Held in memory only. It expires in an hour and is re-minted from the refresh token on demand,
  // so writing it to localStorage would add exposure and buy nothing.
  let idToken = "";
  let idTokenExpiry = 0;

  function creds() {
    return { project: PROJECT, apiKey: APIKEY, email: EMAIL, uid: UID, anthropic: AKEY };
  }

  // "Configured and signed in." The project config alone is not enough to read anything, so the
  // setup banner keys off the refresh token being present too.
  function hasCreds() { return Boolean(PROJECT && APIKEY && REFRESH); }
  function isConfigured() { return Boolean(PROJECT && APIKEY); }
  function isSignedIn() { return Boolean(REFRESH); }
  function hasAiKey() { return Boolean(AKEY); }

  function setCreds({ project, apiKey, anthropic }) {
    if (project !== undefined) { PROJECT = normaliseProjectId(project); localStorage.setItem(K.project, PROJECT); }
    if (apiKey !== undefined) { APIKEY = apiKey.trim(); localStorage.setItem(K.apiKey, APIKEY); }
    if (anthropic !== undefined) { AKEY = anthropic.trim(); localStorage.setItem(K.anthropic, AKEY); }
  }

  // Accepts what the user is most likely to paste — a bare project id, or a console URL
  // (https://console.firebase.google.com/project/my-cookbook/overview) — and keeps the id.
  function normaliseProjectId(v) {
    const s = String(v || "").trim();
    const m = s.match(/\/project\/([a-z0-9-]+)/i);
    return m ? m[1] : s.replace(/^https?:\/\/[^/]+\/?/, "").replace(/\/.*$/, "");
  }

  function getUnitSystem() { return localStorage.getItem(K.system) || "metric"; }
  function setUnitSystem(name) {
    localStorage.setItem(K.system, name);
    if (Units) Units.setSystem(name);
  }
  if (Units) Units.setSystem(getUnitSystem());

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  async function signIn(email, password) {
    if (!isConfigured()) throw new Error("Set the Firebase project id and web API key first, under settings ⚙.");
    const r = await fetch(`${IDENTITY}/accounts:signInWithPassword?key=${encodeURIComponent(APIKEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email || "").trim(), password: password || "", returnSecureToken: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(authMessage(j));

    REFRESH = j.refreshToken || "";
    EMAIL = j.email || email;
    UID = j.localId || "";
    idToken = j.idToken || "";
    idTokenExpiry = Date.now() + (Number(j.expiresIn || 3600) - 60) * 1000;
    localStorage.setItem(K.refresh, REFRESH);
    localStorage.setItem(K.email, EMAIL);
    localStorage.setItem(K.uid, UID);
    return { email: EMAIL, uid: UID };
  }

  function signOut() {
    REFRESH = ""; EMAIL = ""; UID = ""; idToken = ""; idTokenExpiry = 0;
    localStorage.removeItem(K.refresh);
    localStorage.removeItem(K.email);
    localStorage.removeItem(K.uid);
  }

  // Firebase reports auth failures as terse SCREAMING_SNAKE codes. Translating them here means the
  // settings dialog can say what actually went wrong instead of showing the user "INVALID_LOGIN".
  function authMessage(body) {
    const code = ((body && body.error && body.error.message) || "").split(" ")[0];
    switch (code) {
      case "EMAIL_NOT_FOUND":
      case "INVALID_PASSWORD":
      case "INVALID_LOGIN_CREDENTIALS":
        return "That email and password didn't match an account in this Firebase project.";
      case "USER_DISABLED":
        return "That account has been disabled in the Firebase console.";
      case "TOO_MANY_ATTEMPTS_TRY_LATER":
        return "Too many sign-in attempts. Wait a few minutes and try again.";
      case "INVALID_EMAIL":
        return "That doesn't look like a valid email address.";
      case "API_KEY_INVALID":
      case "INVALID_API_KEY":
        return "That web API key isn't valid for this project. Copy it again from Project settings → General.";
      case "OPERATION_NOT_ALLOWED":
        return "Email/password sign-in isn't switched on yet. Enable it in the Firebase console under Authentication → Sign-in method.";
      case "TOKEN_EXPIRED":
      case "INVALID_REFRESH_TOKEN":
        return "Your session expired. Sign in again under settings ⚙.";
      default:
        return `Firebase refused the sign-in${code ? ` (${code})` : ""}.`;
    }
  }

  // Returns a valid ID token, minting a fresh one from the refresh token when the current one is
  // within a minute of expiry. Every Firestore call goes through this.
  async function token() {
    if (!REFRESH) throw new Error("Not signed in. Open settings ⚙ and sign in to your cookbook.");
    if (idToken && Date.now() < idTokenExpiry) return idToken;

    const r = await fetch(`${SECURETOKEN}/token?key=${encodeURIComponent(APIKEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(REFRESH)}`,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // A refresh token only fails permanently — the password changed, or the account is gone.
      // Clearing it sends the user to the sign-in form instead of retrying forever.
      signOut();
      throw new Error(authMessage(j));
    }
    idToken = j.id_token || "";
    idTokenExpiry = Date.now() + (Number(j.expires_in || 3600) - 60) * 1000;
    if (j.refresh_token && j.refresh_token !== REFRESH) {
      REFRESH = j.refresh_token;
      localStorage.setItem(K.refresh, REFRESH);
    }
    return idToken;
  }

  // ---------------------------------------------------------------------------
  // Firestore value encoding
  // ---------------------------------------------------------------------------
  // Firestore's REST API types every value explicitly — {"stringValue": "x"} rather than "x". These
  // two functions are the whole translation, and being generic is what lets ingredients and steps
  // be stored as real nested arrays of objects. Under Airtable they had to be JSON strings crammed
  // into a long-text field to stay inside the 1,000-record ceiling; that compromise is gone.
  function encode(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return { nullValue: null };
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
    if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
    return { stringValue: String(v) };
  }

  function encodeFields(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) out[k] = encode(v);
    return out;
  }

  function decode(v) {
    if (!v || typeof v !== "object") return null;
    if ("nullValue" in v) return null;
    if ("booleanValue" in v) return Boolean(v.booleanValue);
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("stringValue" in v) return v.stringValue;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
    if ("mapValue" in v) return decodeFields(v.mapValue.fields);
    return null;
  }

  function decodeFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) out[k] = decode(v);
    return out;
  }

  // A document's REST name is a full path; the id is its last segment.
  function docId(doc) {
    return String(doc && doc.name || "").split("/").pop();
  }

  // ---------------------------------------------------------------------------
  // REST plumbing
  // ---------------------------------------------------------------------------
  // No throttle queue any more. That existed because Airtable answered a burst of more than five
  // requests per second with a 429 and a thirty-second penalty. Firestore's per-project write
  // ceiling is orders of magnitude above anything a single cookbook does, so pacing would only slow
  // a bulk import down for no reason.
  function docsUrl(path, qs) {
    const u = new URL(`${FS}/projects/${PROJECT}/databases/(default)/documents${path}`);
    if (qs) for (const [k, v] of Object.entries(qs)) {
      if (Array.isArray(v)) v.forEach((one) => u.searchParams.append(k, one));
      else u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async function request(href, opts, retrying) {
    if (!isConfigured()) throw new Error("No Firebase project configured. Open settings ⚙ and paste your project id and web API key.");
    const t = await token();
    const r = await fetch(href, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, (opts || {}).headers),
    }));

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      // One retry on 401: the usual cause is a token that expired between the check above and the
      // request landing. Forcing a re-mint fixes it; a second 401 is a real auth problem.
      if (r.status === 401 && !retrying) {
        idToken = ""; idTokenExpiry = 0;
        return request(href, opts, true);
      }
      if (r.status === 401) throw new Error("Firebase rejected the session. Sign in again under settings ⚙.");
      if (r.status === 403) throw new Error("Firestore denied access (403). Check your security rules allow this account, and that the Firestore database has been created.");
      if (r.status === 404) throw new Error(`Firestore returned 404 — check the project id is right and the database exists. ${body.slice(0, 160)}`);
      if (r.status === 429) throw new Error("Firestore quota exceeded (429). This should be rare on the free tier — check the Firebase console usage page.");
      throw new Error(`Firestore returned ${r.status}. ${body.slice(0, 200)}`);
    }
    return r.status === 204 ? null : r.json();
  }

  // Reads every document in a collection, following Firestore's page tokens. An empty collection
  // comes back as {} with no documents key at all, which is why the fallback matters.
  async function fetchAll(collection) {
    let docs = [], pageToken;
    do {
      const qs = { pageSize: "300" };
      if (pageToken) qs.pageToken = pageToken;
      const j = await request(docsUrl(`/${collection}`, qs), { method: "GET" });
      docs = docs.concat(j.documents || []);
      pageToken = j.nextPageToken;
    } while (pageToken);
    return docs;
  }

  async function getDoc(collection, id) {
    try {
      return await request(docsUrl(`/${collection}/${encodeURIComponent(id)}`), { method: "GET" });
    } catch (e) {
      if (/404/.test(e.message)) return null;
      throw e;
    }
  }

  async function createDoc(collection, data, id) {
    return request(docsUrl(`/${collection}`, id ? { documentId: id } : null), {
      method: "POST",
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
  }

  // Firestore's PATCH replaces the whole document unless an update mask names the fields to touch.
  // Passing the mask is what lets setFavourite flip one flag without rewriting the recipe — and
  // without clobbering an edit made in another tab. With no id supplied it upserts, which is how
  // meal plans are saved.
  async function patchDoc(collection, id, data, fieldPaths) {
    const qs = {};
    if (fieldPaths && fieldPaths.length) qs["updateMask.fieldPaths"] = fieldPaths;
    return request(docsUrl(`/${collection}/${encodeURIComponent(id)}`, qs), {
      method: "PATCH",
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
  }

  async function deleteDoc(collection, id) {
    await request(docsUrl(`/${collection}/${encodeURIComponent(id)}`), { method: "DELETE" });
  }

  // ---------------------------------------------------------------------------
  // Recipe translation
  // ---------------------------------------------------------------------------
  function safeParseJson(text, fallback) {
    if (!text) return fallback;
    if (typeof text === "object") return text;
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) || (v && typeof v === "object") ? v : fallback;
    } catch {
      // A document hand-edited in the Firestore console and left as broken JSON must not take the
      // whole recipe list down.
      return fallback;
    }
  }

  function parseRecipe(doc) {
    const f = decodeFields(doc.fields);
    const photo = f[F.photoUrl] || "";
    return {
      id: docId(doc),
      name: f[F.name] || "Untitled",
      description: f[F.description] || "",
      photoUrl: photo,
      // Airtable generated thumbnails; Firestore stores the URL we were given and nothing else.
      // Keeping the key means every call site above this layer is unchanged.
      photoThumb: photo,
      sourceUrl: f[F.sourceUrl] || "",
      sourceType: f[F.sourceType] || "Manual",
      servings: Number(f[F.servings]) || 1,
      servingUnit: f[F.servingUnit] || "servings",
      prepMinutes: f[F.prepMinutes] != null ? Number(f[F.prepMinutes]) : null,
      cookMinutes: f[F.cookMinutes] != null ? Number(f[F.cookMinutes]) : null,
      collectionIds: f[F.collectionIds] || [],
      favourite: Boolean(f[F.favourite]),
      tried: Boolean(f[F.tried]),
      tags: f[F.tags] || [],
      // safeParseJson tolerates the Airtable-era shape, where these were JSON strings. A document
      // migrated across still reads correctly, and is rewritten as an array on its next save.
      ingredients: normaliseIngredients(safeParseJson(f[F.ingredients], [])),
      steps: normaliseSteps(safeParseJson(f[F.steps], [])),
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

  // Back to document shape — a plain object, encoded to Firestore's typed values at the boundary.
  // Photo is deliberately absent: it is written by setPhotoFromUrl so that a dead image URL can
  // never cost the recipe it belongs to.
  function recipeToFields(r) {
    return {
      [F.name]: r.name || "Untitled",
      [F.description]: r.description || "",
      [F.sourceUrl]: r.sourceUrl || "",
      [F.sourceType]: r.sourceType || "Manual",
      [F.servings]: Number(r.servings) || 1,
      [F.servingUnit]: r.servingUnit || "servings",
      [F.prepMinutes]: r.prepMinutes != null && r.prepMinutes !== "" ? Number(r.prepMinutes) : null,
      [F.cookMinutes]: r.cookMinutes != null && r.cookMinutes !== "" ? Number(r.cookMinutes) : null,
      [F.collectionIds]: r.collectionIds || [],
      [F.favourite]: Boolean(r.favourite),
      [F.tried]: Boolean(r.tried),
      [F.tags]: r.tags || [],
      [F.ingredients]: normaliseIngredients(r.ingredients || []),
      [F.steps]: normaliseSteps(r.steps || []),
      [F.notes]: r.notes || "",
    };
  }

  // Every field this layer owns. Passing it as the update mask means anything you added by hand in
  // the Firestore console survives a save from the app.
  const RECIPE_FIELDS = Object.keys(recipeToFields({}));

  // ---------------------------------------------------------------------------
  // Public data operations
  // ---------------------------------------------------------------------------
  async function loadAll() {
    const [recipeDocs, collectionDocs] = await Promise.all([
      fetchAll(T.recipes),
      fetchAll(T.collections).catch(() => []),   // a cookbook with no collections yet still works
    ]);
    return {
      recipes: recipeDocs.map(parseRecipe),
      collections: collectionDocs.map(parseCollection).sort((a, b) => (a.order || 0) - (b.order || 0)),
    };
  }

  function parseCollection(doc) {
    const f = decodeFields(doc.fields);
    return {
      id: docId(doc),
      name: f[F.colName] || "Untitled",
      emoji: f[F.colEmoji] || "",
      order: Number(f[F.colOrder]) || 0,
      description: f[F.colDescription] || "",
    };
  }

  async function createRecipe(recipe) {
    const doc = await createDoc(T.recipes, recipeToFields(recipe));
    return parseRecipe(doc);
  }

  async function updateRecipe(recipe) {
    const doc = await patchDoc(T.recipes, recipe.id, recipeToFields(recipe), RECIPE_FIELDS);
    return parseRecipe(doc);
  }

  async function deleteRecipe(id) { await deleteDoc(T.recipes, id); }

  // Favourite toggling is its own call so the list view can flip a star without serialising and
  // rewriting the whole recipe (and without risking clobbering a concurrent edit elsewhere).
  async function setFavourite(id, on) {
    const doc = await patchDoc(T.recipes, id, { [F.favourite]: Boolean(on) }, [F.favourite]);
    return parseRecipe(doc);
  }

  // Same rationale as setFavourite — flipping "tried" from the grid shouldn't rewrite the whole
  // recipe. This is what moves a recipe between the "To Try" and "Cookbook" sections.
  async function setTried(id, on) {
    const doc = await patchDoc(T.recipes, id, { [F.tried]: Boolean(on) }, [F.tried]);
    return parseRecipe(doc);
  }

  // Airtable fetched an attachment URL and stored its own copy; Firestore stores the URL as given,
  // so the image stays hotlinked from wherever it was clipped. Cheaper and simpler, at the cost of
  // a photo that can disappear if the source site takes it down.
  async function setPhotoFromUrl(id, imageUrl) {
    const doc = await patchDoc(T.recipes, id, { [F.photoUrl]: imageUrl || "" }, [F.photoUrl]);
    return parseRecipe(doc);
  }

  async function createCollection(name, emoji, order) {
    const doc = await createDoc(T.collections, {
      [F.colName]: name, [F.colEmoji]: emoji || "", [F.colOrder]: order || 0,
    });
    return parseCollection(doc);
  }

  // --- meal plans -------------------------------------------------------------
  // One document per week, and the week's Monday is the document id. That turns loading a week
  // into a single get by key — no query, no index, and no filter formula of the kind the Airtable
  // version needed.
  async function loadWeek(weekStartIso) {
    const doc = await getDoc(T.mealPlans, weekStartIso);
    if (!doc) return { id: null, weekStarting: weekStartIso, plan: {}, notes: "" };
    const f = decodeFields(doc.fields);
    return {
      id: docId(doc),
      weekStarting: f[F.weekStarting] || weekStartIso,
      plan: safeParseJson(f[F.plan], {}) || {},
      notes: f[F.planNotes] || "",
    };
  }

  async function saveWeek(week) {
    const id = week.weekStarting;
    const data = {
      [F.weekStarting]: id,
      [F.plan]: week.plan || {},
      [F.planNotes]: week.notes || "",
    };
    // PATCH upserts, so a week that has never been planned needs no separate create.
    const doc = await patchDoc(T.mealPlans, id, data, Object.keys(data));
    return Object.assign({}, week, { id: docId(doc) });
  }

  // --- shopping lists ---------------------------------------------------------
  async function loadShoppingLists() {
    const docs = await fetchAll(T.shoppingLists);
    return docs.map((doc) => {
      const f = decodeFields(doc.fields);
      return {
        id: docId(doc),
        name: f[F.listName] || "Shopping list",
        weekStarting: f[F.listWeek] || "",
        items: safeParseJson(f[F.items], []) || [],
        done: Boolean(f[F.listDone]),
      };
    });
  }

  async function saveShoppingList(list) {
    const data = {
      [F.listName]: list.name || "Shopping list",
      [F.listWeek]: list.weekStarting || "",
      [F.items]: list.items || [],
      [F.listDone]: Boolean(list.done),
    };
    const doc = list.id
      ? await patchDoc(T.shoppingLists, list.id, data, Object.keys(data))
      : await createDoc(T.shoppingLists, data);
    return Object.assign({}, list, { id: docId(doc) });
  }

  async function deleteShoppingList(id) { await deleteDoc(T.shoppingLists, id); }

  // Confirms the project is reachable and the session works, so settings can tell the user what's
  // wrong immediately instead of failing later on a real operation. Unlike Airtable there are no
  // collections to create in advance — Firestore makes one the first time you write a document —
  // so this only has to prove that reading is permitted.
  async function testConnection() {
    if (!isConfigured()) throw new Error("Paste the project id and web API key first.");
    if (!isSignedIn()) throw new Error("Configured, but not signed in yet — sign in below.");
    await request(docsUrl(`/${T.recipes}`, { pageSize: "1" }), { method: "GET" });
    return true;
  }

  return {
    T, F, K,
    creds, hasCreds, isConfigured, isSignedIn, hasAiKey, setCreds, normaliseProjectId,
    signIn, signOut,
    getUnitSystem, setUnitSystem,
    loadAll, testConnection,
    createRecipe, updateRecipe, deleteRecipe, setFavourite, setTried, setPhotoFromUrl,
    createCollection,
    loadWeek, saveWeek,
    loadShoppingLists, saveShoppingList, deleteShoppingList,
    parseRecipe, recipeToFields, normaliseIngredients, normaliseSteps, safeParseJson,
    encode, decode, encodeFields, decodeFields,
  };
});
