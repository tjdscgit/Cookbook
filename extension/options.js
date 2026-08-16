// options.js
(() => {
  "use strict";
  const $ = (sel) => document.querySelector(sel);

  function init() {
    const c = CookbookData.creds();
    $("#project").value = c.project || "";
    $("#apiKey").value = c.apiKey || "";
    $("#email").value = c.email || "";
    $("#key").value = c.anthropic || "";
    $("#btnSave").onclick = save;
  }

  async function save() {
    const status = $("#status");
    const btn = $("#btnSave");
    btn.disabled = true;
    status.classList.remove("err");
    status.textContent = "Saving…";
    CookbookData.setCreds({
      project: $("#project").value,
      apiKey: $("#apiKey").value,
      anthropic: $("#key").value,
    });
    try {
      // A password is only required the first time, or after signing out — an existing session
      // refreshes itself, so re-saving the other settings shouldn't demand it again.
      const password = $("#password").value;
      if (password || !CookbookData.isSignedIn()) {
        await CookbookData.signIn($("#email").value, password);
        $("#password").value = "";
      }
      await CookbookData.testConnection();
      status.textContent = "Saved — signed in and connected to Firestore.";
    } catch (e) {
      status.textContent = e.message;
      status.classList.add("err");
    } finally {
      btn.disabled = false;
    }
  }

  init();
})();
