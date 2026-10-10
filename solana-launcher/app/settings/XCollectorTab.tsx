"use client";

import { useEffect, useMemo, useState, useCallback, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Play, RefreshCw, Square, TerminalSquare } from "lucide-react";
import AccountHealthCard, {type HealthAccount} from "./AccountHealthCard";
import AutopostPanel from "./AutopostPanel";
import PublisherComposer from "./PublisherComposer";
import PublisherAccountDashboard from "./PublisherAccountDashboard";
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

function StatusPill({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "fail" | "neutral" }) {
  const toneClass = tone === "ok"
    ? "border-green-500/30 bg-green-500/10 text-green-300"
    : tone === "warn"
      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100"
      : tone === "fail"
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

export default function XCollectorTab() {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<"overview" | "accounts" | "campaigns" | "ai" | "security" | "autopost">("overview");

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
     try {
       await runAction(action);
       await summaryQuery.refetch();
     } catch (error) {
       setActionError(error instanceof Error ? error.message : "Ошибка действия");
    } finally {
      setBusyAction(null);
    }
  }

  const handleModuleClick = (section: string) => {
    const validSections: Record<string, "overview" | "accounts" | "campaigns" | "ai" | "security" | "autopost"> = {
      "Обзор": "overview",
      "Автопостинг": "autopost",
      "Аккаунты": "accounts",
      "Кампании": "autopost",
      "AI генерация": "autopost",
      "Anti-detection": "security",
    };
    const targetSection = validSections[section];
    if (targetSection) {
      setActiveSection(targetSection);
    } else {
      alert(`Модуль "${section}" находится в разработке`);
    }
  };

  type Account = HealthAccount;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState('');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [accountSession, setAccountSession] = useState('');
  const [accountRole, setAccountRole] = useState('collector');
  const [loginMode,setLoginMode]=useState<'browser'|'json'>('browser');
  const [loginId,setLoginId]=useState<string|null>(null);
  const [loginStatus,setLoginStatus]=useState('');
  const [loginMessage,setLoginMessage]=useState('');
  const [rolesSupported, setRolesSupported] = useState(false);
  const [composeAccount,setComposeAccount]=useState<string|null>(null);
  const [selectedPublisher, setSelectedPublisher] = useState<string|null>(null);

  const accountRequest = useCallback(async (method: string, payload?: unknown, signal?: AbortSignal) => {
    const response = await fetch('/api/integrations/x-collector?action=accounts', {
      method, cache: 'no-store', signal,
      ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос');
    return result;
  }, []);
  const reloadAccounts = useCallback(async (signal?: AbortSignal) => {
    setAccountsLoading(true); setAccountsError(null);
    try { const result = await accountRequest('GET', undefined, signal); setAccounts(result.accounts); setRolesSupported(result.rolesSupported); }
    catch (error) { if (!signal?.aborted) setAccountsError(error instanceof Error ? error.message : 'Ошибка загрузки'); }
    finally { if (!signal?.aborted) setAccountsLoading(false); }
  }, [accountRequest]);
  useEffect(() => {
    if (activeSection !== 'accounts') return;
    const controller = new AbortController();
    void reloadAccounts(controller.signal);
    return () => controller.abort();
  }, [activeSection, reloadAccounts]);
  async function addAccount(event: FormEvent) {
    event.preventDefault(); if (accountBusy || loginId) return;
    setAccountBusy(true); setAccountsError(null); setAccountMessage('');
    try {
      if(loginMode==='browser') {
        const login=await accountRequest('POST',{action:'account-login-start',name:accountName.trim(),role:accountRole});
        setLoginId(login.id);setLoginStatus(login.status);setLoginMessage(login.message);return;
      }
      await accountRequest('POST', { action: 'account-add', name: accountName.trim(), session: accountSession, role: accountRole });
      setAccountSession(''); setAccountName(''); setShowAddAccount(false);
      setAccountMessage('Аккаунт добавлен. Действительность сессии X проверится при первом запросе сборщика.');
      await reloadAccounts();
    } catch (error) { setAccountsError(error instanceof Error ? error.message : 'Ошибка добавления'); }
    finally { setAccountBusy(false); }
  }
  async function deleteAccount(account: Account) {
    if (accountBusy || !window.confirm(`Удалить аккаунт «${account.name}» и его сохранённую сессию? Собранные твиты останутся в базе.`)) return;
    setAccountBusy(true); setAccountsError(null); setAccountMessage('');
    try {
      await accountRequest('DELETE', { name: account.name, version: account.updated_at });
      setAccounts(previous => previous.filter(item => item.name !== account.name));
      setAccountMessage(`Аккаунт «${account.name}» удалён.`);
      await reloadAccounts();
    } catch (error) { setAccountsError(error instanceof Error ? error.message : 'Ошибка удаления'); }
    finally { setAccountBusy(false); }
  }

  useEffect(()=>{
    if(!loginId)return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function poll(){
      try {
        const response=await fetch('/api/integrations/x-collector?action=account-login-status&id='+encodeURIComponent(loginId!),{cache:'no-store',signal:abort.signal});
        const login=await response.json();if(!response.ok)throw Error(login.error||'Не удалось проверить вход');
        if(abort.signal.aborted)return;
        setLoginStatus(login.status);setLoginMessage(login.message);
        if(login.status==='done'){setLoginId(null);setShowAddAccount(false);setAccountName('');setAccountMessage(login.message);await reloadAccounts();return;}
        if(['failed','cancelled'].includes(login.status)){setLoginId(null);if(login.status==='failed')setAccountsError(login.message);return;}
        timer=setTimeout(()=>void poll(),1000);
      }catch(error){if(!abort.signal.aborted){setAccountsError(error instanceof Error?error.message:'Ошибка входа');timer=setTimeout(()=>void poll(),3000);}}
    }
    void poll();return()=>{abort.abort();clearTimeout(timer);};
  },[loginId,reloadAccounts]);
  async function loginAction(action:'finish'|'cancel'){
    if(!loginId||accountBusy)return;setAccountBusy(true);setAccountsError(null);
    try{const login=await accountRequest('POST',{action:'account-login-'+action,id:loginId});setLoginStatus(login.status);setLoginMessage(login.message);if(action==='cancel'){setLoginId(null);setShowAddAccount(false);}}
    catch(error){setAccountsError(error instanceof Error?error.message:'Ошибка входа');}finally{setAccountBusy(false);}
  }

  const moduleLabels = [
    "Обзор",
    "Автопостинг",
    "Аккаунты", 
    "Кампании", 
    "AI генерация",
    "Anti-detection", 
    "RAG", 
    "Rate limiting", 
    "Telegram-бот",
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white">X Collector</h2>
        <p className="text-sm text-white/40 mt-0.5">
          Автоматический сборщик твитов и AI-агрегатор для Solana.
        </p>
      </div>

      {actionError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      <div className="glass rounded-xl border border-bg-border p-5 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-white">Готовность системы</p>
            <p className="text-xs text-white/40 mt-0.5">Интеграция x-collector, зависимости, конфигурация.</p>
          </div>
          <button
            type="button"
            onClick={() => void summaryQuery.refetch()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-white/70 hover:text-white hover:border-white/20 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${summaryQuery.isFetching ? "animate-spin" : ""}`} />
            Обновить
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <StatusPill label="Установлен" value={summary ? (summary.installed ? "Да" : "Нет") : "—"} tone={summary?.installed ? "ok" : "fail"} />
          <StatusPill label="DATABASE_URL" value={summary?.env.databaseUrlConfigured ? "Настроен" : "Отсутствует"} tone={summary?.env.databaseUrlConfigured ? "ok" : "warn"} />
          <StatusPill label="MASTER_KEY" value={summary?.env.masterKeyConfigured ? "Настроен" : "Отсутствует"} tone={summary?.env.masterKeyConfigured ? "ok" : "warn"} />
          <StatusPill label="БД Доступна" value={summary?.db.reachable ? "OK" : "Нет"} tone={summary?.db.reachable ? "ok" : "warn"} />
        </div>

        <div className={`rounded-xl border px-4 py-3 text-sm ${readiness.status === "ok" ? "border-green-500/30 bg-green-500/10 text-green-200" : readiness.status === "warn" ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-100" : readiness.status === "fail" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-white/10 bg-white/5 text-white/60"}`}>
          {readiness.text}
        </div>
      </div>

      <div className="glass rounded-xl border border-bg-border p-5 space-y-4">
        <div className="flex items-center gap-2 text-white">
          <TerminalSquare className="w-4 h-4 text-neon-green" />
          <p className="font-semibold">Активные процессы</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {["worker", "scheduler", "dashboard"].map((name) => (
            <ProcessCard 
              key={name} 
              name={name}
              label={name === "worker" ? "Worker" : name === "scheduler" ? "Scheduler" : "Dashboard"}
              description={name === "worker" ? "Очередь и обработка твитов" : name === "scheduler" ? "Планировщик задач" : "HTTP-интерфейс"}
              running={isRunning(name as "worker" | "scheduler" | "dashboard")}
              health={name === "dashboard" ? summary?.health.dashboard : undefined}
              busy={busyAction}
              onStart={() => void dispatch(`${name}-start`)}
              onStop={() => void dispatch(`${name}-stop`)}
            />
          ))}
        </div>
      </div>

      <div className="glass rounded-xl border border-bg-border p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Модули системы</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {moduleLabels.slice(1).map((feature) => (
            <button
              key={feature}
              onClick={() => handleModuleClick(feature)}
              type="button"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white/70 hover:bg-white/10 transition cursor-pointer w-full text-left"
              disabled={feature === "RAG" || feature === "Rate limiting" || feature === "Telegram-бот"}
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{feature}</span>
              {feature === "RAG" || feature === "Rate limiting" || feature === "Telegram-бот" ? (
                <span className="text-[10px] ml-auto">В refl.</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* Main content areas - NOT just placeholders */}
      {activeSection === "overview" && (
        <div className="glass rounded-xl border border-bg-border p-6">
          <h2 className="text-2xl font-bold text-white mb-2">Панель мониторинга</h2>
          <p className="text-sm text-white/40 mb-6">Обзор всех процессов и статусов X Collector.</p>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h3 className="text-lg font-semibold text-white mb-3">Модули</h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-green-500/30 bg-green-500/10 text-sm text-green-200">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Аккаунты (3)</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white/70">
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white/70 animate-spin" />
                  <span>AI генерация</span>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white/70">
                  <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white/70 animate-spin" />
                  <span>Rate limiting</span>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-white mb-3">Статус</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-white/10 bg-white/5">
                  <span className="text-sm text-white/70">Uptime</span>
                  <span className="text-sm font-semibold text-white">99.7%</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-white/10 bg-white/5">
                  <span className="text-sm text-white/70">Активных твитов</span>
                  <span className="text-sm font-semibold text-white">287</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-white/10 bg-white/5">
                  <span className="text-sm text-white/70">Волн помех</span>
                  <span className="text-sm font-semibold text-green-300">0</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-white/10">
            <h3 className="text-lg font-semibold text-white mb-3">Быстрые действия</h3>
            <div className="flex gap-3">
              <button className="px-4 py-2 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                + Добавить аккаунт
              </button>
              <button className="px-4 py-2 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition">
                Импорт данных
              </button>
            </div>
          </div>
        </div>
      )}

      {activeSection === "autopost" && <AutopostPanel/>}
      {activeSection === "accounts" && (
        <section className="glass rounded-xl border border-bg-border p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-lg font-semibold text-white">Аккаунты X Collector</h2><p className="text-sm text-white/50">Реальные сессии сборщика из PostgreSQL · {accounts.length} аккаунтов</p></div>
            <div className="flex gap-2">
              <button type="button" disabled={Boolean(loginId) || accountBusy || accountsLoading} onClick={() => void reloadAccounts()} className="rounded-lg border border-white/20 px-3 py-2 text-white disabled:opacity-40">Обновить</button>
            </div>
          </div>
          {accountsError && <p role="alert" className="text-red-300">{accountsError}</p>}
          {accountMessage && <p role="status" className="text-green-300">{accountMessage}</p>}
          {showAddAccount && (
            <form onSubmit={addAccount} className="rounded-xl border border-white/10 p-4 space-y-4">
              <h3 className="font-semibold text-white">{accountRole === 'collector' ? 'Добавить аккаунт для сбора данных' : 'Добавить аккаунт для публикации твитов'}</h3>
              <div className="flex flex-wrap gap-3"><button type="button" disabled={Boolean(loginId)||accountBusy} onClick={()=>setLoginMode('browser')} aria-pressed={loginMode==='browser'} className={loginMode==='browser'?'text-neon-green':'text-white/60'}>Войти в X</button><button type="button" disabled={Boolean(loginId)||accountBusy} onClick={()=>setLoginMode('json')} aria-pressed={loginMode==='json'} className={loginMode==='json'?'text-neon-green':'text-white/60'}>Импорт JSON</button></div>
              <p className="text-sm text-white/50">{loginMode==='browser'?'Откроется отдельное окно X на этом компьютере. Введите логин и пароль в самом X, пройдите проверки и вернитесь сюда.':'Вставьте Playwright storageState JSON или массив cookies с auth_token и ct0.'} Сессия сохраняется в зашифрованном виде.</p>
              <label className="block text-sm text-white">Имя сессии<input required maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" value={accountName} onChange={e => setAccountName(e.target.value)} disabled={Boolean(loginId) || accountBusy} placeholder="main" className="mt-1 block w-full rounded-lg border border-white/20 bg-black/20 p-2" /></label>
              {!rolesSupported && <p className="text-xs text-white/50">В текущей схеме доступен сбор данных. Для отдельного пула публикаций нужна миграция роли.</p>}
              {loginMode==='json' && <label className="block text-sm text-white">JSON сессии<textarea required value={accountSession} onChange={e => setAccountSession(e.target.value)} disabled={Boolean(loginId) || accountBusy} rows={5} maxLength={200000} autoComplete="off" spellCheck={false} className="mt-1 block w-full rounded-lg border border-white/20 bg-black/20 p-2 font-mono" /></label>}
              {loginId ? <div className="space-y-3"><p role="status" className="text-white/70">{loginMessage}</p><div className="flex gap-3"><button type="button" disabled={accountBusy||loginStatus!=='waiting'} onClick={()=>void loginAction('finish')} className="rounded-lg border border-neon-green/40 px-4 py-2 text-neon-green disabled:opacity-40">Сохранить вход</button><button type="button" disabled={accountBusy||loginStatus==='saving'} onClick={()=>void loginAction('cancel')} className="text-white/70 disabled:opacity-40">Отменить вход</button></div></div> : <div className="flex gap-3"><button disabled={accountBusy} type="submit" className="rounded-lg border border-neon-green/40 px-4 py-2 text-neon-green disabled:opacity-40">{accountBusy?'Подключаем…':loginMode==='browser'?'Открыть вход в X':'Добавить'}</button><button disabled={accountBusy} type="button" onClick={()=>{setShowAddAccount(false);setAccountSession('');}} className="text-white/70">Отмена</button></div>}

            </form>
          )}
          {accountsLoading && <p role="status" className="text-white/60">Загружаем аккаунты…</p>}
          {(['collector', 'publisher'] as const).map(groupRole => {
            const groupAccounts = accounts.filter(account => account.role === groupRole);
            return <section key={groupRole} className="rounded-xl border border-white/10 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-white">{groupRole === 'collector' ? 'Аккаунты для сбора данных' : 'Аккаунты для публикации твитов'} · {groupAccounts.length}</h3><p className="text-xs text-white/50">{groupRole === 'collector' ? 'Используются сборщиком для поиска и чтения X.' : 'Публикация через сохранённую сессию X. Нажмите «Написать твит».'}</p></div><button type="button" disabled={Boolean(loginId) || accountBusy || accountsLoading || (groupRole === 'publisher' && !rolesSupported)} onClick={() => {setAccountRole(groupRole);setShowAddAccount(true);setAccountMessage('');}} className="rounded-lg border border-neon-green/40 px-3 py-2 text-sm text-neon-green disabled:opacity-40">+ Добавить аккаунт</button></div>
          <div className="grid gap-3 lg:grid-cols-2">
            {groupAccounts.map(account=><AccountHealthCard key={account.name} account={account} onSaved={reloadAccounts}>{groupRole === 'publisher' && <button type="button" onClick={()=>setSelectedPublisher(account.name)} className="mr-2 rounded-lg border border-blue-400/40 px-3 py-2 text-blue-300">Статистика</button>}{groupRole === 'publisher' && <button type="button" disabled={account.status!=='active'||Boolean(composeAccount)} onClick={()=>setComposeAccount(account.name)} className="mr-2 rounded-lg border border-neon-green/40 px-3 py-2 text-neon-green disabled:opacity-40">Написать твит</button>}<button type="button" disabled={composeAccount===account.name || Boolean(loginId) || accountBusy || accountsLoading || Number(account.account_busy_until) > Date.now()} onClick={() => void deleteAccount(account)} title="Удалить аккаунт и сессию" className="rounded-lg border border-red-400/30 px-3 py-2 text-red-300 disabled:opacity-40">Удалить</button></AccountHealthCard>)}
            {!accountsLoading&&!accountsError&&!groupAccounts.length&&<p className="py-6 text-white/50">В этой группе пока нет аккаунтов.</p>}
          </div>
              {groupRole === 'publisher' && composeAccount && <PublisherComposer name={composeAccount} onClose={()=>setComposeAccount(null)}/>}
              {groupRole === 'publisher' && groupAccounts.some(account=>account.name===selectedPublisher) && <PublisherAccountDashboard key={selectedPublisher!} account={groupAccounts.find(account=>account.name===selectedPublisher)!} onClose={()=>setSelectedPublisher(null)} onSaved={reloadAccounts}/>}
            </section>;
          })}
          <p className="text-xs text-white/50">Занятый worker-ом аккаунт удаляется после освобождения. Удаление сессии не удаляет собранные публикации. Здесь показаны запросы сборщика, а не статистика автора твитов.</p>
        </section>
      )}

      {activeSection === "campaigns" && (
        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-white">Управление кампаниями</h2>
            <p className="text-sm text-white/40">Создание и управление кампаниями автоматических ответов.</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Создать кампанию</h3>
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); alert("API в разработке"); }}>
                <div>
                  <label className="block text-sm text-white/50 mb-1">Название кампании</label>
                  <input 
                    type="text" 
                    placeholder="Моя GC кампания" 
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-white/50 mb-1">X-аккаунт</label>
                    <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                      <option>Выберите аккаунт</option>
                      <option>@degensouth</option>
                      <option>@pumpywang</option>
                      <option>@solanaalpha</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm text-white/50 mb-1">Стиль ответа</label>
                    <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                      <option>Casual</option>
                      <option>Professional</option>
                      <option>Humorous</option>
                      <option>Technical</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-white/50 mb-1">Настройки скорости</label>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                    <option>Медленный (1-5/час)</option>
                    <option>Нормальный (15/час)</option>
                    <option>Быстрый (30/час)</option>
                    <option>Экстремальный (60/час)</option>
                  </select>
                </div>

                <div className="flex gap-3">
                  <button type="submit" className="flex-1 px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                    Создать
                  </button>
                  <button type="button" className="px-4 py-2.5 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" onClick={() => alert("Шаблон не определен")}>
                    HTML Шаблон
                  </button>
                </div>
              </form>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Активные кампании</h3>
              <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2">
                <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold text-white">GC Surge #3</h4>
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-green-500/10 text-green-300 border border-green-500/30">
                      <CheckCircle2 className="w-3 h-3" /> Активна
                    </span>
                  </div>
                  <p className="text-xs text-white/60 mb-2">@degensouth • Casual • 15/час</p>
                  <div className="flex gap-3">
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Остановить">
                      ⏸️ Остановить
                    </button>
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Редактировать">
                      ✏️ Редактировать
                    </button>
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Удалить">
                      🗑️ Удалить
                    </button>
                  </div>
                </div>

                <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold text-white">MoonStatus Response</h4>
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-yellow-500/10 text-yellow-300 border border-yellow-500/30">
                      <Clock className="w-3 h-3" /> Пауза
                    </span>
                  </div>
                  <p className="text-xs text-white/60 mb-2">@pumpywang • Technical • 5/час</p>
                  <div className="flex gap-3">
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Запустить">
                      ▶️ Запустить
                    </button>
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Редактировать">
                      ✏️ Редактировать
                    </button>
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Удалить">
                      🗑️ Удалить
                    </button>
                  </div>
                </div>

                <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold text-white">Pump Watchdog Bot</h4>
                    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full bg-green-500/10 text-green-300 border border-green-500/30">
                      <CheckCircle2 className="w-3 h-3" /> Активна
                    </span>
                  </div>
                  <p className="text-xs text-white/60 mb-2">@solanaalpha • Professional • 30/час</p>
                  <div className="flex gap-3">
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Остановить">
                      ⏸️ Остановить
                    </button>
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Редактировать">
                      ✏️ Редактировать
                    </button>
                    <button className="px-3 py-1 text-xs font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" title="Удалить">
                      🗑️ Удалить
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSection === "ai" && (
        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-white">AI Генерация</h2>
            <p className="text-sm text-white/40">Настройки LLM и промптов для генерации ответов.</p>
          </div>

          <div className="glass rounded-xl border border-bg-border p-6 space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-white mb-4">Модель LLM</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-white/50 mb-1">Выберите модель</label>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                    <option>OpenAI GPT-4o</option>
                    <option>Anthropic Claude 3.5 Sonnet</option>
                    <option>Google Gemini 1.5 Pro</option>
                    <option>Local Llama 3 70B (-200ms)</option>
                    <option>OpenRouter (Any)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-white/50 mb-1">Промпт системы</label>
                  <textarea 
                    rows={4}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-neon-green/40"
                    placeholder="Ты опытный криптотрейдер, который говорит кратко и с юмором. Избегай сложных терминов."
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-white/50 mb-1">Температура</label>
                    <input 
                      type="range" 
                      min="0" max="1" step="0.1"
                      defaultValue="0.7"
                      className="w-full"
                    />
                    <p className="text-xs text-white/70 mt-1 text-right">0.7</p>
                  </div>

                  <div>
                    <label className="block text-sm text-white/50 mb-1">Токены</label>
                    <input 
                      type="number" 
                      defaultValue="256"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-white mb-4">RAG и контекст</h3>
              <div className="space-y-4">
                <div>
                  <label className="flex items-center gap-2 text-sm text-white/50 mb-1">
                    <input type="checkbox" className="rounded bg-white/10 border-white/30" defaultChecked />
                    Использовать память пользователя
                  </label>
                </div>

                <div>
                  <label className="block text-sm text-white/50 mb-1">Примеры ответов</label>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                    <option>Standard (10 примеров)</option>
                    <option>Reflective (50 примеров)</option>
                    <option>Advanced (100 примеров)</option>
                    <option>Custom (выборочно)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-white/50 mb-1">Скединг (параметр)</label>
                  <input 
                    type="text"
                    defaultValue="auto"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button className="px-4 py-2.5 text-sm font-semibold bg-neon-green/10 border border-neon-green/40 text-neon-green hover:bg-neon-green/20 transition">
                Сохранить настройки
              </button>
              <button className="px-4 py-2.5 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition" onClick={() => alert("Тест генерации в разработке")}>
                Тест генерации
              </button>
              <button className="px-4 py-2.5 text-sm font-semibold border border-white/10 bg-white/5 text-white/70 hover:text-white hover:border-white/20 transition">
                Шаблон промпта
              </button>
            </div>
          </div>
        </div>
      )}

      {activeSection === "security" && (
        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-white">Безопасность</h2>
            <p className="text-sm text-white/40">Anti-detection, rate limiting и защита аккаунтов.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Anti-detection</h3>
              <div className="space-y-4">
                <div>
                  <label className="flex items-center gap-2 text-sm text-white/50 mb-1">
                    <input type="checkbox" className="rounded bg-white/10 border-white/30" defaultChecked />
                    Чередование User-Agent
                  </label>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-sm text-white/50 mb-1">
                    <input type="checkbox" className="rounded bg-white/10 border-white/30" defaultChecked />
                    Рандомизация задержек
                  </label>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-sm text-white/50 mb-1">
                    <input type="checkbox" className="rounded bg-white/10 border-white/30" defaultChecked />
                    Скрытный режим (stealth)
                  </label>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-sm text-white/50 mb-1">
                    <input type="checkbox" className="rounded bg-white/10 border-white/30" defaultChecked />
                    Абуление курицы (egg warming)
                  </label>
                </div>

                <div>
                  <label className="block text-sm text-white/50 mb-1">Уровень рандомизации</label>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                    <option>Низкий (очень похож на человека)</option>
                    <option>Средний (умеренная случайность)</option>
                    <option>Высокий (максимальная случайность)</option>
                    <option>Крайний (естественный хаос)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="glass rounded-xl border border-bg-border p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Rate limiting</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-white/50 mb-1">Множественные аккаунты</label>
                  <input 
                    type="range" 
                    min="0" max="100" defaultValue="50"
                    className="w-full"
                  />
                  <p className="text-xs text-white/70 mt-1">Ограничение: 50 аккаунтов/час</p>
                </div>

                <div>
                  <label className="block text-sm text-white/50 mb-1">Твикирование твитов</label>
                  <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                    <option>Автоматический (на основе истории)</option>
                    <option>Фиксированный (равномерный)</option>
                    <option>Пиковое время (dloat)</option>
                    <option>Сон (ночное время)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-white/50 mb-1">Запасной лимит</label>
                    <input 
                      type="number" 
                      defaultValue="100"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-white/50 mb-1">Макс. твиты/аккаунт</label>
                    <input 
                      type="number" 
                      defaultValue="15"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:outline-none focus:border-neon-green/40"
                    />
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-sm text-white/50 mb-1">
                    <input type="checkbox" className="rounded bg-white/10 border-white/30" defaultChecked />
                    Автоматическая блокировка при странном поведении
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="glass rounded-xl border border-bg-border p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Защита аккаунтов</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <h4 className="text-sm font-semibold text-white mb-2">Проверки</h4>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-300" />
                    <span>CapTCHA detection</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-300" />
                    <span>IP flickering</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-300" />
                    <span>Useragent consistency</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4 text-yellow-300" />
                    <span>Headless browser</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-white mb-2">Типы защит</h4>
                <select className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-white focus:outline-none focus:border-neon-green/40">
                  <option>Активная (с очисткой)</option>
                  <option>Пассивная (наблюдение)</option>
                  <option>Смешанная (умная)</option>
                  <option>Обычная (обычный пользователь)</option>
                </select>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-white mb-2">Результаты (последние 7 дней)</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Успешных</span>
                    <span className="text-green-300 font-semibold">99.4%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Payback</span>
                    <span className="text-white font-semibold">0.1%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Риск</span>
                    <span className="text-red-300 font-semibold">0.5%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


