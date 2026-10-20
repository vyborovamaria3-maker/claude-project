"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, Coins, RefreshCw, TrendingUp } from "lucide-react";

type TokenRow = {
  chain_id: string; mint: string; symbol: string | null; name: string | null; first_seen_at: string;
  mentions_7d: number; sources_7d: number; velocity_5m: number | null; price_usd: string | null;
  liquidity_usd: string | null; volume_1h: string | null; market_cap_estimate: string | null;
  market_observed_at: string | null; first_mention_at: string | null; first_mention_channel: string | null;
  narratives: string[];
};
type ChannelRow = {
  source_id: string; identifier: string; discovery_score: number | null; outcome_score: number | null;
  originality_score: number | null; risk_score: number | null; composite_score: number | null;
  sample_size: number; confidence_lower: number | null; confidence_upper: number | null; computed_at: string;
};
type SignalRow = {
  id: string; signal_type: string; mint: string; confidence: number; detected_at: string;
  model_version: string; status: string; source_identifier: string | null;
};
type Snapshot = {
  tokenStats: {
    tokens_total: number; unresolved_addresses: number; analysis_backfill_remaining: number; ticker_mentions_24h: number;
    confirmed_tokens_24h: number; signals_24h: number; market_snapshots_24h: number;
  };
  tokens: TokenRow[];
  channels: ChannelRow[];
  unresolvedTickers: { ticker: string; evidence_count: number; last_seen_at: string }[];
  signals: SignalRow[];
};

