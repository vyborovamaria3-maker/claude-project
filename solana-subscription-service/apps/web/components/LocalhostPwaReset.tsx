"use client";

import { useEffect } from "react";

function isLocalhostHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function LocalhostPwaReset() {
  useEffect(() => {
    if (!isLocalhostHost(window.location.hostname)) return;

    const resetKey = "solsub:localhost-pwa-reset";
    if (sessionStorage.getItem(resetKey) === "1") return;
    sessionStorage.setItem(resetKey, "1");

    void (async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      } catch {
        // Best-effort cleanup only.
      }

      try {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((cacheName) => caches.delete(cacheName)));
      } catch {
        // Best-effort cleanup only.
      }
    })();
  }, []);

  return null;
}
