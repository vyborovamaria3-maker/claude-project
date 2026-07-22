"use client";

import { useEffect } from "react";
import { apiFetch } from "../lib/api";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

export function MiniAppAutoLogin({ onAuthenticated }: { onAuthenticated: () => void }) {
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const sdk = await import("@telegram-apps/sdk-react");
        void sdk;
      } catch {
        // The global Telegram WebApp object is enough for auth; the SDK is loaded when bundled.
      }

      window.Telegram?.WebApp?.ready?.();
      window.Telegram?.WebApp?.expand?.();
      const initData = window.Telegram?.WebApp?.initData;
      if (!initData) return;

      await apiFetch("/api/auth/telegram", {
        method: "POST",
        body: JSON.stringify({ initData })
      });
      if (!cancelled) onAuthenticated();
    }

    run().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [onAuthenticated]);

  return null;
}
