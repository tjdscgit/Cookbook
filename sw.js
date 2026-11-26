// v2 was the Airtable → Firestore move, v3/v4 the "Editorial Press" redesign. v5 is the redesign
// from design/cookbook-redesign.html (new shell, tokens, cook-mode timers); v6 its Plan and Shop
// screens; v7 Add a recipe and sharing in (POST share target). Bump this on every deploy so devices
// drop the old shell.
const CACHE_NAME = "cookbook-shell-v7";
const SHELL_FILES = [
  "./index.html",
  "./cookbook.css",
  "./cookbook-units.js",
  "./cookbook-timer.js",
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
      Promise.all(names.filter((n) => n !== CACHE_NAME && n !== SHARE_CACHE).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never touch Firestore/Anthropic/cross-origin
  // Share → Cookbook (manifest share_target, POST multipart). Images are parked in their own cache
  // for the page to pick up; the link and text ride along in the redirect's query string.
  if (req.method === "POST" && url.pathname.endsWith("/share")) {
    event.respondWith(receiveShare(req));
    return;
  }
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

const SHARE_CACHE = "cookbook-share";
async function receiveShare(req) {
  const back = new URL("./", self.registration.scope);
  back.searchParams.set("shared", "1");
  try {
    const form = await req.formData();
    for (const k of ["url", "text", "title"]) {
      const v = form.get(k);
      if (v) back.searchParams.set(k, String(v).slice(0, 2000));
    }
    const files = form.getAll("files").filter((f) => f && typeof f === "object" && f.size);
    if (files.length) {
      await caches.delete(SHARE_CACHE);
      const cache = await caches.open(SHARE_CACHE);
      await Promise.all(files.slice(0, 6).map((f, i) => cache.put(
        new Request(`./shared-file-${i}`),
        new Response(f, { headers: { "content-type": f.type || "image/jpeg", "x-name": encodeURIComponent(f.name || `image-${i + 1}`) } })
      )));
      back.searchParams.set("files", String(Math.min(files.length, 6)));
    }
  } catch { /* still open the app */ }
  return Response.redirect(back.href, 303);
}
