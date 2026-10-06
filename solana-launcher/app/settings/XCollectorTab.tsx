"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  Layers,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  Shield,
  Square,
  TerminalSquare,
  X,
  KeyRound,
  Zap,
  Waves,
  Send,
  LayoutGrid,
  Link,
  FileText,
  Settings,
  LogOut
} from "lucide-react";
import { useCachedValue, writeCachedValue } from "@/lib/client-cache";
import { useQuery } from "@/lib/react-query";

type ProcessRecord = { pid: number; startedAt: number; command: string };

type XCollectorSummary = {
  installed: boolean;
  dirExists: boolean;
  nodeModulesPresent: boolean;
  env: {
    databaseUrlConfigured: boolean;
    masterKeyConfigured: boolean;
  };
  migrations: {
    complete: boolean;
    missing: string[];
    path: string;
  };
  processes: {
    worker: ProcessRecord | null;
    scheduler: ProcessRecord | null;
    dashboard: ProcessRecord | null;
  };
  health: {
    worker: { url: string; reachable: boolean; detail: string };
    dashboard: { url: string; reachable: boolean; detail: string };
  };
  db: {
    reachable: boolean;
    detail: string;
  };
};

const X_COLLECTOR_SUMMARY_CACHE_KEY = "solana-launcher.xcollector-summary.v1";
const X_COLLECTOR_SUMMARY_CACHE_TTL_MS = 15_000;
const QUERY_KEY = ["x-collector-summary"] as const;

async function fetchSummary(): Promise<XCollectorSummary> {
  const response = await fetch("/api/integrations/x-collector", { cache: "no-store" });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error || "Failed to load X Collector summary");
  return json as XCollectorSummary;
}

async function runAction(action: string): Promise<{ output?: string }> {
  const response = await fetch("/api/integrations/x-collector", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json?.error || "Failed to run action");
  return json as { output?: string };
}

function StatusPill({ label, value, tone: toneKey }: { label: string; value: string; tone: "ok" | "warn" | "fail" | "neutral" }) {
  const toneClass = toneKey === "ok"
    ? "border-green-500/30 bg-green-500/10 text-green-300"
    : toneKey === "warn"
      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100"
      : toneKey === "fail"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : "border-white/10 bg-white/5 text-white/70";
  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-sm font-semibold break-all">{value}</p>
    </div>
  );
}

