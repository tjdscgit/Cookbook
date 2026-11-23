// cookbook-plan.js
// Plan (#pl) and Shop (#sh) markup, ported from design/cookbook-redesign.html.
//
// Pure render-from-state: every function here takes data and returns an HTML string. Nothing here
// fetches, saves, or reaches into the app's state — cookbook-ui.js owns all of that and wires the
// data-* attributes these strings carry. Keeping it one-directional means either screen can be
// repainted after any change without worrying about what else it might have touched.
(function (root, factory) {
  root.CookbookPlan = factory(root.CookbookUnits);
})(typeof self !== "undefined" ? self : this, function (Units) {
  "use strict";

  const MEALS = ["Breakfast", "Lunch", "Dinner"];
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // Fixed rather than toLocaleDateString: en-AU writes September as "Sept", and these labels
  // shouldn't change shape from one month to the next.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const AISLE_ORDER = ["Produce", "Meat & Fish", "Dairy & Eggs", "Bakery", "Baking", "Pantry", "Frozen", "Other"];
  // "Any day" lives beside the date keys in a week's plan map: plan.any.Dinner = [...] (Part H.1).
  const ANY = "any";

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

  // "16–22 Nov", or "30 Nov – 6 Dec" across a month boundary.
  function rangeText(monday) {
    const end = addDays(monday, 6);
    return monday.getMonth() === end.getMonth()
      ? `${monday.getDate()}–${end.getDate()} ${MONTHS[end.getMonth()]}`
      : `${monday.getDate()} ${MONTHS[monday.getMonth()]} – ${end.getDate()} ${MONTHS[end.getMonth()]}`;
  }

  // "This week · 16–22 Nov", "Next week · …", "Last week · …", else just the dates.
  function weekLabel(monday, thisMonday) {
    const weeks = Math.round((mondayOf(monday) - mondayOf(thisMonday)) / (7 * 864e5));
    const name = { 0: "This week", 1: "Next week", "-1": "Last week" }[weeks];
    return name ? `${name} · ${rangeText(monday)}` : rangeText(monday);
  }

  function dayInfo(d) {
    const i = (d.getDay() + 6) % 7;
    return { iso: isoDate(d), long: DAY_NAMES[i], short: DAY_SHORT[i], date: `${d.getDate()} ${MONTHS[d.getMonth()]}` };
  }

  // --- small shared bits ------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const totalMins = (r) => (r.prepMinutes || 0) + (r.cookMinutes || 0);
  const timeLabel = (m) => !m ? "" : m < 60 ? `${m} min` : (m % 60 ? `${Math.floor(m / 60)} hr ${m % 60}` : `${m / 60} hr`);
  const stepper = (val, key) => `<div class="stp"><button data-${key}="-1" aria-label="Fewer">−</button><b>${val}</b><button data-${key}="1" aria-label="More">+</button></div>`;

  // Meal keys of one day in display order: Breakfast, Lunch, Dinner, then anything hand-added in
  // the console, so no stored entry is ever hidden.
  function mealKeys(dayPlan) {
    return MEALS.concat(Object.keys(dayPlan || {}).filter((k) => !MEALS.includes(k)));
  }

  // Every planned entry of a day (or "any"), each with a reference "key|meal|index".
  function dayEntries(plan, key) {
    const dp = (plan || {})[key] || {};
    const out = [];
    for (const meal of mealKeys(dp)) {
      (Array.isArray(dp[meal]) ? dp[meal] : []).forEach((entry, i) => out.push({ key, meal, i, entry, ref: `${key}|${meal}|${i}` }));
    }
    return out;
  }

  // The week's entries: Monday..Sunday, then Any day.
  function weekEntries(week, monday) {
    const keys = weekDates(monday).map(isoDate).concat(ANY);
    return [].concat(...keys.map((k) => dayEntries(week && week.plan, k)));
  }

  // --- planner ----------------------------------------------------------------
  function mealRow(e, recipesById, phInner) {
    const r = recipesById[e.entry.recipeId];
    const cooked = Boolean(e.entry.cooked);
    const bits = [];
    if (r) { const n = (r.ingredients || []).length; bits.push(`${n} ingredient${n === 1 ? "" : "s"}`); }
    const t = r ? timeLabel(totalMins(r)) : "";
    if (t) bits.push(t);
    bits.push(`serves ${esc(e.entry.servings)}`);
    const ref = esc(e.ref);
    return `<div class="meal ${cooked ? "cooked" : ""}"><button class="ck ${cooked ? "on" : ""}" data-cooked="${ref}" aria-label="Cooked">✓</button>`
      + `<div class="ph" data-openr="${ref}">${phInner(r || { name: "" })}</div>`
      + `<button class="openr" data-openr="${ref}"><div class="mn">${esc(r ? r.name : "(deleted recipe)")}</div><div class="mm">${e.meal !== "Dinner" ? `<i>${esc(e.meal)}</i> · ` : ""}${bits.join(" · ")}</div></button>`
      + `<button class="more" data-mmore="${ref}" aria-label="More">⋯</button></div>`;
  }

  // o: { week, monday, thisMonday, today (iso), recipesById, phInner, card: {added, total} }
  function plannerHtml(o) {
    const plan = (o.week && o.week.plan) || {};
    const pastWeek = isoDate(o.monday) < isoDate(o.thisMonday);
    let days = "";
    for (const d of weekDates(o.monday).map(dayInfo)) {
      const es = dayEntries(plan, d.iso);
      days += `<section class="day ${d.iso < o.today ? "past" : ""}"><div class="dh"><span class="dn">${d.long}<small>${d.date}</small>${d.iso === o.today ? '<span class="today">Today</span>' : ""}</span><button class="addb" data-addday="${d.iso}" aria-label="Add to ${d.long}">+</button></div>`
        + (es.length ? es.map((e) => mealRow(e, o.recipesById, o.phInner)).join("") : '<div class="nothing">Nothing planned</div>') + "</section>";
    }
    const anyEs = dayEntries(plan, ANY);
    days += `<section class="day ${pastWeek ? "past" : ""}"><div class="dh"><span class="dn">Any day<small>this week</small></span><button class="addb" data-addday="${ANY}" aria-label="Add to any day">+</button></div>`
      + (anyEs.length ? anyEs.map((e) => mealRow(e, o.recipesById, o.phInner)).join("") : '<div class="nothing">Nothing here</div>') + "</section>";

    const c = o.card;
    const all = c && c.added === c.total;
    const card = c && c.total ? `<div class="shopcard"><div><b>Shopping list</b><small>${all ? `All ${c.total} meals added` : `${c.added} of ${c.total} meals added`}</small></div><button data-upd>${all ? "Open" : "Update"}</button></div>` : "";

    return `<div class="top"><h1 class="h1">Plan</h1></div>
      <div class="wk"><button data-wk="-1" aria-label="Previous week">‹</button><span>${esc(weekLabel(o.monday, o.thisMonday))}</span><button data-wk="1" aria-label="Next week">›</button></div>
      ${card}${days}<div class="plspace"></div>`;
  }

  // Day buttons for the "Add to plan" and "Move to" sheets: Mon..Sun, then Any day.
  function dayChipsHtml(monday, onKey, attr) {
    return `<div class="daychips">${weekDates(monday).map(dayInfo).map((d) => `<button class="dchip ${d.iso === onKey ? "on" : ""}" ${attr}="${d.iso}">${d.short}<small>${d.date}</small></button>`).join("")}<button class="dchip ${onKey === ANY ? "on" : ""}" ${attr}="${ANY}">Any day<small>this week</small></button></div>`;
  }

  // The "⋯" sheet on a planned meal. o: { recipe, entry, key, monday }
  function mealMenuHtml(o) {
    return `<div class="sh-h"><h3>${esc(o.recipe ? o.recipe.name : "(deleted recipe)")}</h3><button class="ib" data-x aria-label="Close">✕</button></div><div class="sh-b">
      ${o.recipe ? `<button class="mitem" data-openr>Open recipe<small>At ${esc(o.entry.servings)} servings</small></button>` : ""}
      <div class="lbl" style="margin-top:14px">Move to</div>${dayChipsHtml(o.monday, o.key, "data-mv")}
      <button class="mitem danger" data-rm>Remove from plan</button></div>`;
  }

  // The Add sheet (+ on a day). o: { key, meal, q, f, recipes, picked, sv, phInner }
  function pickHtml(o) {
    const d = o.key === ANY ? null : dayInfo(new Date(o.key + "T00:00:00"));
    const rows = o.recipes.map((r) => `<button class="prow" data-pr="${esc(r.id)}"><div class="ph">${o.phInner(r)}</div><span><b>${esc(r.name)}</b><small>${timeLabel(totalMins(r)) || "No time set"} · serves ${esc(r.servings)}</small></span><span class="ck ${o.picked === r.id ? "on" : ""}">✓</span></button>`).join("");
    return `<div class="sh-h"><h3>Add ${o.meal.toLowerCase()} · ${d ? `${d.short} ${d.date}` : "Any day"}</h3><button class="ib" data-x aria-label="Close">✕</button></div>
      <div class="sh-b"><input class="search pq" type="search" placeholder="Search recipes" value="${esc(o.q)}" data-pq aria-label="Search recipes" autocomplete="off">
        <div class="minichips">${["Faves", "To try", "All"].map((c) => `<button class="chip ${o.f === c ? "on" : ""}" data-pf="${c}">${c}</button>`).join("")}</div>
        <div class="plist">${rows || '<p class="nothing">No matches</p>'}</div></div>
      <div class="sh-f"><div class="mseg">${["Dinner", "Lunch", "Breakfast"].map((m) => `<button class="${o.meal === m ? "on" : ""}" data-pm="${m}">${m}</button>`).join("")}</div>
        <div class="fline"><span class="k">Serves</span>${stepper(o.sv, "ps")}</div>
        <button class="btn" data-padd2 ${o.picked ? "" : "disabled"}>Add to ${d ? d.long : "Any day"}</button></div>`;
  }

  // Flattens a week's plan into the [{recipe, servings}] shape the shopping-list builder wants.
  // Walks every key of the plan, so "Any day" meals (plan.any) are included with the dated ones.
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
  // A hand-added line, or one with no recipe behind it, belongs to "Added by you".
  const byYou = (it) => Boolean(it.manual) || !(it.fromRecipes || []).length;

  function amountOf(it) {
    if (it.qty == null) return it.unit || "";
    return `${Units.formatQty(it.qty)} ${Units.pluraliseUnit(it.unit, it.qty)}`.trim();
  }

  // o: { list, view: "aisle"|"recipe", open (trolley), recipesById, phInner, subline, draft }
  function shoppingHtml(o) {
    const rows = ((o.list && o.list.items) || []).map((it, i) => ({ it, i }));
    const open = rows.filter((x) => !x.it.checked), done = rows.filter((x) => x.it.checked);

    const fromTxt = (it) => byYou(it) ? "Added by you"
      : it.fromRecipes.map((id) => o.recipesById[id] && o.recipesById[id].name).filter(Boolean).join(" · ");
    const irow = ({ it, i }) => {
      const a = amountOf(it), from = o.view === "aisle" ? fromTxt(it) : "";
      return `<button class="irow ${it.checked ? "done" : ""}" data-it="${i}"><span class="ck">✓</span><span class="it">${a ? `<b>${esc(a)}</b> ` : ""}${esc(it.name)}${from ? `<small>${esc(from)}</small>` : ""}</span></button>`;
    };

    let list = "";
    if (o.view === "aisle") {
      const aisles = [...new Set(open.map((x) => x.it.aisle || "Other"))].sort((a, b) => {
        const ia = AISLE_ORDER.indexOf(a), ib = AISLE_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      for (const a of aisles) list += `<div class="grp lbl">${esc(a)}</div>${open.filter((x) => (x.it.aisle || "Other") === a).map(irow).join("")}`;
    } else {
      // Recipes in the order they first appear on the list; an item for two recipes shows under
      // both, sharing one tick because both rows point at the same item.
      const ids = [];
      for (const x of open) if (!byYou(x.it)) for (const id of x.it.fromRecipes) if (!ids.includes(id)) ids.push(id);
      for (const id of ids) {
        const its = open.filter((x) => !byYou(x.it) && x.it.fromRecipes.includes(id));
        const r = o.recipesById[id] || { name: "(deleted recipe)" };
        list += `<div class="rhead"><div class="ph">${o.phInner(r)}</div><b>${esc(r.name)}</b><small>${its.length} item${its.length === 1 ? "" : "s"}</small></div>${its.map(irow).join("")}`;
      }
      const man = open.filter((x) => byYou(x.it));
      if (man.length) list += `<div class="grp lbl">Added by you</div>${man.map(irow).join("")}`;
    }
    if (!open.length) list = '<p class="nothing shempty">Everything’s in the trolley.</p>';

    return `<div class="top"><h1 class="h1">Shopping</h1><button class="ib" data-shmore aria-label="More">⋯</button></div>
      <div class="subline">${esc(o.subline)}</div>
      <form class="addrow" data-addform><input placeholder="Add an item" aria-label="Add an item" autocomplete="off" value="${esc(o.draft || "")}"><button type="submit">Add</button></form>
      <div class="seg flat"><button class="${o.view === "aisle" ? "on" : ""}" data-shview="aisle">By aisle</button><button class="${o.view === "recipe" ? "on" : ""}" data-shview="recipe">By recipe</button></div>
      ${list}
      ${done.length ? `<button class="trolley ${o.open ? "open" : ""}" data-trolley><span>In the trolley · ${done.length}</span><i>›</i></button>${o.open ? done.map(irow).join("") : ""}` : ""}
      <div class="shspace"></div>`;
  }

  // The Shop "⋯" sheet, and the confirm step that replaces its body for "Clear whole list".
  function shopMenuHtml(nTicked) {
    return `<div class="sh-h"><h3>Shopping list</h3><button class="ib" data-x aria-label="Close">✕</button></div><div class="sh-b"><button class="mitem" data-clear>Clear ticked<small>${nTicked} items in the trolley</small></button><button class="mitem danger" data-clearall>Clear whole list</button></div>`;
  }
  function clearConfirmHtml(n) {
    return `<p class="clearq">Remove all ${n} items? Manual items go too.</p><button class="btn clearyes" data-clearyes>Clear whole list</button><button class="btn line" data-x>Keep it</button>`;
  }

  return {
    MEALS, DAY_NAMES, ANY, AISLE_ORDER,
    isoDate, mondayOf, addDays, weekDates, rangeText, weekLabel, dayInfo,
    dayEntries, weekEntries, mealsForWeek,
    plannerHtml, mealMenuHtml, pickHtml, dayChipsHtml,
    shoppingHtml, shopMenuHtml, clearConfirmHtml,
  };
});
