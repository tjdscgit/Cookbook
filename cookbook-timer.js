// cookbook-timer.js
// Finds a cooking time in a method step ("cook for 2 to 3 minutes") so cook mode can offer a timer.
//
// Same UMD shape as cookbook-units.js so `node cookbook-timer.test.js` can load it with no build
// step. The rule comes from the redesign brief: "N minutes", "N to M minutes" (use M),
// "1 1/2 minutes", "N seconds", "N hours". The first time in the step wins.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./cookbook-units.js"));
  } else {
    root.CookbookTimer = factory(root.CookbookUnits);
  }
})(typeof self !== "undefined" ? self : this, function (Units) {
  "use strict";

  const TIME_RE = /(\d+)(?:\s+(\d)\/(\d))?(?:\s*to\s*(\d+))?\s*(hours?|minutes?|mins?|seconds?|secs?)/i;

  // Returns { s, label } (seconds, and the "3 min" / "45 sec" text for the button) or null.
  function timerFor(text) {
    const m = String(text || "").match(TIME_RE);
    if (!m) return null;
    let n = Number(m[4] || m[1]);
    if (!m[4] && m[2]) n += Number(m[2]) / Number(m[3]);
    const u = m[5].toLowerCase();
    const s = Math.round(u.startsWith("h") ? n * 3600 : u.startsWith("s") ? n : n * 60);
    if (!s) return null;
    const label = s < 60 ? `${s} sec` : `${Units.formatQty(s / 60)} min`;
    return { s, label };
  }

  // 161 -> "2:41"
  function clock(s) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  return { timerFor, clock };
});