function ProcessCard({ name, label, description, running, health, busy, onStart, onStop }: {
  name: string;
  label: string;
  description: string;
  running: boolean;
  health?: { url: string; reachable: boolean; detail: string };
  busy: string | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const healthOk = health?.reachable === true;
  return (
    <div className="glass rounded-xl border border-bg-border p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-white">
          <TerminalSquare className="w-4 h-4 text-neon-green" />
          <p className="font-semibold">{label}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${running ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-white/10 bg-white/5 text-white/50"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-green-400" : "bg-white/30"}`} />
          {running ? "running" : "stopped"}
        </span>
      </div>
      <p className="text-xs text-white/40">{description}</p>
      {health && (
        <p className={`text-xs ${healthOk ? "text-green-300" : "text-white/40"}`}>
          {healthOk ? `Health OK · ${health.detail}` : "Health недоступен"}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={busy !== null || running}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === `${name}-start` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Start
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={busy !== null || !running}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === `${name}-stop` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
          Stop
        </button>
      </div>
    </div>
  );
}

const FEATURE_LIST = [
  { key: "accounts", name: "Аккаунты и cookies", status: "done", icon: KeyRound },
  { key: "proxy", name: "Прокси", status: "done", icon: Shield },
  { key: "campaigns", name: "Кампании", status: "pending", icon: Zap },
  { key: "lore", name: "Персонаж (lore)", status: "pending", icon: Layers },
  { key: "sources", name: "Источники твитов", status: "pending", icon: Waves },
  { key: "filters", name: "Фильтры", status: "pending", icon: Search },
  { key: "ai", name: "LLM генерация", status: "pending", icon: Bot },
  { key: "rag", name: "RAG поиск примеров", status: "pending", icon: Search },
  { key: "rate", name: "Rate limiting", status: "pending", icon: Clock },
  { key: "detection", name: "Anti-detection", status: "pending", icon: Shield },
  { key: "bot", name: "Telegram-бот", status: "pending", icon: MessageSquare },
  { key: "stats", name: "Статистика и алерты", status: "pending", icon: Waves },
] as const;

export default function XCollectorTab() {
  const [activeSection, setActiveSection] = useState<"overview" | "accounts" | "campaigns" | "lore" | "proxies" | "sources" | "ai" | "security">("overview");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [registerForm, setRegisterForm] = useState({ handle: "", cookies: "", proxy: "{}", userAgent: "", timezone: "" });

  const cachedSummary = useCachedValue<XCollectorSummary>(X_COLLECTOR_SUMMARY_CACHE_KEY);
  const summaryQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchSummary,
    initialData: cachedSummary ?? undefined,
    staleTime: X_COLLECTOR_SUMMARY_CACHE_TTL_MS,
    gcTime: 5 * 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (summaryQuery.data) {
      writeCachedValue(X_COLLECTOR_SUMMARY_CACHE_KEY, summaryQuery.data, X_COLLECTOR_SUMMARY_CACHE_TTL_MS);
    }
  }, [summaryQuery.data]);

  const summary = summaryQuery.data ?? null;
  const loading = summaryQuery.isPending && !summary;

  const readiness = useMemo(() => {
    if (!summary) return { status: "checking", text: "Загружаю состояние X Collector..." };
    if (!summary.dirExists) return { status: "fail", text: "Папка x-collector не найдена." };
    if (!summary.nodeModulesPresent) return { status: "warn", text: "Зависимости не установлены." };
    if (!summary.env.databaseUrlConfigured) return { status: "warn", text: "Нужен DATABASE_URL." };
    if (!summary.env.masterKeyConfigured) return { status: "warn", text: "Нужен MASTER_KEY." };
    if (!summary.migrations.complete) return { status: "warn", text: `Миграции неполные: ${summary.migrations.missing.join(", ")}.` };
    if (!summary.db.reachable) return { status: "warn", text: `БД недоступна: ${summary.db.detail}.` };
    return { status: "ok", text: "X Collector готов к работе." };
  }, [summary]);

  const isRunning = (name: "worker" | "scheduler" | "dashboard") => Boolean(summary?.processes?.[name]);

  async function dispatch(action: string) {
    setBusyAction(action);
    setActionError(null);
    setActionLog(null);
    try {
      const result = await runAction(action);
      if (result.output) setActionLog(result.output);
      await summaryQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to run action");
    } finally {
      setBusyAction(null);
    }
  }

  async function registerAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusyAction("register-session");
    try {
      await fetch("/api/integrations/x-collector/register-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          handle: registerForm.handle, 
          cookies: registerForm.cookies, 
          proxy: JSON.parse(registerForm.proxy) || {},
          user_agent: registerForm.userAgent,
          timezone: registerForm.timezone
        }),
      });
      setRegisterForm({ handle: "", cookies: "", proxy: "{}", userAgent: "", timezone: "" });
      setActionLog(`Аккаунт ${registerForm.handle} успешно создан!`);
      await summaryQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Ошибка регистрации");
    } finally {
      setBusyAction(null);
    }
  }

  const completed = FEATURE_LIST.filter(f => f.status === "done").length;
  const total = FEATURE_LIST.length;
  const progress = Math.round((completed / total) * 100);

  const planPhases = [
    { title: "Фаза 1: Модели + кампании", duration: "1-2 недели", features: ["accounts", "proxy", "campaigns"], status: "pending" },
    { title: "Фаза 2: AI + RAG", duration: "2-3 недели", features: ["ai", "rag", "lore", "detection"], status: "pending" },
    { title: "Фаза 3: Rate limiting", duration: "1 неделя", features: ["rate"], status: "pending" },
    { title: "Фаза 4: Telegram-бот", duration: "1-2 недели", features: ["bot"], status: "pending" },
    { title: "Фаза 5: Тесты + деплой", duration: "1 неделя", features: ["stats", "bot"], status: "pending" },
  ];

  const implementationPlan = [
    { step: 1, title: "Модели данных", desc: "Create campaigns, loras, examples, sources, filters, rate_limits tables" },
    { step: 2, title: "RAG-движок", desc: "Embeddings with pgvector, top-K search" },
    { step: 3, title: "LLM генерация", desc: "OpenAI/Anthropic API + vision" },
    { step: 4, title: "Anti-detection", desc: "14 layers: headers, timezone, TLS, session warming" },
    { step: 5, title: "Rate limiting", desc: "Token bucket, sleep mode" },
    { step: 6, title: "Telegram-бот", desc: "Manage campaigns, view stats" },
  ];

  return (
    <div className="flex flex-col">
      {/* Navigation tabs */}
      <div className="bg-black/30 border-b border-white/10 p-4">
        <div className="flex gap-2 overflow-x-auto">
          {[
            { id: "overview", label: "Мониторинг", icon: LayoutGrid },
            { id: "accounts", label: "Аккаунты", icon: KeyRound },
            { id: "campaigns", label: "Кампании", icon: FileText },
            { id: "lore", label: "Персонаж", icon: Layers },
            { id: "proxies", label: "Прокси", icon: Shield },
            { id: "sources", label: "Источники", icon: Waves },
            { id: "ai", label: "AI", icon: Bot },
            { id: "security", label: "Безопасность", icon: Search },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id as any)}
              className={`px-3 py-2 rounded-lg border text-sm font-semibold transition-colors whitespace-nowrap flex items-center gap-2 ${
                activeSection === tab.id
                  ? "bg-neon-green/10 border-neon-green/40 text-neon-green"
                  : "border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20"
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {/* OVERVIEW SECTION */}
        {activeSection === "overview" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-white">AI Reply Guy</h2>
                <p className="text-sm text-white/40 mt-1">
                  Автоматический ответчик в X (Twitter) с персонажем и RAG
                </p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-white">{progress}%</div>
                <div className="text-xs text-white/40">Готовность системы</div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="glass rounded-xl border border-bg-border p-6">
              <div className="flex items-center gap-4 mb-4">
                <div className="flex-1 bg-white/5 rounded-full h-3 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-neon-green to-green-400 transition-all duration-500" style={{ width: `${progress}%` }} />
                </div>
                <div className="text-sm text-white/70 whitespace-nowrap font-semibold">
                  {completed} из {total} модулей
                </div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {FEATURE_LIST.map((feature) => (
                  <div key={feature.key} className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm ${
                    feature.status === "done" 
                      ? "border-green-500/30 bg-green-500/10 text-green-300" 
                      : "border-white/10 bg-white/5 text-white/70"
                  }`}>
                    <feature.icon className="w-4 h-4" />
                    <span className="truncate">{feature.name}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Readiness */}
            <div className="glass rounded-xl border border-bg-border p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">Готовность</h3>
                  <p className="text-sm text-white/40 mt-0.5">Состояние компонентов</p>
                </div>
                <button 
                  onClick={() => void summaryQuery.refetch()}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-white/70 hover:text-white hover:border-white/20 transition"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${summaryQuery.isFetching ? "animate-spin" : ""}`} />
                  Обновить
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
                <StatusPill label="Установлен" value={summary ? (summary.installed ? "Да" : "Нет") : "—"} tone={summary?.installed ? "ok" : "fail"} />
                <StatusPill label="DATABASE_URL" value={summary?.env.databaseUrlConfigured ? "Настроен" : "Отсутствует"} tone={summary?.env.databaseUrlConfigured ? "ok" : "warn"} />
                <StatusPill label="MASTER_KEY" value={summary?.env.masterKeyConfigured ? "Настроен" : "Отсутствует"} tone={summary?.env.masterKeyConfigured ? "ok" : "warn"} />
                <StatusPill label="БД Доступна" value={summary?.db.reachable ? "OK" : "Нет"} tone={summary?.db.reachable ? "ok" : "warn"} />
              </div>

              <div className={`rounded-xl border px-4 py-3 text-sm ${readiness.status === "ok" ? "border-green-500/30 bg-green-500/10 text-green-200" : readiness.status === "warn" ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100" : readiness.status === "fail" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-white/10 bg-white/5 text-white/60"}`}>
                {readiness.text}
              </div>
            </div>

            {/* Processes */}
            <div>
               <h3 className="text-lg font-semibold text-white mb-3">Активные процессы</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {["worker", "scheduler", "dashboard"].map((name) => (
                  <ProcessCard 
                    key={name} 
                    name={name}
                    label={name === "worker" ? "Worker" : name === "scheduler" ? "Scheduler" : "Dashboard"}
                    description={name === "worker" ? "Очередь и обработка твитов" : name === "scheduler" ? "Планировщик задач" : "HTTP-интерфейс"}
                    running={isRunning(name as any)}
                    health={name === "dashboard" ? summary?.health.dashboard : undefined}
                    busy={busyAction}
                    onStart={() => void dispatch(`${name}-start`)}
                    onStop={() => void dispatch(`${name}-stop`)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ACCOUNTS SECTION */}
        {activeSection === "accounts" && (
          <div className="space-y-6">
            <div>
               <h2 className="text-2xl font-bold text-white">Аккаунты X</h2>
              <p className="text-sm text-white/40 mt-1">
                Подключение и управление X-аккаунтами через cookies
              </p>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6 space-y-4">
              <div className="flex items-center gap-2 text-neon-green">
                <CheckCircle2 className="w-5 h-5" />
                <h3 className="text-lg font-semibold text-white">Новый аккаунт</h3>
              </div>
              
              <form onSubmit={registerAccount} className="space-y-4">
                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Handle (@username)</span>
                  <input 
                    type="text" 
                    value={registerForm.handle} 
                    onChange={e => setRegisterForm({...registerForm, handle: e.target.value})}
                    placeholder="username" 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>
                
                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Cookies (многострочно)</span>
                  <textarea 
                    value={registerForm.cookies} 
                    onChange={e => setRegisterForm({...registerForm, cookies: e.target.value})}
                    placeholder="auth_token, ct0, __Host-*, ..." 
                    rows={6} 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>
                
                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Proxy JSON</span>
                  <textarea 
                    value={registerForm.proxy} 
                    onChange={e => setRegisterForm({...registerForm, proxy: e.target.value})}
                    placeholder='{"server": "host:port", "login": "user", "password": "pass"}'
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-neon-green/40 transition"
                    rows={3} 
                  />
                </label>

                {actionError && (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{actionError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busyAction === "register-session" || !registerForm.handle || !registerForm.cookies}
                  className="w-full inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {busyAction === "register-session" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Подключить аккаунт
                </button>
              </form>
            </div>
          </div>
        )}

        {/* CAMPAIGNS SECTION */}
        {activeSection === "campaigns" && (
          <div className="space-y-6">
            <div>
               <h2 className="text-2xl font-bold text-white">Кампании</h2>
              <p className="text-sm text-white/40 mt-1">
                Управление кампаниями автоматических ответов
              </p>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Создать кампанию</h3>
              
              <div className="space-y-4">
                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Название кампании</span>
                  <input 
                    type="text" 
                    placeholder="Моя кампания" 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="space-y-1 block">
                    <span className="text-sm text-white/50">X-аккаунт</span>
                    <select className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition">
                      <option value="">Выберите аккаунт</option>
                      <option value="1">@example1</option>
                      <option value="2">@example2</option>
                    </select>
                  </label>

                  <label className="space-y-1 block">
                    <span className="text-sm text-white/50">Темп ответа</span>
                    <select className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition">
                      <option value="slow">Медленный (1-5/час)</option>
                      <option value="normal">Нормальный (15/час)</option>
                      <option value="fast">Быстрый (30/час)</option>
                    </select>
                  </label>
                </div>

                <button className="w-full inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                  <Zap className="w-4 h-4" />
                  Создать кампанию
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <Layers className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Активные кампании</h4>
                </div>
                <div className="text-sm text-white/40 space-y-2">
                  <div className="p-3 rounded-lg border border-white/10 bg-white/5 flex items-center justify-between">
                    <span>Нет активных кампаний</span>
                    <span className="text-xs px-2 py-1 rounded bg-white/5">0</span>
                  </div>
                </div>
              </div>

              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <Clock className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Планировщики</h4>
                </div>
                <div className="text-sm text-white/40">
                  <div className="flex items-center justify-between mb-2">
                    <span>worker</span>
                    <span className="text-neon-green">running</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>dashboard</span>
                    <span className="text-neon-green">running</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* LORE SECTION */}
        {activeSection === "lore" && (
          <div className="space-y-6">
            <div>
               <h2 className="text-2xl font-bold text-white">Персонаж (Lore)</h2>
              <p className="text-sm text-white/40 mt-1">
                Настройка стиля ответов и примеров
              </p>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Настройки персонажа</h3>
              
              <div className="space-y-4">
                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Имя персонажа</span>
                  <input 
                    type="text" 
                    placeholder="Алекс" 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Стиль ответа</span>
                  <textarea 
                    placeholder="Циничный криптотрейдер, саркастичный, краткие реплики" 
                    rows={3} 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Биография</span>
                  <textarea 
                    placeholder="3 года в крипте, потерял 2 портфеля" 
                    rows={2} 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Системный промпт (опционально)</span>
                  <textarea 
                    placeholder="Ты ведешь себя как опытный криптоинвестор..." 
                    rows={4} 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <div className="border-t border-white/10 pt-4">
                  <h4 className="font-semibold text-white mb-3">Примеры ответов (RAG)</h4>
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <input 
                        type="text" 
                        placeholder="Исходный твит" 
                        className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white text-sm focus:outline-none focus:border-neon-green/40 transition"
                      />
                      <input 
                        type="text" 
                        placeholder="Идеальный ответ" 
                        className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white text-sm focus:outline-none focus:border-neon-green/40 transition"
                      />
                    </div>
                    <button className="px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-white/70 text-sm hover:text-white hover:border-white/20 transition">
                      + Добавить пример
                    </button>
                  </div>
                </div>

                <button className="w-full inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                  <CheckCircle2 className="w-4 h-4" />
                  Сохранить персонажа
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PROXIES SECTION */}
        {activeSection === "proxies" && (
          <div className="space-y-6">
            <div>
               <h2 className="text-2xl font-bold text-white">Прокси</h2>
              <p className="text-sm text-white/40 mt-1">
                Подключение и тестирование прокси-серверов
              </p>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Добавить новый прокси</h3>
              
              <div className="space-y-4">
                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Формат подключения</span>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition">
                    <option value="user:pass@host:port">user:pass@host:port</option>
                    <option value="host:port:user:pass">host:port:user:pass</option>
                    <option value="protocol://user:pass@host:port">protocol://user:pass@host:port</option>
                    <option value="protocol://host:port">protocol://host:port</option>
                  </select>
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Строка прокси</span>
                  <input 
                    type="text" 
                    placeholder="user:pass@123.45.67.89:8080" 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Геолокация</span>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition">
                    <option value="us">United States</option>
                    <option value="uk">United Kingdom</option>
                    <option value="eu">Europe</option>
                    <option value="jp">Japan</option>
                  </select>
                </label>

                <div className="flex gap-3">
                  <button className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-white/5 border border-white/10 text-white hover:text-white hover:border-white/20 transition">
                    <CheckCircle2 className="w-4 h-4" />
                    Тестировать
                  </button>
                  <button className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                    <Zap className="w-4 h-4" />
                    Добавить
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <Shield className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Статус</h4>
                </div>
                <div className="text-sm text-white/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <span>Активные</span>
                    <span className="text-neon-green">0</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Dead</span>
                    <span className="text-red-400">0</span>
                  </div>
                </div>
              </div>

              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <Clock className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Автомониторинг</h4>
                </div>
                <div className="text-sm text-white/40">
                  Проверка каждые 15 минут • Таймаут: 15 сек
                </div>
              </div>

              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <AlertTriangle className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Алерты</h4>
                </div>
                <div className="text-sm text-white/40">
                  Уведомления в Telegram при сбое
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SOURCES SECTION */}
        {activeSection === "sources" && (
          <div className="space-y-6">
            <div>
               <h2 className="text-2xl font-bold text-white">Источники</h2>
              <p className="text-sm text-white/40 mt-1">
                Настройка источников твитов для сбора
              </p>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Добавить источник</h3>
              
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 block">
                    <span className="text-sm text-white/50">Тип</span>
                    <select className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition">
                      <option value="list">Twitter List</option>
                      <option value="search">Поиск X</option>
                    </select>
                  </label>

                  <label className="space-y-1 block">
                    <span className="text-sm text-white/50">Приоритет</span>
                    <select className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition">
                      <option value="1">Низкий (1-3)</option>
                      <option value="4">Средний (4-6)</option>
                      <option value="7">Высокий (7-10)</option>
                    </select>
                  </label>
                </div>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">ID списка / Запрос поиска</span>
                  <input 
                    type="text" 
                    placeholder="1234567890 (для списка) или crypto memes (для поиска)" 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Фильтры</span>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex items-center gap-2 text-sm text-white/50">
                      <input type="checkbox" className="rounded border-white/10 bg-white/5" />
                      Пропускать младше 1 мин
                    </label>
                    <label className="flex items-center gap-2 text-sm text-white/50">
                      <input type="checkbox" className="rounded border-white/10 bg-white/5" />
                      Пропускать старше 10 мин
                    </label>
                    <label className="flex items-center gap-2 text-sm text-white/50">
                      <input type="checkbox" className="rounded border-white/10 bg-white/5" />
                      Пропускать ответы
                    </label>
                    <label className="flex items-center gap-2 text-sm text-white/50">
                      <input type="checkbox" className="rounded border-white/10 bg-white/5" />
                      Пропускать репосты
                    </label>
                  </div>
                </label>

                <button className="w-full inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                  <Zap className="w-4 h-4" />
                  Добавить источник
                </button>
              </div>
            </div>
          </div>
        )}

        {/* AI SECTION */}
        {activeSection === "ai" && (
          <div className="space-y-6">
            <div>
               <h2 className="text-2xl font-bold text-white">AI Генерация</h2>
              <p className="text-sm text-white/40 mt-1">
                Настройка LLM и генерации ответов
              </p>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Провайдер LLM</h3>
              
              <div className="space-y-4">
                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">API Стринг</span>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition">
                    <option value="openai">OpenAI (GPT-4)</option>
                    <option value="anthropic">Anthropic (Claude 3)</option>
                    <option value="local">Локальный (Ollama)</option>
                  </select>
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">API Ключ</span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <input 
                      type="password" 
                      placeholder="sk-..." 
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                    />
                    <button className="px-3 py-2.5 rounded-lg border border-white/10 bg-white/5 text-white/70 text-sm hover:text-white hover:border-white/20 transition">
                      Продемоментировать
                    </button>
                  </div>
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Модель</span>
                  <input 
                    type="text" 
                    placeholder="gpt-4-turbo" 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40 transition"
                  />
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Temperature</span>
                  <input 
                    type="range" 
                    min="0" 
                    max="1" 
                    step="0.1"
                    defaultValue="0.7"
                    className="w-full h-2 bg-white/5 rounded-lg appearance-none cursor-pointer"
                  />
                  <div className="text-xs text-white/50">Текущее: 0.7</div>
                </label>

                <label className="space-y-1 block">
                  <span className="text-sm text-white/50">Vision (обрабатывать картинки)</span>
                  <div className="flex items-center gap-3">
                    <button className="flex-1 py-2.5 rounded-lg border border-white/10 bg-white/5 text-white text-sm hover:border-neon-green/40 transition">Включено</button>
                    <button className="flex-1 py-2.5 rounded-lg border border-white/10 bg-white/5 text-white/50 text-sm hover:border-neon-green/40 transition">Выключено</button>
                  </div>
                </label>

                <button className="w-full inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                  <CheckCircle2 className="w-4 h-4" />
                  Сохранить настройки
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="glass rounded-xl border border-bg-border p-6">
                <h4 className="font-semibold text-white mb-3">RAG Поиск</h4>
                <div className="text-sm text-white/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <span>Топ K похожих примеров</span>
                    <span className="text-neon-green">5</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Векторная база</span>
                    <span className="text-neon-green">pgvector</span>
                  </div>
                </div>
              </div>

              <div className="glass rounded-xl border border-bg-border p-6">
                <h4 className="font-semibold text-white mb-3">Rate Limiting</h4>
                <div className="text-sm text-white/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <span>Ответов в час</span>
                    <span className="text-neon-green">15</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Задержка (сек)</span>
                    <span className="text-neon-green">20</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SECURITY SECTION */}
        {activeSection === "security" && (
          <div className="space-y-6">
            <div>
               <h2 className="text-2xl font-bold text-white">Безопасность</h2>
              <p className="text-sm text-white/40 mt-1">
                Управление шифрованием и доступом
              </p>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Шифрование данных</h3>
              
              <div className="space-y-3 mb-6">
                <div className="p-3 rounded-lg border border-white/10 bg-white/5 flex items-center gap-3">
                  <Shield className="w-5 h-5 text-neon-green" />
                  <div>
                    <div className="text-sm font-semibold text-white">Fernet (AES-CBC + HMAC-SHA256)</div>
                    <div className="text-xs text-white/40">Стандарт безопасности</div>
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-white/10 bg-white/5 flex items-center gap-3">
                  <Database className="w-5 h-5 text-neon-green" />
                  <div>
                    <div className="text-sm font-semibold text-white">Зашифровано в БД</div>
                    <div className="text-xs text-white/40">cookies, прокси, токены</div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <button className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-white/5 border border-white/10 text-white/70 hover:text-white hover:border-white/20 transition">
                  <KeyRound className="w-4 h-4" />
                  Сгенерировать новый ключ шифрования
                </button>
                <button className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold bg-white/5 border border-white/10 text-white/70 hover:text-white hover:border-white/20 transition">
                  <RefreshCw className="w-4 h-4" />
                  Перешифровать все данные
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <Zap className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Изоляция</h4>
                </div>
                <div className="text-sm text-white/40">
                  Один аккаунт = один процесс
                </div>
              </div>

              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <Bot className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Telegram Bot</h4>
                </div>
                <div className="text-sm text-white/40">
                  JWT аутентификация • Моментальный отзыв
                </div>
              </div>

              <div className="glass rounded-xl border border-bg-border p-6">
                <div className="flex items-center gap-2 text-white mb-3">
                  <ExternalLink className="w-4 h-4 text-neon-green" />
                  <h4 className="font-semibold">Логирование</h4>
                </div>
                <div className="text-sm text-white/40">
                  Без секретов • Безопасный доступ
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-200">
              <p className="font-semibold mb-1">⚠️ Что НЕ сохраняется</p>
              <ul className="list-disc list-inside text-xs space-y-1">
                <li>Пароли от аккаунтов (только cookies)</li>
                <li>Секретные ключи в незашифрованном виде</li>
                <li>Логи с персональными данными</li>
                <li>Трафик в открытом виде</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
