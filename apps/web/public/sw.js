/// <reference lib="webworker" />

// Bump this string on every shell-affecting deploy (M1.6 user report: a
// device that installed the SW before this version never re-evaluated
// itself because the constant never changed, so `activate`'s own
// old-cache-eviction loop below never had anything to actually evict).
// `skipWaiting`/`clients.claim` (below) already make the browser hand
// control to a new script promptly once it fetches one — this bump is
// what makes the fetch happen sooner (a changed script body ends the
// browser's up-to-24h byte-for-byte reuse of its last-seen sw.js) and
// guarantees this activation actually has a stale cache to remove.
const CACHE_NAME = "mihomo-orbit-v2";

// Assets to pre-cache on install
const PRECACHE_ASSETS = ["/", "/manifest.webmanifest"];

// Install event - pre-cache core assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch event - network first strategy
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Cache only same-origin http(s) requests.
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Skip API requests
  if (url.pathname.startsWith("/api/")) return;

  // Skip dev HMR stream endpoints.
  if (url.pathname.startsWith("/_next/webpack-hmr")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful GET requests
        if (response.status === 200) {
          const responseToCache = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, responseToCache))
              .catch(() => {
                // Ignore cache write failures
              }),
          );
        }

        return response;
      })
      .catch(() => {
        // Fallback to cache if network fails
        return caches.match(event.request).then((cached) => cached || Response.error());
      }),
  );
});

// Listen for skip waiting message
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
