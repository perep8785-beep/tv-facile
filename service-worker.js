const CACHE = "tv-facile-v10";

self.addEventListener("install", event => {{
  self.skipWaiting();
}});

self.addEventListener("activate", event => {{
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
}});

self.addEventListener("fetch", event => {{
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate" || url.pathname.endsWith("/index.html")) {{
    event.respondWith(
      fetch(event.request, {{cache:"no-store"}})
        .catch(() => caches.match(event.request))
    );
    return;
  }}

  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
}});
