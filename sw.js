/* =========================================================
   TINDER — sw.js  (Version 3)

   Two things were wrong with the old worker:

     1. cache.addAll() is all-or-nothing. A single file that
        404s made the whole installation fail, and a service
        worker that never installs means the app is never
        installable — no install prompt, no 📥 button.

     2. Every request was answered from the cache first. After
        a deploy, anyone who had already opened the app kept
        seeing the old copy forever, because the new files were
        never fetched.

   The app shell now goes to the network first and falls back to
   the cache when offline, so an update lands on the next visit.
   ========================================================= */

const CACHE_NAME = "tinder-message-v3";

const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-192.png",
  "./icon-maskable-512.png"
];

/* ---------------- INSTALL ---------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      /* Added one at a time: a missing file can no longer take the
         whole installation down with it. */
      .then((cache) => Promise.all(
        FILES_TO_CACHE.map((url) => cache.add(url).catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

/* ---------------- ACTIVATE ---------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* The page asks a waiting worker to take over straight away */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ---------------- STRATEGIES ---------------- */

/* HTML, CSS and JS: always try the network, so updates arrive */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;

    /* Offline, and this exact URL was never cached: a navigation can
       still be answered with the app shell. */
    if (request.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return new Response("You are offline.", {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/* Icons and other static files: cache is fine, they rarely change */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    return new Response("You are offline.", {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/plain" }
    });
  }
}

function isShellRequest(request, url) {
  if (request.mode === "navigate") return true;
  return /\.(html|css|js)$/.test(url.pathname) || /manifest\.json$/.test(url.pathname);
}

/* ---------------- FETCH ---------------- */
self.addEventListener("fetch", (event) => {
  const request = event.request;

  /* Only plain reads are cacheable */
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /* chrome-extension:, data:, blob: and friends cannot be stored,
     and trying to store them throws inside the worker */
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  /* Firebase realtime traffic and the Firebase SDK live on other
     origins. They must reach the network untouched — a cached
     database response would show stale messages. */
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    isShellRequest(request, url) ? networkFirst(request) : cacheFirst(request)
  );
});