const endpoint = "/api/integrations/tg-collector?mode=memecoin";
function fmt(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: digits });
}
function usd(value: string | null): string {
  if (value === null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return n < 0.0001 ? "$" + n.toExponential(2) : "$" + n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString("ru-RU") : "—";
}
function shortMint(mint: string): string {
  return mint.length > 14 ? mint.slice(0, 6) + "…" + mint.slice(-5) : mint;
}

export default function TGMemecoinAnalytics({ authToken }: { authToken: string }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(endpoint, {
        cache: "no-store", signal,
        headers: authToken ? { Authorization: "Bearer " + authToken } : {},
      });
      const body = await response.json() as Snapshot & { error?: string };
      if (!response.ok) throw new Error(body.error || "Не удалось загрузить мемкоин-аналитику");
      if (!signal?.aborted) { setData(body); setError(null); setUpdatedAt(new Date().toISOString()); }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Ошибка API аналитики");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);

  const stats = data?.tokenStats;
  const cards = [
    { title: "Проверенные mint", value: stats?.tokens_total ?? 0, icon: Coins },
    { title: "Адреса на проверке", value: stats?.unresolved_addresses ?? 0, icon: AlertTriangle },
    { title: "Токены · 24 ч", value: stats?.confirmed_tokens_24h ?? 0, icon: Activity },
    { title: "Тикеры · 24 ч", value: stats?.ticker_mentions_24h ?? 0, icon: TrendingUp },
    { title: "Сигналы · 24 ч", value: stats?.signals_24h ?? 0, icon: Activity },
    { title: "Снимки рынка · 24 ч", value: stats?.market_snapshots_24h ?? 0, icon: TrendingUp },
  ];

  return (
    <section className="surface-panel mt-5 space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-content">Solana Memecoin Intelligence</h3>
          <p className="mt-1 text-xs text-content-muted">Первые наблюдения, скорость упоминаний, рейтинг каналов и реальные снимки рынка.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-content-muted">Обновлено: {date(updatedAt)}</span>
          <button type="button" onClick={() => void load()} disabled={loading}
            className="rounded-lg border border-bg-border px-3 py-2 text-xs text-content-muted hover:text-content disabled:opacity-50">
            <RefreshCw className={"mr-1 inline h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} /> Обновить
          </button>
        </div>
      </div>
      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">{error}</div>}
      {(stats?.analysis_backfill_remaining ?? 0) > 0 && (
        <p role="status" className="text-xs text-amber-300">
          Аналитика v4 ещё пересчитывается: {fmt(stats?.analysis_backfill_remaining,0)} сообщений осталось
          переиндексировать. Статистика упоминаний включает актуальные версии v3/v4 без двойного подсчёта,
          но производные рейтинги и скорость могут быть неполными до analyze:backfill и analyze:refresh.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => {
          const Icon = card.icon;
          return <div key={card.title} className="rounded-xl border border-bg-border bg-bg-soft p-3">
            <Icon className="mb-2 h-4 w-4 text-content-muted" />
            <div className="text-xs text-content-muted">{card.title}</div>
            <div className="mt-1 text-xl font-semibold text-content">{fmt(card.value, 0)}</div>
          </div>;
        })}
      </div>

      <div>
        <h4 className="mb-3 text-sm font-semibold text-content">Токены по активности за 7 дней</h4>
        <div className="overflow-x-auto rounded-xl border border-bg-border">
          <table className="min-w-[1000px] w-full text-left text-xs">
            <thead className="bg-bg-soft text-content-muted"><tr>
              {["Токен / mint","Упоминания","Каналы","Скорость / сек","Цена","Ликвидность","Объём 1 ч","Первое в собранной истории","Нарративы"].map((x) =>
                <th key={x} className="px-3 py-3 font-medium">{x}</th>)}
            </tr></thead>
            <tbody>
              {(data?.tokens ?? []).map((token) => <tr key={token.chain_id + ":" + token.mint} className="border-t border-bg-border">
                <td className="px-3 py-3">
                  <div className="font-semibold text-content">{token.symbol || token.name || "Unknown token"}</div>
                  <a className="text-content-muted hover:text-content" href={"https://solscan.io/token/" + encodeURIComponent(token.mint)} target="_blank" rel="noopener noreferrer" title={token.mint}>{shortMint(token.mint)} ↗</a>
                  <div className="mt-1 text-[10px] text-content-muted">Mint проверен Alchemy · {date(token.first_seen_at)}</div>
                </td>
                <td className="px-3 py-3 text-content">{fmt(token.mentions_7d, 0)}</td>
                <td className="px-3 py-3 text-content">{fmt(token.sources_7d, 0)}</td>
                <td className="px-3 py-3 text-content">{fmt(token.velocity_5m, 5)}</td>
                <td className="px-3 py-3 text-content">{usd(token.price_usd)}<div className="mt-1 text-[10px] text-content-muted">{date(token.market_observed_at)}</div></td>
                <td className="px-3 py-3 text-content">{usd(token.liquidity_usd)}</td>
                <td className="px-3 py-3 text-content">{usd(token.volume_1h)}</td>
                <td className="px-3 py-3 text-content">{token.first_mention_channel ? "@" + token.first_mention_channel : "—"}<div className="mt-1 text-[10px] text-content-muted">{date(token.first_mention_at)}</div></td>
                <td className="px-3 py-3"><div className="flex max-w-48 flex-wrap gap-1">{token.narratives?.length
                  ? token.narratives.map((narrative) => <span key={narrative} className="rounded-md border border-bg-border px-2 py-1 text-content-muted">{narrative}</span>)
                  : <span className="text-content-muted">—</span>}</div></td>
              </tr>)}
              {data && data.tokens.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-content-muted">Пока нет подтверждённых mint. Запустите сбор и tokens:resolve.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-content-muted">Первое упоминание — первое в собранной истории, а не гарантированно первое сообщение Telegram. Рыночные поля — последний наблюдённый снимок DexScreener.</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div>
          <h4 className="mb-3 text-sm font-semibold text-content">Оценка каналов</h4>
          <div className="overflow-x-auto rounded-xl border border-bg-border">
            <table className="min-w-[620px] w-full text-left text-xs">
              <thead className="bg-bg-soft text-content-muted"><tr>
                {["Канал","Discovery","Outcome","Originality","Risk","Общий балл","N"].map((x) => <th key={x} className="px-3 py-3 font-medium">{x}</th>)}
              </tr></thead>
              <tbody>
                {(data?.channels ?? []).map((channel) => <tr key={channel.source_id} className="border-t border-bg-border">
                  <td className="px-3 py-3 font-medium text-content">@{channel.identifier}</td>
                  <td className="px-3 py-3 text-content">{fmt(channel.discovery_score)}</td>
                  <td className="px-3 py-3 text-content">{fmt(channel.outcome_score)}</td>
                  <td className="px-3 py-3 text-content">{fmt(channel.originality_score)}</td>
                  <td className="px-3 py-3 text-content">{channel.risk_score === null ? "нет данных" : fmt(channel.risk_score)}</td>
                  <td className="px-3 py-3 font-semibold text-content">{channel.composite_score === null ? "недостаточно данных" : fmt(channel.composite_score)}</td>
                  <td className="px-3 py-3 text-content">{fmt(channel.sample_size, 0)}</td>
                </tr>)}
                {data && data.channels.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-content-muted">Рейтинг появится после подтверждённых упоминаний и расчёта аналитики.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-content-muted">Outcome и общий балл недоступны без достаточного числа реальных рыночных исходов. Risk не подменяется предположением об отсутствии риска.</p>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-semibold text-content">Неоднозначные тикеры</h4>
          <div className="rounded-xl border border-bg-border">
            {(data?.unresolvedTickers ?? []).map((ticker) => <div key={ticker.ticker} className="flex items-center justify-between gap-3 border-b border-bg-border px-3 py-3 last:border-b-0">
              <span className="font-semibold text-content">{"$" + ticker.ticker}</span>
              <span className="text-right text-xs text-content-muted">{fmt(ticker.evidence_count, 0)} упоминаний · {date(ticker.last_seen_at)}</span>
            </div>)}
            {data && data.unresolvedTickers.length === 0 && <p className="px-3 py-6 text-center text-xs text-content-muted">Неоднозначных тикеров пока нет.</p>}
          </div>
        </div>
      </div>

      <div>
        <h4 className="mb-3 text-sm font-semibold text-content">Последние сигналы для проверки</h4>
        <div className="space-y-2">
          {(data?.signals ?? []).map((signal) => <article key={signal.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bg-border bg-bg-soft p-3">
            <div>
              <div className="font-medium text-content">{signal.signal_type.replaceAll("_", " ")}</div>
              <a href={"https://solscan.io/token/" + encodeURIComponent(signal.mint)} target="_blank" rel="noopener noreferrer" className="text-xs text-content-muted hover:text-content">{shortMint(signal.mint)} ↗</a>
              <div className="mt-1 text-[10px] text-content-muted">{signal.source_identifier ? "@" + signal.source_identifier + " · " : ""}{signal.model_version} · {date(signal.detected_at)}</div>
            </div>
            <div className="text-right"><div className="text-sm font-semibold text-content">{fmt(signal.confidence * 100)}%</div><div className="text-[10px] text-content-muted">{signal.status}</div></div>
          </article>)}
          {data && data.signals.length === 0 && <p className="rounded-xl border border-bg-border p-6 text-center text-xs text-content-muted">Сигналы появятся после пересчёта скорости упоминаний и первых обнаружений.</p>}
        </div>
      </div>
    </section>
  );
}
