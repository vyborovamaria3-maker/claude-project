"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BrainCircuit, Loader2, ShieldAlert, Sparkles, TrendingUp } from "lucide-react";

type Trade = {
  source?: string;
  maker?: string;
  side?: string;
  tokenAddress?: string;
  symbol?: string | null;
  amountUsd?: number | null;
  tokenAmount?: number | null;
  priceUsd?: number | null;
  buyCostUsd?: number | null;
  timestamp?: number | null;
  positionAction?: string | null;
  launchpad?: string | null;
  twitterUsername?: string | null;
  twitterName?: string | null;
  tags?: string[] | null;
  transactionHash?: string | null;
};

type KolsResponse = {
  configured?: boolean;
  available?: boolean;
  kolTrades?: Trade[];
  smartMoneyTrades?: Trade[];
  errors?: string[];
};

type Assessment = {
  currentSituation?: string;
  interpretation?: string;
  entryImpact?: string;
  supportingFeatureKeys?: string[];
  confidence?: number;
};

type KolsAiResponse = {
  available?: boolean;
  insufficient?: boolean;
  provider?: string;
  model?: string;
  summary?: string;
  confidence?: number;
  assessment?: Assessment | null;
  reasoningSummary?: string[];
  error?: string;
};

export default function KolAiAnalysis({ mint }: { mint: string }) {
  const [source, setSource] = useState<KolsResponse | null>(null);
  const [ai, setAi] = useState<KolsAiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function run() {
      setLoading(true);
      setSource(null);
      setAi(null);
      try {
        const response = await fetch(`/api/trade/kols?mint=${encodeURIComponent(mint)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as KolsResponse;
        if (!response.ok) throw new Error(`KOL source HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setSource(payload);

        const kolTrades = payload.kolTrades ?? [];
        const smartMoneyTrades = payload.smartMoneyTrades ?? [];
        if (kolTrades.length === 0 && smartMoneyTrades.length === 0) {
          setAi({ available: false, insufficient: true, summary: "Недостаточно свежих KOL / Smart Money данных для отдельного AI-анализа." });
          return;
        }

        const aiResponse = await fetch("/api/trade/kols-ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mint, kolTrades, smartMoneyTrades }),
          cache: "no-store",
          signal: controller.signal,
        });
        const aiPayload = (await aiResponse.json()) as KolsAiResponse;
        if (controller.signal.aborted) return;
        if (!aiResponse.ok) {
          setAi({ available: false, error: aiPayload.error || `AI HTTP ${aiResponse.status}` });
        } else {
          setAi(aiPayload);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setAi({ available: false, error: error instanceof Error ? error.message : "KOL AI unavailable" });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void run();
    return () => controller.abort();
  }, [mint]);

  const stats = useMemo(() => {
    const rows = [...(source?.kolTrades ?? []), ...(source?.smartMoneyTrades ?? [])];
    const buys = rows.filter((row) => row.side === "buy");
    const sells = rows.filter((row) => row.side === "sell");
    const sum = (items: Trade[]) => items.reduce((total, row) => total + Number(row.amountUsd || 0), 0);
    const tags = Array.from(new Set(rows.flatMap((row) => row.tags ?? [])));
    return {
      buys: buys.length,
      sells: sells.length,
      buyUsd: sum(buys),
      sellUsd: sum(sells),
      riskTags: tags.filter((tag) => ["wash_trader", "arbitrager", "sniper", "insider", "bundler"].includes(tag)),
    };
  }, [source]);

  const assessment = ai?.assessment ?? null;
  const confidence = assessment?.confidence ?? ai?.confidence;

  return (
    <section
      className="overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/10 via-bg-card to-bg-card shadow-sm"
      data-tag="trade.ai.source.kols"
    >
      <div className="flex flex-col gap-3 border-b border-primary/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
            <BrainCircuit className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-content">AI-анализ KOLs / Smart Money</h2>
            <p className="text-[10px] text-content-faint">Модель получает только текущий GMGN evidence этой вкладки</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {ai?.provider && <span className="rounded-full border border-bg-border bg-bg-card/70 px-2 py-1 text-[9px] text-content-faint">{ai.provider}{ai.model ? ` · ${ai.model}` : ""}</span>}
          <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 font-mono text-[10px] font-semibold text-content">
            {confidence == null ? "—" : `${Math.round(confidence * 100)}%`}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-36 items-center justify-center gap-2 px-4 py-8 text-xs text-content-faint">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> AI анализирует GMGN evidence…
        </div>
      ) : ai?.insufficient ? (
        <div className="px-4 py-7 text-xs leading-6 text-content-muted">
          {ai.summary || "Недостаточно KOL / Smart Money данных для отдельного AI-анализа."}
        </div>
      ) : ai?.error ? (
        <div className="flex items-start gap-2 px-4 py-6 text-xs leading-5 text-red-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>AI недоступен: {ai.error}</span>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniEvidence label="Buys" value={`${stats.buys} · ${usd(stats.buyUsd)}`} icon={<TrendingUp />} />
            <MiniEvidence label="Sells" value={`${stats.sells} · ${usd(stats.sellUsd)}`} icon={<TrendingUp />} />
            <MiniEvidence label="Net flow" value={usd(stats.buyUsd - stats.sellUsd, true)} icon={<Sparkles />} />
            <MiniEvidence label="Risk tags" value={stats.riskTags.length ? stats.riskTags.join(", ") : "none"} icon={<ShieldAlert />} />
          </div>

          {assessment ? (
            <div className="grid gap-3 lg:grid-cols-3">
              <Insight label="Что происходит" text={assessment.currentSituation} />
              <Insight label="Как это читать" text={assessment.interpretation} />
              <Insight label="Влияние на тезис" text={assessment.entryImpact} />
            </div>
          ) : (
            <p className="rounded-xl border border-bg-border bg-bg-card/65 p-3 text-xs leading-6 text-content-muted">{ai?.summary || "—"}</p>
          )}

          {Boolean(ai?.reasoningSummary?.length) && (
            <div className="rounded-xl border border-bg-border bg-bg-card/60 p-3">
              <div className="text-[9px] uppercase tracking-wider text-content-faint">AI evidence notes</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {(ai?.reasoningSummary || []).slice(0, 6).map((line, index) => (
                  <div key={`${index}-${line.slice(0, 24)}`} className="rounded-lg border border-bg-border bg-bg-elevated/35 px-3 py-2 text-[11px] leading-5 text-content-muted">{line}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MiniEvidence({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card/65 p-3">
      <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-content-faint">
        <span className="text-primary [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>{label}
      </div>
      <div className="mt-1 break-words font-mono text-sm font-semibold text-content">{value}</div>
    </div>
  );
}

function Insight({ label, text }: { label: string; text?: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card/65 p-3">
      <div className="text-[9px] uppercase tracking-wider text-content-faint">{label}</div>
      <p className="mt-2 text-xs leading-5 text-content-muted">{text || "—"}</p>
    </div>
  );
}

function usd(value: number, signed = false) {
  const sign = signed && value > 0 ? "+" : signed && value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 })}`;
}
