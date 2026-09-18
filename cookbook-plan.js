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
    el.className = "planner";

    for (const [i, date] of weekDates(monday).entries()) {
      const key = isoDate(date);
      const dayPlan = week.plan[key] || {};
      const isToday = key === today;

      // A week is a ruled list, not seven bordered cards: the day sits in the left
      // margin like a running head, its meals set beside it.
      const day = document.createElement("section");
      day.className = isToday ? "pday today" : "pday";

      const head = document.createElement("div");
      head.className = "pday-head";
      head.innerHTML = `
        <div class="nm">${DAY_NAMES[i]}</div>
        <div class="dt">${date.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</div>
        ${isToday ? '<div class="now">Today</div>' : ""}`;
      day.appendChild(head);

      const body = document.createElement("div");
      body.className = "pday-body";

      for (const meal of MEALS) {
        const entries = dayPlan[meal] || [];
        const row = document.createElement("div");
        row.className = "pmeal";

        const label = document.createElement("div");
        label.textContent = meal;
        label.className = "lbl";
        row.appendChild(label);

        const slots = document.createElement("div");
        slots.className = "slots";

        for (const entry of entries) {
          const recipe = recipesById[entry.recipeId];
          const item = document.createElement("span");
          item.className = "pmeal-item";

          const nameBtn = document.createElement("button");
          nameBtn.textContent = recipe ? recipe.name : "(deleted recipe)";
          nameBtn.className = "nm";
          if (recipe) nameBtn.onclick = () => onOpen(recipe.id);
          item.appendChild(nameBtn);

          const serves = document.createElement("span");
          serves.textContent = `\u00D7${entry.servings}`;
          serves.className = "sv";
          item.appendChild(serves);

          const x = document.createElement("button");
          x.textContent = "\u2715";
          x.title = "Remove";
          x.setAttribute("aria-label", `Remove ${recipe ? recipe.name : "meal"}`);
          x.className = "rm";
          x.onclick = () => onRemove(key, meal, entry);
          item.appendChild(x);

          slots.appendChild(item);
        }

        const add = document.createElement("button");
        add.textContent = entries.length ? "Add another" : "Add";
        add.title = `Add a ${meal.toLowerCase()}`;
        add.className = "padd";
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
        <div class="mark">&mdash;</div>
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
      ul.className = "inglist shoplist";

      for (const item of items) {
        const li = document.createElement("li");
        if (item.checked) li.className = "done";

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = Boolean(item.checked);
        box.className = "tickbox";
        box.onchange = () => onToggle(item, box.checked);
        li.appendChild(box);

        // You buy "plain flour", not "2½ cups plain flour" — the item is the thing you're looking
        // for on the shelf; the tallied amount is just a reminder of how much, so it trails in
        // parentheses rather than leading the line.
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = item.name;
        li.appendChild(nm);

        if (item.qty != null) {
          const qtyText = `${Units.formatQty(item.qty)} ${Units.pluraliseUnit(item.unit, item.qty)}`.trim();
          const amt = document.createElement("span");
          amt.className = "qty";
          amt.textContent = `(${qtyText})`;
          li.appendChild(amt);
        }

        const x = document.createElement("button");
        x.textContent = "\u2715";
        x.title = "Remove";
        x.setAttribute("aria-label", `Remove ${item.name}`);
        x.className = "rm";
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
