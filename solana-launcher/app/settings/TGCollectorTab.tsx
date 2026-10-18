"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Database, Loader2, Pause, Play, Plus, RefreshCw, Search, Trash2, Wifi, Square, Save } from "lucide-react";
import TGGraphPanel from "./TGGraphPanel";
import TGMemecoinAnalytics from "./TGMemecoinAnalytics";
import type { TgCollectorSnapshot as Snapshot, TgCollectorSource as Source } from "@/lib/tgCollectorTypes";

const endpoint = "/api/integrations/tg-collector";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("ru-RU");
}

function pill(state: Source["state"]) {
  switch (state) {
    case "running": return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    case "failed": return "border-red-500/30 bg-red-500/10 text-red-300";
    case "delayed": return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    default: return "border-white/10 bg-white/5 text-content-muted";
  }
}

export default function TGCollectorTab() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [accessKey, setAccessKey] = useState("");
  const [localConnected, setLocalConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint + "/session", { method: "POST", signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setLocalConnected(response.ok); })
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setConnecting(false); });
    return () => controller.abort();
  }, []);
  const [keyInput, setKeyInput] = useState("");
  const [selected, setSelected] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proxyType, setProxyType] = useState<"socks5" | "socks4" | "mtproxy">("socks5");
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("1080");
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [proxySecret, setProxySecret] = useState("");
  const [proxyDirty, setProxyDirty] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!accessKey && !localConnected) return;
    const params = new URLSearchParams({ page: String(page) });
    if (selected) params.set("source", selected);
    if (query) params.set("q", query);
    try {
      const response = await fetch(`${endpoint}?${params}`, { cache: "no-store", signal, headers: accessKey ? {Authorization: `Bearer ${accessKey}`} : {} });
      const value = await response.json() as Snapshot & { error?: string };
      if (response.status === 401) { setAccessKey(""); setLocalConnected(false); throw new Error("Неверный ключ доступа TG Collector."); }
      if (!response.ok) throw new Error(value.error || "Не удалось получить данные");
      if (signal?.aborted) return;
      setData(value);
      setError(null);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Ошибка соединения");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [selected, query, page, accessKey, localConnected]);

  useEffect(() => {
    if (!data?.proxy || proxyDirty) return;
    if (data.proxy.configured) {
      setProxyType(data.proxy.proxyType ?? "socks5");
      setProxyHost(data.proxy.host ?? "");
      setProxyPort(String(data.proxy.port ?? 1080));
    } else {
      setProxyType("socks5");
      setProxyHost("");
      setProxyPort("1080");
      setProxyUsername("");
      setProxyPassword("");
      setProxySecret("");
    }
  }, [data?.proxy?.updatedAt, data?.proxy?.configured, proxyDirty]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = setInterval(() => void refresh(controller.signal), 15000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [refresh]);

  async function command(action: "add" | "pause" | "resume" | "sync" | "retry" | "remove" | "start" | "stop", source?: Source) {
    if (busy) return;
    if (action === "remove" && source &&
      !window.confirm(`Удалить @${source.identifier} и все собранные сообщения из TG Collector? Это нельзя отменить.`)) return;
    setBusy(action + (source?.id ?? ""));
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(accessKey ? {Authorization: `Bearer ${accessKey}`} : {}) },
        body: JSON.stringify(
          action === "add" ? { action, username: channel.trim() }
            : { action, sourceId: source?.id, confirm: action === "remove" ? source?.identifier : undefined }
        ),
      });
      const result: { error?: string } = await response.json();
      if (response.status === 401) { setAccessKey(""); setLocalConnected(false); }
      if (!response.ok) throw new Error(result.error || "Действие не выполнено");
      if (action === "add") setChannel("");
      if (action === "remove" && source?.id === selected) setSelected("");
      setNotice(
        action === "add" ? "Источник добавлен в очередь." :
        action === "remove" ? "Источник и его сообщения удалены." :
        action === "pause" ? "Источник приостановлен после текущего запроса." :
        action === "resume" ? "Сбор источника возобновлён." :
        action === "start" ? "Сбор запущен. Worker начнёт брать доступные задания." :
        action === "stop" ? "Сбор остановлен. Текущий запрос может завершиться, новые задания не берутся." :
        "Задача поставлена в очередь."
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ошибка выполнения команды");
    } finally {
      setBusy(null);
    }
  }

  async function proxyCommand(action: "save" | "enable" | "disable" | "clear" | "test") {
    if ((!accessKey && !localConnected) || proxyBusy) return;
    setProxyBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload =
        action === "save"
          ? {
              action: "proxy-save",
              proxyType,
              host: proxyHost.trim(),
              port: Number(proxyPort),
              username: proxyUsername.trim() || undefined,
              password: proxyPassword || undefined,
              secret: proxySecret || undefined,
            }
          : { action: `proxy-${action}` };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(accessKey ? {Authorization: `Bearer ${accessKey}`} : {}) },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { error?: string; proxy?: Snapshot["proxy"]; latencyMs?: number; message?: string };
      if (response.status === 401) { setAccessKey(""); setLocalConnected(false); }
      if (!response.ok) throw new Error(result.error || "Операция с прокси не выполнена");
      if (action === "save") {
        setProxyDirty(false);
        setProxyPassword("");
        setProxySecret("");
        setNotice("Прокси сохранён. Перезапустите TG Collector worker, чтобы новое соединение использовало эту конфигурацию.");
      } else if (action === "clear") {
        setProxyDirty(false);
        setProxyHost("");
        setProxyPort("1080");
        setProxyUsername("");
        setProxyPassword("");
        setProxySecret("");
        setNotice("Прокси отключён и удалён из конфигурации.");
      } else if (action === "test") {
        setNotice(result.message || `TCP-порт прокси доступен за ${result.latencyMs ?? "—"} мс.`);
      } else {
        setNotice(action === "enable" ? "Прокси включён." : "Прокси выключен.");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ошибка операции с прокси");
    } finally {
      setProxyBusy(false);
    }
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    void command("add");
  }
  function onSearch(event: FormEvent) {
    event.preventDefault();
    setPage(0);
    setQuery(searchInput.trim());
  }

  const metrics = [
    { title: "Источники", value: data?.stats.sources ?? 0 },
    { title: "Сообщения", value: data?.stats.messages ?? 0 },
    { title: "Выполняются", value: data?.stats.running ?? 0 },
    { title: "Ошибки", value: data?.stats.failed ?? 0 },
    { title: "Сообщений сегодня", value: data?.runtimeMetrics.messages_per_day ?? 0 },
    { title: "Связей сегодня", value: data?.runtimeMetrics.links_per_day ?? 0 },
    { title: "Всего связей", value: data?.runtimeMetrics.links_total ?? 0 },
    { title: "Заданий в очереди", value: data?.runtimeMetrics.jobs_pending ?? 0 },
  ];
  const globallyPaused = Boolean(data?.pausedUntil && new Date(data.pausedUntil) > new Date());

  if (connecting) return <section role="status" className="surface-panel p-6 text-content-muted">Подключение к TG Collector…</section>;
  if (!accessKey && !localConnected) return (
    <section className="surface-panel mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold text-content">Доступ к локальному TG Collector</h2>
      <p className="text-sm text-content-muted">Введите ключ из
        <code> solana-launcher/.env.local</code> — значение переменной
        <code> TG_COLLECTOR_ADMIN_TOKEN</code>. Ключ хранится только в памяти этой вкладки,
        не сохраняется в браузерном хранилище.</p>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (keyInput.length >= 24) { setError(null); setLoading(true); setAccessKey(keyInput); setKeyInput(""); }
        else setError("Ключ должен содержать не менее 24 символов.");
      }}>
        <input type="password" required minLength={24} autoComplete="off" value={keyInput}
          onChange={event=>setKeyInput(event.target.value)} aria-label="Ключ доступа TG Collector"
          placeholder="Локальный ключ доступа"
          className="min-w-48 flex-1 rounded-xl border border-bg-border bg-bg-soft px-3 py-2 text-content" />
        <button type="submit" className="rounded-xl border border-primary-border px-4 py-2 text-content">Открыть</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="surface-panel p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2"><Database className="h-5 w-5 text-primary" /><h2 className="text-xl font-bold text-content">TG Collector</h2></div>
            <p className="mt-2 text-sm text-content-muted">Локальный сбор публичных каналов и супергрупп Telegram через MTProto.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void command("start")} disabled={busy !== null || data?.collectionEnabled} className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 disabled:opacity-40">
              <Play className="h-4 w-4" /> Запустить парсинг
            </button>
            <button type="button" onClick={() => void command("stop")} disabled={busy !== null || data?.collectionEnabled === false} className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300 disabled:opacity-40">
              <Square className="h-4 w-4" /> Остановить
            </button>
            <button type="button" onClick={() => void refresh()} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-xl border border-bg-border px-3 py-2 text-sm text-content-muted hover:text-content disabled:opacity-40">
              <RefreshCw className="h-4 w-4" /> Обновить
            </button>
          </div>
        </div>

        <button type="button" onClick={() => { void fetch(endpoint + "/session", { method: "DELETE", headers: accessKey ? {Authorization: `Bearer ${accessKey}`} : {} }); setData(null); setAccessKey(""); setLocalConnected(false); }}
          className="mt-3 text-xs text-content-muted hover:text-content">Закрыть доступ к TG Collector</button>
        <div className="mt-5 flex flex-wrap gap-3 text-xs">
          <span className={`rounded-lg border px-3 py-2 ${data?.collectionEnabled === false ? "border-amber-500/30 text-amber-300" : "border-emerald-500/30 text-emerald-300"}`}>
            {data?.collectionEnabled === false ? "Сбор остановлен" : "Сбор включён"}
          </span>
          <span className={`rounded-lg border px-3 py-2 ${data?.workerOnline ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300"}`}>
            {data?.workerOnline ? <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" /> : <Clock3 className="mr-1 inline h-3.5 w-3.5" />}
            Worker: {data?.workerOnline ? "работает" : "не обнаружен"}
          </span>
          <span className="rounded-lg border border-bg-border px-3 py-2 text-content-muted">
            Worker version: {data?.runtimeMetrics.worker_version ?? "—"}
          </span>
          {data?.runtimeMetrics.last_error_code && <span className="rounded-lg border border-amber-500/30 px-3 py-2 text-amber-300">
            Последняя ошибка: {data.runtimeMetrics.last_error_code}
          </span>}
          <span className="rounded-lg border border-bg-border px-3 py-2 text-content-muted">Последний сигнал: {formatDate(data?.heartbeatAt ?? null)}</span>
          {globallyPaused && <span className="rounded-lg border border-amber-500/30 px-3 py-2 text-amber-300">Telegram FloodWait до {formatDate(data?.pausedUntil ?? null)}</span>}
          {data?.blockReason && <span className="rounded-lg border border-red-500/30 px-3 py-2 text-red-300">Telegram заблокирован для сборщика: {data.blockReason}. Проверьте аккаунт перед повторным запуском.</span>}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {metrics.map(item => (
            <div key={item.title} className="rounded-xl border border-bg-border bg-bg-soft p-4">
              <div className="text-xs text-content-muted">{item.title}</div>
              <div className="mt-1 text-2xl font-semibold text-content">{item.value.toLocaleString("ru-RU")}</div>
            </div>
          ))}
        </div>
      </div>

      {loading && !data && <div className="surface-panel flex items-center gap-2 p-4 text-sm text-content-muted"><Loader2 className="h-4 w-4 animate-spin" /> Загрузка состояния...</div>}
      {error && <div role="alert" className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-300">{notice}</div>}

      <section className="surface-panel p-5 sm:p-6">
        <h3 className="font-semibold text-content">Добавить источник</h3>
        <p className="mt-1 text-xs text-content-muted">Публичный @username или ссылка t.me/username. Без вступления в закрытые чаты.</p>
        <form onSubmit={onAdd} className="mt-4 flex flex-wrap gap-2">
          <input aria-label="Telegram username" value={channel} onChange={event => setChannel(event.target.value)} maxLength={128}
            placeholder="@channel или https://t.me/channel" required
            className="min-w-0 flex-1 rounded-xl border border-bg-border bg-bg-soft px-4 py-3 text-sm text-content outline-none focus:border-primary-border" />
          <button type="submit" disabled={!channel.trim() || busy !== null} className="inline-flex items-center gap-2 rounded-xl border border-primary-border bg-primary/10 px-4 py-3 text-sm font-medium text-primary disabled:opacity-40">
            {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Добавить
          </button>
        </form>
      </section>

      <section className="surface-panel p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-content"><Wifi className="h-4 w-4 text-primary" /> Прокси Telegram</h3>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              Поддерживаются SOCKS5, SOCKS4 и MTProto. Логин, пароль и secret не возвращаются в UI и хранятся зашифрованными.
              Новая конфигурация применяется при следующем подключении worker.
            </p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs ${data?.proxy?.enabled ? "border-emerald-500/30 text-emerald-300" : "border-bg-border text-content-muted"}`}>
            {data?.proxy?.configured ? (data.proxy.enabled ? "Прокси включён" : "Прокси выключен") : "Прокси не настроен"}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs text-content-muted">Тип
            <select value={proxyType} onChange={e=>{setProxyType(e.target.value as typeof proxyType);setProxyDirty(true);}}
              className="mt-1 w-full rounded-xl border border-bg-border bg-bg-soft px-3 py-2.5 text-sm text-content">
              <option value="socks5">SOCKS5</option><option value="socks4">SOCKS4</option><option value="mtproxy">MTProto</option>
            </select>
          </label>
          <label className="text-xs text-content-muted">Host
            <input value={proxyHost} onChange={e=>{setProxyHost(e.target.value);setProxyDirty(true);}} maxLength={253}
              placeholder="127.0.0.1" className="mt-1 w-full rounded-xl border border-bg-border bg-bg-soft px-3 py-2.5 text-sm text-content" />
          </label>
          <label className="text-xs text-content-muted">Port
            <input value={proxyPort} onChange={e=>{setProxyPort(e.target.value);setProxyDirty(true);}} inputMode="numeric" maxLength={5}
              placeholder="1080" className="mt-1 w-full rounded-xl border border-bg-border bg-bg-soft px-3 py-2.5 text-sm text-content" />
          </label>
          <label className="text-xs text-content-muted">Логин
            <input value={proxyUsername} onChange={e=>{setProxyUsername(e.target.value);setProxyDirty(true);}} autoComplete="off" maxLength={256}
              disabled={proxyType==="mtproxy"} placeholder="необязательно" className="mt-1 w-full rounded-xl border border-bg-border bg-bg-soft px-3 py-2.5 text-sm text-content disabled:opacity-40" />
          </label>
          <label className="text-xs text-content-muted">{proxyType==="mtproxy" ? "Secret" : "Пароль"}
            <input type="password" value={proxyType==="mtproxy" ? proxySecret : proxyPassword}
              onChange={e=>{proxyType==="mtproxy" ? setProxySecret(e.target.value) : setProxyPassword(e.target.value);setProxyDirty(true);}}
              autoComplete="new-password" maxLength={512} placeholder={data?.proxy?.secretConfigured || data?.proxy?.passwordConfigured ? "оставьте пустым для сохранения" : "необязательно"}
              className="mt-1 w-full rounded-xl border border-bg-border bg-bg-soft px-3 py-2.5 text-sm text-content" />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={proxyBusy || !proxyHost.trim()} onClick={()=>void proxyCommand("save")}
            className="inline-flex items-center gap-2 rounded-xl border border-primary-border bg-primary/10 px-4 py-2.5 text-sm font-medium text-primary disabled:opacity-40">
            {proxyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Сохранить прокси
          </button>
          <button type="button" disabled={proxyBusy || !data?.proxy?.configured} onClick={()=>void proxyCommand(data?.proxy?.enabled ? "disable" : "enable")}
            className="rounded-xl border border-bg-border px-4 py-2.5 text-sm text-content-muted disabled:opacity-40">
            {data?.proxy?.enabled ? "Выключить" : "Включить"}
          </button>
          <button type="button" disabled={proxyBusy || !data?.proxy?.configured} onClick={()=>void proxyCommand("test")}
            className="rounded-xl border border-bg-border px-4 py-2.5 text-sm text-content-muted disabled:opacity-40">
            Проверить порт
          </button>
          <button type="button" disabled={proxyBusy || !data?.proxy?.configured} onClick={()=>{if(window.confirm("Удалить сохранённую конфигурацию прокси?")) void proxyCommand("clear");}}
            className="rounded-xl border border-red-500/20 px-4 py-2.5 text-sm text-red-300 disabled:opacity-40">
            Удалить
          </button>
        </div>
        {data?.proxy?.configured && <p className="mt-3 text-xs text-content-muted">
          {data.proxy.host}:{data.proxy.port} · {data.proxy.proxyType?.toUpperCase()} · учётные данные: {data.proxy.usernameConfigured || data.proxy.passwordConfigured || data.proxy.secretConfigured ? "сохранены" : "не заданы"}
          {data.proxy.updatedAt ? ` · обновлено ${formatDate(data.proxy.updatedAt)}` : ""}
        </p>}
      </section>

      <section className="surface-panel p-5 sm:p-6">
        <h3 className="font-semibold text-content">Источники и задания</h3>
        <div className="mt-4 space-y-3">
          {data?.sources.length === 0 && <p className="text-sm text-content-muted">Источников пока нет. Добавьте публичный канал выше.</p>}
          {data?.sources.map(source => (
            <div key={source.id} className="rounded-xl border border-bg-border bg-bg-soft p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-content">{source.title || "@" + source.identifier}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${pill(source.state)}`}>{source.enabled ? source.state ?? "без задачи" : "пауза"}</span>
                    {source.history_partial && <span className="text-xs text-amber-300">История неполная</span>}
                  </div>
                  <a href={`https://t.me/${source.identifier}`} rel="noreferrer noopener" target="_blank" className="text-xs text-primary hover:underline">@{source.identifier}</a>
                  <div className="mt-2 text-xs text-content-muted">{source.message_count} сообщений · ID {source.last_message_id} · Успешная синхронизация: {formatDate(source.last_success_at)}</div>
                  {source.last_error && <div className="mt-2 max-w-xl break-words text-xs text-red-300">Ошибка: {source.last_error}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy !== null} onClick={() => { setSelected(source.id); setPage(0); }} className="rounded-lg border border-bg-border px-3 py-2 text-xs text-content-muted hover:text-content">Сообщения</button>
                  {source.enabled ? (
                    <button type="button" disabled={busy !== null} title="Отключает новые задания" onClick={() => void command("pause", source)}
                      className="rounded-lg border border-bg-border px-3 py-2 text-xs text-content-muted hover:text-content"><Pause className="mr-1 inline h-3.5 w-3.5" /> Пауза</button>
                  ) : (
                    <button type="button" disabled={busy !== null} onClick={() => void command("resume", source)}
                      className="rounded-lg border border-emerald-500/30 px-3 py-2 text-xs text-emerald-300"><Play className="mr-1 inline h-3.5 w-3.5" /> Возобновить</button>
                  )}
                  <button type="button" disabled={busy !== null || !source.enabled || source.state === "running"} onClick={() => void command(source.state === "failed" ? "retry" : "sync", source)}
                    className="rounded-lg border border-bg-border px-3 py-2 text-xs text-content-muted disabled:opacity-30 hover:text-content"><RefreshCw className="mr-1 inline h-3.5 w-3.5" /> {source.state === "failed" ? "Повтор" : "Синхронизировать"}</button>
                  <button type="button" disabled={busy !== null || source.state === "running"} onClick={() => void command("remove", source)}
                    className="rounded-lg border border-red-500/20 px-3 py-2 text-xs text-red-300 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5" aria-label="Удалить" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <TGGraphPanel sources={data?.sources ?? []} authToken={accessKey} />
      <TGMemecoinAnalytics authToken={accessKey} />

      <section className="surface-panel p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-content">Сообщения</h3>
          <select aria-label="Фильтр по источнику" value={selected} onChange={event => { setSelected(event.target.value); setPage(0); }}
            className="min-w-40 rounded-xl border border-bg-border bg-bg-soft px-3 py-2 text-sm text-content">
            <option value="">Все источники</option>
            {data?.sources.map(source => <option key={source.id} value={source.id}>@{source.identifier}</option>)}
          </select>
        </div>
        <form onSubmit={onSearch} className="mt-4 flex gap-2">
          <input value={searchInput} maxLength={120} onChange={event => setSearchInput(event.target.value)}
            placeholder="Поиск по тексту сообщений" className="min-w-0 flex-1 rounded-xl border border-bg-border bg-bg-soft px-3 py-2 text-sm text-content outline-none focus:border-primary-border" />
          <button type="submit" className="rounded-xl border border-bg-border px-4 py-2 text-sm text-content-muted hover:text-content"><Search className="mr-1 inline h-4 w-4" /> Найти</button>
        </form>
        <div className="mt-4 space-y-2">
          {data?.messages.length === 0 && <p className="text-sm text-content-muted">Нет сообщений по выбранным условиям.</p>}
          {data?.messages.map(message => (
            <article key={`${message.source_id}:${message.message_id}`} className="rounded-xl border border-bg-border bg-bg-soft p-4">
              <div className="flex flex-wrap justify-between gap-2 text-xs text-content-muted">
                <a href={`https://t.me/${message.identifier}/${message.message_id}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">@{message.identifier} · #{message.message_id}</a>
                <span>{formatDate(message.posted_at)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-content">{message.text || "(медиа без текста)"}</p>
              <p className="mt-2 text-xs text-content-muted">Автор: {message.sender_id || "—"} · Просмотры: {message.views ?? "—"} · Пересылки: {message.forwards ?? "—"} · Ответы: {message.replies ?? "—"}</p>
            </article>
          ))}
        </div>
        <div className="mt-4 flex justify-between gap-3">
          <button type="button" disabled={page === 0} onClick={() => setPage(n => Math.max(0, n - 1))} className="rounded-lg border border-bg-border px-4 py-2 text-xs text-content-muted disabled:opacity-30">Назад</button>
          <span className="self-center text-xs text-content-muted">Страница {page + 1}</span>
          <button type="button" disabled={!data || data.messages.length < 40 || page >= 100} onClick={() => setPage(n => n + 1)} className="rounded-lg border border-bg-border px-4 py-2 text-xs text-content-muted disabled:opacity-30">Далее</button>
        </div>
      </section>

      <section className="surface-panel p-5 text-xs leading-6 text-content-muted">
        <strong className="text-content">Локальный запуск:</strong> в папке <code>tg-collector</code> выполните
        <code> npm run migrate</code>, <code>npm run login</code>, затем <code>npm run worker</code>.
        Не вводите API hash, пароль Telegram или строку сессии в браузере — они хранятся локально у воркера.
        При первом запуске собираются только последние сообщения в пределах заданного лимита.
      </section>
    </div>
  );
}
