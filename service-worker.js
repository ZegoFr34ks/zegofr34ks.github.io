// service-worker.js
const CACHE_NAME = "music-player-v1";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME));
});

self.addEventListener("fetch", event => {
  // Only cache GET requests for audio and images
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // Serve from cache if present
      if (cached) return cached;

      // Otherwise fetch and cache it
      return fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached); // fallback if offline
    })
  );
});
