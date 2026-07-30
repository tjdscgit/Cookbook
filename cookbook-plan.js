// cookbook-plan.js
// Weekly planner and shopping list rendering.
//
// Both are pure render-from-state functions: they take data plus callbacks and paint an element.
// They never fetch, never save, and never reach into the app's state — cookbook-ui.js owns all of
// that. Keeping it one-directional means the planner can be re-rendered after any change without
// worrying about what else it might have touched.
(function (root, factory) {
  root.CookbookPlan = factory(root.CookbookUnits);
})(typeof self !== "undefined" ? self : this, function (Units) {
  "use strict";

  const MEALS = ["Breakfast", "Lunch", "Dinner"];
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  // --- date helpers -----------------------------------------------------------
  // Weeks start Monday. Dates are handled as local-time YYYY-MM-DD strings throughout: using an
  // ISO timestamp would shift the day boundary for anyone east of UTC, which in Australia means
  // every meal lands on the wrong day.
  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function mondayOf(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const dow = (d.getDay() + 6) % 7;   // Sunday(0) becomes 6
    d.setDate(d.getDate() - dow);
    return d;
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function weekDates(monday) {
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }

  function formatWeekLabel(monday) {
    const end = addDays(monday, 6);
    const opts = { day: "numeric", month: "short" };
    const a = monday.toLocaleDateString("en-AU", opts);
    const b = end.toLocaleDateString("en-AU", { ...opts, year: "numeric" });
    return `${a} – ${b}`;
  }

  // --- planner ----------------------------------------------------------------
  // `week.plan` is { "2026-07-28": { Dinner: [{recipeId, servings}] } }.
  function renderPlanner(el, opts) {
    const { week, recipesById, onAdd, onRemove, onOpen } = opts;
    const monday = new Date(week.weekStarting + "T00:00:00");
    const today = isoDate(new Date());
    el.innerHTML = "";

    for (const [i, date] of weekDates(monday).entries()) {
      const key = isoDate(date);
      const dayPlan = week.plan[key] || {};
      const isToday = key === today;

      const day = document.createElement("section");
      day.style.cssText = `
        border:1px solid var(--line); border-radius:var(--r); background:var(--card);
        margin-bottom:12px; overflow:hidden;
        ${isToday ? "border-color:var(--clay-soft); box-shadow:0 0 0 2px var(--clay-wash);" : ""}`;

      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:baseline;gap:9px;padding:11px 15px;border-bottom:1px solid var(--line-soft);";
      head.innerHTML = `
        <b style="font-family:var(--serif);font-size:16px">${DAY_NAMES[i]}</b>
        <span style="color:var(--ink-faint);font-size:13px">${date.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span>
        ${isToday ? '<span style="margin-left:auto;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--clay)">Today</span>' : ""}`;
      day.appendChild(head);

      const body = document.createElement("div");
      body.style.cssText = "padding:9px 15px 13px;";

      for (const meal of MEALS) {
        const entries = dayPlan[meal] || [];
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:flex-start;gap:11px;padding:6px 0;";

        const label = document.createElement("div");
        label.textContent = meal;
        label.style.cssText = "flex:0 0 82px;font-size:12.5px;font-weight:600;color:var(--ink-faint);padding-top:5px;";
        row.appendChild(label);

        const slots = document.createElement("div");
        slots.style.cssText = "flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;";

        for (const entry of entries) {
          const recipe = recipesById[entry.recipeId];
          const pill = document.createElement("span");
          pill.style.cssText = `display:inline-flex;align-items:center;gap:7px;background:var(--clay-wash);
            border:1px solid var(--clay-soft);border-radius:999px;padding:4px 6px 4px 12px;font-size:13.5px;`;

          const nameBtn = document.createElement("button");
          nameBtn.textContent = recipe ? recipe.name : "(deleted recipe)";
          nameBtn.style.cssText = "color:var(--clay);font-weight:500;text-align:left;";
          if (recipe) nameBtn.onclick = () => onOpen(recipe.id);
          pill.appendChild(nameBtn);

          const serves = document.createElement("span");
          serves.textContent = `×${entry.servings}`;
          serves.style.cssText = "color:var(--ink-faint);font-size:12px;font-variant-numeric:tabular-nums;";
          pill.appendChild(serves);

          const x = document.createElement("button");
          x.textContent = "✕";
          x.title = "Remove";
          x.style.cssText = "color:var(--ink-faint);font-size:12px;padding:2px 4px;";
          x.onclick = () => onRemove(key, meal, entry);
          pill.appendChild(x);

          slots.appendChild(pill);
        }

        const add = document.createElement("button");
        add.textContent = "＋";
        add.title = `Add a ${meal.toLowerCase()}`;
        add.style.cssText = `width:26px;height:26px;border-radius:50%;border:1px dashed var(--line);
          color:var(--ink-faint);font-size:14px;line-height:1;`;
        add.onclick = () => onAdd(key, meal);
        slots.appendChild(add);

        row.appendChild(slots);
        body.appendChild(row);
      }

      day.appendChild(body);
      el.appendChild(day);
    }
  }

  // Flattens a week's plan into the [{recipe, servings}] shape the shopping-list builder wants.
  function mealsForWeek(week, recipesById) {
    const out = [];
    for (const dayKey in week.plan || {}) {
      for (const meal in week.plan[dayKey]) {
        for (const entry of week.plan[dayKey][meal] || []) {
          const recipe = recipesById[entry.recipeId];
          if (recipe) out.push({ recipe, servings: entry.servings });
        }
      }
    }
    return out;
  }

  // --- shopping list ----------------------------------------------------------
  function renderShopping(el, opts) {
    const { list, onToggle, onRemove } = opts;
    el.innerHTML = "";

    if (!list || !list.items || !list.items.length) {
      el.innerHTML = `<div class="empty">
        <div class="mark">🛒</div>
        <h3>Nothing on the list</h3>
        <p>Plan some meals for the week, then use “Make shopping list” — or add items by hand above.</p>
      </div>`;
      return;
    }

    // Group by aisle so the list follows the shape of a supermarket rather than the order the
    // recipes happened to be planned in.
    const byAisle = new Map();
    for (const item of list.items) {
      const a = item.aisle || "Other";
      if (!byAisle.has(a)) byAisle.set(a, []);
      byAisle.get(a).push(item);
    }
    const AISLE_ORDER = ["Produce", "Meat & Fish", "Dairy & Eggs", "Bakery", "Baking", "Pantry", "Frozen", "Other"];
    const aisles = [...byAisle.keys()].sort((a, b) => {
      const ia = AISLE_ORDER.indexOf(a), ib = AISLE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    for (const aisle of aisles) {
      const items = byAisle.get(aisle);
      const head = document.createElement("div");
      head.className = "grouphead";
      head.textContent = aisle;
      el.appendChild(head);

      const ul = document.createElement("ul");
      ul.className = "inglist";
      ul.style.marginBottom = "14px";

      for (const item of items) {
        const li = document.createElement("li");
        li.style.alignItems = "center";
        if (item.checked) li.style.opacity = ".45";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = Boolean(item.checked);
        box.style.cssText = "width:19px;height:19px;accent-color:var(--clay);flex:0 0 auto;";
        box.onchange = () => onToggle(item, box.checked);
        li.appendChild(box);

        // You buy "plain flour", not "2½ cups plain flour" — the item is the thing you're looking
        // for on the shelf; the tallied amount is just a reminder of how much, so it trails in
        // parentheses rather than leading the line.
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = item.name;
        if (item.checked) nm.style.textDecoration = "line-through";
        li.appendChild(nm);

        if (item.qty != null) {
          const qtyText = `${Units.formatQty(item.qty)} ${Units.pluraliseUnit(item.unit, item.qty)}`.trim();
          const amt = document.createElement("span");
          amt.style.cssText = "font-style:italic;font-weight:400;color:var(--ink-faint);font-size:13px;flex:0 0 auto;";
          amt.textContent = `(${qtyText})`;
          li.appendChild(amt);
        }

        const x = document.createElement("button");
        x.textContent = "✕";
        x.title = "Remove";
        x.style.cssText = "color:var(--ink-faint);font-size:13px;padding:2px 6px;flex:0 0 auto;";
        x.onclick = () => onRemove(item);
        li.appendChild(x);

        ul.appendChild(li);
      }
      el.appendChild(ul);
    }
  }

  return {
    MEALS, DAY_NAMES,
    isoDate, mondayOf, addDays, weekDates, formatWeekLabel,
    renderPlanner, mealsForWeek, renderShopping,
  };
});
