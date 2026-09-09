"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Database,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  fetchTeraGramInviteChannels,
  fetchTeraGramInviteStatus,
  uniqueInviteSources,
  type TeraGramClassification,
  type TeraGramInviteChannel,
  type TeraGramInviteStatus,
} from "@/lib/teragramInvite";

type Props = {
  onImportSources?: (usernames: string[]) => void | Promise<void>;
  importLimit?: number;
  className?: string;
};

type Filter = "all" | TeraGramClassification;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Все сильные" },
  { value: "solana", label: "Solana" },
  { value: "memecoin", label: "Memecoin" },
  { value: "caller", label: "Callers" },
];

const compactNumber = new Intl.NumberFormat("ru-RU", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fullNumber = new Intl.NumberFormat("ru-RU");

export default function TeraGramInviteSource({
  onImportSources,
  importLimit = 250,
  className = "",
}: Props) {
  const [status, setStatus] = useState<TeraGramInviteStatus | null>(null);
  const [channels, setChannels] = useState<TeraGramInviteChannel[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const nextStatus = await fetchTeraGramInviteStatus(signal);
        setStatus(nextStatus);
        if (!nextStatus.ready) {
          setChannels([]);
          setTotal(0);
          return;
        }
        const response = await fetchTeraGramInviteChannels(
          {
            limit: importLimit,
            classification: filter === "all" ? null : filter,
          },
          signal,
        );
        setChannels(response.items);
        setTotal(response.meta.total);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Не удалось загрузить TeraGram");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [filter, importLimit],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const sources = useMemo(() => uniqueInviteSources(channels), [channels]);

  async function importSources() {
    if (!onImportSources || sources.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      await onImportSources(sources);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось добавить источники в TG Invite");
    } finally {
      setImporting(false);
    }
  }

  const ready = Boolean(status?.ready);
  const categories = status?.categories ?? {};

  return (
    <section
      data-tag="tginvite.teragram-source"
      className={`surface-panel relative overflow-hidden rounded-[24px] border border-bg-border p-4 sm:p-5 ${className}`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--theme-primary)_10%,transparent),transparent_38%)]" />
      <div className="relative space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary-border bg-bg-soft text-primary">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-bold text-content">База источников / TeraGram</h3>
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                    ready
                      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                      : "border-amber-400/20 bg-amber-400/10 text-amber-300"
                  }`}
                >
                  {ready ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                  {ready ? "готово" : "нет базы"}
                </span>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-5 text-content-muted">
                TeraGram находит сильные crypto / Solana / memecoin каналы. Они добавляются в список
                источников TG Invite, после чего обычный MTProto-flow уже получает участников этих
                каналов и формирует пользовательскую очередь.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-bg-border bg-bg-soft px-3 text-xs font-semibold text-content-muted transition hover:border-primary-border hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Обновить
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Metric
            label="Проверено чатов"
            value={status ? compactNumber.format(status.chats_total) : "—"}
          />
          <Metric
            label="Кандидаты"
            value={status ? fullNumber.format(status.candidate_channels) : "—"}
          />
          <Metric
            label="Источники Invite"
            value={status ? fullNumber.format(status.seed_channels) : "—"}
          />
          <Metric label="Solana" value={fullNumber.format(Number(categories.solana || 0))} />
          <Metric label="Callers" value={fullNumber.format(Number(categories.caller || 0))} />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-red-400/20 bg-red-400/10 px-3 py-2.5 text-xs text-red-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {ready ? (
          <div className="rounded-2xl border border-bg-border bg-bg-soft/60 p-3 sm:p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                {FILTERS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setFilter(item.value)}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                      filter === item.value
                        ? "border-primary-border bg-primary/10 text-primary"
                        : "border-bg-border bg-bg-card text-content-muted hover:border-primary-border hover:text-content"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void importSources()}
                disabled={!onImportSources || importing || loading || sources.length === 0}
                title={
                  !onImportSources ? "Подключите callback списка источников TG Invite" : undefined
                }
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-primary-border bg-primary/10 px-4 text-sm font-bold text-primary transition hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {importing ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {onImportSources
                  ? `Добавить ${sources.length} источников`
                  : "Ожидает список источников TG Invite"}
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-content-faint">
              <span>Найдено по фильтру: {fullNumber.format(total)}</span>
              <span>Загружено: {fullNumber.format(channels.length)}</span>
              <span>Лимит импорта: {fullNumber.format(importLimit)}</span>
            </div>

            {channels.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {channels.slice(0, 6).map((channel) => (
                  <div
                    key={channel.username}
                    className="rounded-xl border border-bg-border bg-bg-card px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-content">
                        @{channel.username}
                      </span>
                      <span className="text-xs font-bold text-primary">
                        {channel.seed_score.toFixed(1)}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-content-faint">
                      {channel.classifications.slice(0, 3).join(" · ") || "candidate"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-bg-border bg-bg-soft/40 p-4">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 h-4 w-4 text-primary" />
              <div>
                <div className="text-sm font-semibold text-content">
                  Сначала нужен один успешный TeraGram scan
                </div>
                <p className="mt-1 text-xs leading-5 text-content-muted">
                  UI специально не запускает тяжёлый многотерабайтный job. После CLI/job scan здесь
                  автоматически появятся найденные source-каналы и импорт в TG Invite.
                </p>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setDetailsOpen((value) => !value)}
          className="flex w-full items-center justify-between border-t border-bg-border pt-3 text-left text-xs text-content-muted"
        >
          <span>Детали источника и состояние</span>
          <ChevronDown
            className={`h-4 w-4 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
          />
        </button>

        {detailsOpen && (
          <div className="grid gap-2 text-xs text-content-muted sm:grid-cols-2 xl:grid-cols-4">
            <Detail label="Signal source" value={status?.signal_source || "—"} />
            <Detail label="Последний scan" value={formatDate(status?.generated_at)} />
            <Detail
              label="Public discovery"
              value={status?.active_for_public_discovery ? "TeraGram active" : "legacy fallback"}
            />
            <Detail
              label="Zenodo preview"
              value={
                status?.source?.preview_record_id
                  ? String(status.source.preview_record_id)
                  : "18262126"
              }
            />
          </div>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-bg-border bg-bg-soft/60 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-content-faint">{label}</div>
      <div className="mt-1 text-lg font-bold text-content">{value}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-soft/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-content-faint">{label}</div>
      <div className="mt-1 break-words font-medium text-content-muted">{value}</div>
    </div>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ru-RU");
}
