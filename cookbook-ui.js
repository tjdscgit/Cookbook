// cookbook-ui.js
// Application state, navigation, and every rendered view.
//
// One module owns state and orchestration; cookbook-plan.js and cookbook-clip.js are called by it
// and never call back into it except through the callbacks it hands them. `render()` repaints the
// current view from state — there is no partial DOM patching anywhere, because a cookbook's data is
// small enough that a full repaint is instant and always correct.
//
// The Recipes list, recipe page and cook mode emit the markup of design/cookbook-redesign.html
// (#rc, #rd, #dk, #ck) so its CSS applies unchanged.
(function () {
  "use strict";

  const Units = window.CookbookUnits;
  const Data = window.CookbookData;
  const Clip = window.CookbookClip;
  const Plan = window.CookbookPlan;
  const Timer = window.CookbookTimer;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Phone shell up to 800px, sidenav desktop above it (brief, Part A).
  const desk = window.matchMedia("(min-width: 801px)");

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
    view: "recipes",
    recipes: [],
    collections: [],
    recipesById: {},
    // Recipes screen
    section: "cookbook",  // "cookbook" (tried), "toTry" (not yet tried) or "cols" — always starts on Cookbook, never remembered
    search: "",
    chip: null,           // "fav", "u30", a collection id, or null. Single-select.
    // recipe page
    openId: null,
    servings: null,       // the working serving count, which may differ from the recipe's own
    detailTab: "ing",     // "ing" or "met" (phone only; desktop shows both)
    ticked: {},           // recipeId -> Set of ticked ingredient ids. Session only, never saved.
    awake: true,          // "Keep screen on" switch
    // editor
    editing: null,        // the recipe object being edited (null = not open)
    // planner
    monday: Plan.mondayOf(new Date()),
    week: null,
    // shopping
    list: null,
    listLoaded: false,
    listWeek: null,       // the planned week the list was made from, for the "From 7 meals" line
    shView: readShopView(), // "aisle" or "recipe", remembered
    trolleyOpen: false,   // "In the trolley" starts collapsed
    // clip
    clipMode: "url",
    clipFile: null,
    loaded: false,
  };

  function readShopView() {
    try { return localStorage.getItem("cookbook_shop_view") === "recipe" ? "recipe" : "aisle"; }
    catch { return "aisle"; }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    applyStoredTheme();
    wireNav();
    wireSettings();
    wireRecipes();
    wireDetail();
    wireEditor();
    wireClip();
    consumeSharedLink();
    wirePlanner();
    wireShopping();
    wireWakeLock();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }

    if (!Data.hasCreds()) {
      $("#setupBanner").hidden = false;
      setView("recipes");
      return;
    }
    setView("recipes");
    await Data.pullAnthropicKey().catch(() => {});
    await refresh();
  }

  async function refresh() {
    try {
      toast("Loading…", 0);
      const { recipes, collections } = await Data.loadAll();
      S.recipes = recipes;
      S.collections = collections;
      S.recipesById = Object.fromEntries(recipes.map((r) => [r.id, r]));
      S.loaded = true;
      clearToast();
      $("#setupBanner").hidden = true;
      render();
    } catch (e) {
      clearToast();
      toastError(e.message);
      $("#setupBanner").hidden = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  function wireNav() {
    $$("[data-view]").forEach((btn) => {
      btn.onclick = () => setView(btn.dataset.view);
    });
    $("#navSettings").onclick = openSettings;
    $("#bannerSettings").onclick = openSettings;
    $("#btnRecipesMore").onclick = recipesMenu;
    // "+ Add recipe" opens the existing clipper until the Add recipe sheet (a later stage) exists.
    $("#btnAdd").onclick = openClip;

    // Dialogs all close the same way.
    $$("[data-close]").forEach((b) => {
      b.onclick = () => b.closest("dialog").close();
    });

    // Escape closes an open bottom sheet before anything else sees the key.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.querySelector(".sheet")) { e.stopImmediatePropagation(); closeSheet(); }
    }, true);

    // A photo that fails to load drops out, leaving the letter placeholder underneath.
    document.addEventListener("error", (e) => {
      if (e.target.tagName === "IMG" && e.target.closest(".ph")) e.target.remove();
    }, true);

    desk.addEventListener("change", () => { if (S.view === "recipe") renderDetail(); });
  }

  // ---------------------------------------------------------------------------
  // Wake lock
  // ---------------------------------------------------------------------------
  // Keeps the screen on everywhere in the app, not just Cook Mode — this is a kitchen tablet/phone
  // sitting on a bench, and it locking mid-shop or mid-browse is just as annoying as mid-recipe.
  // The recipe page's "Keep screen on" switch turns that off (cook mode still holds it while open).
  // The lock is released by the browser whenever the tab is backgrounded, so it has to be
  // re-requested every time the app becomes visible again, or the screen goes back to sleeping.
  let wakeLock = null;
  let cookOpen = false;

  function wireWakeLock() {
    requestWakeLock();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") requestWakeLock();
    });
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || !(S.awake || cookOpen)) return;
    if (wakeLock && !wakeLock.released) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); }
    catch { /* denied or unsupported — the app still works, the screen just sleeps normally */ }
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  function setAwake(on) {
    S.awake = on;
    if (on || cookOpen) requestWakeLock(); else releaseWakeLock();
  }

  function setView(view) {
    S.view = view;
    if (view !== "recipe") S.openId = null;

    $("#viewRecipes").hidden = view !== "recipes";
    $("#viewRecipe").hidden = view !== "recipe";
    $("#viewPlanner").hidden = view !== "planner";
    $("#viewShopping").hidden = view !== "shopping";
    $("#btnAdd").hidden = view !== "recipes";

    // The recipe page is a child of Recipes as far as the nav is concerned.
    const navKey = view === "recipe" ? "recipes" : view;
    $$("[data-view]").forEach((b) => {
      const on = b.dataset.view === navKey;
      b.classList.toggle("on", on);
      b.setAttribute("aria-current", String(on));
    });

    $("#main").scrollTop = 0;
    render();
  }

  function render() {
    if (S.view === "recipes") renderRecipes();
    else if (S.view === "recipe") renderDetail();
    else if (S.view === "planner") renderPlannerView();
    else if (S.view === "shopping") renderShoppingView();
  }

  // ---------------------------------------------------------------------------
  // Theme: Light, Dark or System (no stored choice). Lives in the Recipes ⋯ sheet.
  // ---------------------------------------------------------------------------
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  darkQuery.addEventListener("change", () => { if (themeSetting() === "system") applyStoredTheme(); });

  function themeSetting() {
    const saved = localStorage.getItem("cookbook_theme");
    return saved === "dark" || saved === "light" ? saved : "system";
  }
  function applyStoredTheme() {
    const s = themeSetting();
    const dark = s === "system" ? darkQuery.matches : s === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }
  function cycleTheme() {
    const next = { light: "dark", dark: "system", system: "light" }[themeSetting()];
    if (next === "system") localStorage.removeItem("cookbook_theme");
    else localStorage.setItem("cookbook_theme", next);
    applyStoredTheme();
  }
  function themeLabel() {
    return { light: "Light", dark: "Dark", system: "System" }[themeSetting()];
  }

  function recipesMenu() {
    openSheet(`<div class="sh-h"><h3>Cookbook</h3><button class="ib" data-x aria-label="Close">✕</button></div>
      <div class="sh-b"><button class="mitem" data-settings>Settings<small>Firebase, sign-in, Anthropic key, measurements, import</small></button><button class="mitem" data-theme-cycle>Theme<small>${themeLabel()}</small></button></div>`,
      (b) => {
        if ("settings" in b.dataset) { closeSheet(); openSettings(); }
        else if ("themeCycle" in b.dataset) { cycleTheme(); closeSheet(); }
      });
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function wireSettings() {
    $("#btnSaveSettings").onclick = async () => {
      Data.setCreds({
        project: $("#setProject").value,
        apiKey: $("#setApiKey").value,
      });
      await Data.pushAnthropicKey($("#setKey").value).catch(() => {});
      Data.setUnitSystem($("#setSystem").value);
      $("#dlgSettings").close();
      await refresh();
    };

    $("#btnTest").onclick = async () => {
      const el = $("#connStatus");
      Data.setCreds({ project: $("#setProject").value, apiKey: $("#setApiKey").value });
      el.innerHTML = '<span class="spinner"></span> Checking…';
      try {
        await Data.testConnection();
        el.innerHTML = '<span style="color:var(--herb)">✓ Connected — Firestore is reachable and your account can read it.</span>';
      } catch (e) {
        el.innerHTML = `<span style="color:var(--danger)">✕ ${escapeHtml(e.message)}</span>`;
      }
    };

    // Signing in has to save the project config first: the sign-in call needs the API key, and the
    // user has almost certainly just pasted both without pressing Save.
    $("#btnSignIn").onclick = async () => {
      const el = $("#connStatus");
      Data.setCreds({ project: $("#setProject").value, apiKey: $("#setApiKey").value });
      el.innerHTML = '<span class="spinner"></span> Signing in…';
      try {
        await Data.signIn($("#setEmail").value, $("#setPassword").value);
        $("#setPassword").value = "";
        await Data.pullAnthropicKey().catch(() => {});
        $("#setKey").value = Data.creds().anthropic;
        el.innerHTML = '<span style="color:var(--herb)">✓ Signed in.</span>';
        renderAuth();
        await refresh();
      } catch (e) {
        el.innerHTML = `<span style="color:var(--danger)">✕ ${escapeHtml(e.message)}</span>`;
      }
    };

    $("#btnSignOut").onclick = () => {
      Data.signOut();
      renderAuth();
      $("#connStatus").textContent = "";
      $("#setupBanner").hidden = false;
    };

    $("#btnImport").onclick = runImport;
  }

  // The account block is either the sign-in form or a "signed in as" line, never both.
  function renderAuth() {
    const inn = Data.isSignedIn();
    $("#authSignedIn").hidden = !inn;
    $("#authSignedOut").hidden = inn;
    $("#authEmail").textContent = Data.creds().email || "";
  }

  // Bulk import from another recipe app's export, converted to app shape by
  // scripts/convert-flavorish.mjs. The file is read here in the browser and pushed straight to
  // Firestore through the normal Data layer, so the session stays where it already lives and no
  // third party ever sees either the recipes or the credentials. This is also the migration path
  // off Airtable: the same export file, re-imported into the new backend.
  async function runImport() {
    const el = $("#importStatus");
    const file = $("#setImportFile").files[0];
    if (!file) { el.innerHTML = '<span style="color:var(--danger)">Choose a file first.</span>'; return; }
    if (!Data.hasCreds()) { el.innerHTML = '<span style="color:var(--danger)">Set up your Firebase project and sign in first.</span>'; return; }

    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      el.innerHTML = '<span style="color:var(--danger)">That file isn\'t valid JSON.</span>';
      return;
    }
    const incoming = Array.isArray(payload) ? payload : payload.recipes;
    if (!Array.isArray(incoming) || !incoming.length) {
      el.innerHTML = '<span style="color:var(--danger)">No recipes found in that file.</span>';
      return;
    }

    el.innerHTML = '<span class="spinner"></span> Checking what\'s already there…';

    let existing, collections;
    try {
      // Work against the live cookbook rather than whatever's on screen, so an import run from a
      // stale tab can't duplicate everything.
      ({ recipes: existing, collections } = await Data.loadAll());
    } catch (e) {
      el.innerHTML = `<span style="color:var(--danger)">Couldn't load the cookbook: ${escapeHtml(e.message)}</span>`;
      return;
    }
    const have = new Set(existing.map((r) => normaliseName(r.name)));

    // Collections are records the recipes link to by id, so any the import mentions have to
    // exist before the recipes are written.
    const byName = new Map(collections.map((c) => [normaliseName(c.name), c]));
    const wanted = [...new Set(incoming.flatMap((r) => r.collections || []))];
    try {
      for (const name of wanted) {
        if (byName.has(normaliseName(name))) continue;
        const created = await Data.createCollection(name, "", byName.size + 1);
        byName.set(normaliseName(name), created);
      }
    } catch (e) {
      el.innerHTML = `<span style="color:var(--danger)">Couldn't create collections: ${escapeHtml(e.message)}</span>`;
      return;
    }

    const todo = incoming.filter((r) => !have.has(normaliseName(r.name)));
    const skipped = incoming.length - todo.length;
    let done = 0, failed = 0;

    // One at a time, and with the photo as a follow-up call, so a single bad image URL can't cost
    // the recipe it belongs to.
    for (const r of todo) {
      el.innerHTML = `<span class="spinner"></span> Importing ${done + 1} of ${todo.length} — ${escapeHtml(r.name)}`;
      try {
        const saved = await Data.createRecipe({
          name: r.name,
          description: r.description || "",
          servings: r.servings,
          servingUnit: r.servingUnit || "servings",
          prepMinutes: r.prepMinutes,
          cookMinutes: r.cookMinutes,
          ingredients: r.ingredients || [],
          steps: r.steps || [],
          notes: r.notes || "",
          sourceUrl: r.sourceUrl || "",
          sourceType: r.sourceType || "Manual",
          tags: r.tags || [],
          favourite: Boolean(r.favourite),
          tried: r.tried !== false,
          collectionIds: (r.collections || [])
            .map((n) => (byName.get(normaliseName(n)) || {}).id)
            .filter(Boolean),
        });
        if (r.photoUrl) {
          await Data.setPhotoFromUrl(saved.id, r.photoUrl).catch(() => {});
        }
        done++;
      } catch (e) {
        failed++;
        console.warn("import failed:", r.name, e);
      }
    }

    const parts = [`Imported ${done}.`];
    if (skipped) parts.push(`${skipped} already in the cookbook.`);
    if (failed) parts.push(`${failed} failed — see the browser console.`);
    el.innerHTML = `<span style="color:${failed ? "var(--danger)" : "var(--herb)"}">${escapeHtml(parts.join(" "))}</span>`;
    await refresh();
  }

  function normaliseName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function openSettings() {
    const c = Data.creds();
    $("#setProject").value = c.project;
    $("#setApiKey").value = c.apiKey;
    $("#setKey").value = c.anthropic;
    $("#setSystem").value = Data.getUnitSystem();
    $("#connStatus").textContent = "";
    renderAuth();
    $("#dlgSettings").showModal();
  }

  // ---------------------------------------------------------------------------
  // Recipe helpers shared by the list, the page and cook mode
  // ---------------------------------------------------------------------------
  const totalMins = (r) => (r.prepMinutes || 0) + (r.cookMinutes || 0);
  // 25 -> "25 min", 65 -> "1 hr 5", 210 -> "3 hr 30", 120 -> "2 hr"
  const timeLabel = (m) => !m ? "" : m < 60 ? `${m} min` : (m % 60 ? `${Math.floor(m / 60)} hr ${m % 60}` : `${m / 60} hr`);

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }
  // What a card and the recipe page say the recipe came from.
  function sourceLabel(r) {
    const h = hostOf(r.sourceUrl);
    if (/(^|\.)instagram\.com$/.test(h)) return "Instagram";
    if (/(^|\.)tiktok\.com$/.test(h)) return "TikTok";
    if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "YouTube";
    if (r.sourceType === "Photo") return "From a photo";
    return h || "Your recipe";
  }

  // The inside of a .ph photo box: the first letter, covered by the photo when there is one.
  function phInner(r, full) {
    const url = full ? (r.photoUrl || r.photoThumb) : (r.photoThumb || r.photoUrl);
    const letter = (String(r.name || "").trim()[0] || "").toUpperCase();
    return `<span class="ltr">${escapeHtml(letter)}</span>${url ? `<img src="${escapeAttr(url)}" alt="" loading="lazy">` : ""}`;
  }

  function collectionNames(r) {
    return S.collections.filter((c) => (r.collectionIds || []).includes(c.id)).map((c) => c.name);
  }

  // ---------------------------------------------------------------------------
  // Recipes screen (#rc)
  // ---------------------------------------------------------------------------
  function wireRecipes() {
    $("#search").oninput = (e) => {
      S.search = e.target.value.trim().toLowerCase();
      if (S.section === "cols") S.section = "cookbook";
      renderRecipes();
    };
    // Switching tabs while the app is open is fine to keep in memory (S.section), but it's
    // deliberately never written to localStorage — a reload or a fresh app-switch launch should
    // always land on Cookbook, not wherever you happened to leave off.
    $("#sectionTabs").onclick = (e) => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      S.section = b.dataset.tab;
      S.chip = null;
      renderRecipes();
    };
    $("#recipesBody").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const d = b.dataset;
      if (d.chip) { S.chip = S.chip === d.chip ? null : d.chip; renderRecipes(); }
      else if (d.open) openRecipe(d.open);
      else if (d.col) { S.section = "cookbook"; S.chip = d.col; renderRecipes(); $("#main").scrollTop = 0; }
      else if ("newcol" in d) newCollection();
    };
    $("#btnNew").onclick = () => { $("#dlgClip").close(); openEditor(blankRecipe()); };
  }

  const inSection = (r) => (S.section === "toTry" ? !r.tried : r.tried);

  // Faves, Under 30 min, then every collection. Counts reflect the current tab.
  function chipDefs() {
    return [
      ["fav", "Faves", (r) => r.favourite],
      ["u30", "Under 30 min", (r) => { const m = totalMins(r); return m > 0 && m <= 30; }],
      ...S.collections.map((c) => [c.id, c.name, (r) => (r.collectionIds || []).includes(c.id)]),
    ];
  }

  function visibleRecipes() {
    const chip = chipDefs().find((c) => c[0] === S.chip);
    return S.recipes.filter((r) => {
      if (!inSection(r)) return false;
      if (chip && !chip[2](r)) return false;
      if (S.search) {
        // Ingredients, collections and the source site are searched too, so "what can I do with
        // haloumi" and "recipetineats" both work.
        const hay = [
          r.name, r.description, (r.tags || []).join(" "),
          (r.ingredients || []).map((i) => i.item).join(" "),
          collectionNames(r).join(" "), hostOf(r.sourceUrl), sourceLabel(r),
        ].join(" ").toLowerCase();
        if (!hay.includes(S.search)) return false;
      }
      return true;
    });
  }

  function cardHtml(r) {
    const t = timeLabel(totalMins(r));
    return `<button class="card" data-open="${escapeAttr(r.id)}"><div class="ph">${phInner(r)}${t ? `<span class="badge">${t}</span>` : ""}${r.favourite ? '<span class="favdot">★</span>' : ""}</div><div class="cn">${escapeHtml(r.name)}</div><div class="cs">${escapeHtml(sourceLabel(r))}</div></button>`;
  }

  function renderRecipes() {
    const nCook = S.recipes.filter((r) => r.tried).length;
    $("#nCookbook").textContent = S.loaded ? nCook : "";
    $("#nToTry").textContent = S.loaded ? S.recipes.length - nCook : "";
    $$("#sectionTabs .utab").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.section));

    const body = $("#recipesBody");
    if (S.section === "cols") {
      const rows = [{ id: "fav", name: "Faves", list: S.recipes.filter((r) => r.favourite) }]
        .concat(S.collections.map((c) => ({ id: c.id, name: c.name, list: S.recipes.filter((r) => (r.collectionIds || []).includes(c.id)) })));
      body.innerHTML = rows.map((c) => `<button class="crow" data-col="${escapeAttr(c.id)}"><div class="stack">${c.list.slice(0, 3).map((r) => `<div class="ph">${phInner(r)}</div>`).join("")}</div><div><b>${escapeHtml(c.name)}</b><small>${c.list.length} recipe${c.list.length === 1 ? "" : "s"}</small></div><span class="chev">›</span></button>`).join("")
        + `<button class="crow" data-newcol><div><b class="new">+ New collection</b></div></button><div class="crowpad"></div>`;
      return;
    }

    const defs = chipDefs();
    const list = visibleRecipes();
    let empty = "";
    if (S.loaded && !list.length) {
      const chip = defs.find((c) => c[0] === S.chip);
      if (S.search) empty = `No recipes match “${escapeHtml($("#search").value.trim())}”`;
      else if (chip) empty = `No recipes match “${escapeHtml(chip[1])}”`;
      else if (S.section === "cookbook") empty = "Nothing tried yet. Recipes move here once you mark them as cooked.";
      else empty = "No recipes yet. Clip one from a website or photo, or write one in by hand.";
    }
    body.innerHTML = `<div class="chiprow">${defs.map(([id, label, pred]) => `<button class="chip ${S.chip === id ? "on" : ""}" data-chip="${escapeAttr(id)}">${escapeHtml(label)}<span>${S.recipes.filter((r) => inSection(r) && pred(r)).length}</span></button>`).join("")}</div>
      <div class="grid">${list.map(cardHtml).join("")}${empty ? `<div class="noresult">${empty}</div>` : ""}</div>`;
  }

  async function newCollection() {
    const name = prompt("Collection name (e.g. Weeknight dinners):");
    if (!name || !name.trim()) return;
    try {
      await Data.createCollection(name.trim(), "", S.collections.length);
      await refresh();
      toast("Collection created");
    } catch (e) { toastError(e.message); }
  }

  // ---------------------------------------------------------------------------
  // Recipe page (#rd on the phone, #dk on the desktop)
  // ---------------------------------------------------------------------------
  function openRecipe(id) {
    S.openId = id;
    const r = S.recipesById[id];
    S.servings = r ? r.servings : 1;
    S.detailTab = "ing";
    setView("recipe");
  }

  function tickSet(id) { return S.ticked[id] || (S.ticked[id] = new Set()); }

  function scaledFor(r) {
    return Units.scaleIngredients(r.ingredients, (S.servings || r.servings) / (r.servings || 1));
  }

  function amountText(ing) {
    if (ing.qty == null) return ing.unit || "";
    const q = ing.qtyMax != null
      ? `${Units.formatQty(ing.qty)}–${Units.formatQty(ing.qtyMax)}`
      : Units.formatQty(ing.qty);
    const u = Units.pluraliseUnit(ing.unit, ing.qtyMax != null ? ing.qtyMax : ing.qty);
    return `${q}${u ? " " + u : ""}${ing.altText ? " / " + ing.altText : ""}`;
  }

  function ingRowsHtml(r, scaled) {
    const ticks = tickSet(r.id);
    let html = "";
    for (const [group, items] of groupBy(scaled, (i) => i.group || "")) {
      if (group) html += `<div class="lbl ghead">${escapeHtml(group)}</div>`;
      for (const g of items) {
        const a = amountText(g);
        html += `<button class="ingrow ${ticks.has(g.id) ? "done" : ""}" data-tick="${escapeAttr(g.id)}"><span class="ck">✓</span><span class="it">${a ? `<b>${escapeHtml(a)}</b> ` : ""}${escapeHtml(g.item)}${g.note ? `<small>${escapeHtml(g.note)}</small>` : ""}</span></button>`;
      }
    }
    return html;
  }

  // The feature the whole app is built around: each step carries its own ingredients and amounts.
  function stepRowsHtml(r, byId) {
    let n = 0, html = "";
    for (const [group, steps] of groupBy(r.steps, (s) => s.group || "")) {
      if (group) html += `<div class="lbl ghead">${escapeHtml(group)}</div>`;
      for (const st of steps) {
        n++;
        // A stale id from a hand-edited document shouldn't render an empty pill.
        const ings = (st.ingredientIds || []).map((id) => byId[id]).filter(Boolean);
        const pills = ings.length ? `<div class="pills">${ings.map((g) => { const a = amountText(g); return `<span class="pill">${a ? `<b>${escapeHtml(a)}</b> ` : ""}${escapeHtml(g.item)}</span>`; }).join("")}</div>` : "";
        html += `<div class="step"><span class="sn">${n}</span><div><div class="stx">${escapeHtml(st.text)}</div>${pills}</div></div>`;
      }
    }
    return html;
  }

  function srcHtml(r) {
    const label = escapeHtml(sourceLabel(r));
    return r.sourceUrl
      ? `<a class="src" href="${escapeAttr(r.sourceUrl)}" target="_blank" rel="noopener">${label} ↗</a>`
      : `<span class="src">${label}</span>`;
  }

  function metaText(r) {
    const bits = [];
    if (r.prepMinutes) bits.push(`${r.prepMinutes} min prep`);
    if (r.cookMinutes) bits.push(`${r.cookMinutes} min cook`);
    const n = (r.ingredients || []).length;
    if (n) bits.push(`${n} ingredient${n === 1 ? "" : "s"}`);
    return bits.join(" · ");
  }

  function stepperHtml(val, key) {
    return `<div class="stp"><button data-${key}="-1" aria-label="Fewer">−</button><b>${val}</b><button data-${key}="1" aria-label="More">+</button></div>`;
  }

  function servRowHtml(r) {
    const changed = S.servings !== r.servings;
    // Cooking times don't scale with quantity, so say so rather than let the numbers imply it.
    return `<div class="servrow"><span class="k">Serves</span>${changed ? '<button class="reset" data-reset>Reset</button>' : ""}${stepperHtml(S.servings, "sv")}</div>${changed && r.cookMinutes ? '<p class="scalenote">Amounts are scaled. Cooking times usually aren\'t.</p>' : ""}`;
  }

  const awakeHtml = () => `<button class="awake" data-awake><span>Keep screen on</span><span class="sw ${S.awake ? "on" : ""}"></span></button>`;
  const notesHtml = (r) => r.notes ? `<div class="notesbox"><div class="lbl">Your notes</div><p>${escapeHtml(r.notes)}</p></div>` : "";

  function renderDetail() {
    const el = $("#viewRecipe");
    const r = S.recipesById[S.openId];
    if (!r) { el.innerHTML = '<p class="noresult">Recipe not found</p>'; return; }

    const scaled = scaledFor(r);
    const byId = Object.fromEntries(scaled.map((i) => [i.id, i]));
    const main = $("#main");
    const top = main.scrollTop;

    if (desk.matches) {
      el.innerHTML = `<div class="dk"><div class="inner">
        <button class="crumb" data-back>‹ Recipes</button>
        <div class="dkacts"><button class="ib fav ${r.favourite ? "on" : ""}" data-fav aria-label="Favourite">★</button><button class="ib" data-more aria-label="More">⋯</button></div>
        <div class="tophalf"><div>
          ${srcHtml(r)}
          <h1 class="dt">${escapeHtml(r.name)}</h1>
          <div class="meta">${metaText(r)}</div>
          <div class="acts"><button class="btn" data-cook>Start cooking</button><button class="btn soft" data-plan>Add to plan</button><button class="btn soft" data-shop>Shopping list</button></div>
        </div><div class="ph">${phInner(r, true)}</div></div>
        <div class="lower">
          <div><h4>Method</h4>${awakeHtml()}${stepRowsHtml(r, byId)}${notesHtml(r)}</div>
          <div class="ingcol"><h4>Ingredients</h4>${servRowHtml(r)}${ingRowsHtml(r, scaled)}</div>
        </div>
      </div></div>`;
    } else {
      el.innerHTML = `<div class="hero"><div class="ph">${phInner(r, true)}</div><button class="ov l" data-back aria-label="Back">‹</button><button class="ov r1 fav ${r.favourite ? "on" : ""}" data-fav aria-label="Favourite">★</button><button class="ov r2" data-more aria-label="More">⋯</button></div>
        <div class="dsheet">
          ${srcHtml(r)}
          <h1 class="dt">${escapeHtml(r.name)}</h1>
          <div class="meta">${metaText(r)}</div>
          <button class="btn cookbtn" data-cook>Start cooking</button>
          <div class="pair"><button class="btn soft" data-plan>Add to plan</button><button class="btn soft" data-shop>Shopping list</button></div>
          ${servRowHtml(r)}
          <div class="seg"><button class="${S.detailTab === "ing" ? "on" : ""}" data-seg="ing">Ingredients</button><button class="${S.detailTab === "met" ? "on" : ""}" data-seg="met">Method</button></div>
          ${S.detailTab === "ing" ? ingRowsHtml(r, scaled) : awakeHtml() + stepRowsHtml(r, byId)}
          ${notesHtml(r)}
        </div>`;
    }
    main.scrollTop = top;
  }

  function wireDetail() {
    $("#viewRecipe").onclick = (e) => {
      const b = e.target.closest("button");
      const r = S.recipesById[S.openId];
      if (!b || !r) return;
      const d = b.dataset;
      if (d.sv) setServings(S.servings + Number(d.sv));
      else if ("reset" in d) setServings(r.servings);
      else if (d.seg) { S.detailTab = d.seg; renderDetail(); }
      else if (d.tick) { toggleTick(r.id, d.tick); renderDetail(); }
      else if ("awake" in d) { setAwake(!S.awake); renderDetail(); }
      else if ("fav" in d) toggleFavourite(r);
      else if ("cook" in d) openCookMode(r);
      else if ("plan" in d) planSheet(r);
      else if ("shop" in d) addToShoppingList(r);
      else if ("more" in d) recipeMenu(r);
      else if ("back" in d) setView("recipes");
    };
  }

  function toggleTick(recipeId, ingId) {
    const t = tickSet(recipeId);
    if (t.has(ingId)) t.delete(ingId); else t.add(ingId);
  }

  function setServings(n) {
    S.servings = Math.max(1, Math.round(n));
    renderDetail();
  }

  async function toggleFavourite(r) {
    // Flip locally first so the star responds instantly; roll back if the write fails.
    const was = r.favourite;
    r.favourite = !was;
    renderDetail();
    toast(r.favourite ? "Added to Faves" : "Removed from Faves");
    try { await Data.setFavourite(r.id, r.favourite); }
    catch (err) { r.favourite = was; renderDetail(); toastError(err.message); }
  }

  async function setTriedFlag(r, on, msg) {
    const was = r.tried;
    r.tried = on;
    if (msg) toast(msg);
    try { await Data.setTried(r.id, on); }
    catch (err) { r.tried = was; render(); toastError(err.message); }
  }

  function recipeMenu(r) {
    const cols = collectionNames(r).join(", ");
    openSheet(`<div class="sh-h"><h3>${escapeHtml(r.name)}</h3><button class="ib" data-x aria-label="Close">✕</button></div><div class="sh-b">
        <button class="mitem" data-edit>Edit recipe</button>
        <button class="mitem" data-tried>${r.tried ? "Move to To try" : "Mark as cooked"}<small>${r.tried ? "It’s in your Cookbook now" : "It’s in To try now"}</small></button>
        <button class="mitem" data-cols>Collections${cols ? `<small>${escapeHtml(cols)}</small>` : ""}</button>
        <button class="mitem danger" data-del>Delete recipe</button></div>`,
      (b) => {
        const d = b.dataset;
        closeSheet();
        // Collections are chosen in the editor, which already has the collection chips.
        if ("edit" in d || "cols" in d) openEditor(deepCopy(r));
        else if ("tried" in d) setTriedFlag(r, !r.tried, r.tried ? "Moved to To try" : "Moved to your Cookbook");
        else if ("del" in d) deleteRecipeById(r);
      });
  }

  async function deleteRecipeById(r) {
    if (!confirm(`Delete “${r.name}”? This can't be undone.`)) return;
    try {
      await Data.deleteRecipe(r.id);
      await refresh();
      setView("recipes");
      toast("Deleted");
    } catch (e) { toastError(e.message); }
  }

  // Add to plan: this week's days plus Any day (plan.any), today preselected, at the page's serves.
  function planSheet(r) {
    const monday = Plan.mondayOf(new Date());
    const longOf = (key) => key === Plan.ANY ? "Any day" : Plan.dayInfo(new Date(key + "T00:00:00")).long;
    let key = Plan.isoDate(new Date());
    let sv = S.servings;
    const sheet = openSheet(`<div class="sh-h"><h3>Add to plan</h3><button class="ib" data-x aria-label="Close">✕</button></div>
      <div class="sh-b"><div class="lbl">This week</div>${Plan.dayChipsHtml(monday, key, "data-pday")}
      <div class="rowline"><span class="k">Serves</span>${stepperHtml(sv, "psv")}</div></div>
      <div class="sh-f"><button class="btn" data-padd>Add to ${longOf(key)}</button></div>`,
      async (b) => {
        const d = b.dataset;
        if (d.pday) {
          key = d.pday;
          sheet.querySelectorAll(".dchip").forEach((c) => c.classList.toggle("on", c === b));
          sheet.querySelector("[data-padd]").textContent = `Add to ${longOf(key)}`;
        } else if (d.psv) {
          sv = Math.max(1, sv + Number(d.psv));
          sheet.querySelector(".stp b").textContent = sv;
        } else if ("padd" in d) {
          closeSheet();
          try {
            const iso = Plan.isoDate(monday);
            const week = S.week && S.week.weekStarting === iso ? S.week : await Data.loadWeek(iso);
            const day = week.plan[key] = week.plan[key] || {};
            (day.Dinner = day.Dinner || []).push({ recipeId: r.id, servings: sv });
            const saved = await Data.saveWeek(week);
            if (!S.week || S.week === week || S.week.weekStarting === iso) S.week = saved;
            toast("Added to the plan");
          } catch (e) { toastError(e.message); }
        }
      });
  }

  // Adds this recipe at the page's serves to the current shopping list, merging with what's there.
  async function addToShoppingList(r) {
    const lines = Units.buildShoppingList([{ recipe: r, servings: S.servings }]);
    try {
      await ensureList();
      if (!S.list) S.list = { id: null, name: "Shopping list", weekStarting: "", items: [], done: false };
      // Ticked and hand-added lines stay as they are; open recipe lines merge with the new ones.
      const keep = S.list.items.filter((i) => i.checked || i.manual);
      const open = S.list.items.filter((i) => !i.checked && !i.manual);
      const merged = Units.aggregate(open.concat(lines).map((i) => ({ item: i.name, qty: i.qty, unit: i.unit, fromRecipes: i.fromRecipes || [] })));
      S.list.items = merged.concat(keep);
      S.list = await Data.saveShoppingList(S.list);
      toast(`Added ${lines.length} item${lines.length === 1 ? "" : "s"}`);
    } catch (e) { toastError(e.message); }
  }

  // ---------------------------------------------------------------------------
  // Bottom sheets (centred dialogs on the desktop)
  // ---------------------------------------------------------------------------
  function openSheet(html, onClick) {
    closeSheet();
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.onclick = closeSheet;
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.innerHTML = `<div class="grab"></div>${html}`;
    sheet.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if ("x" in b.dataset) closeSheet();
      else if (onClick) onClick(b, e);
    });
    document.body.append(scrim, sheet);
    return sheet;
  }
  function closeSheet() {
    $$("body > .scrim, body > .sheet").forEach((n) => n.remove());
  }

  // ---------------------------------------------------------------------------
  // Cook mode (#ck)
  // ---------------------------------------------------------------------------
  const SIZES = [22, 26, 32];
  // One timer at a time, kept outside cook mode's paint so it survives moving between steps.
  const TM = { left: 0, up: false, iv: null, audio: null, onTick: null, onChange: null };

  function startTimer(s) {
    stopTimer();
    TM.left = s;
    // An AudioContext made during the tap is allowed to play later, when the timer runs out.
    try { TM.audio = TM.audio || new (window.AudioContext || window.webkitAudioContext)(); TM.audio.resume(); } catch { TM.audio = null; }
    TM.iv = setInterval(() => {
      TM.left--;
      if (TM.left <= 0) {
        clearInterval(TM.iv); TM.iv = null; TM.up = true;
        timeUpAlert();
        if (TM.onChange) TM.onChange();
      } else if (TM.onTick) TM.onTick();
    }, 1000);
  }
  function stopTimer() {
    clearInterval(TM.iv); TM.iv = null; TM.up = false; TM.left = 0;
  }
  function timeUpAlert() {
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch { /* not on desktop */ }
    try {
      const ctx = TM.audio;
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      o.start(); o.stop(ctx.currentTime + 0.65);
    } catch { /* no audio */ }
  }

  function openCookMode(recipe) {
    const steps = recipe.steps.length ? recipe.steps : [{ id: "s1", text: "No method recorded.", ingredientIds: [], group: "" }];
    let idx = 0;
    let fin = false;
    let fs = Number(localStorage.getItem("cookbook_cook_text")) || 26;
    if (!SIZES.includes(fs)) fs = 26;
    let sheetOpen = false;

    cookOpen = true;
    requestWakeLock();

    const wrap = document.createElement("div");
    wrap.className = "cook";
    $("#cookRoot").appendChild(wrap);

    function paint() {
      const scaled = scaledFor(recipe);
      const byId = Object.fromEntries(scaled.map((i) => [i.id, i]));
      const st = steps[idx], n = steps.length;
      const tm = Timer.timerFor(st.text);
      const running = Boolean(TM.iv) || TM.up;
      const ings = (st.ingredientIds || []).map((id) => byId[id]).filter(Boolean);
      wrap.style.setProperty("--cfs", fs + "px");
      wrap.innerHTML = `
        <div class="cbar"><button class="ib" data-close aria-label="Close cook mode">✕</button><div class="ttl"><b>${escapeHtml(recipe.name)}</b><small>Step ${idx + 1} of ${n}</small></div><button class="txtb" data-aa aria-label="Text size">Aa</button><button class="txtb" data-all>Ingredients</button></div>
        ${running ? `<div class="tbanner ${TM.up ? "up" : ""}"><span>${TM.up ? "Time’s up" : "Timer · " + Timer.clock(TM.left)}</span><button data-stop>${TM.up ? "OK" : "Stop"}</button></div>` : ""}
        <div class="cstage ${running ? "t" : ""}">
          <div class="lbl stepno">${st.group ? escapeHtml(st.group) + " · " : ""}Step ${idx + 1}</div>
          <div class="ctext">${escapeHtml(st.text)}</div>
          ${tm && !running ? `<button class="tbtn" data-start="${tm.s}">Start ${tm.label} timer</button>` : ""}
          ${ings.length ? `<div class="lbl">You’ll need</div>${ings.map((g) => `<div class="nrow"><span class="q">${escapeHtml(amountText(g)) || "·"}</span><span>${escapeHtml(g.item)}</span></div>`).join("")}` : ""}
        </div>
        <div class="cnav"><button class="back" data-prev ${idx === 0 ? "disabled" : ""}>‹ Back</button><button class="next" data-next>${idx === n - 1 ? "Finish" : "Next step ›"}</button></div>
        ${fin ? `<div class="finish"><h3>Done. Enjoy it.</h3><p>${recipe.tried ? `Serves ${S.servings}. Mark it cooked to keep track of what you’ve made.` : "Moves it from To try into your Cookbook."}</p><button class="btn" data-cooked>Mark as cooked</button><button class="btn line" data-again>Back to recipe</button></div>` : ""}`;
    }

    // Only the clock text changes each second, so the stage keeps its scroll position.
    TM.onTick = () => {
      const s = wrap.querySelector(".tbanner span");
      if (s) s.textContent = "Timer · " + Timer.clock(TM.left); else paint();
    };
    TM.onChange = paint;

    function ingSheet() {
      sheetOpen = true;
      const sheet = openSheet(`<div class="sh-h"><h3>Ingredients · serves ${S.servings}</h3><button class="ib" data-x aria-label="Close">✕</button></div><div class="sh-b">${ingRowsHtml(recipe, scaledFor(recipe))}</div>`,
        (b) => {
          if (!b.dataset.tick) return;
          toggleTick(recipe.id, b.dataset.tick);
          const body = sheet.querySelector(".sh-b"), top = body.scrollTop;
          body.innerHTML = ingRowsHtml(recipe, scaledFor(recipe));
          body.scrollTop = top;
        });
    }

    function next() { if (idx < steps.length - 1) idx++; else fin = true; paint(); }
    function prev() { if (idx > 0) { idx--; paint(); } }

    wrap.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const d = b.dataset;
      if ("next" in d) next();
      else if ("prev" in d) prev();
      else if ("aa" in d) {
        fs = SIZES[(SIZES.indexOf(fs) + 1) % SIZES.length];
        localStorage.setItem("cookbook_cook_text", String(fs));
        paint();
        toast(`Text ${fs}px`);
      }
      else if ("all" in d) ingSheet();
      else if (d.start) { startTimer(Number(d.start)); paint(); }
      else if ("stop" in d) { stopTimer(); paint(); }
      else if ("close" in d || "again" in d) close();
      else if ("cooked" in d) {
        if (!recipe.tried) setTriedFlag(recipe, true);
        close();
        toast("Marked as cooked");
      }
    };

    function onKey(e) {
      if (document.querySelector(".sheet")) return;   // the sheet handles its own Escape
      if (e.key === "Escape") close();
      else if (fin) return;
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    }

    function close() {
      document.removeEventListener("keydown", onKey);
      stopTimer();
      TM.onTick = TM.onChange = null;
      if (sheetOpen) closeSheet();
      wrap.remove();
      cookOpen = false;
      if (!S.awake) releaseWakeLock();
      if (S.view === "recipe") renderDetail();
    }

    document.addEventListener("keydown", onKey);
    paint();
  }

  // ---------------------------------------------------------------------------
  // Editor
  // ---------------------------------------------------------------------------
  function blankRecipe() {
    return {
      id: null, name: "", description: "", servings: 4, servingUnit: "servings",
      prepMinutes: null, cookMinutes: null, ingredients: [], steps: [],
      notes: "", sourceUrl: "", sourceType: "Manual", tags: [], favourite: false, tried: false,
      collectionIds: [], photoUrl: "",
    };
  }

  function wireEditor() {
    $("#edAddIng").onclick = () => {
      S.editing.ingredients.push({ id: nextId(S.editing.ingredients, "i"), qty: null, qtyMax: null, unit: "", item: "", note: "", group: "", scalable: true });
      renderEditorIngredients();
    };
    $("#edAddStep").onclick = () => {
      S.editing.steps.push({ id: nextId(S.editing.steps, "s"), text: "", ingredientIds: [], group: "" });
      renderEditorSteps();
    };
    $("#edPasteIng").onclick = pasteIngredients;
    $("#btnSaveRecipe").onclick = saveRecipe;
    $("#btnDelete").onclick = deleteRecipe;
    $("#edPhotoUrl").oninput = () => paintPhotoPreview($("#edPhotoUrl").value.trim());
    $("#edPhotoClear").onclick = () => { $("#edPhotoUrl").value = ""; paintPhotoPreview(""); };
  }

  function paintPhotoPreview(url) {
    const img = $("#edPhotoPreview");
    if (url) { img.src = url; img.hidden = false; } else { img.hidden = true; img.removeAttribute("src"); }
  }

  function openEditor(recipe) {
    S.editing = recipe;
    $("#editTitle").textContent = recipe.id ? "Edit recipe" : "New recipe";
    $("#btnDelete").hidden = !recipe.id;
    $("#edName").value = recipe.name || "";
    $("#edDesc").value = recipe.description || "";
    $("#edServings").value = recipe.servings || 4;
    $("#edServingUnit").value = recipe.servingUnit || "servings";
    $("#edPrep").value = recipe.prepMinutes ?? "";
    $("#edCook").value = recipe.cookMinutes ?? "";
    $("#edNotes").value = recipe.notes || "";
    $("#edSource").value = recipe.sourceUrl || "";
    $("#edPhotoUrl").value = recipe.photoUrl || "";
    $("#edPhotoHint").hidden = !(recipe.photoUrl && !recipe.id);
    paintPhotoPreview(recipe.photoUrl || "");
    renderEditorIngredients();
    renderEditorSteps();
    renderEditorCollections();
    $("#dlgEdit").showModal();
  }

  function renderEditorIngredients() {
    const el = $("#edIngredients");
    el.innerHTML = "";
    S.editing.ingredients.forEach((ing, i) => {
      const row = document.createElement("div");
      row.className = "editrow";

      const qty = document.createElement("input");
      qty.type = "text";
      qty.placeholder = "2½";
      qty.value = ing.qty != null ? Units.formatQty(ing.qty) + (ing.qtyMax != null ? `-${Units.formatQty(ing.qtyMax)}` : "") : "";
      qty.oninput = () => {
        // Re-parse through the same path a written line takes, so "1 1/2" and "1½" both work here.
        const parsed = Units.parseIngredient(`${qty.value} x`);
        ing.qty = parsed.qty;
        ing.qtyMax = parsed.qtyMax;
        ing.scalable = ing.qty != null && !/\b(pinch|dash|to taste)\b/i.test(ing.unit + " " + ing.item);
      };
      row.appendChild(qty);

      const unit = document.createElement("input");
      unit.type = "text";
      unit.placeholder = "cups";
      unit.value = ing.unit || "";
      unit.oninput = () => {
        const probe = Units.parseIngredient(`1 ${unit.value} x`);
        ing.unit = probe.unit || unit.value.trim();
      };
      row.appendChild(unit);

      const item = document.createElement("input");
      item.type = "text";
      item.placeholder = "plain flour, sifted";
      item.value = ing.item + (ing.note ? `, ${ing.note}` : "");
      item.oninput = () => {
        const parsed = Units.parseIngredient(item.value);
        ing.item = parsed.item;
        ing.note = parsed.note;
      };
      row.appendChild(item);

      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = "Remove";
      del.onclick = () => {
        // Steps reference ingredients by id, so a deleted ingredient has to be unlinked too or the
        // step would keep a dangling reference that renders as nothing.
        const gone = S.editing.ingredients[i].id;
        S.editing.ingredients.splice(i, 1);
        for (const st of S.editing.steps) {
          st.ingredientIds = (st.ingredientIds || []).filter((x) => x !== gone);
        }
        renderEditorIngredients();
        renderEditorSteps();
      };
      row.appendChild(del);

      el.appendChild(row);
    });
  }

  function renderEditorSteps() {
    const el = $("#edSteps");
    el.innerHTML = "";
    S.editing.steps.forEach((st, i) => {
      const box = document.createElement("div");
      box.className = "stepedit";

      const head = document.createElement("div");
      head.className = "head";
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = i + 1;
      head.appendChild(n);
      head.appendChild(document.createTextNode("Step"));
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.style.marginLeft = "auto";
      del.onclick = () => { S.editing.steps.splice(i, 1); renderEditorSteps(); };
      head.appendChild(del);
      box.appendChild(head);

      const ta = document.createElement("textarea");
      ta.rows = 2;
      ta.placeholder = "Cream the butter and sugar until pale.";
      ta.value = st.text || "";
      ta.oninput = () => { st.text = ta.value; };
      box.appendChild(ta);

      // The ingredient picker — this is what makes per-step amounts possible.
      const pick = document.createElement("div");
      pick.className = "ingpick";
      if (!S.editing.ingredients.length) {
        const hint = document.createElement("span");
        hint.style.cssText = "font-size:12.5px;color:var(--ink-3)";
        hint.textContent = "Add ingredients above to link them to this step.";
        pick.appendChild(hint);
      }
      for (const ing of S.editing.ingredients) {
        if (!ing.item) continue;
        const on = (st.ingredientIds || []).includes(ing.id);
        const b = document.createElement("button");
        b.className = "chip";
        b.textContent = ing.item;
        b.setAttribute("aria-pressed", String(on));
        b.onclick = () => {
          st.ingredientIds = st.ingredientIds || [];
          const at = st.ingredientIds.indexOf(ing.id);
          if (at >= 0) st.ingredientIds.splice(at, 1); else st.ingredientIds.push(ing.id);
          renderEditorSteps();
        };
        pick.appendChild(b);
      }
      box.appendChild(pick);
      el.appendChild(box);
    });
  }

  function renderEditorCollections() {
    const el = $("#edCollections");
    el.innerHTML = "";
    if (!S.collections.length) {
      el.innerHTML = '<span style="font-size:13px;color:var(--ink-3)">No collections yet — make one on the Collections tab.</span>';
      return;
    }
    for (const c of S.collections) {
      const on = (S.editing.collectionIds || []).includes(c.id);
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = c.name;
      b.setAttribute("aria-pressed", String(on));
      b.onclick = () => {
        S.editing.collectionIds = S.editing.collectionIds || [];
        const at = S.editing.collectionIds.indexOf(c.id);
        if (at >= 0) S.editing.collectionIds.splice(at, 1); else S.editing.collectionIds.push(c.id);
        renderEditorCollections();
      };
      el.appendChild(b);
    }
  }

  // Bulk entry: paste a whole ingredient list and let the parser split every line. Far faster than
  // filling three fields per ingredient, and the rows stay individually editable afterwards.
  function pasteIngredients() {
    const text = prompt("Paste an ingredient list — one per line:");
    if (!text) return;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parsed = Units.parseIngredient(line);
      parsed.id = nextId(S.editing.ingredients, "i");
      parsed.group = "";
      S.editing.ingredients.push(parsed);
    }
    renderEditorIngredients();
    renderEditorSteps();
  }

  async function saveRecipe() {
    const r = S.editing;
    r.name = $("#edName").value.trim() || "Untitled";
    r.description = $("#edDesc").value.trim();
    r.servings = Math.max(1, parseInt($("#edServings").value, 10) || 1);
    r.servingUnit = $("#edServingUnit").value.trim() || "servings";
    r.prepMinutes = $("#edPrep").value === "" ? null : Number($("#edPrep").value);
    r.cookMinutes = $("#edCook").value === "" ? null : Number($("#edCook").value);
    r.notes = $("#edNotes").value;
    r.sourceUrl = $("#edSource").value.trim();
    r.ingredients = r.ingredients.filter((i) => i.item && i.item.trim());
    r.steps = r.steps.filter((s) => s.text && s.text.trim());
    const newPhotoUrl = $("#edPhotoUrl").value.trim();
    const photoChanged = newPhotoUrl !== (r.photoUrl || "");
    r.photoUrl = newPhotoUrl;

    const btn = $("#btnSaveRecipe");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const saved = r.id ? await Data.updateRecipe(r) : await Data.createRecipe(r);
      // Attachment fields are set by URL in a separate call — only touch it if you actually
      // changed something, so re-saving an existing recipe doesn't re-fetch an unchanged photo.
      if (photoChanged) {
        try { await Data.setPhotoFromUrl(saved.id, r.photoUrl); } catch { /* photo is optional */ }
      }
      $("#dlgEdit").close();
      S.editing = null;
      await refresh();
      openRecipe(saved.id);
      toast("Saved");
    } catch (e) {
      toastError(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Save recipe";
    }
  }

  async function deleteRecipe() {
    if (!S.editing.id) return;
    if (!confirm(`Delete “${S.editing.name}”? This can't be undone.`)) return;
    try {
      await Data.deleteRecipe(S.editing.id);
      $("#dlgEdit").close();
      S.editing = null;
      await refresh();
      setView("recipes");
      toast("Deleted");
    } catch (e) { toastError(e.message); }
  }

  // ---------------------------------------------------------------------------
  // Clipper
  // ---------------------------------------------------------------------------
  function wireClip() {
    $$("#clipTabs [data-clip]").forEach((tab) => {
      tab.onclick = () => {
        S.clipMode = tab.dataset.clip;
        $$("#clipTabs [data-clip]").forEach((t) => t.setAttribute("aria-pressed", String(t === tab)));
        $$(".clip-pane").forEach((p) => { p.hidden = p.dataset.pane !== S.clipMode; });
        $("#clipStatus").textContent = "";
      };
    });

    $("#clipPhoto").onchange = (e) => {
      S.clipFile = e.target.files[0] || null;
      const prev = $("#clipPreview");
      if (S.clipFile) { prev.src = URL.createObjectURL(S.clipFile); prev.hidden = false; }
      else prev.hidden = true;
    };

    $("#btnDoClip").onclick = doClip;
  }

  // Android's share sheet lands here via the manifest's share_target (GET, so no service-worker
  // hook needed) — different apps put the link in different fields, so all three are checked.
  function consumeSharedLink() {
    const params = new URLSearchParams(location.search);
    if (!params.has("shared_url") && !params.has("shared_text") && !params.has("shared_title")) return;
    const candidates = [params.get("shared_url"), params.get("shared_text"), params.get("shared_title")];
    const found = candidates.map((c) => c && c.match(/https?:\/\/\S+/)).find(Boolean);
    history.replaceState(null, "", location.pathname + location.hash);
    if (!found) return;
    openClip();
    $("#clipUrl").value = found[0];
  }

  function openClip() {
    $("#clipUrl").value = "";
    $("#clipText").value = "";
    $("#clipPhoto").value = "";
    $("#clipPreview").hidden = true;
    $("#clipStatus").textContent = "";
    S.clipFile = null;
    $("#dlgClip").showModal();
  }

  async function doClip() {
    const status = $("#clipStatus");
    const btn = $("#btnDoClip");
    const say = (msg) => { status.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`; };

    btn.disabled = true;
    try {
      let recipe;
      if (S.clipMode === "url") {
        const url = $("#clipUrl").value.trim();
        if (!url) throw new Error("Paste a recipe URL first.");
        recipe = await Clip.clipFromUrl(url, say);
      } else if (S.clipMode === "photo") {
        if (!S.clipFile) throw new Error("Choose a photo first.");
        recipe = await Clip.clipFromPhoto(S.clipFile, say);
      } else {
        recipe = await Clip.clipFromText($("#clipText").value, say);
      }

      $("#dlgClip").close();
      // Every clip lands in the editor for review — nothing is saved until Save is pressed.
      recipe.id = null;
      openEditor(recipe);
      if (recipe.confidence === "low") {
        toastError("Read it, but the source was hard to make out — check the amounts before saving.");
      } else {
        toast("Read it — check it over, then save.");
      }
    } catch (e) {
      status.innerHTML = `<span style="color:var(--danger)">${escapeHtml(e.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Plan (#pl)
  // ---------------------------------------------------------------------------
  // A week's plan is { "YYYY-MM-DD": { Dinner: [{recipeId, servings, cooked?}] }, any: {...} }.
  // Entries are addressed by "key|meal|index" (Plan.dayEntries), so nothing extra is stored.
  function wirePlanner() {
    $("#viewPlanner").onclick = (e) => {
      const b = e.target.closest("button, [data-openr]");
      if (!b) return;
      const d = b.dataset;
      if (d.wk) { S.monday = Plan.addDays(S.monday, 7 * Number(d.wk)); loadWeek(); }
      else if ("upd" in d) updateList();
      else if (d.cooked) toggleCooked(d.cooked);
      else if (d.openr) openPlanned(d.openr);
      else if (d.addday) openPick(d.addday);
      else if (d.mmore) mealMenu(d.mmore);
    };
  }

  async function loadWeek() {
    const iso = Plan.isoDate(S.monday);
    try {
      const [week] = await Promise.all([Data.loadWeek(iso), ensureList()]);
      if (Plan.isoDate(S.monday) !== iso) return;   // moved to another week while this one loaded
      S.week = week;
      if (S.view === "planner") renderPlannerView();
    } catch (e) { toastError(e.message); }
  }

  function renderPlannerView() {
    if (!S.week || S.week.weekStarting !== Plan.isoDate(S.monday)) { loadWeek(); return; }
    $("#viewPlanner").innerHTML = Plan.plannerHtml({
      week: S.week,
      monday: S.monday,
      thisMonday: Plan.mondayOf(new Date()),
      today: Plan.isoDate(new Date()),
      recipesById: S.recipesById,
      phInner,
      card: mealsOnList(S.week),
    });
  }

  // How many of a week's planned meals the current shopping list covers ("4 of 7 meals added").
  // Nothing records this directly, so it's read off the list: a meal counts once the list belongs
  // to its week and some recipe line on it came from that meal's recipe. A recipe with no
  // ingredients (or one since deleted) has nothing to add, so it counts as added.
  function mealsOnList(week) {
    const es = Plan.weekEntries(week, new Date(week.weekStarting + "T00:00:00"));
    const forWeek = Boolean(S.list && S.list.weekStarting === week.weekStarting);
    const onList = new Set();
    if (forWeek) for (const it of S.list.items) if (!it.manual) for (const id of it.fromRecipes || []) onList.add(id);
    const added = es.filter((e) => {
      if (!forWeek) return false;
      const r = S.recipesById[e.entry.recipeId];
      return !r || !(r.ingredients || []).some((i) => i.item) || onList.has(e.entry.recipeId);
    }).length;
    return { added, total: es.length };
  }

  function entryAt(ref) {
    const [key, meal, i] = ref.split("|");
    const arr = ((S.week.plan[key] || {})[meal]) || [];
    return { key, meal, i: Number(i), arr, entry: arr[Number(i)] };
  }

  // Writes the week this screen is showing. If the screen moved to another week before the save
  // came back, the newer state is kept rather than overwritten by the one just saved.
  async function saveWeek() {
    const w = S.week;
    try {
      const saved = await Data.saveWeek(w);
      if (S.week === w) S.week = saved;
    } catch (e) { toastError(e.message); }
  }

  // Ticking a meal marks it cooked, and moves a To try recipe into the Cookbook (Part H.2).
  // Unticking clears cooked only: the recipe has still been cooked, so tried is left alone.
  async function toggleCooked(ref) {
    const { entry } = entryAt(ref);
    if (!entry) return;
    entry.cooked = !entry.cooked;
    const r = S.recipesById[entry.recipeId];
    const promote = entry.cooked && r && r.tried === false;
    renderPlannerView();
    if (promote) setTriedFlag(r, true, "Cooked, and moved into your Cookbook");
    await saveWeek();
  }

  // Opens the recipe at the planned servings.
  function openPlanned(ref) {
    const { entry } = entryAt(ref);
    if (!entry || !S.recipesById[entry.recipeId]) return;
    openRecipe(entry.recipeId);
    setServings(Number(entry.servings) || S.servings);
  }

  function mealMenu(ref) {
    const at = entryAt(ref);
    if (!at.entry) return;
    openSheet(Plan.mealMenuHtml({ recipe: S.recipesById[at.entry.recipeId], entry: at.entry, key: at.key, monday: S.monday }), (b) => {
      const d = b.dataset;
      if ("openr" in d) { closeSheet(); openPlanned(ref); }
      else if (d.mv) {
        closeSheet();
        // The entry moves as it is (servings, meal, cooked), so a Lunch stays a Lunch.
        at.arr.splice(at.i, 1);
        const day = S.week.plan[d.mv] = S.week.plan[d.mv] || {};
        (day[at.meal] = day[at.meal] || []).push(at.entry);
        renderPlannerView();
        toast("Moved");
        saveWeek();
      } else if ("rm" in d) {
        closeSheet();
        at.arr.splice(at.i, 1);
        renderPlannerView();
        toast("Removed");
        saveWeek();
      }
    });
  }

  // The Add sheet: search, Faves / To try / All, one recipe, meal and serves, then Add.
  let pick = null;
  function openPick(key) {
    if (!S.recipes.length) { toastError("Add a recipe first."); return; }
    pick = { key, picked: null, sv: 2, meal: "Dinner", f: "Faves", q: "" };
    const sheet = openSheet("", onPickClick);
    sheet.classList.add("pick");
    sheet.addEventListener("input", (e) => {
      if (e.target.matches("[data-pq]")) { pick.q = e.target.value; renderPick(); }
    });
    renderPick();
  }

  function pickRecipes() {
    const q = pick.q.trim().toLowerCase();
    return S.recipes.filter((r) =>
      (pick.f === "All" || (pick.f === "Faves" ? r.favourite : !r.tried)) &&
      (!q || (r.name + " " + (r.ingredients || []).map((i) => i.item).join(" ")).toLowerCase().includes(q)));
  }

  function renderPick() {
    const sheet = $("body > .sheet");
    if (!sheet || !pick) return;
    const body = sheet.querySelector(".sh-b");
    const top = body ? body.scrollTop : 0;
    const typing = document.activeElement && document.activeElement.matches("[data-pq]");
    sheet.innerHTML = `<div class="grab"></div>` + Plan.pickHtml(Object.assign({}, pick, { recipes: pickRecipes(), phInner }));
    sheet.querySelector(".sh-b").scrollTop = top;
    if (typing) { const i = sheet.querySelector("[data-pq]"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  function onPickClick(b) {
    const d = b.dataset;
    if (d.pf) { pick.f = d.pf; renderPick(); }
    else if (d.pr) { pick.picked = d.pr; pick.sv = S.recipesById[d.pr].servings; renderPick(); }
    else if (d.pm) { pick.meal = d.pm; renderPick(); }
    else if (d.ps) { pick.sv = Math.max(1, pick.sv + Number(d.ps)); renderPick(); }
    else if ("padd2" in d) {
      const r = S.recipesById[pick.picked];
      if (!r) return;
      closeSheet();
      const day = S.week.plan[pick.key] = S.week.plan[pick.key] || {};
      (day[pick.meal] = day[pick.meal] || []).push({ recipeId: r.id, servings: pick.sv });
      renderPlannerView();
      const words = r.name.split(" ");
      toast(`Added ${words.length > 3 ? words.slice(0, 3).join(" ") + "…" : r.name}`);
      saveWeek();
    }
  }

  // The shopping card: "Open" when every meal is on the list, otherwise "Update".
  async function updateList() {
    const c = mealsOnList(S.week);
    if (c.total && c.added === c.total) setView("shopping");
    else await makeShoppingList();
  }

  // ---------------------------------------------------------------------------
  // Shop (#sh)
  // ---------------------------------------------------------------------------
  function wireShopping() {
    const el = $("#viewShopping");
    el.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b || b.closest("form")) return;   // the Add button submits the form instead
      const d = b.dataset;
      if (d.it !== undefined) toggleItem(Number(d.it));
      else if (d.shview) {
        S.shView = d.shview;
        try { localStorage.setItem("cookbook_shop_view", d.shview); } catch { /* remembered for this visit only */ }
        renderShoppingView();
      }
      else if ("trolley" in d) { S.trolleyOpen = !S.trolleyOpen; renderShoppingView(); }
      else if ("shmore" in d) shopMenu();
    };
    el.onsubmit = (e) => {
      e.preventDefault();
      addManualItem(e.target.querySelector("input"));
    };
  }

  // The current list: the first one not marked done, as before.
  async function ensureList() {
    if (S.listLoaded) return;
    try {
      const lists = await Data.loadShoppingLists();
      S.list = lists.find((l) => !l.done) || lists[lists.length - 1] || null;
      S.listLoaded = true;
    } catch (e) { toastError(e.message); }
  }

  async function makeShoppingList() {
    if (!S.week) return;
    const meals = Plan.mealsForWeek(S.week, S.recipesById);   // every key, so Any day too
    if (!meals.length) { toastError("No meals planned for this week yet."); return; }

    await ensureList();
    const items = Units.buildShoppingList(meals);
    // Manual additions survive a regenerate — they're things the plan doesn't know about (milk,
    // bin bags) and losing them every time the list was rebuilt would make the feature useless.
    const same = S.list && S.list.weekStarting === S.week.weekStarting;
    const keep = same ? S.list.items.filter((i) => i.manual) : [];

    S.list = {
      id: same ? S.list.id : null,
      name: `Week of ${Plan.rangeText(S.monday)}`,
      weekStarting: S.week.weekStarting,
      items: items.concat(keep),
      done: false,
    };
    S.listWeek = S.week;
    renderPlannerView();
    toast("Shopping list updated");
    await saveList();
  }

  // The week behind the current list, for "From 7 meals · 16–22 Nov".
  function listWeek() {
    const ws = S.list && S.list.weekStarting;
    if (!ws) return null;
    if (S.week && S.week.weekStarting === ws) return S.week;
    if (S.listWeek && S.listWeek.weekStarting === ws) return S.listWeek;
    return null;
  }

  function shopSubline() {
    const ws = S.list && S.list.weekStarting;
    if (!ws) return "Your list";
    const w = listWeek();
    const range = Plan.rangeText(new Date(ws + "T00:00:00"));
    if (!w) return range;
    const n = mealsOnList(w).added;
    return `From ${n} meal${n === 1 ? "" : "s"} · ${range}`;
  }

  async function renderShoppingView() {
    if (!S.listLoaded) { await ensureList(); if (S.view !== "shopping") return; }
    const ws = S.list && S.list.weekStarting;
    if (ws && !listWeek()) {
      // Load the list's week once so the subline can count its meals, then paint again.
      Data.loadWeek(ws).then((w) => { S.listWeek = w; if (S.view === "shopping") renderShoppingView(); }).catch(() => {});
    }
    const el = $("#viewShopping");
    const input = el.querySelector(".addrow input");
    const typing = input && document.activeElement === input;
    el.innerHTML = Plan.shoppingHtml({
      list: S.list, view: S.shView, open: S.trolleyOpen,
      recipesById: S.recipesById, phInner, subline: shopSubline(), draft: input ? input.value : "",
    });
    if (typing) el.querySelector(".addrow input").focus();
  }

  function toggleItem(i) {
    const it = S.list && S.list.items[i];
    if (!it) return;
    it.checked = !it.checked;
    renderShoppingView();
    saveList();
  }

  async function addManualItem(input) {
    const text = input.value.trim();
    if (!text) return;
    if (!S.list) S.list = { id: null, name: "Shopping list", weekStarting: "", items: [], done: false };
    const parsed = Units.parseIngredient(text);
    const aisle = Units.aisleFor(parsed.item || text);
    // At the top, so it leads its aisle.
    S.list.items.unshift({
      id: "x" + Math.random().toString(36).slice(2, 9),
      name: parsed.item || text,
      qty: parsed.qty, unit: parsed.unit,
      aisle,
      checked: false, manual: true, fromRecipes: [],
    });
    input.value = "";
    renderShoppingView();
    toast(`Added to ${aisle}`);
    await saveList();
  }

  function shopMenu() {
    const n = S.list ? S.list.items.filter((i) => i.checked).length : 0;
    const sheet = openSheet(Plan.shopMenuHtml(n), (b) => {
      const d = b.dataset;
      if ("clear" in d) {
        closeSheet();
        if (S.list) S.list.items = S.list.items.filter((i) => !i.checked);
        renderShoppingView();
        toast("Cleared ticked items");
        saveList();
      } else if ("clearall" in d) {
        // Second step, in the same sheet.
        sheet.querySelector(".sh-b").innerHTML = Plan.clearConfirmHtml(S.list ? S.list.items.length : 0);
      } else if ("clearyes" in d) {
        closeSheet();
        if (S.list) S.list.items = [];
        renderShoppingView();
        saveList();
      }
    });
  }

  // Writes are fire-and-forget from the UI's point of view — the local state has already been
  // repainted, so a failed save shows an error but never leaves a half-updated screen.
  async function saveList() {
    const l = S.list;
    if (!l) return;
    try {
      const saved = await Data.saveShoppingList(l);
      // Keep the live object (and any ticks made meanwhile); only pick up the new id.
      if (S.list === l) l.id = saved.id;
    } catch (e) { toastError(e.message); }
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  // Preserves first-seen order, so sub-recipe sections appear in the order the recipe lists them.
  function groupBy(list, keyFn) {
    const map = new Map();
    for (const item of list || []) {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    }
    return map;
  }

  function nextId(list, prefix) {
    let n = 1;
    const used = new Set((list || []).map((x) => x.id));
    while (used.has(prefix + n)) n++;
    return prefix + n;
  }

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // Toast: centred above the tab bar (brief, Part A).
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    showToast(msg, "ptoast", ms);
  }
  function toastError(msg) {
    showToast(msg, "ptoast err", 6000);
  }
  function showToast(msg, cls, ms) {
    clearToast();
    const t = document.createElement("div");
    t.className = cls;
    t.textContent = msg;
    t.id = "toast";
    document.body.appendChild(t);
    if (ms) toastTimer = setTimeout(clearToast, ms);
  }
  function clearToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    const old = document.getElementById("toast");
    if (old) old.remove();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
