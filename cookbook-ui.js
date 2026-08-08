// cookbook-ui.js
// Application state, navigation, and every rendered view.
//
// One module owns state and orchestration; cookbook-plan.js and cookbook-clip.js are called by it
// and never call back into it except through the callbacks it hands them. `render()` repaints the
// current view from state — there is no partial DOM patching anywhere, because a cookbook's data is
// small enough that a full repaint is instant and always correct.
(function () {
  "use strict";

  const Units = window.CookbookUnits;
  const Data = window.CookbookData;
  const Clip = window.CookbookClip;
  const Plan = window.CookbookPlan;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
    view: "recipes",
    recipes: [],
    collections: [],
    recipesById: {},
    // filters
    section: "cookbook",  // "cookbook" (tried) or "toTry" (not yet tried) — always starts here, never remembered
    search: "",
    collectionId: null,
    favOnly: false,
    // detail
    openId: null,
    servings: null,       // the working serving count, which may differ from the recipe's own
    // editor
    editing: null,        // the recipe object being edited (null = not open)
    // planner
    monday: Plan.mondayOf(new Date()),
    week: null,
    // shopping
    list: null,
    // clip
    clipMode: "url",
    clipFile: null,
    loaded: false,
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    applyStoredTheme();
    wireNav();
    wireSettings();
    wireRecipes();
    wireEditor();
    wireClip();
    consumeSharedLink();
    wirePlanner();
    wireShopping();
    wireCollections();
    wireWakeLock();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }

    if (!Data.hasCreds()) {
      $("#setupBanner").hidden = false;
      setView("recipes");
      return;
    }
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
    $("#navTheme").onclick = toggleTheme;
    $("#navSettings").onclick = openSettings;
    $("#navSettingsM").onclick = openSettings;
    $("#bannerSettings").onclick = openSettings;
    $("#btnBack").onclick = () => setView("recipes");

    // Dialogs all close the same way.
    $$("[data-close]").forEach((b) => {
      b.onclick = () => b.closest("dialog").close();
    });
  }

  // ---------------------------------------------------------------------------
  // Wake lock
  // ---------------------------------------------------------------------------
  // Keeps the screen on everywhere in the app, not just Cook Mode — this is a kitchen tablet/phone
  // sitting on a bench, and it locking mid-shop or mid-browse is just as annoying as mid-recipe.
  // The lock is released by the browser whenever the tab is backgrounded, so it has to be
  // re-requested every time the app becomes visible again, or the screen goes back to sleeping.
  let wakeLock = null;

  function wireWakeLock() {
    requestWakeLock();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") requestWakeLock();
    });
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request("screen"); }
    catch { /* denied or unsupported — the app still works, the screen just sleeps normally */ }
  }

  function setView(view) {
    S.view = view;
    if (view !== "recipe") S.openId = null;

    $("#viewRecipes").hidden = view !== "recipes";
    $("#viewRecipe").hidden = view !== "recipe";
    $("#viewPlanner").hidden = view !== "planner";
    $("#viewShopping").hidden = view !== "shopping";
    $("#viewCollections").hidden = view !== "collections";

    // The detail view is a child of Recipes as far as the nav is concerned.
    const navKey = view === "recipe" ? "recipes" : view;
    $$("[data-view]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === navKey)));

    window.scrollTo(0, 0);
    render();
  }

  function render() {
    if (S.view === "recipes") renderGrid();
    else if (S.view === "recipe") renderDetail();
    else if (S.view === "planner") renderPlannerView();
    else if (S.view === "shopping") renderShoppingView();
    else if (S.view === "collections") renderCollections();
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  function applyStoredTheme() {
    const saved = localStorage.getItem("cookbook_theme");
    const dark = saved ? saved === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }
  function toggleTheme() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    localStorage.setItem("cookbook_theme", dark ? "light" : "dark");
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function wireSettings() {
    $("#btnSaveSettings").onclick = async () => {
      Data.setCreds({
        pat: $("#setPat").value,
        base: $("#setBase").value,
        anthropic: $("#setKey").value,
      });
      Data.setUnitSystem($("#setSystem").value);
      $("#dlgSettings").close();
      await refresh();
    };

    $("#btnTest").onclick = async () => {
      const el = $("#connStatus");
      Data.setCreds({ pat: $("#setPat").value, base: $("#setBase").value });
      el.innerHTML = '<span class="spinner"></span> Checking…';
      try {
        await Data.testConnection();
        el.innerHTML = '<span style="color:var(--herb)">✓ Connected — all four tables found.</span>';
      } catch (e) {
        el.innerHTML = `<span style="color:var(--danger)">✕ ${escapeHtml(e.message)}</span>`;
      }
    };

    $("#btnImport").onclick = runImport;
  }

  // Bulk import from another recipe app's export, converted to app shape by
  // scripts/convert-flavorish.mjs. The file is read here in the browser and pushed straight to
  // Airtable through the normal Data layer, so the token stays where it already lives and no
  // third party ever sees either the recipes or the credentials.
  async function runImport() {
    const el = $("#importStatus");
    const file = $("#setImportFile").files[0];
    if (!file) { el.innerHTML = '<span style="color:var(--danger)">Choose a file first.</span>'; return; }
    if (!Data.hasCreds()) { el.innerHTML = '<span style="color:var(--danger)">Save your token and base id first.</span>'; return; }

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

    // One at a time, and with the photo as a follow-up call: Airtable fetches an attachment URL
    // itself, and a single dead image URL must not cost the recipe it belongs to.
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
    $("#setPat").value = c.pat;
    $("#setBase").value = c.base;
    $("#setKey").value = c.anthropic;
    $("#setSystem").value = Data.getUnitSystem();
    $("#connStatus").textContent = "";
    $("#dlgSettings").showModal();
  }

  // ---------------------------------------------------------------------------
  // Recipe grid
  // ---------------------------------------------------------------------------
  function wireRecipes() {
    $("#search").oninput = (e) => { S.search = e.target.value.toLowerCase(); renderGrid(); };
    $("#filterFav").onclick = (e) => {
      S.favOnly = !S.favOnly;
      e.currentTarget.setAttribute("aria-pressed", String(S.favOnly));
      renderGrid();
    };
    // Switching tabs while the app is open is fine to keep in memory (S.section), but it's
    // deliberately never written to localStorage — a reload or a fresh app-switch launch should
    // always land on Cookbook, not wherever you happened to leave off.
    $("#tabCookbook").onclick = () => { S.section = "cookbook"; renderGrid(); };
    $("#tabToTry").onclick = () => { S.section = "toTry"; renderGrid(); };
    $("#btnNew").onclick = () => openEditor(blankRecipe());
    $("#btnClip").onclick = openClip;
  }

  function visibleRecipes() {
    return S.recipes.filter((r) => {
      if (S.section === "cookbook" ? !r.tried : r.tried) return false;
      if (S.favOnly && !r.favourite) return false;
      if (S.collectionId && !(r.collectionIds || []).includes(S.collectionId)) return false;
      if (S.search) {
        // Ingredients are searched too, so "what can I do with haloumi" works.
        const hay = [
          r.name, r.description, (r.tags || []).join(" "),
          (r.ingredients || []).map((i) => i.item).join(" "),
        ].join(" ").toLowerCase();
        if (!hay.includes(S.search)) return false;
      }
      return true;
    });
  }

  function renderGrid() {
    renderCollectionChips();
    $("#tabCookbook").setAttribute("aria-pressed", String(S.section === "cookbook"));
    $("#tabToTry").setAttribute("aria-pressed", String(S.section === "toTry"));

    const list = visibleRecipes();
    const sectionTotal = S.recipes.filter((r) => (S.section === "cookbook" ? r.tried : !r.tried)).length;
    const grid = $("#recipeGrid");
    grid.innerHTML = "";

    $("#recipeCount").textContent = S.loaded
      ? `${sectionTotal} recipe${sectionTotal === 1 ? "" : "s"}${list.length !== sectionTotal ? ` · ${list.length} shown` : ""}`
      : "";

    $("#recipeEmpty").hidden = list.length > 0 || !S.loaded;
    if (S.loaded && !list.length) {
      if (S.section === "cookbook") {
        $("#recipeEmptyTitle").textContent = "Nothing tried yet";
        $("#recipeEmptyBody").textContent = "Recipes move here once you mark them as tried from the To Try list.";
      } else {
        $("#recipeEmptyTitle").textContent = "No recipes yet";
        $("#recipeEmptyBody").textContent = "Clip one from a website or photo, or write one in by hand.";
      }
    }
    if (!list.length) return;

    for (const r of list) {
      const card = document.createElement("div");
      card.className = "card";

      const open = document.createElement("button");
      open.style.cssText = "display:block;text-align:left;width:100%;";

      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (r.photoThumb) thumb.style.backgroundImage = `url("${cssUrl(r.photoThumb)}")`;
      else thumb.textContent = "🍽️";
      open.appendChild(thumb);

      const body = document.createElement("div");
      body.className = "body";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = r.name;
      body.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "meta";
      const bits = [];
      bits.push(`${r.servings} ${r.servingUnit}`);
      const total = (r.prepMinutes || 0) + (r.cookMinutes || 0);
      if (total) bits.push(`${total} min`);
      if (r.steps && r.steps.length) bits.push(`${r.steps.length} steps`);
      meta.textContent = bits.join(" · ");
      body.appendChild(meta);
      open.appendChild(body);

      open.onclick = () => openRecipe(r.id);
      card.appendChild(open);

      const star = document.createElement("button");
      star.className = "star";
      star.textContent = r.favourite ? "★" : "☆";
      star.setAttribute("aria-pressed", String(Boolean(r.favourite)));
      star.title = r.favourite ? "Remove from favourites" : "Add to favourites";
      star.onclick = async (e) => {
        e.stopPropagation();
        // Flip locally first so the star responds instantly; roll back if the write fails.
        const was = r.favourite;
        r.favourite = !was;
        renderGrid();
        try { await Data.setFavourite(r.id, r.favourite); }
        catch (err) { r.favourite = was; renderGrid(); toastError(err.message); }
      };
      card.appendChild(star);

      const tried = document.createElement("button");
      tried.className = "tried";
      tried.textContent = r.tried ? "✓" : "🔖";
      tried.setAttribute("aria-pressed", String(Boolean(r.tried)));
      tried.title = r.tried ? "Move back to To Try" : "Mark as tried (move to Cookbook)";
      tried.onclick = async (e) => {
        e.stopPropagation();
        const was = r.tried;
        r.tried = !was;
        renderGrid();
        try { await Data.setTried(r.id, r.tried); }
        catch (err) { r.tried = was; renderGrid(); toastError(err.message); }
      };
      card.appendChild(tried);

      grid.appendChild(card);
    }
  }

  function renderCollectionChips() {
    const el = $("#collectionChips");
    el.innerHTML = "";
    if (!S.collections.length) return;

    const all = document.createElement("button");
    all.className = "chip";
    all.textContent = "All";
    all.setAttribute("aria-pressed", String(!S.collectionId));
    all.onclick = () => { S.collectionId = null; renderGrid(); };
    el.appendChild(all);

    for (const c of S.collections) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = `${c.emoji ? c.emoji + " " : ""}${c.name}`;
      b.setAttribute("aria-pressed", String(S.collectionId === c.id));
      b.onclick = () => { S.collectionId = S.collectionId === c.id ? null : c.id; renderGrid(); };
      el.appendChild(b);
    }
  }

  // ---------------------------------------------------------------------------
  // Recipe detail — the servings stepper and per-step ingredients
  // ---------------------------------------------------------------------------
  function openRecipe(id) {
    S.openId = id;
    const r = S.recipesById[id];
    S.servings = r ? r.servings : 1;
    setView("recipe");
  }

  function renderDetail() {
    const r = S.recipesById[S.openId];
    const el = $("#recipeDetail");
    if (!r) { el.innerHTML = '<div class="empty"><h3>Recipe not found</h3></div>'; return; }

    const factor = (S.servings || r.servings) / (r.servings || 1);
    const scaled = Units.scaleIngredients(r.ingredients, factor);
    const byId = Object.fromEntries(scaled.map((i) => [i.id, i]));

    el.innerHTML = "";

    if (r.photoUrl) {
      const img = document.createElement("img");
      img.className = "hero";
      img.src = r.photoUrl;
      img.alt = "";
      el.appendChild(img);
    }

    const h1 = document.createElement("h1");
    h1.textContent = r.name;
    el.appendChild(h1);

    if (r.description) {
      const p = document.createElement("p");
      p.className = "lede";
      p.textContent = r.description;
      el.appendChild(p);
    }

    // Facts + actions
    const bar = document.createElement("div");
    bar.className = "factbar";
    const facts = [];
    if (r.prepMinutes) facts.push(`Prep <b>${r.prepMinutes} min</b>`);
    if (r.cookMinutes) facts.push(`Cook <b>${r.cookMinutes} min</b>`);
    if (r.sourceUrl) facts.push(`<a href="${escapeAttr(r.sourceUrl)}" target="_blank" rel="noopener">Source ↗</a>`);
    bar.innerHTML = facts.join("");
    const spacer = document.createElement("span");
    spacer.style.marginLeft = "auto";
    bar.appendChild(spacer);
    bar.appendChild(makeBtn("✏️ Edit", "btn ghost sm", () => openEditor(deepCopy(r))));
    bar.appendChild(makeBtn("👩‍🍳 Cook", "btn primary sm", () => openCookMode(r, factor)));
    el.appendChild(bar);

    // Servings stepper
    const sv = document.createElement("div");
    sv.className = "servings";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = "Makes";
    sv.appendChild(lbl);

    const stepper = document.createElement("div");
    stepper.className = "stepper";
    stepper.appendChild(makeBtn("−", "", () => setServings((S.servings || r.servings) - 1)));
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = `${S.servings} ${r.servingUnit}`;
    stepper.appendChild(val);
    stepper.appendChild(makeBtn("+", "", () => setServings((S.servings || r.servings) + 1)));
    sv.appendChild(stepper);

    if (S.servings !== r.servings) {
      const reset = makeBtn(`Reset to ${r.servings}`, "btn ghost sm reset", () => setServings(r.servings));
      sv.appendChild(reset);
      // Cooking times don't scale with quantity, so say so rather than let the numbers imply it.
      if (r.cookMinutes) {
        const warn = document.createElement("div");
        warn.style.cssText = "flex-basis:100%;font-size:12.5px;color:var(--ink-soft);";
        warn.textContent = "Amounts are scaled. Cooking times usually aren't — check as you go.";
        sv.appendChild(warn);
      }
    }
    el.appendChild(sv);

    // Ingredients, grouped if the recipe has sub-sections
    el.appendChild(makeH2("Ingredients"));
    const groups = groupBy(scaled, (i) => i.group || "");
    for (const [group, items] of groups) {
      if (group) el.appendChild(makeGroupHead(group));
      const ul = document.createElement("ul");
      ul.className = "inglist";
      for (const ing of items) {
        const li = document.createElement("li");
        const amt = document.createElement("span");
        amt.className = "amt";
        amt.textContent = amountText(ing);
        li.appendChild(amt);
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = ing.item;
        if (ing.note) {
          const nt = document.createElement("span");
          nt.className = "nt";
          nt.textContent = `, ${ing.note}`;
          nm.appendChild(nt);
        }
        li.appendChild(nm);
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }

    // Method — each step carries its own ingredients at the scaled amounts
    el.appendChild(makeH2("Method"));
    const stepGroups = groupBy(r.steps, (s) => s.group || "");
    for (const [group, steps] of stepGroups) {
      if (group) el.appendChild(makeGroupHead(group));
      const ol = document.createElement("ol");
      ol.className = "steps";
      for (const st of steps) {
        const li = document.createElement("li");
        const txt = document.createElement("div");
        txt.className = "txt";
        txt.textContent = st.text;
        li.appendChild(txt);
        const pills = stepIngredientPills(st, byId);
        if (pills) li.appendChild(pills);
        ol.appendChild(li);
      }
      el.appendChild(ol);
    }

    if (r.notes) {
      el.appendChild(makeH2("Notes"));
      const box = document.createElement("div");
      box.className = "notebox";
      box.textContent = r.notes;
      el.appendChild(box);
    }
  }

  // The feature the whole app is built around: the amounts for a step, shown at the step.
  function stepIngredientPills(step, byId) {
    const ids = step.ingredientIds || [];
    if (!ids.length) return null;
    const wrap = document.createElement("div");
    wrap.className = "stepings";
    for (const id of ids) {
      const ing = byId[id];
      if (!ing) continue;   // a stale id from a hand-edited JSON field shouldn't render an empty pill
      const pill = document.createElement("span");
      pill.className = "pill";
      const amt = amountText(ing);
      // The gap between amount and name is a text node, not CSS: the pill is inline-flex, so
      // trailing whitespace inside the <b> would be collapsed away and the two would run together.
      if (amt) { const b = document.createElement("b"); b.textContent = amt; pill.appendChild(b); }
      pill.appendChild(document.createTextNode(amt ? " " + ing.item : ing.item));
      wrap.appendChild(pill);
    }
    return wrap.children.length ? wrap : null;
  }

  function amountText(ing) {
    if (ing.qty == null) return ing.unit || "";
    const q = ing.qtyMax != null
      ? `${Units.formatQty(ing.qty)}–${Units.formatQty(ing.qtyMax)}`
      : Units.formatQty(ing.qty);
    const u = Units.pluraliseUnit(ing.unit, ing.qtyMax != null ? ing.qtyMax : ing.qty);
    return `${q}${u ? " " + u : ""}${ing.altText ? " / " + ing.altText : ""}`;
  }

  function setServings(n) {
    S.servings = Math.max(1, Math.round(n));
    renderDetail();
  }

  // ---------------------------------------------------------------------------
  // Cook mode
  // ---------------------------------------------------------------------------
  async function openCookMode(recipe, factor) {
    const scaled = Units.scaleIngredients(recipe.ingredients, factor);
    const byId = Object.fromEntries(scaled.map((i) => [i.id, i]));
    const steps = recipe.steps.length ? recipe.steps : [{ id: "s1", text: "No method recorded.", ingredientIds: [] }];
    let idx = 0;
    const done = new Set();

    const root = $("#cookRoot");
    const wrap = document.createElement("div");
    wrap.className = "cook";
    root.appendChild(wrap);

    function paint() {
      const st = steps[idx];
      wrap.innerHTML = "";

      const bar = document.createElement("div");
      bar.className = "bar";
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = recipe.name;
      bar.appendChild(nm);
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${idx + 1} / ${steps.length}`;
      bar.appendChild(count);
      bar.appendChild(makeBtn("✕", "btn ghost sm", close));
      wrap.appendChild(bar);

      const stage = document.createElement("div");
      stage.className = "stage";
      const no = document.createElement("div");
      no.className = "stepno";
      no.textContent = st.group ? `${st.group} · Step ${idx + 1}` : `Step ${idx + 1}`;
      stage.appendChild(no);
      const txt = document.createElement("div");
      txt.className = "txt";
      txt.textContent = st.text;
      stage.appendChild(txt);
      const pills = stepIngredientPills(st, byId);
      if (pills) stage.appendChild(pills);

      const tick = document.createElement("label");
      tick.className = "tick";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = done.has(idx);
      box.onchange = () => { box.checked ? done.add(idx) : done.delete(idx); };
      tick.appendChild(box);
      tick.appendChild(document.createTextNode("Done"));
      stage.appendChild(tick);
      wrap.appendChild(stage);

      const nav = document.createElement("div");
      nav.className = "nav";
      const prev = makeBtn("← Back", "btn", () => { if (idx > 0) { idx--; paint(); } });
      prev.disabled = idx === 0;
      nav.appendChild(prev);
      if (idx < steps.length - 1) {
        nav.appendChild(makeBtn("Next →", "btn primary", () => { done.add(idx); idx++; paint(); }));
      } else {
        nav.appendChild(makeBtn("Finish", "btn primary", close));
      }
      wrap.appendChild(nav);
    }

    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" && idx < steps.length - 1) { idx++; paint(); }
      else if (e.key === "ArrowLeft" && idx > 0) { idx--; paint(); }
    }

    function close() {
      document.removeEventListener("keydown", onKey);
      wrap.remove();
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
        hint.style.cssText = "font-size:12.5px;color:var(--ink-faint)";
        hint.textContent = "Add ingredients above to link them to this step.";
        pick.appendChild(hint);
      }
      for (const ing of S.editing.ingredients) {
        if (!ing.item) continue;
        const on = (st.ingredientIds || []).includes(ing.id);
        const b = document.createElement("button");
        b.className = "opt";
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
      el.innerHTML = '<span style="font-size:13px;color:var(--ink-faint)">No collections yet — make one on the Collections tab.</span>';
      return;
    }
    for (const c of S.collections) {
      const on = (S.editing.collectionIds || []).includes(c.id);
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = `${c.emoji ? c.emoji + " " : ""}${c.name}`;
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
      // Every clip lands in the editor for review — nothing reaches Airtable until Save is pressed.
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
  // Planner
  // ---------------------------------------------------------------------------
  function wirePlanner() {
    $("#weekPrev").onclick = () => { S.monday = Plan.addDays(S.monday, -7); loadWeek(); };
    $("#weekNext").onclick = () => { S.monday = Plan.addDays(S.monday, 7); loadWeek(); };
    $("#weekToday").onclick = () => { S.monday = Plan.mondayOf(new Date()); loadWeek(); };
    $("#btnMakeList").onclick = makeShoppingList;
    $("#btnAddMeal").onclick = confirmAddMeal;
  }

  async function loadWeek() {
    $("#weekLabel").textContent = Plan.formatWeekLabel(S.monday);
    try {
      S.week = await Data.loadWeek(Plan.isoDate(S.monday));
      renderPlannerView();
    } catch (e) { toastError(e.message); }
  }

  function renderPlannerView() {
    $("#weekLabel").textContent = Plan.formatWeekLabel(S.monday);
    if (!S.week || S.week.weekStarting !== Plan.isoDate(S.monday)) { loadWeek(); return; }
    Plan.renderPlanner($("#plannerGrid"), {
      week: S.week,
      recipesById: S.recipesById,
      onOpen: openRecipe,
      onAdd: promptAddMeal,
      onRemove: async (dayKey, meal, entry) => {
        const arr = (S.week.plan[dayKey] || {})[meal] || [];
        const at = arr.indexOf(entry);
        if (at >= 0) arr.splice(at, 1);
        renderPlannerView();
        try { S.week = await Data.saveWeek(S.week); }
        catch (e) { toastError(e.message); }
      },
    });
  }

  let pendingSlot = null;
  function promptAddMeal(dayKey, meal) {
    if (!S.recipes.length) { toastError("Add a recipe first."); return; }
    pendingSlot = { dayKey, meal };
    const sel = $("#mealRecipe");
    sel.innerHTML = "";
    for (const r of S.recipes) {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = r.name;
      sel.appendChild(o);
    }
    sel.onchange = () => { $("#mealServings").value = S.recipesById[sel.value].servings; };
    $("#mealServings").value = S.recipes[0].servings;
    $("#addMealTitle").textContent = `Add ${meal.toLowerCase()}`;
    $("#dlgAddMeal").showModal();
  }

  async function confirmAddMeal() {
    const { dayKey, meal } = pendingSlot || {};
    if (!dayKey) return;
    const recipeId = $("#mealRecipe").value;
    const servings = Math.max(1, parseInt($("#mealServings").value, 10) || 1);

    S.week.plan[dayKey] = S.week.plan[dayKey] || {};
    S.week.plan[dayKey][meal] = S.week.plan[dayKey][meal] || [];
    S.week.plan[dayKey][meal].push({ recipeId, servings });

    $("#dlgAddMeal").close();
    renderPlannerView();
    try { S.week = await Data.saveWeek(S.week); }
    catch (e) { toastError(e.message); }
  }

  // ---------------------------------------------------------------------------
  // Shopping
  // ---------------------------------------------------------------------------
  function wireShopping() {
    $("#btnAddItem").onclick = addManualItem;
    $("#manualItem").onkeydown = (e) => { if (e.key === "Enter") addManualItem(); };
    $("#btnClearChecked").onclick = async () => {
      if (!S.list) return;
      S.list.items = S.list.items.filter((i) => !i.checked);
      renderShoppingView();
      await saveList();
    };
  }

  async function makeShoppingList() {
    if (!S.week) return;
    const meals = Plan.mealsForWeek(S.week, S.recipesById);
    if (!meals.length) { toastError("No meals planned for this week yet."); return; }

    const items = Units.buildShoppingList(meals);
    // Manual additions survive a regenerate — they're things the plan doesn't know about (milk,
    // bin bags) and losing them every time the list was rebuilt would make the feature useless.
    const keep = S.list && S.list.weekStarting === S.week.weekStarting
      ? S.list.items.filter((i) => i.manual)
      : [];

    S.list = {
      id: S.list && S.list.weekStarting === S.week.weekStarting ? S.list.id : null,
      name: `Week of ${Plan.formatWeekLabel(S.monday)}`,
      weekStarting: S.week.weekStarting,
      items: items.concat(keep),
      done: false,
    };
    try {
      S.list = await Data.saveShoppingList(S.list);
      setView("shopping");
      toast(`${items.length} items from ${meals.length} meals`);
    } catch (e) { toastError(e.message); }
  }

  async function renderShoppingView() {
    if (!S.list) {
      try {
        const lists = await Data.loadShoppingLists();
        S.list = lists.find((l) => !l.done) || lists[lists.length - 1] || null;
      } catch (e) { toastError(e.message); }
    }
    $("#shoppingSub").textContent = S.list
      ? `${S.list.items.filter((i) => !i.checked).length} left · ${S.list.name}`
      : "";
    Plan.renderShopping($("#shoppingList"), {
      list: S.list,
      onToggle: async (item, checked) => {
        item.checked = checked;
        renderShoppingView();
        await saveList();
      },
      onRemove: async (item) => {
        S.list.items = S.list.items.filter((i) => i !== item);
        renderShoppingView();
        await saveList();
      },
    });
  }

  async function addManualItem() {
    const input = $("#manualItem");
    const text = input.value.trim();
    if (!text) return;
    if (!S.list) {
      S.list = { id: null, name: "Shopping list", weekStarting: "", items: [], done: false };
    }
    const parsed = Units.parseIngredient(text);
    S.list.items.push({
      id: "x" + Math.random().toString(36).slice(2, 9),
      name: parsed.item || text,
      qty: parsed.qty, unit: parsed.unit,
      aisle: Units.aisleFor(parsed.item || text),
      checked: false, manual: true, fromRecipes: [],
    });
    input.value = "";
    renderShoppingView();
    await saveList();
  }

  // Writes are fire-and-forget from the UI's point of view — the local state has already been
  // repainted, so a failed save shows an error but never leaves a half-updated screen.
  async function saveList() {
    if (!S.list) return;
    try { S.list = await Data.saveShoppingList(S.list); }
    catch (e) { toastError(e.message); }
  }

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------
  function wireCollections() {
    $("#btnNewCollection").onclick = async () => {
      const name = prompt("Collection name (e.g. Weeknight dinners):");
      if (!name) return;
      const emoji = prompt("An emoji for it? (optional)") || "";
      try {
        await Data.createCollection(name.trim(), emoji.trim(), S.collections.length);
        await refresh();
        toast("Collection created");
      } catch (e) { toastError(e.message); }
    };
  }

  function renderCollections() {
    const el = $("#collectionGrid");
    el.innerHTML = "";
    if (!S.collections.length) {
      el.innerHTML = `<div class="empty" style="grid-column:1/-1">
        <div class="mark">🗂️</div><h3>No collections yet</h3>
        <p>Collections are just groups — “Weeknight dinners”, “Baking”, “Mum's recipes”.</p></div>`;
      return;
    }
    for (const c of S.collections) {
      const count = S.recipes.filter((r) => (r.collectionIds || []).includes(c.id)).length;
      const card = document.createElement("button");
      card.className = "card";
      card.style.padding = "20px 18px";
      card.innerHTML = `
        <div style="font-size:30px;margin-bottom:8px">${escapeHtml(c.emoji || "🗂️")}</div>
        <div class="title" style="margin-bottom:3px">${escapeHtml(c.name)}</div>
        <div class="meta">${count} recipe${count === 1 ? "" : "s"}</div>`;
      card.onclick = () => { S.collectionId = c.id; setView("recipes"); };
      el.appendChild(card);
    }
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function makeBtn(label, cls, onclick) {
    const b = document.createElement("button");
    if (cls) b.className = cls;
    b.textContent = label;
    b.onclick = onclick;
    return b;
  }
  function makeH2(text) { const h = document.createElement("h2"); h.textContent = text; return h; }
  function makeGroupHead(text) { const d = document.createElement("div"); d.className = "grouphead"; d.textContent = text; return d; }

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
  // Quotes and backslashes would otherwise break out of the url("…") wrapper in a style attribute.
  function cssUrl(s) { return String(s || "").replace(/["\\]/g, "\\$&"); }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    clearToast();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    t.id = "toast";
    document.body.appendChild(t);
    if (ms) toastTimer = setTimeout(clearToast, ms);
  }
  function toastError(msg) {
    clearToast();
    const t = document.createElement("div");
    t.className = "toast err";
    t.textContent = msg;
    t.id = "toast";
    document.body.appendChild(t);
    toastTimer = setTimeout(clearToast, 6000);
  }
  function clearToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    const old = document.getElementById("toast");
    if (old) old.remove();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
