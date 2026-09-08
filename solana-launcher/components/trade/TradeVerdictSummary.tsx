"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, ShieldAlert, TimerReset } from "lucide-react";
import type { TwitterStats } from "@/app/api/trade/dev-twitter/route";
import { authHeaders } from "@/lib/clientAuth";
import {
  buildTradeAnalysisScore,
  type AnalysisChainInput,
  type TokenSocialMeta,
} from "@/lib/trade/analysis-score";

type Props = {
  mint: string;
  chain: AnalysisChainInput | null;
};

const TONE = {
  buy: {
    icon: CheckCircle2,
    border: "border-success/40",
    bg: "bg-success/10",
    text: "text-success",
  },
  wait: {
    icon: TimerReset,
    border: "border-warning/40",
    bg: "bg-warning/10",
    text: "text-warning",
  },
  avoid: {
    icon: ShieldAlert,
    border: "border-danger/40",
    bg: "bg-danger/10",
    text: "text-danger",
  },
  insufficient: {
    icon: HelpCircle,
    border: "border-bg-border",
    bg: "bg-white/5",
    text: "text-content-muted",
  },
};

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: authHeaders(),
    signal,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof json?.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json as T;
}

function normalizeMeta(payload: any): TokenSocialMeta | null {
  if (!payload || typeof payload !== "object") return null;
  return {
    symbol: typeof payload.symbol === "string" ? payload.symbol : null,
    name: typeof payload.name === "string" ? payload.name : null,
    socials: {
      twitter: payload.socials?.twitter ?? payload.twitter ?? null,
      telegram: payload.socials?.telegram ?? payload.telegram ?? null,
      website: payload.socials?.website ?? payload.website ?? null,
    },
  };
}

function shortSourceList(score: ReturnType<typeof buildTradeAnalysisScore>) {
  return [
    score.sources.chain ? "on-chain" : null,
    score.sources.x ? "X" : null,
    score.sources.provenance ? "provenance" : null,
    score.sources.telegramFirstCall ? "TG first-call" : null,
  ].filter(Boolean).join(" · ");
}

export default function TradeVerdictSummary({ mint, chain }: Props) {
  const [x, setX] = useState<TwitterStats | null>(null);
  const [meta, setMeta] = useState<TokenSocialMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!mint) return;
    const controller = new AbortController();
    setLoading(true);
    setWarning(null);
    setX(null);
    setMeta(null);

    void (async () => {
      let nextMeta: TokenSocialMeta | null = null;
      try {
        nextMeta = normalizeMeta(await fetchJson<any>(`/api/trade/token-info?mint=${encodeURIComponent(mint)}`, controller.signal));
        setMeta(nextMeta);
      } catch (error) {
        if (!controller.signal.aborted) {
          setWarning(`Metadata: ${error instanceof Error ? error.message : "недоступна"}`);
        }
      }

      const symbol = nextMeta?.symbol || "";
      try {
        const params = new URLSearchParams({ mint });
        if (symbol) params.set("symbol", symbol);
        const nextX = await fetchJson<TwitterStats>(`/api/trade/dev-twitter?${params.toString()}`, controller.signal);
        setX(nextX);
      } catch (error) {
        if (!controller.signal.aborted) {
          setWarning((current) => {
            const message = `X: ${error instanceof Error ? error.message : "недоступен"}`;
            return current ? `${current} · ${message}` : message;
          });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [mint]);

  const unified = useMemo(
    () => buildTradeAnalysisScore({ chain, x, meta }),
    [chain, x, meta],
  );
  const tone = TONE[unified.action];
  const Icon = tone.icon;
  const symbol = meta?.symbol ? `$${meta.symbol}` : mint.slice(0, 6);

  return (
    <section className={`surface-panel rounded-xl border ${tone.border} p-4`} data-tag="trade.main_findings">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className={`shrink-0 rounded-lg ${tone.bg} p-2 ${tone.text}`}>
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-sm font-semibold text-content">{symbol}</span>
              <h2 className={`text-lg font-bold ${tone.text}`}>{unified.title}</h2>
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-content-faint" />}
            </div>
            <p className="mt-1 text-sm leading-5 text-content-muted">{unified.oneLiner}</p>
            <p className="mt-2 text-xs leading-5 text-content-muted">
              Safe entry thesis: {unified.safeEntryThesis}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-right">
          <Score label="Score" value={unified.score} />
          <Score label="Risk" value={unified.risk} />
          <Score label="Trust" value={unified.confidence} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <FindingColumn title="За" rows={unified.reasonsFor} empty="пока нет сильных подтверждений" tone="for" />
        <FindingColumn title="Против" rows={unified.reasonsAgainst} empty="явных стоп-факторов в доступных данных нет" tone="against" />
        <div className="rounded-lg border border-bg-border bg-bg-card p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">Provenance / TG first-call</div>
          <div className="mt-2 space-y-1.5 text-xs leading-5 text-content-muted">
            {[...unified.provenance.notes, ...unified.firstCall.notes].map((note) => (
              <div key={note} className="flex gap-2">
                <span className="text-content-faint">•</span>
                <span>{note}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(warning || unified.missing.length > 0) && (
        <div className="mt-4 flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-content-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            Источники: {shortSourceList(unified) || "нет"}.
            {unified.missing.length > 0 ? ` Не хватает: ${unified.missing.join(", ")}.` : ""}
            {warning ? ` ${warning}.` : ""}
          </span>
        </div>
      )}
    </section>
  );
}

function Score({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-card px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-content-faint">{label}</div>
      <div className="mt-1 font-mono text-base font-bold text-content">{value == null ? "—" : Math.round(value)}</div>
    </div>
  );
}

function FindingColumn({
  title,
  rows,
  empty,
  tone,
}: {
  title: string;
  rows: string[];
  empty: string;
  tone: "for" | "against";
}) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-card p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">{title}</div>
      <div className="mt-2 space-y-1.5">
        {rows.length > 0 ? rows.slice(0, 4).map((row) => (
          <div key={row} className="flex gap-2 text-xs leading-5 text-content-muted">
            <span className={tone === "for" ? "text-success" : "text-danger"}>
              {tone === "for" ? "+" : "-"}
            </span>
            <span>{row}</span>
          </div>
        )) : (
          <div className="text-xs leading-5 text-content-faint">{empty}</div>
        )}
      </div>
    </div>
  );
}
