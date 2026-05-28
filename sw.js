// AgriVision service worker — cache-first for app shell + same-origin assets.
// Bump CACHE_VERSION on app updates.
const CACHE_VERSION = "agriv-v1";
const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GET. Let API/POST requests pass through unchanged.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Don't cache cross-origin API calls (Anthropic, IGN, Dropbox, BAN, Wikipedia, iNat).
  // Cache cross-origin static libs (Leaflet, exifr, suncalc) opportunistically.
  const isStaticLib = /(unpkg\.com|jsdelivr\.net|tile\.openstreetmap)/.test(url.hostname);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isStaticLib) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && (sameOrigin || isStaticLib)) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => cached);  // offline + nothing cached → reject naturally
    })
  );
});
