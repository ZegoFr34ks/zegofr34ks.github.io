// service-worker.js
// 🔥 IMPORTANT: Increment this version number whenever you deploy changes
const CACHE_VERSION = "v251220250717"; // Change this to v3, v4, etc. on each deploy //IMPORTANT TO CHANGE EACH DEPLOY
const CACHE_NAME = `music-player-${CACHE_VERSION}`;

// Optional: List critical files to cache immediately on install
const PRECACHE_URLS = [
  './', // Your main HTML file
  './gallery.css',
  // Add other critical assets here
];

// Install event - precache critical files and skip waiting
self.addEventListener("install", event => {
  console.log(`[SW] Installing version ${CACHE_VERSION}`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Precaching critical files');
        return cache.addAll(PRECACHE_URLS);
      })
      .then(() => self.skipWaiting()) // Force activation immediately
  );
});

// Activate event - delete old caches
self.addEventListener("activate", event => {
  console.log(`[SW] Activating version ${CACHE_VERSION}`);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Delete any cache that doesn't match current version
          if (cacheName.startsWith('music-player-') && cacheName !== CACHE_NAME) {
            console.log(`[SW] Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    })
    .then(() => self.clients.claim()) // Take control of all pages immediately
  );
});

// Fetch event - serve from cache, fall back to network
self.addEventListener("fetch", event => {
  // Only cache GET requests
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  
  // For HTML files, try network first (so updates are immediate)
  if (url.pathname.endsWith('.html') || url.pathname === url.origin + '/') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache the new version
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request)) // Fallback to cache if offline
    );
    return;
  }

  // For other files (audio, images, CSS, JS): cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request)
        .then(response => {
          // Only cache successful responses
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});