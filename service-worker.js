const CACHE_NAME = "tv-facile-v12";

const APP_SHELL = [
  "./index.html",
  "./data.json",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener(
  "install",
  event => {

    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then(cache =>
          cache.addAll(APP_SHELL)
        )
        .then(() =>
          self.skipWaiting()
        )
    );
  }
);

self.addEventListener(
  "activate",
  event => {

    event.waitUntil(
      caches
        .keys()
        .then(keys =>
          Promise.all(
            keys
              .filter(
                key =>
                  key !== CACHE_NAME
              )
              .map(
                key =>
                  caches.delete(key)
              )
          )
        )
        .then(() =>
          self.clients.claim()
        )
    );
  }
);

function canonicalRequest(url) {
  if (
    url.pathname.endsWith(
      "/data.json"
    )
  ) {
    return new Request(
      new URL(
        "./data.json",
        self.registration.scope
      )
    );
  }

  return new Request(
    new URL(
      "./index.html",
      self.registration.scope
    )
  );
}

async function networkFirst(
  request
) {
  const url =
    new URL(request.url);

  const canonical =
    canonicalRequest(url);

  try {
    /*
      IMPORTANT:

      Always request the newest
      index.html / data.json.
    */

    const response =
      await fetch(
        request,
        {
          cache: "no-store"
        }
      );

    if (
      response &&
      response.ok
    ) {
      const cache =
        await caches.open(
          CACHE_NAME
        );

      await cache.put(
        canonical,
        response.clone()
      );
    }

    return response;
  }

  catch (error) {
    const cached =
      await caches.match(
        canonical
      );

    if (cached) {
      return cached;
    }

    throw error;
  }
}

self.addEventListener(
  "fetch",
  event => {

    if (
      event.request.method !== "GET"
    ) {
      return;
    }

    const url =
      new URL(
        event.request.url
      );

    /*
      Do not intercept YouTube,
      thumbnails, etc.
    */

    if (
      url.origin !==
      self.location.origin
    ) {
      return;
    }

    /*
      NETWORK-FIRST:

      index.html
      navigation
      data.json
    */

    if (
      event.request.mode ===
        "navigate" ||

      url.pathname.endsWith(
        "/index.html"
      ) ||

      url.pathname.endsWith(
        "/data.json"
      )
    ) {
      event.respondWith(
        networkFirst(
          event.request
        )
      );

      return;
    }

    /*
      CACHE-FIRST:

      icons / manifest / shell
    */

    event.respondWith(
      caches
        .match(
          event.request
        )
        .then(cached => {

          if (cached) {
            return cached;
          }

          return fetch(
            event.request
          )
            .then(response => {

              if (
                response &&
                response.ok
              ) {
                const copy =
                  response.clone();

                caches
                  .open(
                    CACHE_NAME
                  )
                  .then(
                    cache =>
                      cache.put(
                        event.request,
                        copy
                      )
                  );
              }

              return response;
            });
        })
    );
  }
);
