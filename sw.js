// AgriVision service worker — resource-aware caching:
//   • navigations (HTML) → network-first (fresh on deploy, cached fallback offline)
//   • app code (js/css)  → stale-while-revalidate (instant + self-refreshing, no version bump)
//   • everything else    → cache-first (icons, versioned libs, tiles — effectively immutable)
// A new SW waits (no auto-skipWaiting) until the page asks it to activate via SKIP_WAITING,
// so the user gets an "update ready" prompt instead of a surprise mid-session swap.
// Bump CACHE_VERSION only for a hard purge (e.g. a breaking cache-shape change).
const CACHE_VERSION = "agriv-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./icon.svg",
  "./favicon.ico",
  "./favicon-32.png",
  "./favicon-16.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "./logo-chip.png",
];

self.addEventListener("install", (event) => {
  // Precache the shell as the offline fallback. Do NOT skipWaiting here — the new SW stays in
  // "waiting" until the page sends SKIP_WAITING (see below), which powers the update prompt.
  // (First install has nothing to wait behind, so it activates immediately anyway.)
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// The page calls this (on user "Recharger") to swap the waiting SW in immediately. The page's
// controllerchange listener then reloads into the new version.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// ===== Web Push (rain alerts) — fires even when the app is closed =====
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "AgriVision", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "AgriVision";
  const options = {
    body: data.body || "",
    icon: "./icon-192.png",
    badge: "./favicon-32.png",
    tag: data.tag || "agrivision-alert",
    data: { url: data.url || "./", ...data.data },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GET. Let API/POST requests pass through unchanged.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Don't touch cross-origin API calls (Anthropic, IGN, Dropbox, BAN, Wikipedia, iNat).
  // Cache cross-origin static libs (Leaflet, exifr, suncalc) opportunistically.
  const isStaticLib = /(unpkg\.com|jsdelivr\.net|tile\.openstreetmap)/.test(url.hostname);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isStaticLib) return;

  // 1) Navigations (the HTML document) → network-first: a fresh deploy is picked up while
  //    online; if offline, fall back to the precached shell so the app still boots.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put("./index.html", clone));
          return res;
        })
        .catch(() =>
          caches.match("./index.html").then((c) => c || caches.match("./"))
        )
    );
    return;
  }

  // 2) Same-origin app code (js/css) → stale-while-revalidate: serve the cached copy instantly,
  //    refetch in the background and update the cache so the NEXT load is fresh. This is what
  //    lets a deploy propagate without bumping CACHE_VERSION.
  if (sameOrigin && /\.(?:js|mjs|css)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || network; // cached → instant; else wait for network
        })
      )
    );
    return;
  }

  // 3) Everything else (icons, fonts, versioned libs, map tiles) → cache-first; these are
  //    effectively immutable, so the network is only hit on a cache miss.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && (sameOrigin || isStaticLib)) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached); // offline + nothing cached → reject naturally
    })
  );
});
