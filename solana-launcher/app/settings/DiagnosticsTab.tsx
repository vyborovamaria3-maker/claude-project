"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { loadWallets, type WalletMeta } from "@/lib/walletStore";

type CheckStatus = "checking" | "ok" | "warn" | "fail";

type CheckItem = {
  title: string;
  status: CheckStatus;
  detail: string;
};

const ENDPOINTS = [
  {
    key: "market-overview",
    title: "Market Overview API",
    url: "/api/market-overview?timeframe=24h",
    description: "Проверяет, что страница обзора рынка отвечает быстро и без внешних зависимостей.",
  },
  {
    key: "trending",
    title: "Trending API",
    url: "/api/trending",
    description: "Проверяет выдачу трендов и fallback-кэш для главной панели.",
  },
  {
    key: "apify",
    title: "Apify Integration API",
    url: "/api/integrations/apify",
    description: "Проверяет server-side интеграцию Apify и состояние последних runs.",
  },
] as const;

function statusClass(status: CheckStatus) {
  switch (status) {
    case "ok":
      return "bg-green-500/10 border-green-500/30 text-green-400";
    case "warn":
      return "bg-yellow-500/10 border-yellow-500/30 text-yellow-300";
    case "fail":
      return "bg-red-500/10 border-red-500/30 text-red-300";
    default:
      return "bg-white/5 border-white/10 text-white/50";
  }
}

