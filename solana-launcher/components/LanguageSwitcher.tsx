"use client";

import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { DynamicFlag } from "@sankyu/react-circle-flags";
import {
  getLocaleFlagCountryCode,
  getLocaleLabel,
  LOCALE_COOKIE_NAME,
  LOCALE_STORAGE_KEY,
  PENDING_LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  resolveSupportedLocale,
} from "@/lib/i18n/locales";
import { useI18n } from "@/components/providers/I18nProvider";

function setLocaleCookie(locale: string) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

type LanguageStatus = {
  ok: boolean;
  provider: string;
  fallbackLocale: string;
  reason: string | null;
};

function LocaleFlag({ locale }: { locale: string }) {
  const countryCode = getLocaleFlagCountryCode(locale);

  return (
    <DynamicFlag
      code={countryCode}
      width={20}
      height={20}
      title=""
      aria-hidden="true"
      className="h-5 w-5 shrink-0 rounded-full ring-1 ring-white/10 shadow-inner"
    />
  );
}

export default function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [languageStatus, setLanguageStatus] = useState<LanguageStatus | null>(null);
  const [mounted, setMounted] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const currentLocale = resolveSupportedLocale(locale);
  const currentLocaleLabel = getLocaleLabel(currentLocale);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      try {
        const response = await fetch("/api/i18n/status");
        const data = (await response.json()) as LanguageStatus;
        if (!cancelled) {
          setLanguageStatus(data);
        }
      } catch (cause) {
        if (!cancelled) {
          setLanguageStatus({
            ok: false,
            provider: "lingo.dev",
            fallbackLocale: "en",
            reason: cause instanceof Error ? cause.message : "Status unavailable",
          });
        }
      }
    }

    checkStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    function updatePosition() {
      const anchor = buttonRef.current?.getBoundingClientRect();
      if (!anchor) return;

      const vw = document.documentElement.clientWidth;
      const menuWidth = Math.min(300, vw - 24);
      const right = Math.max(0, vw - anchor.right);
      const top = anchor.bottom + 10;

      setPanelStyle({
        position: "fixed",
        top,
        right,
        width: menuWidth,
        zIndex: 9999,
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, currentLocale]);

  const filteredLocales = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return SUPPORTED_LOCALES.filter((value) => {
      if (!normalizedQuery) return true;
      const label = getLocaleLabel(value).toLowerCase();
      return value.includes(normalizedQuery) || label.includes(normalizedQuery);
    });
  }, [query]);

  async function handleLocaleChange(nextLocale: string) {
    const normalized = resolveSupportedLocale(nextLocale);
    const lingoLocale = normalized as typeof locale;

    if (normalized === resolveSupportedLocale(locale)) {
      setIsOpen(false);
      return;
    }

    setError("");

    try {
      window.localStorage.setItem(PENDING_LOCALE_STORAGE_KEY, normalized);
      window.localStorage.setItem(LOCALE_STORAGE_KEY, normalized);
      setLocaleCookie(normalized);
      setLocale(lingoLocale);
      setIsOpen(false);
    } catch {
      window.localStorage.removeItem(PENDING_LOCALE_STORAGE_KEY);
      window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
      setLocaleCookie("en");
      setLocale("en");
      setError(t("language.fallbackError"));
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 text-content-muted shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/10 hover:text-content hover:shadow-[0_10px_30px_rgba(0,0,0,0.26)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={t("language.chooseCurrent", { language: currentLocaleLabel })}
        aria-expanded={isOpen}
      >
        <LocaleFlag locale={currentLocale} />
        <span className="max-w-28 truncate text-sm font-medium tracking-tight">{currentLocaleLabel}</span>
        <ChevronDown
          className={[
            "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
            isOpen ? "rotate-180" : "rotate-0",
          ].join(" ")}
        />
      </button>

      {mounted && isOpen
        ? createPortal(
            <div
              ref={menuRef}
              role="dialog"
              aria-label={t("language.selection")}
              aria-hidden={!isOpen}
              style={panelStyle}
              className="origin-top-right rounded-2xl border border-white/10 bg-bg/95 p-2.5 shadow-[0_20px_50px_rgba(0,0,0,0.32)] backdrop-blur-xl transition-all duration-200 ease-out will-change-transform animate-[language-menu-in_160ms_ease-out]"
            >
              <div className="mb-2 flex items-center gap-2 rounded-xl border border-bg-border bg-bg-elevated px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 text-content-muted" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("language.search")}
                  className="w-full bg-transparent text-xs text-content outline-none placeholder:text-content-faint"
                />
              </div>

              {languageStatus && !languageStatus.ok ? (
                <div className="mb-2 text-[11px] text-warning">
                  {t("language.fallbackWarning")}
                  {languageStatus.reason ? ` (${languageStatus.reason})` : null}
                </div>
              ) : null}

              {error ? <div className="mb-2 text-[11px] text-warning">{error}</div> : null}

              <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {filteredLocales.map((value) => {
                  const active = value === resolveSupportedLocale(locale);
                  const label = getLocaleLabel(value);

                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleLocaleChange(value)}
                      className={[
                        "flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-sm transition",
                        active
                          ? "bg-primary/15 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                          : "text-content-muted hover:bg-bg-elevated hover:text-content",
                      ].join(" ")}
                    >
                      <span className="flex min-w-0 items-center gap-2 truncate">
                        <LocaleFlag locale={value} />
                        <span className="truncate">{label}</span>
                      </span>
                      <span className="ml-3 flex items-center gap-2 shrink-0">
                        {active && <Check className="h-4 w-4" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
