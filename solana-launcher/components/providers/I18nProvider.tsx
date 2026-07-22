"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { detectBrowserLocale, LOCALE_COOKIE_NAME, LOCALE_STORAGE_KEY, SOURCE_LOCALE, resolveSupportedLocale } from "@/lib/i18n/locales";
import { getMessages, hasTranslationLocale, type TranslationKey } from "@/lib/i18n/translations";

type I18nContextValue = {
  locale: string;
  setLocale: (locale: string) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function setLocaleCookie(locale: string) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

function interpolate(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function I18nProvider({ initialLocale, children }: { initialLocale?: string; children: React.ReactNode }) {
  const [locale, setLocaleState] = useState(() => resolveSupportedLocale(initialLocale ?? SOURCE_LOCALE));

  useEffect(() => {
    const savedLocale = typeof window === "undefined" ? null : window.localStorage.getItem(LOCALE_STORAGE_KEY);
    const browserLocale = detectBrowserLocale();
    const nextLocale = resolveSupportedLocale(savedLocale || initialLocale || browserLocale || SOURCE_LOCALE);
    setLocaleState(nextLocale);
    document.documentElement.lang = nextLocale;
    setLocaleCookie(nextLocale);
  }, [initialLocale]);

  const setLocale = useCallback((nextLocale: string) => {
    const resolved = resolveSupportedLocale(nextLocale);
    setLocaleState(resolved);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, resolved);
      setLocaleCookie(resolved);
    }
    document.documentElement.lang = resolved;
  }, []);

  const t = useCallback((key: TranslationKey, vars?: Record<string, string | number>) => {
    const messages = getMessages(hasTranslationLocale(locale) ? locale : SOURCE_LOCALE) as Record<string, string>;
    const fallbackMessages = getMessages(SOURCE_LOCALE) as Record<string, string>;
    const template = messages[key] ?? fallbackMessages[key] ?? key;
    return interpolate(template, vars);
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}

export function useOptionalI18n() {
  return useContext(I18nContext);
}
