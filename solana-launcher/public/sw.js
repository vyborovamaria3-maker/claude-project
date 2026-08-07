/* eslint-disable no-undef */
importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.1.0/workbox-sw.js");

const CACHE_PREFIX = "potapoff-v3";
const STATIC_CACHE = `${CACHE_PREFIX}-static`;
const API_CACHE = `${CACHE_PREFIX}-api`;
const ACTIVE_CACHES = new Set([STATIC_CACHE, API_CACHE]);

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith("potapoff-") && !ACTIVE_CACHES.has(name))
          .map((name) => caches.delete(name)),
      ),
    ),
  );
});

if (workbox) {
  workbox.setConfig({ debug: false });
  workbox.core.skipWaiting();
  workbox.core.clientsClaim();

  // App Router navigation must always resolve against the currently deployed
  // frontend. Caching HTML/RSC responses here can keep users on an old build
  // after deployment and produce mixed old/new Next.js chunks.
  workbox.routing.registerRoute(
    ({ request, url }) => request.mode === "navigate" && url.origin === self.location.origin,
    new workbox.strategies.NetworkOnly(),
  );

  // Next.js static assets are content-hashed, so stale-while-revalidate is safe.
  // The versioned cache name also guarantees a clean slate after this fix.
  workbox.routing.registerRoute(
    ({ request, url }) =>
      url.origin === self.location.origin &&
      ["style", "script", "worker", "font", "image"].includes(request.destination),
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: STATIC_CACHE,
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 160,
          maxAgeSeconds: 24 * 60 * 60,
          purgeOnQuotaError: true,
        }),
      ],
    }),
  );

  workbox.routing.registerRoute(
    ({ url, request }) =>
      request.method === "GET" &&
      url.origin === self.location.origin &&
      url.pathname.startsWith("/api/"),
    new workbox.strategies.NetworkFirst({
      cacheName: API_CACHE,
      networkTimeoutSeconds: 3,
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 80,
          maxAgeSeconds: 5 * 60,
          purgeOnQuotaError: true,
        }),
      ],
    }),
  );
}
