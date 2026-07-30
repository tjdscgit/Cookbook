// cookbook-clip.js
// Getting recipes in from the wild: websites, photos, and pasted text.
//
// The ordering here is deliberate and it's about cost and accuracy, not just fallbacks. Most recipe
// sites publish schema.org/Recipe JSON-LD — machine-readable, authored by the site itself, exact.
// Reading that is free and instant, so it's always tried first. Claude is the fallback for pages
// without it, and the only option for photos and social captions, where there's no structured data
// to read at all.
(function (root, factory) {
  root.CookbookClip = factory(root.CookbookUnits, root.CookbookData);
})(typeof self !== "undefined" ? self : this, function (Units, Data) {
  "use strict";

  const MODEL = "claude-opus-5";
  const MAX_EDGE = 2576;   // the model's high-res vision ceiling on the long edge

  // A browser can't fetch an arbitrary third-party site — CORS forbids it and recipe sites don't
  // opt in. This public relay sits in between. It sees the recipe URL, which isn't sensitive, but
  // it IS a third party in the loop, which is why the Chrome extension (which runs in the page and
  // needs no relay at all) is on the roadmap.
  //
  // Both the HTML and text routes go through the same relay (r.jina.ai) — the `X-Return-Format`
  // header picks which one comes back. An earlier version used a second relay (allorigins.win) for
  // HTML, but it was returning 522s/timeouts often enough that it was silently killing the free
  // JSON-LD path on working sites and forcing every clip through Claude.
  const PROXY_HTML = (u) => `https://r.jina.ai/${u}`;
  const PROXY_TEXT = (u) => `https://r.jina.ai/${u}`;

  // ---------------------------------------------------------------------------
  // Structured-output schema
  // ---------------------------------------------------------------------------
  // Every key is required and explicitly nullable. This schema dialect has no clean "optional key",
  // so a value the model can't read must come back as null rather than being omitted — or, worse,
  // invented. A guessed quantity is the one failure mode that matters here: it reads as correct
  // while being wrong, and you don't find out until the cake doesn't rise.
  const STR = { anyOf: [{ type: "string" }, { type: "null" }] };
  const NUM = { anyOf: [{ type: "number" }, { type: "null" }] };

  const RECIPE_SCHEMA = {
    type: "object",
    properties: {
      name: { type: "string", description: "The recipe title." },
      description: STR,
      servings: { ...NUM, description: "How many the recipe makes, as a number, or null if not stated." },
      serving_unit: { ...STR, description: 'What is being counted: "servings", "cookies", "loaves".' },
      prep_minutes: NUM,
      cook_minutes: NUM,
      ingredients: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: 'Short unique id, "i1", "i2", … Steps refer to these.' },
            qty: { ...NUM, description: "Numeric amount. Write 0.5 for ½, 1.5 for 1½. Null if none is given." },
            qty_max: { ...NUM, description: 'Upper bound of a range ("2-3 tbsp" -> qty 2, qty_max 3). Null otherwise.' },
            unit: { ...STR, description: 'Unit exactly as written: "cup", "tbsp", "g", "clove". Null if none.' },
            item: { type: "string", description: "The ingredient itself, without amount or preparation." },
            note: { ...STR, description: 'Preparation: "sifted", "finely chopped", "at room temperature".' },
            group: { ...STR, description: 'Sub-recipe heading if the list has them ("For the sauce"). Null otherwise.' },
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
            text: { type: "string", description: "The instruction, verbatim where possible." },
            ingredient_ids: {
              type: "array",
              items: { type: "string" },
              description: "ids of the ingredients this step uses. Empty array if none.",
            },
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

  const PROMPT_COMMON = `Extract the recipe into the given structure.

Rules that matter:
- Transcribe amounts EXACTLY as written. Do not convert units, do not tidy "1 1/2" into "1.5 cups" of a different unit, and never estimate a quantity that is not stated — use null instead. A wrong number is far worse than a missing one.
- Split each ingredient into its amount, unit, the ingredient itself, and any preparation note. "2 cups plain flour, sifted" is qty 2, unit "cup", item "plain flour", note "sifted".
- Fractions become decimals: ½ -> 0.5, 1¼ -> 1.25, ⅓ -> 0.333.
- Ranges: "2-3 tablespoons" is qty 2, qty_max 3.
- For each method step, list the ids of the ingredients that step actually uses, in ingredient_ids. This is the most important part: it is what lets the app show the right amounts beside each step while cooking. A step that uses no ingredients (like "preheat the oven") gets an empty array.
- If the recipe has sub-sections ("For the base", "For the topping"), put that heading in the group field of both the ingredients and the steps it covers.
- Set confidence to "low" if the source was hard to read or clearly incomplete.`;

  // ---------------------------------------------------------------------------
  // The Claude call
  // ---------------------------------------------------------------------------
  // Goes browser-direct to api.anthropic.com with the key the user pasted into settings — same
  // trust model as the Airtable token, no proxy of ours in between.
  async function callClaude(content) {
    const key = Data.creds().anthropic;
    if (!key) throw new Error("This needs an Anthropic API key. Add one under settings ⚙ — or use a website URL, which doesn't need one.");

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        // Without this header the browser's CORS preflight is rejected outright.
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        // Recipe extraction is transcription, not reasoning — thinking would add cost and latency
        // for no gain. Permitted at the default `high` effort; it would 400 at xhigh or max.
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
        messages: [{ role: "user", content }],
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (r.status === 401) throw new Error("Anthropic rejected the API key (401). Check it under settings ⚙.");
      if (r.status === 429) throw new Error("Rate limited by Anthropic (429). Wait a moment and try again.");
      throw new Error(`Anthropic returned ${r.status}. ${t.slice(0, 200)}`);
    }

    const j = await r.json();
    if (j.stop_reason === "refusal") throw new Error("Claude declined to read that.");
    if (j.stop_reason === "max_tokens") throw new Error("That was too long to read in one go. Try a single recipe at a time, or photograph half the page.");
    const text = (j.content || []).find((b) => b.type === "text")?.text;
    if (!text) throw new Error("Claude returned no readable output.");
    try { return JSON.parse(text); }
    catch { throw new Error("Couldn't parse Claude's response as JSON."); }
  }

  // ---------------------------------------------------------------------------
  // Website: JSON-LD first
  // ---------------------------------------------------------------------------
  async function clipFromUrl(pageUrl, onProgress) {
    const say = onProgress || (() => {});
    let html = "";

    say("Fetching the page…");
    try {
      const r = await fetch(PROXY_HTML(pageUrl), { headers: { "X-Return-Format": "html" } });
      if (r.ok) html = await r.text();
    } catch { /* fall through to the text route below */ }

    if (html) {
      say("Looking for structured recipe data…");
      const ld = findRecipeJsonLd(html);
      if (ld) {
        say("Found it — reading directly, no AI needed.");
        const recipe = fromJsonLd(ld, pageUrl);
        recipe.photoUrl = recipe.photoUrl || findOgImage(html) || "";
        return recipe;
      }
    }

    // No structured data. Fall back to reading the page as text with Claude.
    say("No structured data on that page — reading it with Claude instead…");
    let text = "";
    try {
      const r = await fetch(PROXY_TEXT(pageUrl));
      if (r.ok) text = await r.text();
    } catch { /* handled below */ }
    if (!text && html) text = stripHtml(html);
    if (!text) throw new Error("Couldn't read that page. Try copying the recipe text and using the “Paste text” tab instead.");

    const data = await callClaude([
      { type: "text", text: `${PROMPT_COMMON}\n\nHere is the page:\n\n${text.slice(0, 60000)}` },
    ]);
    const recipe = fromModel(data);
    recipe.sourceUrl = pageUrl;
    recipe.sourceType = "Website";
    if (html) recipe.photoUrl = findOgImage(html) || "";
    return recipe;
  }

  // Walks every JSON-LD block on the page looking for a Recipe. Sites nest these inconsistently —
  // bare object, @graph array, or a plain array — so all three shapes are handled.
  function findRecipeJsonLd(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const b of blocks) {
      let parsed;
      try { parsed = JSON.parse(b.textContent); } catch { continue; }
      const found = searchForRecipe(parsed);
      if (found) return found;
    }
    return null;
  }

  function searchForRecipe(node, depth = 0) {
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

  // Maps schema.org/Recipe onto our shape. Ingredient strings get parsed locally by cookbook-units.
  //
  // JSON-LD has no way to express "this step uses these ingredients", so step-linked ingredients —
  // the app's whole point — can't come from this route. Rather than leave them blank, each step is
  // matched against the ingredient list by name. It's approximate but it's free, and every clip
  // lands in the editor for review before saving anyway.
  function fromJsonLd(ld, pageUrl) {
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
      photoUrl: firstImage(ld.image),
      tags: [],
      favourite: false,
      collectionIds: [],
      confidence: "high",
    };
  }

  // Word-overlap match between a step's text and each ingredient name. Deliberately strict — it
  // needs a whole-word hit on a word longer than three letters — because a loose match that wires
  // "salt" into every step is worse than wiring nothing.
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
      // Some sites cram the whole method into one string with newlines or numbered sentences.
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
  // "PT1H30M" -> 90
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
  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,nav,header,footer,aside").forEach((n) => n.remove());
    return (doc.body ? doc.body.textContent : "").replace(/\s+/g, " ").trim();
  }
  function findOgImage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const m = doc.querySelector('meta[property="og:image"], meta[name="og:image"]');
    return m ? m.getAttribute("content") || "" : "";
  }

  // ---------------------------------------------------------------------------
  // Photo
  // ---------------------------------------------------------------------------
  async function clipFromPhoto(file, onProgress) {
    const say = onProgress || (() => {});
    say("Preparing the image…");
    const { b64, mediaType } = await downscale(file);
    say("Reading it with Claude…");
    const data = await callClaude([
      { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
      { type: "text", text: `${PROMPT_COMMON}\n\nThis is a photograph of a recipe — it may be a printed cookbook page, a handwritten card, or a screenshot. Transcribe only what is actually on the page.` },
    ]);
    const recipe = fromModel(data);
    recipe.sourceType = "Photo";
    return recipe;
  }

  // Scales the long edge down to the model's high-res ceiling. Anything larger is downsampled by
  // the API anyway, so sending it just costs upload time and tokens.
  function downscale(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        const longEdge = Math.max(w, h);
        if (longEdge > MAX_EDGE) {
          const scale = MAX_EDGE / longEdge;
          w = Math.round(w * scale); h = Math.round(h * scale);
        }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL("image/jpeg", 0.92);
        resolve({ b64: dataUrl.slice(dataUrl.indexOf(",") + 1), mediaType: "image/jpeg" });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image file.")); };
      img.src = url;
    });
  }

  // ---------------------------------------------------------------------------
  // Pasted text (social captions, emails, anything copied)
  // ---------------------------------------------------------------------------
  async function clipFromText(text, onProgress) {
    const say = onProgress || (() => {});
    if (!text || !text.trim()) throw new Error("Nothing to read — paste the recipe text first.");
    say("Reading it with Claude…");
    const data = await callClaude([
      { type: "text", text: `${PROMPT_COMMON}\n\nThis text was copied from a social media post, an email, or a web page. It may contain hashtags, chatter, or comments around the recipe — ignore those and extract only the recipe.\n\n${text.slice(0, 60000)}` },
    ]);
    const recipe = fromModel(data);
    recipe.sourceType = "Social";
    return recipe;
  }

  // ---------------------------------------------------------------------------
  // Model output -> app shape
  // ---------------------------------------------------------------------------
  function fromModel(d) {
    const ingredients = (d.ingredients || []).map((ing, i) => ({
      id: ing.id || `i${i + 1}`,
      qty: ing.qty != null ? Number(ing.qty) : null,
      qtyMax: ing.qty_max != null ? Number(ing.qty_max) : null,
      unit: normaliseUnit(ing.unit),
      item: ing.item || "",
      note: ing.note || "",
      group: ing.group || "",
      // Re-derive scalability locally rather than asking the model for it — "pinch", "to taste"
      // and "for greasing" are a fixed, knowable list, and the rule belongs in one place.
      scalable: isScalable(ing),
    }));

    const validIds = new Set(ingredients.map((i) => i.id));
    const steps = (d.steps || []).map((st, i) => ({
      id: `s${i + 1}`,
      text: st.text || "",
      // Drop references to ids that don't exist — a hallucinated link would render an empty pill.
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
      sourceType: "Manual",
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

  // Runs the model's free-text unit through the same alias table the parser uses, so "Tablespoons"
  // and "tbsp" end up as the same canonical unit and aggregate together on the shopping list.
  function normaliseUnit(unit) {
    if (!unit) return "";
    const probe = Units.parseIngredient(`1 ${unit} x`);
    return probe.unit || String(unit).toLowerCase();
  }

  return { clipFromUrl, clipFromPhoto, clipFromText, MODEL };
});
