"use client";

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { useI18n } from "@/components/providers/I18nProvider";
import { resolveSupportedLocale } from "@/lib/i18n/locales";

type Props = {
  text: string;
  sourceLocale?: string | null;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
};

function normalizeEvidenceLocale(value?: string | null) {
  const normalized = String(value || "en")
    .toLowerCase()
    .trim()
    .replace("_", "-")
    .split("-")[0];

  return /^[a-z]{2,3}$/.test(normalized)
    ? normalized
    : "en";
}

export default function LocalizedEvidenceText({
  text,
  sourceLocale,
  active = true,
  className,
  style,
}: Props) {
  const { locale, t } = useI18n();
  const targetLocale = resolveSupportedLocale(locale);
  const normalizedSource = normalizeEvidenceLocale(sourceLocale);

  const shouldTranslate =
    active
    && Boolean(text.trim())
    && normalizedSource !== targetLocale;

  const [translated, setTranslated] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setTranslated(null);
    setShowOriginal(false);
    setFailed(false);

    if (!shouldTranslate) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    void fetch("/api/i18n/localize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        sourceLocale: normalizedSource,
        targetLocale,
      }),
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`translation_http_${response.status}`);
        }

        return await response.json() as { text?: string };
      })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setTranslated(
            typeof payload.text === "string" && payload.text.trim()
              ? payload.text
              : null,
          );
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setTranslated(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [
    normalizedSource,
    shouldTranslate,
    targetLocale,
    text,
  ]);

  const displayText = useMemo(() => {
    if (showOriginal || !translated) return text;
    return translated;
  }, [showOriginal, text, translated]);

  return (
    <div className="min-w-0">
      <div
        className={className}
        style={style}
        dir="auto"
      >
        {displayText}
      </div>

      {shouldTranslate ? (
        <div className="mt-2 flex min-h-6 items-center gap-2">
          {translated ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setShowOriginal((value) => !value);
              }}
              className="rounded-md border border-bg-border bg-bg-card/70 px-2 py-1 text-[10.5px] font-semibold text-content-muted transition hover:border-primary/35 hover:text-content"
            >
              {showOriginal
                ? t("analysis.translation.showTranslation")
                : t("analysis.translation.showOriginal")}
            </button>
          ) : null}

          {loading ? (
            <span className="text-[10px] text-content-faint">
              {t("analysis.translation.translating")}
            </span>
          ) : null}

          {translated && !showOriginal ? (
            <span className="text-[10px] text-content-faint">
              {t("analysis.translation.translated")}
            </span>
          ) : null}

          {failed ? (
            <span className="text-[10px] text-content-faint">
              {t("analysis.translation.unavailable")}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
