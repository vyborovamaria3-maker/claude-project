"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TrendingUp, TrendingDown } from "lucide-react";
import clsx from "clsx";
import { useI18n } from "@/components/providers/I18nProvider";
import type { TrendingToken } from "@/app/api/trending/route";

export default function TrendingBar() {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<TrendingToken[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const r = await fetch("/api/trending", { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && Array.isArray(data) && data.length > 0) {
          setTokens(data);
        }
      } catch {
        // keep previous state on error
      }
    }

    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (tokens.length === 0) return (
    <div
      data-tag="trending.bar"
      className="min-w-0 max-w-full border-b border-bg-border/70 bg-bg/70 backdrop-blur-xl glass-strong"
    >
      <div className="min-w-0 px-4 sm:px-5 py-2 flex items-center gap-3 sm:gap-4 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0 text-xs uppercase tracking-widest text-content-muted">
          <TrendingUp className="w-3.5 h-3.5 text-primary" />
          {t("trending.title")}
        </div>
        <div className="flex items-center gap-2 text-xs text-content-faint animate-pulse">
          {t("trending.loading")}
        </div>
      </div>
    </div>
  );

  return (
    <div
      data-tag="trending.bar"
      className="min-w-0 max-w-full border-b border-bg-border/70 bg-bg/70 backdrop-blur-xl glass-strong"
    >
      <div className="min-w-0 px-4 sm:px-5 py-2 flex items-center gap-3 sm:gap-4 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0 text-xs uppercase tracking-widest text-content-muted">
          <TrendingUp className="w-3.5 h-3.5 text-primary" />
          {t("trending.title")}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {tokens.map((t, i) => (
            <Link
              key={`${t.id}-${i}`}
              href={`/token-launch/chart?mint=${t.mint}`}
              data-tag="trending.item"
              className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-full border border-bg-border bg-bg-card/70 hover:border-primary-border hover:bg-bg-elevated transition"
            >
              <span className="w-5 h-5 rounded bg-[color-mix(in_srgb,var(--theme-secondary)_18%,transparent)] border border-neon-purple/30 text-[10px] flex items-center justify-center text-neon-purple font-bold">
                {t.icon}
              </span>
              <span className="text-xs text-content-soft">{t.name.length > 12 ? t.name.slice(0, 12) + "\u2026" : t.name}</span>
              <span className="text-xs font-semibold text-content">{t.ticker}</span>
              <span className="text-xs text-content-muted">{t.price}</span>
              <span
                className={clsx(
                  "text-[10px] flex items-center gap-0.5",
                  t.changePct >= 0 ? "text-success" : "text-danger"
                )}
              >
                {t.changePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {t.changePct >= 0 ? "+" : ""}
                {t.changePct.toFixed(1)}%
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
