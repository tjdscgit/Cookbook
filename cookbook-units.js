// cookbook-units.js
// Ingredient parsing, serving scaling, and shopping-list aggregation.
//
// This is the only file that understands what "2 1/2 cups plain flour, sifted" MEANS. Everything
// else (UI, clipping, planner) works with the structured {qty, unit, item} shape this produces, so
// the messy string handling lives here and nowhere else.
//
// A recipe's units are stored EXACTLY as written and are never silently converted for display — a
// recipe that says "1 cup" still says "1 cup" after scaling, because cooks match their measuring
// cups to the words on the page. Conversion happens in exactly one place: aggregating the shopping
// list, where 3 tsp + 1 tbsp genuinely does need to become a single line.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CookbookUnits = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Unit tables
  // ---------------------------------------------------------------------------
  // Australian measures are the default and they differ from US ones in ways that matter at recipe
  // scale: an AU tablespoon is 20 ml (four teaspoons), the US one is 15 ml (three). A recipe using
  // 4 tbsp of raising agent is a third out if you pick the wrong one. `system` is therefore a
  // user-visible setting, not a constant — but it only ever affects aggregation, never display.
  const SYSTEMS = {
    metric: { tbsp: 20, cup: 250, floz: 30 },   // Australia / NZ / metric cup
    us:     { tbsp: 15, cup: 240, floz: 29.5735 },
  };

  let SYSTEM = "metric";
  function setSystem(name) { if (SYSTEMS[name]) SYSTEM = name; }
  function getSystem() { return SYSTEM; }

  // Canonical unit name -> {family, base-units-per-one, aliases}. `base` is ml for volume and g for
  // mass; count units have no base and never convert.
  function unitTable() {
    const s = SYSTEMS[SYSTEM];
    return {
      // volume
      tsp:    { family: "volume", base: 5,        aliases: ["tsp", "tsps", "teaspoon", "teaspoons", "t"] },
      tbsp:   { family: "volume", base: s.tbsp,   aliases: ["tbsp", "tbsps", "tablespoon", "tablespoons", "tbs", "T"] },
      cup:    { family: "volume", base: s.cup,    aliases: ["cup", "cups", "c"] },
      ml:     { family: "volume", base: 1,        aliases: ["ml", "mls", "millilitre", "millilitres", "milliliter", "milliliters"] },
      l:      { family: "volume", base: 1000,     aliases: ["l", "litre", "litres", "liter", "liters"] },
      "fl oz":{ family: "volume", base: s.floz,   aliases: ["fl oz", "floz", "fluid ounce", "fluid ounces"] },
      pint:   { family: "volume", base: s.floz*20,aliases: ["pint", "pints", "pt"] },
      quart:  { family: "volume", base: s.floz*40,aliases: ["quart", "quarts", "qt"] },
      // mass
      g:      { family: "mass",   base: 1,        aliases: ["g", "gram", "grams", "gm", "gms"] },
      kg:     { family: "mass",   base: 1000,     aliases: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"] },
      oz:     { family: "mass",   base: 28.3495,  aliases: ["oz", "ounce", "ounces"] },
      lb:     { family: "mass",   base: 453.592,  aliases: ["lb", "lbs", "pound", "pounds"] },
      // countable containers and vague amounts — never converted, only summed when identical
      clove:  { family: "count",  aliases: ["clove", "cloves"] },
      slice:  { family: "count",  aliases: ["slice", "slices"] },
      sprig:  { family: "count",  aliases: ["sprig", "sprigs"] },
      stalk:  { family: "count",  aliases: ["stalk", "stalks", "stick", "sticks"] },
      bunch:  { family: "count",  aliases: ["bunch", "bunches"] },
      can:    { family: "count",  aliases: ["can", "cans", "tin", "tins"] },
      jar:    { family: "count",  aliases: ["jar", "jars"] },
      packet: { family: "count",  aliases: ["packet", "packets", "pack", "packs", "pkt"] },
      handful:{ family: "count",  aliases: ["handful", "handfuls"] },
      pinch:  { family: "count",  aliases: ["pinch", "pinches"] },
      dash:   { family: "count",  aliases: ["dash", "dashes"] },
      drop:   { family: "count",  aliases: ["drop", "drops"] },
    };
  }

  // Reverse lookup built per call because the table depends on SYSTEM.
  function aliasMap() {
    const table = unitTable(), map = {};
    for (const canon in table) {
      // The canonical name itself is always an alias; `T` (capital) must stay case-sensitive so it
      // doesn't collide with `t` for teaspoon, so it's handled separately in parseUnit.
      for (const a of table[canon].aliases) map[a.toLowerCase()] = canon;
      map[canon.toLowerCase()] = canon;
    }
    return map;
  }

  // Amounts that shouldn't multiply when you scale a recipe. Doubling a cake doesn't double the oil
  // you grease the tin with, and "salt to taste" has no number to double in the first place.
  const NON_SCALING_UNITS = new Set(["pinch", "dash", "drop", "handful"]);
  const NON_SCALING_PHRASES = /\b(to taste|for greasing|for dusting|for serving|for garnish|as needed|if needed|optional)\b/i;

  // ---------------------------------------------------------------------------
  // Fractions
  // ---------------------------------------------------------------------------
  const UNICODE_FRACTIONS = {
    "¼": 0.25, "½": 0.5, "¾": 0.75, "⅐": 1/7, "⅑": 1/9, "⅒": 0.1,
    "⅓": 1/3, "⅔": 2/3, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
    "⅙": 1/6, "⅚": 5/6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
  };
  // Rendered back the other way. Ordered so lookup finds the closest match.
  const NICE_FRACTIONS = [
    [1/8, "⅛"], [1/4, "¼"], [1/3, "⅓"], [3/8, "⅜"], [1/2, "½"],
    [5/8, "⅝"], [2/3, "⅔"], [3/4, "¾"], [7/8, "⅞"],
  ];

  // Turns a number into something a cook can read off a page: 1.5 -> "1½", 0.333 -> "⅓".
  // Falls back to a decimal only when nothing sensible is close (2.37 -> "2.4"), because an
  // unreadable "2.3745 cups" is worse than a rounded one.
  function formatQty(n) {
    if (n == null || isNaN(n)) return "";
    if (n === 0) return "0";
    const neg = n < 0;
    n = Math.abs(n);

    const whole = Math.floor(n);
    const frac = n - whole;
    let out;

    if (frac < 0.02) {
      out = String(whole);
    } else {
      // Find the nearest nice fraction, but only accept it if it's genuinely close — otherwise
      // we'd render 0.45 as "½" and quietly lie about the amount.
      let best = null, bestDiff = Infinity;
      for (const [value, glyph] of NICE_FRACTIONS) {
        const diff = Math.abs(frac - value);
        if (diff < bestDiff) { bestDiff = diff; best = glyph; }
      }
      if (bestDiff < 0.021) {
        out = whole > 0 ? `${whole}${best}` : best;
      } else if (frac > 0.98) {
        out = String(whole + 1);
      } else {
        // No clean fraction. Show at most 2 decimals, trimmed.
        out = String(Math.round(n * 100) / 100);
      }
    }
    return neg ? "-" + out : out;
  }

  // Parses "1 1/2", "1½", "½", "0.5", "1.5" -> number. Returns null if there's no number at all.
  function parseQty(str) {
    if (!str) return null;
    let s = String(str).trim();
    if (!s) return null;

    // Expand unicode fractions into "+0.5" style so the arithmetic below is uniform.
    let total = 0, found = false;
    for (const glyph in UNICODE_FRACTIONS) {
      if (s.includes(glyph)) {
        total += UNICODE_FRACTIONS[glyph];
        found = true;
        s = s.split(glyph).join(" ");
      }
    }

    s = s.trim();
    if (s) {
      // "1 1/2" -> whole 1 + fraction 1/2
      const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
      const simple = s.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (mixed) {
        total += parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
        found = true;
      } else if (simple) {
        total += parseInt(simple[1], 10) / parseInt(simple[2], 10);
        found = true;
      } else {
        const num = parseFloat(s.replace(",", "."));
        if (!isNaN(num)) { total += num; found = true; }
      }
    }
    return found ? total : null;
  }

  // ---------------------------------------------------------------------------
  // Ingredient parsing
  // ---------------------------------------------------------------------------
  // Splits a written ingredient line into structured parts. Deliberately conservative: anything it
  // can't confidently identify stays in `item` verbatim rather than being guessed at, because a
  // wrong quantity is far worse than an unparsed one — the user can see and fix an unparsed line,
  // but a silently mis-parsed "1/2" reads as correct while being wrong.
  // Decodes HTML entities that leak through from scraped source ("&lt;" -> "<"). Handles both
  // simple and double-escaped ("&amp;lt;") cases because &amp; is decoded first.
  function decodeEntities(s) {
    if (!s) return s;
    return String(s)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }

  function parseIngredient(line) {
    const raw = decodeEntities(String(line || "")).trim();
    const out = { qty: null, qtyMax: null, unit: "", item: raw, note: "", scalable: true };
    if (!raw) return out;

    let s = raw;

    // Double-parenthesis asides are this data's footnote convention — "((Note 1))",
    // "((ie. not hot or smoked))", "((or canola or peanut, Note 8 for re-use))" — distinct from a
    // single-paren translation kept inline ("eggplant (aubergine)"). Pull them into the note.
    const noteMarkerRe = /\(\(([^()]+)\)\)/g;
    const foundNotes = [...s.matchAll(noteMarkerRe)].map((m) => m[1].trim());
    if (foundNotes.length) {
      out.note = foundNotes.join("; ");
      s = s.replace(noteMarkerRe, "").replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
    }

    // Same "((" aside convention, but the source sometimes nests unevenly so the close never
    // reads as "))" ("((level cups, unsifted, not packed), + keep 1/4 cup extra ... dough)").
    // Track paren depth from the double-open to where it actually balances back to zero.
    const dblOpen = s.indexOf("((");
    if (dblOpen !== -1) {
      let depth = 2;
      let j = dblOpen + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
        j++;
      }
      const end = s[j - 1] === ")" ? j - 1 : j;
      const inner = s.slice(dblOpen + 2, end).replace(/\)\s*,/g, ",").trim();
      if (inner) {
        out.note = out.note ? `${out.note}; ${inner}` : inner;
        s = (s.slice(0, dblOpen) + s.slice(j)).replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
      }
    }

    // Trailing note after a comma: "plain flour, sifted" -> note "sifted".
    // Only the LAST comma-separated chunk, and only if it reads like a preparation instruction
    // rather than part of the name ("salt, pepper" must not become item "salt" note "pepper").
    const commaIdx = s.lastIndexOf(",");
    if (commaIdx > 0) {
      const tail = s.slice(commaIdx + 1).trim();
      if (/^(finely |roughly |thinly |coarsely |well )?(sifted|chopped|diced|sliced|minced|grated|melted|softened|beaten|crushed|drained|rinsed|peeled|trimmed|halved|quartered|cubed|shredded|toasted|room temperature|at room temperature|plus extra.*|to taste|for .*|optional|divided)$/i.test(tail)) {
        out.note = out.note ? `${out.note}; ${tail}` : tail;
        s = s.slice(0, commaIdx).trim();
      }
    }

    // Leading quantity, possibly a range: "2-3", "1 1/2", "1½", "½".
    // Alternatives are ordered longest-first. "1½" must be tried before the bare-integer branch,
    // or `\d+` claims just the "1" and leaves "½ cups milk" as the item name.
    const FRAC = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
    const qtyPattern = "(" + [
      "\\d+\\s*[" + FRAC + "]",        // 1½
      "\\d+\\s+\\d+\\s*/\\s*\\d+",     // 1 1/2
      "\\d+\\s*/\\s*\\d+",             // 1/2
      "[" + FRAC + "]",                // ½
      "\\d+(?:[.,]\\d+)?",             // 1.5, 2
    ].join("|") + ")";
    const rangeRe = new RegExp("^" + qtyPattern + "\\s*(?:-|–|—|to)\\s*" + qtyPattern + "\\s*(.*)$", "i");
    const singleRe = new RegExp("^" + qtyPattern + "\\s*(.*)$");

    let rest = s;
    const range = s.match(rangeRe);
    if (range) {
      out.qty = parseQty(range[1]);
      out.qtyMax = parseQty(range[2]);
      rest = range[3] || "";
    } else {
      const single = s.match(singleRe);
      if (single) {
        // Guard against swallowing a leading number that's part of the name ("7 up", "00 flour").
        out.qty = parseQty(single[1]);
        rest = single[2] || "";
      }
    }

    // A mixed number written as "1 1/2" leaves nothing odd behind, but "1½ cups" can leave the
    // glyph glued to the unit. parseQty already stripped it; just tidy whitespace.
    rest = rest.trim();

    // Unit, if the next token is one we recognise.
    if (rest) {
      const map = aliasMap();
      // Try two-word units first ("fl oz", "fluid ounces") before single words.
      const twoWord = rest.match(/^(\S+\s+\S+)\b\.?\s*(.*)$/);
      const oneWord = rest.match(/^(\S+?)\b\.?\s*(.*)$/);
      if (twoWord && map[twoWord[1].toLowerCase().replace(/\./g, "")]) {
        out.unit = map[twoWord[1].toLowerCase().replace(/\./g, "")];
        rest = twoWord[2];
      } else if (oneWord) {
        const token = oneWord[1].replace(/\./g, "");
        // `T` means tablespoon, `t` means teaspoon — the only case-sensitive units we honour.
        if (token === "T") { out.unit = "tbsp"; rest = oneWord[2]; }
        else if (token === "t") { out.unit = "tsp"; rest = oneWord[2]; }
        else if (map[token.toLowerCase()]) { out.unit = map[token.toLowerCase()]; rest = oneWord[2]; }
      }
    }

    // A leading "/" after the amount is an alternate-unit duplicate ("1.8 kg / 3.6lb bone in...")
    // — pull it out as an alt-amount shown next to the main quantity instead of leaking into the
    // item name.
    const altMatch = rest.match(/^\/\s*(\S+)\s*/);
    if (altMatch) {
      out.altText = altMatch[1];
      rest = rest.slice(altMatch[0].length).trim();
    }

    // "of" is noise between unit and item: "2 cups of flour".
    rest = rest.replace(/^of\s+/i, "").trim();

    // Tidy punctuation left behind by stripped notes/alt-units: "(, plain)" -> "(plain)", empty
    // parens, doubled spaces, stray leading comma or slash.
    rest = rest
      .replace(/\(\s*,\s*/g, "(")
      .replace(/\s*,\s*\)/g, ")")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[,/]\s*/, "")
      .trim();

    out.item = rest || (out.qty == null ? raw : raw);
    if (!rest && out.qty != null) {
      // We found a number but no item text — the whole line was probably just a name. Undo.
      out.qty = null; out.qtyMax = null; out.unit = ""; out.item = raw;
    }

    // Decide whether this amount should multiply when the recipe is scaled.
    if (NON_SCALING_UNITS.has(out.unit) || NON_SCALING_PHRASES.test(raw)) out.scalable = false;
    if (out.qty == null) out.scalable = false;   // nothing to scale

    return out;
  }

  // ---------------------------------------------------------------------------
  // Scaling
  // ---------------------------------------------------------------------------
  // Rounds a scaled amount to something you can actually measure. The rules differ by unit family
  // because the tolerances differ: 1.67 eggs is nonsense, 137 g of flour is fine but 135 reads
  // better, and 0.42 tsp wants to be ⅜.
  function roundForUnit(n, unit) {
    if (n == null || isNaN(n)) return n;
    const table = unitTable();
    const info = table[unit];

    // Whole countable things (eggs, cloves, slices) — halves at most.
    if (!unit || (info && info.family === "count")) {
      if (n < 1) return Math.round(n * 4) / 4;
      return Math.round(n * 2) / 2;
    }

    if (info && info.family === "mass") {
      if (unit === "kg" || unit === "lb") return Math.round(n * 100) / 100;
      if (n >= 100) return Math.round(n / 10) * 10;
      if (n >= 20) return Math.round(n / 5) * 5;
      return Math.round(n);
    }

    if (info && info.family === "volume") {
      // ml / litres are read off a jug — round to something the jug shows.
      if (unit === "ml") {
        if (n >= 100) return Math.round(n / 10) * 10;
        if (n >= 20) return Math.round(n / 5) * 5;
        return Math.round(n);
      }
      if (unit === "l") return Math.round(n * 100) / 100;
      // Spoons and cups are read off nested measures — snap to the nearest eighth so formatQty has
      // a clean fraction to render.
      return Math.round(n * 8) / 8;
    }

    return Math.round(n * 100) / 100;
  }

  // Returns a COPY of the ingredient with quantities scaled. Never mutates — the stored recipe
  // always holds the original amounts, and scaling is a view concern applied on render.
  function scaleIngredient(ing, factor) {
    const out = Object.assign({}, ing);
    if (!ing.scalable || ing.qty == null || factor === 1) return out;
    out.qty = roundForUnit(ing.qty * factor, ing.unit);
    if (ing.qtyMax != null) out.qtyMax = roundForUnit(ing.qtyMax * factor, ing.unit);
    return out;
  }

  function scaleIngredients(list, factor) {
    return (list || []).map((i) => scaleIngredient(i, factor));
  }

  // The display string for one ingredient, already scaled. `2½ cups plain flour, sifted`.
  function formatIngredient(ing) {
    const bits = [];
    if (ing.qty != null) {
      bits.push(ing.qtyMax != null
        ? `${formatQty(ing.qty)}–${formatQty(ing.qtyMax)}`
        : formatQty(ing.qty));
    }
    if (ing.unit) bits.push(pluraliseUnit(ing.unit, ing.qtyMax != null ? ing.qtyMax : ing.qty));
    if (ing.item) bits.push(ing.item);
    let s = bits.join(" ").trim();
    if (ing.note) s += `, ${ing.note}`;
    return s;
  }

  // "1 cup" / "2 cups". Abbreviations (tsp, tbsp, g, ml) never pluralise — nobody writes "2 mls".
  // The lookup is case-folded because a recipe written with a capital "L" for litres is the normal
  // way to write it, and matching only the lower-case spelling produced "2.4 Ls" on shopping lists.
  const NEVER_PLURAL = new Set(["tsp", "tbsp", "ml", "l", "g", "kg", "oz", "lb", "fl oz"]);
  function pluraliseUnit(unit, qty) {
    if (!unit || NEVER_PLURAL.has(unit.toLowerCase())) return unit;
    if (qty == null || qty === 1) return unit;
    // Already written plural ("leaves", "greens") — adding another s gave "leavess".
    if (/s$/i.test(unit)) return unit;
    // bunch/pinch/dash/box take "es", not "s".
    if (/(?:ch|sh|x|z)$/i.test(unit)) return unit + "es";
    return unit + "s";
  }

  // ---------------------------------------------------------------------------
  // Shopping-list aggregation
  // ---------------------------------------------------------------------------
  // Merges ingredients drawn from several recipes into one line per thing to buy. Units convert
  // only WITHIN a family: 3 tsp + 1 tbsp is 2 tbsp, but 100 g of butter and 1 cup of butter stay
  // as two lines, because converting mass to volume needs a density we don't have and guessing it
  // would put the wrong amount on the list.
  function aggregate(entries) {
    const buckets = new Map();

    for (const e of entries || []) {
      const key = normaliseItemName(e.item);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(e);
    }

    const out = [];
    for (const [key, group] of buckets) {
      // Sub-group by unit family so incompatible units stay separate lines.
      const byFamily = new Map();
      for (const e of group) {
        const fam = familyOf(e.unit);
        // Count-family items only merge when the unit string matches exactly ("2 cloves" +
        // "3 cloves" merges; "1 can" + "2 slices" does not).
        const famKey = fam === "count" || fam === "none" ? `${fam}:${e.unit || ""}` : fam;
        if (!byFamily.has(famKey)) byFamily.set(famKey, []);
        byFamily.get(famKey).push(e);
      }

      for (const [famKey, list] of byFamily) {
        const fam = famKey.split(":")[0];
        const names = list.map((e) => e.item);
        const sources = [].concat(...list.map((e) => e.fromRecipes || []));

        if (fam === "volume" || fam === "mass") {
          // Sum in base units, then pick the unit that reads best.
          const table = unitTable();
          let total = 0, anyUnknown = false;
          for (const e of list) {
            if (e.qty == null || !e.unit || !table[e.unit]) { anyUnknown = true; continue; }
            total += e.qty * table[e.unit].base;
          }
          if (anyUnknown && total === 0) {
            out.push(makeLine(names[0], null, "", sources));
            continue;
          }
          const unitsPresent = list.map((e) => e.unit).filter(Boolean);
          const best = bestUnitFor(total, fam, unitsPresent);
          out.push(makeLine(names[0], roundForUnit(total / best.base, best.unit), best.unit, sources));
        } else {
          // Count or unitless — plain sum, no conversion.
          let total = 0, anyQty = false;
          for (const e of list) {
            if (e.qty != null) { total += e.qty; anyQty = true; }
          }
          const unit = list[0].unit || "";
          out.push(makeLine(names[0], anyQty ? roundForUnit(total, unit) : null, unit, sources));
        }
      }
    }

    return out;
  }

  function makeLine(name, qty, unit, fromRecipes) {
    return {
      id: "x" + Math.random().toString(36).slice(2, 9),
      name, qty, unit,
      aisle: aisleFor(name),
      checked: false,
      manual: false,
      fromRecipes: Array.from(new Set(fromRecipes || [])),
    };
  }

  function familyOf(unit) {
    if (!unit) return "none";
    const info = unitTable()[unit];
    return info ? info.family : "none";
  }

  // Picks the unit a summed amount should be reported in.
  //
  // The rule is "stay in the units the recipes were written in" — specifically, the largest unit
  // that actually appeared. An absolute ladder (promote anything over a litre to litres) gets this
  // badly wrong for dry goods: 7½ cups of flour is 1875 ml, and reporting "1⅞ l of flour" is
  // arithmetically right and useless, because nobody buys flour by the litre. Only the base units
  // (g, ml) promote, since those are the ones where a big number genuinely reads worse than a
  // small one — 1200 g really is better as 1.2 kg.
  function bestUnitFor(baseTotal, family, unitsPresent) {
    const table = unitTable();
    const fallback = family === "mass" ? "g" : "ml";

    let unit = fallback;
    let largest = 0;
    for (const u of unitsPresent || []) {
      const info = table[u];
      if (!info || info.family !== family) continue;
      if (info.base > largest) { largest = info.base; unit = u; }
    }

    if (unit === "g" && baseTotal >= 1000) return { unit: "kg", base: table.kg.base };
    if (unit === "ml" && baseTotal >= 1000) return { unit: "l", base: table.l.base };

    // If the total doesn't even reach one of the chosen unit ("¼ cup" summed from two ⅛ cups is
    // fine, but 0.05 cup is not), step down to the next smaller unit that was actually used.
    const base = table[unit] ? table[unit].base : 1;
    if (baseTotal / base < 0.25) {
      const smaller = (unitsPresent || [])
        .map((u) => table[u])
        .filter((i) => i && i.family === family && i.base < base)
        .sort((a, b) => b.base - a.base)[0];
      if (smaller) {
        const name = Object.keys(table).find((k) => table[k] === smaller);
        return { unit: name, base: smaller.base };
      }
    }
    return { unit, base };
  }

  // Trims preparation words and plurals so "finely chopped onions" and "onion" land in one bucket.
  function normaliseItemName(name) {
    let s = String(name || "").toLowerCase().trim();
    s = s.replace(/\b(finely|roughly|thinly|coarsely|freshly|well)\b/g, "");
    s = s.replace(/\b(chopped|diced|sliced|minced|grated|melted|softened|beaten|crushed|drained|rinsed|peeled|trimmed|halved|quartered|cubed|shredded|toasted|ground)\b/g, "");
    // Strip leftover punctuation before collapsing whitespace. Removing "finely chopped" from
    // "onions, finely chopped" leaves a dangling comma, and "onions," would not depluralise below.
    s = s.replace(/[,;.]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    if (s.endsWith("es") && !s.endsWith("ses")) s = s.slice(0, -2);
    else if (s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
    return s;
  }

  // Rough supermarket-aisle guess so the list groups sensibly. Wrong guesses are harmless — the
  // item still appears, just under a heading you didn't expect — so this stays a simple keyword
  // match rather than anything cleverer.
  // Each pattern ends `(?:e?s)?\b` so plurals match too — without it `\begg\b` never matches
  // "eggs", and the most obvious item on the list lands under "Other".
  const AISLES = [
    ["Produce",   /\b(onion|garlic|carrot|potato|tomato|lettuce|spinach|herb|basil|parsley|coriander|lemon|lime|apple|banana|berry|berries|mushroom|capsicum|pepper|cucumber|celery|ginger|chilli|chili|avocado|broccoli|cauliflower|zucchini|pumpkin|leek|shallot|kale|rocket|cabbage|corn|pea|bean sprout|orange|pear|grape)(?:e?s)?\b/i],
    ["Meat & Fish", /\b(chicken|beef|pork|lamb|mince|bacon|sausage|fish|salmon|tuna|prawn|shrimp|steak|thigh|breast|fillet|ham|turkey)(?:e?s)?\b/i],
    ["Dairy & Eggs", /\b(milk|cream|butter|cheese|yoghurt|yogurt|egg|parmesan|cheddar|feta|ricotta|mozzarella|creme fraiche|sour cream)(?:e?s)?\b/i],
    ["Baking",    /\b(flour|sugar|yeast|baking powder|baking soda|bicarb|vanilla|cocoa|chocolate|icing|cornflour|cornstarch|almond meal)(?:e?s)?\b/i],
    ["Pantry",    /\b(oil|vinegar|salt|pepper|spice|cumin|paprika|cinnamon|oregano|thyme|stock|broth|sauce|soy|honey|maple|mustard|pasta|rice|noodle|lentil|chickpea|tin|can|coconut milk|tomato paste|curry)(?:e?s)?\b/i],
    ["Frozen",    /\b(frozen|ice cream|puff pastry|shortcrust)(?:e?s)?\b/i],
    ["Bakery",    /\b(bread|roll|bun|tortilla|wrap|baguette|sourdough|pita)(?:e?s)?\b/i],
  ];
  function aisleFor(name) {
    for (const [aisle, re] of AISLES) if (re.test(name)) return aisle;
    return "Other";
  }

  // ---------------------------------------------------------------------------
  // Building shopping entries from planned meals
  // ---------------------------------------------------------------------------
  // `meals` is [{recipe, servings}]. Scales each recipe to its planned servings, then aggregates.
  function buildShoppingList(meals) {
    const entries = [];
    for (const m of meals || []) {
      const r = m.recipe;
      if (!r) continue;
      const base = Number(r.servings) || 1;
      const factor = (Number(m.servings) || base) / base;
      for (const ing of scaleIngredients(r.ingredients, factor)) {
        if (!ing.item) continue;
        entries.push({ item: ing.item, qty: ing.qty, unit: ing.unit, fromRecipes: [r.id] });
      }
    }
    return aggregate(entries);
  }

  return {
    setSystem, getSystem,
    parseQty, formatQty,
    parseIngredient,
    scaleIngredient, scaleIngredients, roundForUnit,
    formatIngredient, pluraliseUnit,
    aggregate, buildShoppingList,
    normaliseItemName, aisleFor, familyOf,
    _unitTable: unitTable,
  };
});
