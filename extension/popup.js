// popup.js — the clipper's UI. No proxy, no fetch-the-page-through-a-relay: the recipe is read
// straight out of the tab that's already open, via chrome.scripting.executeScript.
(() => {
  "use strict";
  const $ = (sel) => document.querySelector(sel);
  let clippedRecipe = null;

  function say(msg, isErr) {
    const el = $("#status");
    el.textContent = msg || "";
    el.classList.toggle("err", Boolean(isErr));
  }

  function showPreview(recipe) {
    clippedRecipe = recipe;
    $("#pvName").textContent = recipe.name;
    const bits = [`Serves ${recipe.servings} ${recipe.servingUnit}`];
    if (recipe.prepMinutes) bits.push(`${recipe.prepMinutes} min prep`);
    if (recipe.cookMinutes) bits.push(`${recipe.cookMinutes} min cook`);
    $("#pvMeta").textContent = bits.join(" · ");
    $("#pvIngCount").textContent = recipe.ingredients.length;
    $("#pvStepCount").textContent = recipe.steps.length;
    if (recipe.photoUrl) { $("#pvPhoto").src = recipe.photoUrl; $("#pvPhoto").hidden = false; }
    else { $("#pvPhoto").hidden = true; }
    $("#preview").hidden = false;
  }

  async function doClip() {
    const btn = $("#btnClip");
    btn.disabled = true;
    $("#preview").hidden = true;
    say("Reading the page…");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab.");

      const [{ result: extraction }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: window.CookbookClipExt.extractPageData,
      });

      say(extraction.recipe ? "Found structured recipe data — reading directly." : "No structured data — trying Claude…");
      const recipe = await CookbookClipExt.buildRecipe(extraction, CookbookData.creds().anthropic);
      showPreview(recipe);
      say(recipe.confidence === "low" ? "Read it, but check the amounts before saving." : "Read it — check it over, then save.");
    } catch (e) {
      say(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function doSave() {
    if (!clippedRecipe) return;
    const btn = $("#btnSave");
    btn.disabled = true;
    btn.textContent = "Saving…";
    say("");
    try {
      const saved = await CookbookData.createRecipe(clippedRecipe);
      if (clippedRecipe.photoUrl) {
        try { await CookbookData.setPhotoFromUrl(saved.id, clippedRecipe.photoUrl); } catch { /* photo is optional */ }
      }
      say(`Saved "${saved.name}" to your Cookbook.`);
      $("#preview").hidden = true;
      clippedRecipe = null;
    } catch (e) {
      say(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Save to Cookbook";
    }
  }

  function openOptions() { chrome.runtime.openOptionsPage(); }

  function init() {
    const hasCreds = CookbookData.hasCreds();
    $("#noCreds").hidden = hasCreds;
    $("#main").hidden = !hasCreds;
    $("#btnClip").onclick = doClip;
    $("#btnSave").onclick = doSave;
    $("#btnDiscard").onclick = () => { $("#preview").hidden = true; clippedRecipe = null; say(""); };
    $("#btnOpenOptions").onclick = openOptions;
    $("#linkOptions").onclick = (e) => { e.preventDefault(); openOptions(); };
  }

  init();
})();
