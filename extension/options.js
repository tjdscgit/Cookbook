// options.js
(() => {
  "use strict";
  const $ = (sel) => document.querySelector(sel);

  function init() {
    const c = CookbookData.creds();
    $("#pat").value = c.pat || "";
    $("#base").value = c.base || "";
    $("#key").value = c.anthropic || "";
    $("#btnSave").onclick = save;
  }

  async function save() {
    const status = $("#status");
    const btn = $("#btnSave");
    btn.disabled = true;
    status.classList.remove("err");
    status.textContent = "Saving…";
    CookbookData.setCreds({ pat: $("#pat").value, base: $("#base").value, anthropic: $("#key").value });
    try {
      await CookbookData.testConnection();
      status.textContent = "Saved — connection to Airtable confirmed.";
    } catch (e) {
      status.textContent = e.message;
      status.classList.add("err");
    } finally {
      btn.disabled = false;
    }
  }

  init();
})();
