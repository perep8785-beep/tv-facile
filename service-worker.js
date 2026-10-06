const CACHE_NAME = "tv-facile-v20";
// The 41 MB voice model lives in its own cache so app updates never
// download it again (voice.js stores it there too).
const VOICE_CACHE = "tvf-voice-v1";

const APP_SHELL = [
  "./index.html",
  "./app.js",
  "./voice.js",
  "./data.json",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

// Always try the network first for these, so fixes and new episodes arrive.
const NETWORK_FIRST = ["/index.html", "/app.js", "/voice.js", "/data.json", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key !== VOICE_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function canonicalRequest(url) {
  const path = url.pathname.endsWith("/") ? "./index.html" : "." + url.pathname.slice(url.pathname.lastIndexOf("/"));
  return new Request(new URL(path, self.registration.scope));
}

async function networkFirst(request) {
  const canonical = canonicalRequest(new URL(request.url));
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(canonical, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(canonical);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate" || NETWORK_FIRST.some((p) => url.pathname.endsWith(p))) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (url.pathname.includes("/voice/")) {
    event.respondWith(cacheFirst(event.request, VOICE_CACHE));
    return;
  }

  event.respondWith(cacheFirst(event.request, CACHE_NAME));
});
