/* eslint-disable no-undef */
importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.1.0/workbox-sw.js");

if (workbox) {
  workbox.setConfig({ debug: false });

  workbox.core.skipWaiting();
  workbox.core.clientsClaim();

  workbox.routing.registerRoute(
    ({ request }) => ["style", "script", "worker", "font", "image"].includes(request.destination),
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: "potapoff-static-assets",
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 120,
          maxAgeSeconds: 7 * 24 * 60 * 60,
          purgeOnQuotaError: true,
        }),
      ],
    }),
  );

  workbox.routing.registerRoute(
    ({ url, request }) => request.method === "GET" && url.origin === self.location.origin && url.pathname.startsWith("/api/"),
    new workbox.strategies.NetworkFirst({
      cacheName: "potapoff-api-cache",
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

  workbox.routing.registerRoute(
    ({ request, url }) => request.mode === "navigate" && url.origin === self.location.origin,
    new workbox.strategies.NetworkFirst({
      cacheName: "potapoff-pages",
      networkTimeoutSeconds: 3,
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 40,
          maxAgeSeconds: 24 * 60 * 60,
          purgeOnQuotaError: true,
        }),
      ],
    }),
  );
}
