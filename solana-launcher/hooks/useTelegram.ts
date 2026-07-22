"use client";

import { useEffect, useState, useCallback } from "react";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: {
    user?: { id: number; username?: string; first_name?: string };
  };
  colorScheme: "light" | "dark";
  ready: () => void;
  expand: () => void;
  sendData: (data: string) => void;
  onEvent: (event: string, callback: () => void) => void;
  offEvent: (event: string, callback?: () => void) => void;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
  };
};

export function useTelegram() {
  const [tg, setTg] = useState<TelegramWebApp | null>(null);
  const [user, setUser] = useState<{ id: number; username?: string; first_name?: string } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const webapp = window.Telegram?.WebApp;
    if (!webapp) return;
    webapp.ready();
    webapp.expand();
    setTg(webapp);
    setUser(webapp.initDataUnsafe?.user ?? null);
    setTheme(webapp.colorScheme);
    webapp.onEvent("themeChanged", () => setTheme(webapp.colorScheme));
    return () => {
      webapp.offEvent("themeChanged");
    };
  }, []);

  const sendData = useCallback(
    (data: Record<string, unknown>) => {
      tg?.sendData(JSON.stringify(data));
    },
    [tg]
  );

  const hapticImpact = useCallback(
    (style: "light" | "medium" | "heavy" = "medium") => {
      tg?.HapticFeedback?.impactOccurred(style);
    },
    [tg]
  );

  const hapticNotify = useCallback(
    (type: "error" | "success" | "warning") => {
      tg?.HapticFeedback?.notificationOccurred(type);
    },
    [tg]
  );

  return { tg, user, theme, sendData, hapticImpact, hapticNotify };
}
