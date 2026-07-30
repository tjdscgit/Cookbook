// clip-extension.js
// The whole reason Phase 4 exists: cookbook-clip.js's website route has to go through a public
// proxy (r.jina.ai) because a browser tab can't fetch an arbitrary third-party site. A content
// script has no such problem — it runs IN the page, so it just reads the DOM directly. No proxy,
// no third party in the loop, no timeouts.
//
// Two halves live here:
//   1. extractPageData — injected into the page via chrome.scripting.executeScript. Must be fully
//      self-contained (Chrome serialises it to source and re-runs it in the page's isolated world),
//      so it can only touch document/window/JSON — no closing over anything from popup.js.
//   2. Everything below it runs back in the popup, with CookbookUnits available, and turns whatever
//      extractPageData found into the app's recipe shape — ported from cookbook-clip.js's JSON-LD
//      and Claude-fallback logic, minus the fetch-a-proxy step this phase makes unnecessary.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./cookbook-units.js"));
  } else {
    root.CookbookClipExt = factory(root.CookbookUnits);
  }
})(typeof self !== "undefined" ? self : this, function (Units) {
  "use strict";

  const MODEL = "claude-opus-5";

  // ---------------------------------------------------------------------------
  // 1. In-page extraction (self-contained — see the note above)
  // ---------------------------------------------------------------------------
  function extractPageData() {
    function searchForRecipe(node, depth) {
      depth = depth || 0;
      if (!node || depth > 5) return null;
      if (Array.isArray(node)) {
        for (const n of node) { const f = searchForRecipe(n, depth + 1); if (f) return f; }
        return null;
      }
      if (typeof node !== "object") return null;
      const type = node["@type"];
      const isRecipe = type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
      if (isRecipe) return node;
      if (node["@graph"]) return searchForRecipe(node["@graph"], depth + 1);
      return null;
    }

    const blocks = document.querySelectorAll('script[type="application/ld+json"]');
    let recipe = null;
    for (const b of blocks) {
      let parsed;
      try { parsed = JSON.parse(b.textContent); } catch { continue; }
      recipe = searchForRecipe(parsed);
      if (recipe) break;
    }

    const ogImg = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (clone) clone.querySelectorAll("script,style,nav,header,footer,aside").forEach((n) => n.remove());

    return {
      recipe,
      ogImage: ogImg ? ogImg.getAttribute("content") || "" : "",
      pageText: clone ? clone.textContent.replace(/\s+/g, " ").trim().slice(0, 60000) : "",
      pageUrl: location.href,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. JSON-LD -> recipe shape (ported from cookbook-clip.js, same rules)
  // ---------------------------------------------------------------------------
  function fromJsonLd(ld, pageUrl, ogImage) {
    const ingredients = (asArray(ld.recipeIngredient) || []).map((line, i) => {
      const parsed = Units.parseIngredient(String(line));
      parsed.id = `i${i + 1}`;
      parsed.group = "";
      return parsed;
    });

    const stepTexts = flattenInstructions(ld.recipeInstructions);
    const steps = stepTexts.map((text, i) => ({
      id: `s${i + 1}`,
      text,
      ingredientIds: matchIngredients(text, ingredients),
      group: "",
    }));

    return {
      name: decodeEntities(String(ld.name || "Untitled")),
      description: decodeEntities(stripTags(String(ld.description || ""))),
      servings: parseYield(ld.recipeYield),
      servingUnit: "servings",
      prepMinutes: parseIsoDuration(ld.prepTime),
      cookMinutes: parseIsoDuration(ld.cookTime),
      ingredients,
      steps,
      notes: "",
      sourceUrl: pageUrl,
      sourceType: "Website",
      photoUrl: firstImage(ld.image) || ogImage || "",
      tags: [],
      favourite: false,
      collectionIds: [],
      confidence: "high",
    };
  }

  function matchIngredients(stepText, ingredients) {
    const hay = " " + stepText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
    const hits = [];
    for (const ing of ingredients) {
      const words = String(ing.item || "").toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3);
      if (words.some((w) => hay.includes(` ${w} `) || hay.includes(` ${w}s `))) hits.push(ing.id);
    }
    return hits;
  }

  function flattenInstructions(node, out) {
    out = out || [];
    if (!node) return out;
    if (typeof node === "string") {
      const parts = stripTags(node).split(/\n+|(?:(?<=\.)\s+(?=\d+[.)]\s))/).map((s) => s.trim()).filter(Boolean);
      out.push(...parts);
      return out;
    }
    if (Array.isArray(node)) { for (const n of node) flattenInstructions(n, out); return out; }
    if (typeof node === "object") {
      if (node["@type"] === "HowToSection" && node.itemListElement) return flattenInstructions(node.itemListElement, out);
      const t = node.text || node.name;
      if (t) out.push(stripTags(String(t)).trim());
    }
    return out;
  }

  function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
  function firstImage(img) {
    if (!img) return "";
    if (typeof img === "string") return img;
    if (Array.isArray(img)) return firstImage(img[0]);
    if (img.url) return typeof img.url === "string" ? img.url : "";
    return "";
  }
  function parseYield(y) {
    if (y == null) return 4;
    const s = Array.isArray(y) ? String(y[0]) : String(y);
    const m = s.match(/\d+/);
    return m ? parseInt(m[0], 10) : 4;
  }
  function parseIsoDuration(d) {
    if (!d || typeof d !== "string") return null;
    const m = d.match(/^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
    if (!m) return null;
    const mins = (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10);
    return mins || null;
  }
  function stripTags(s) { return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
  function decodeEntities(s) {
    const el = document.createElement("textarea");
    el.innerHTML = s;
    return el.value;
  }

  // ---------------------------------------------------------------------------
  // 3. Claude fallback — same schema/prompt as cookbook-clip.js, direct to api.anthropic.com
  // ---------------------------------------------------------------------------
  const STR = { anyOf: [{ type: "string" }, { type: "null" }] };
  const NUM = { anyOf: [{ type: "number" }, { type: "null" }] };
  const RECIPE_SCHEMA = {
    type: "object",
    properties: {
      name: { type: "string" },
      description: STR,
      servings: NUM,
      serving_unit: STR,
      prep_minutes: NUM,
      cook_minutes: NUM,
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" }, qty: NUM, qty_max: NUM, unit: STR,
            item: { type: "string" }, note: STR, group: STR,
          },
          required: ["id", "qty", "qty_max", "unit", "item", "note", "group"],
          additionalProperties: false,
        },
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            ingredient_ids: { type: "array", items: { type: "string" } },
            group: STR,
          },
          required: ["text", "ingredient_ids", "group"],
          additionalProperties: false,
        },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["name", "description", "servings", "serving_unit", "prep_minutes", "cook_minutes",
               "ingredients", "steps", "confidence"],
    additionalProperties: false,
  };

  const PROMPT = `Extract the recipe into the given structure.

Rules that matter:
- Transcribe amounts EXACTLY as written. Never estimate a quantity that is not stated — use null instead.
- Split each ingredient into amount, unit, item, and any preparation note.
- Fractions become decimals: ½ -> 0.5, 1¼ -> 1.25.
- Ranges: "2-3 tablespoons" is qty 2, qty_max 3.
- For each method step, list the ids of the ingredients that step actually uses, in ingredient_ids — this is what lets the app show the right amounts beside each step. A step that uses none gets an empty array.
- If the recipe has sub-sections, put that heading in group on both ingredients and steps.
- Set confidence to "low" if the page was messy or clearly incomplete.

This text was extracted from a recipe web page and may contain unrelated navigation or comment
chatter around the recipe — ignore that and extract only the recipe.`;

  async function callClaudeFallback(pageText, apiKey) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
        messages: [{ role: "user", content: `${PROMPT}\n\nHere is the page:\n\n${pageText.slice(0, 60000)}` }],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (r.status === 401) throw new Error("Anthropic rejected the API key (401). Check it under Options.");
      if (r.status === 429) throw new Error("Rate limited by Anthropic (429). Wait a moment and try again.");
      throw new Error(`Anthropic returned ${r.status}. ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    if (j.stop_reason === "refusal") throw new Error("Claude declined to read that page.");
    if (j.stop_reason === "max_tokens") throw new Error("That page was too long to read in one go.");
    const text = (j.content || []).find((b) => b.type === "text")?.text;
    if (!text) throw new Error("Claude returned no readable output.");
    let d;
    try { d = JSON.parse(text); } catch { throw new Error("Couldn't parse Claude's response as JSON."); }
    return fromModel(d);
  }

  function fromModel(d) {
    const ingredients = (d.ingredients || []).map((ing, i) => ({
      id: ing.id || `i${i + 1}`,
      qty: ing.qty != null ? Number(ing.qty) : null,
      qtyMax: ing.qty_max != null ? Number(ing.qty_max) : null,
      unit: normaliseUnit(ing.unit),
      item: ing.item || "",
      note: ing.note || "",
      group: ing.group || "",
      scalable: isScalable(ing),
    }));
    const validIds = new Set(ingredients.map((i) => i.id));
    const steps = (d.steps || []).map((st, i) => ({
      id: `s${i + 1}`,
      text: st.text || "",
      ingredientIds: (st.ingredient_ids || []).filter((id) => validIds.has(id)),
      group: st.group || "",
    }));
    return {
      name: d.name || "Untitled",
      description: d.description || "",
      servings: d.servings != null ? Number(d.servings) : 4,
      servingUnit: d.serving_unit || "servings",
      prepMinutes: d.prep_minutes != null ? Number(d.prep_minutes) : null,
      cookMinutes: d.cook_minutes != null ? Number(d.cook_minutes) : null,
      ingredients,
      steps,
      notes: "",
      sourceUrl: "",
      sourceType: "Website",
      photoUrl: "",
      tags: [],
      favourite: false,
      collectionIds: [],
      confidence: d.confidence || "medium",
    };
  }

  function isScalable(ing) {
    if (ing.qty == null) return false;
    const blob = `${ing.unit || ""} ${ing.item || ""} ${ing.note || ""}`;
    if (/\b(pinch|dash|drop|handful)\b/i.test(blob)) return false;
    if (/\b(to taste|for greasing|for dusting|for serving|for garnish|as needed|optional)\b/i.test(blob)) return false;
    return true;
  }

  function normaliseUnit(unit) {
    if (!unit) return "";
    const probe = Units.parseIngredient(`1 ${unit} x`);
    return probe.unit || String(unit).toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Entry point: given what extractPageData found, produce a recipe (JSON-LD if present,
  // Claude fallback otherwise), or throw if neither is possible.
  // ---------------------------------------------------------------------------
  async function buildRecipe(extraction, apiKey) {
    if (extraction.recipe) {
      return fromJsonLd(extraction.recipe, extraction.pageUrl, extraction.ogImage);
    }
    if (!apiKey) {
      throw new Error("This page has no machine-readable recipe data. Add an Anthropic API key under Options to read it with Claude instead.");
    }
    if (!extraction.pageText) throw new Error("Couldn't read any text on this page.");
    const recipe = await callClaudeFallback(extraction.pageText, apiKey);
    recipe.sourceUrl = extraction.pageUrl;
    recipe.photoUrl = extraction.ogImage || "";
    return recipe;
  }

  return { extractPageData, buildRecipe };
});
