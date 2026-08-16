// Bumped to v2 for the Airtable → Firestore move. A device still holding the v1 shell would keep
// running the old data layer against a backend that no longer answers, so the old cache has to go.
const CACHE_NAME = "cookbook-shell-v2";
const SHELL_FILES = [
  "./index.html",
  "./cookbook.css",
  "./cookbook-units.js",
  "./cookbook-data.js",
  "./cookbook-clip.js",
  "./cookbook-ui.js",
  "./cookbook-plan.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// GitHub Pages serves static files with `Cache-Control: max-age=600`. A plain `fetch(req)` honours
// that HTTP header — so even a "network-first" strategy can silently hand back a browser-disk-cached
// response up to 10 minutes old with NO real network round-trip, which is exactly what let a stale
// build sit invisible on a phone in the farm planner. `cache:"no-store"` forces every request this
// worker makes (both the install-time precache and every runtime fetch) to bypass the HTTP cache
// layer entirely, so "network-first" actually means network, every time.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: "no-store" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never touch Firestore/Anthropic/cross-origin
  if (req.method !== "GET") return;

  event.respondWith(
    fetch(req, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