function statusIcon(status: CheckStatus) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="w-4 h-4" />;
    case "warn":
    case "fail":
      return <AlertTriangle className="w-4 h-4" />;
    default:
      return <Loader2 className="w-4 h-4 animate-spin" />;
  }
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 7000): Promise<{ ok: boolean; elapsed: number; stale: boolean; status: number }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      elapsed: Date.now() - startedAt,
      stale: response.headers.get("x-stale") === "true",
      status: response.status,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchRpcHealth(url: string, timeoutMs = 7000): Promise<{ ok: boolean; elapsed: number; status: number; detail: string }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
      cache: "no-store",
      signal: controller.signal,
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const elapsed = Date.now() - startedAt;
    const health = typeof payload === "object" && payload !== null && "result" in payload ? String((payload as { result?: unknown }).result ?? "") : "";
    const error = typeof payload === "object" && payload !== null && "error" in payload ? (payload as { error?: { message?: string } }).error?.message : null;

    if (!response.ok) {
      return {
        ok: false,
        elapsed,
        status: response.status,
        detail: `HTTP ${response.status}${error ? ` · ${error}` : ""}`,
      };
    }

    if (health && health.toLowerCase() === "ok") {
      return {
        ok: true,
        elapsed,
        status: response.status,
        detail: `RPC здоров. Ответ за ${elapsed}мс.`,
      };
    }

    return {
      ok: true,
      elapsed,
      status: response.status,
      detail: `RPC отвечает${error ? ` · ${error}` : ""}.`,
    };
  } catch (error) {
    return {
      ok: false,
      elapsed: Date.now() - startedAt,
      status: 0,
      detail: error instanceof Error ? error.message : "Не удалось проверить RPC",
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function DiagnosticsTab() {
  const [rpcStatus, setRpcStatus] = useState<CheckItem>({
    title: "RPC Health",
    status: "checking",
    detail: "Проверяю доступность RPC...",
  });
  const [endpointChecks, setEndpointChecks] = useState<Record<string, CheckItem>>({});
  const [wallets, setWallets] = useState<WalletMeta[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const rpcUrl = useMemo(
    () => process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com",
    []
  );

  const runChecks = useCallback(async () => {
    setLoading(true);

    const [rpcResult, ...endpointResults] = await Promise.all([
      fetchRpcHealth(rpcUrl),
      ...ENDPOINTS.map(async (endpoint) => {
        const result = await fetchJsonWithTimeout(endpoint.url);
        let status: CheckStatus = "ok";
        let detail = `Ответ за ${result.elapsed}мс.`;

        if (!result.ok) {
          status = "fail";
          detail = `HTTP ${result.status}`;
        } else if (result.stale) {
          status = "warn";
          detail = `Ответ кэширован / stale за ${result.elapsed}мс.`;
        }

        return {
          key: endpoint.key,
          item: {
            title: endpoint.title,
            status,
            detail,
          },
        };
      }),
    ]);

    const walletsSnapshot = loadWallets();
    const devWallet = walletsSnapshot.find((wallet) => wallet.role === "dev");
    const walletStatus: CheckItem = walletsSnapshot.length > 0
      ? {
          title: "Wallet Store",
          status: devWallet ? "ok" : "warn",
          detail: devWallet
            ? `${walletsSnapshot.length} кошелёк(ов), dev wallet назначен: ${devWallet.publicKey.slice(0, 4)}…${devWallet.publicKey.slice(-4)}.`
            : `${walletsSnapshot.length} кошелёк(ов), но dev wallet не назначен.`,
        }
      : {
          title: "Wallet Store",
          status: "warn",
          detail: "Кошельки ещё не созданы или не импортированы.",
        };

    setRpcStatus({
      title: "RPC Health",
      status: rpcResult.ok ? "ok" : "fail",
      detail: rpcResult.ok
        ? `RPC отвечает за ${rpcResult.elapsed}мс.`
        : rpcResult.detail,
    });

    const nextEndpointChecks: Record<string, CheckItem> = {};
    for (const entry of endpointResults as Array<{ key: string; item: CheckItem }>) {
      nextEndpointChecks[entry.key] = entry.item;
    }
    nextEndpointChecks.wallets = walletStatus;
    setEndpointChecks(nextEndpointChecks);
    setWallets(walletsSnapshot);
    setLastCheckedAt(Date.now());
    setLoading(false);
  }, [rpcUrl]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const walletCount = wallets.length;
  const devWalletCount = wallets.filter((wallet) => wallet.role === "dev").length;
  const bundleWalletCount = wallets.filter((wallet) => wallet.role === "bundle").length;
  const snipeWalletCount = wallets.filter((wallet) => wallet.role === "snipe").length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white">Diagnostics</h2>
        <p className="text-sm text-white/40 mt-0.5">
          Dexter-style readiness checks: RPC, ключевые быстрые API, и состояние локальных кошельков.
        </p>
      </div>

      <div className="glass rounded-xl border border-bg-border p-5 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-white">System readiness</p>
            <p className="text-xs text-white/40 mt-0.5">
              Быстро видно, что готово к анализу и торговле, а что требует внимания.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runChecks()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-xs text-white/70 hover:text-white hover:border-white/20 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <StatusCard item={rpcStatus} />
          {ENDPOINTS.map((endpoint) => (
            <StatusCard
              key={endpoint.key}
              item={endpointChecks[endpoint.key] ?? {
                title: endpoint.title,
                status: loading ? "checking" : "warn",
                detail: loading ? "Проверяю..." : endpoint.description,
              }}
            />
          ))}
          <StatusCard
            item={endpointChecks.wallets ?? {
              title: "Wallet Store",
              status: loading ? "checking" : walletCount > 0 ? "warn" : "warn",
              detail: loading ? "Проверяю..." : "Кошельки не обнаружены.",
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="glass rounded-xl border border-bg-border p-5 space-y-3">
          <div className="flex items-center gap-2 text-white">
            <Wallet className="w-4 h-4 text-neon-green" />
            <p className="font-semibold">Wallet summary</p>
          </div>
          <div className="space-y-2 text-sm">
            <Row label="Total wallets" value={String(walletCount)} />
            <Row label="Dev wallets" value={String(devWalletCount)} />
            <Row label="Bundle wallets" value={String(bundleWalletCount)} />
            <Row label="Snipe wallets" value={String(snipeWalletCount)} />
          </div>
        </div>

        <div className="glass rounded-xl border border-bg-border p-5 space-y-3 lg:col-span-2">
          <div className="flex items-center gap-2 text-white">
            <ShieldCheck className="w-4 h-4 text-neon-green" />
            <p className="font-semibold">What this protects you from</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-white/60">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              Не запускать торговлю, если RPC деградирует или внешние фиды недоступны.
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              Не забывать про состояние кошельков: наличие dev wallet, общий инвентарь и роли.
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              Понимать, какие данные доступны прямо сейчас: market overview, trending и Apify integration.
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              Сразу видеть stale/fallback ответы, чтобы не принимать решение по устаревшим данным.
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              Для глубокой X-аналитики используй отдельную страницу <span className="text-white">/x-analysis</span>.
            </div>
          </div>
        </div>
      </div>

      <div className="text-xs text-white/35">
        {lastCheckedAt
          ? `Последняя проверка: ${new Date(lastCheckedAt).toLocaleString()} · RPC: ${rpcUrl}`
          : `RPC: ${rpcUrl}`}
      </div>
    </div>
  );
}

function StatusCard({ item }: { item: CheckItem }) {
  return (
    <div className={`rounded-xl border p-4 ${statusClass(item.status)}`}>
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5">{statusIcon(item.status)}</div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{item.title}</p>
          <p className="text-xs text-white/60 mt-1 leading-relaxed">{item.detail}</p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <span className="text-white/50">{label}</span>
      <span className="font-semibold text-white">{value}</span>
    </div>
  );
}
