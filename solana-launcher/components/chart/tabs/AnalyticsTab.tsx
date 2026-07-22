"use client";
import React, { useEffect, useState, useMemo } from "react";
import { TabLoading, TabError, TabEmpty, shortAddr, fmtNum } from "./_shared";
import { TrendingUp, TrendingDown, Users, AlertTriangle, Crown, Link as LinkIcon } from "lucide-react";

interface HolderAnalytics {
  address: string;
  tokenBalance: number;
  totalBought: number;
  totalSold: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  roi: number;
  txCount: number;
  firstBuyTime: number | null;
  lastActivity: number | null;
  isDev: boolean;
  connectedToDev: boolean;
  sybilGroup: number | null;
  createdAt?: number | null;
  clusterMethod?: "exact_time" | "time_bucket" | "arithmetic_progression" | "fixed_interval";
  clusterDescription?: string;
}

interface WalletCluster {
  addresses: string[];
  method: "exact_time" | "time_bucket" | "arithmetic_progression" | "fixed_interval";
  description: string;
  timeRange: { min: number; max: number };
}

interface AnalyticsResponse {
  mint: string;
  devWallet: string | null;
  holders: HolderAnalytics[];
  sybilGroups: string[][];
  clusters: WalletCluster[];
  tokenPrice: number;
  error?: string;
}

function formatUsd(amount: number): string {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(2)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4)}`;
}

function formatPct(roi: number): string {
  const sign = roi >= 0 ? "+" : "";
  return `${sign}${roi.toFixed(1)}%`;
}

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return "N/A";
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return "<1h ago";
}

export default function AnalyticsTab({ mint, embedded = false }: { mint: string; embedded?: boolean }) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!mint) return;
    setData(null);
    setErr(null);
    setLoading(true);

    fetch(`/api/token-analytics?mint=${encodeURIComponent(mint)}`)
      .then((r) => r.json())
      .then((j: AnalyticsResponse) => {
        if (j.error) {
          setErr(j.error);
        } else {
          setData(j);
        }
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [mint]);

  // Calculate summary stats
  const stats = useMemo(() => {
    if (!data?.holders) return null;

    const profitable = data.holders.filter((h) => h.totalPnl > 0);
    const losing = data.holders.filter((h) => h.totalPnl < 0);
    const totalPnl = data.holders.reduce((sum, h) => sum + h.totalPnl, 0);
    const avgRoi = data.holders.reduce((sum, h) => sum + h.roi, 0) / data.holders.length || 0;
    const sybilCount = new Set(data.holders.map((h) => h.sybilGroup).filter(Boolean)).size;

    // Count by cluster method
    const clustersByMethod = {
      exact_time: data.holders.filter((h) => h.clusterMethod === "exact_time").length,
      time_bucket: data.holders.filter((h) => h.clusterMethod === "time_bucket").length,
      arithmetic_progression: data.holders.filter((h) => h.clusterMethod === "arithmetic_progression").length,
      fixed_interval: data.holders.filter((h) => h.clusterMethod === "fixed_interval").length,
    };

    return {
      profitable: profitable.length,
      losing: losing.length,
      totalPnl,
      avgRoi,
      sybilCount,
      devConnected: data.holders.filter((h) => h.connectedToDev).length,
      clustersByMethod,
      totalClusters: data.clusters?.length || 0,
    };
  }, [data]);

  if (loading) return <TabLoading />;
  if (err) return <TabError message={`Ошибка загрузки аналитики: ${err}`} />;
  if (!data?.holders?.length) return (
    <TabEmpty message="Нет данных о холдерах. Убедитесь что токен торгуется на mainnet и RPC настроен на mainnet." />
  );

  return (
    <div className={embedded ? "text-[11px]" : "text-[11px]"}>
      {/* Summary Stats */}
      <div className={`grid grid-cols-4 gap-2 border-b border-[#1a1a2e] ${embedded ? "px-3 py-2.5" : "px-4 py-3"}`}>
        <div className="text-center">
          <div className="text-[9px] text-[#d1d4dc]/40 uppercase">Profitable</div>
          <div className="text-[#22c55e] font-semibold">{stats?.profitable}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-[#d1d4dc]/40 uppercase">Losing</div>
          <div className="text-[#ef4444] font-semibold">{stats?.losing}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-[#d1d4dc]/40 uppercase">Sybil Groups</div>
          <div className={stats?.sybilCount ? "text-[#f59e0b] font-semibold" : "text-[#d1d4dc] font-semibold"}>
            {stats?.sybilCount || 0}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[9px] text-[#d1d4dc]/40 uppercase">Dev Connected</div>
          <div className={stats?.devConnected ? "text-[#a855f7] font-semibold" : "text-[#d1d4dc] font-semibold"}>
            {stats?.devConnected}
          </div>
        </div>
      </div>

      {/* Sybil Alert */}
      {(stats?.sybilCount ?? 0) > 0 && (
        <div className={`${embedded ? "mx-3" : "mx-4"} mt-3 p-2 bg-[#f59e0b]/10 border border-[#f59e0b]/30 rounded`}>
          <div className="flex items-center gap-2 text-[#f59e0b]">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-medium">Sybil Detected</span>
          </div>
          <div className="text-[10px] text-[#d1d4dc]/70 mt-1">
            Found {stats?.sybilCount ?? 0} group(s) of wallets with suspicious timing patterns
          </div>
        </div>
      )}

      {/* Dev Info */}
      {data.devWallet && (
        <div className={`${embedded ? "mx-3" : "mx-4"} mt-3 p-2 bg-[#a855f7]/10 border border-[#a855f7]/30 rounded`}>
          <div className="flex items-center gap-2 text-[#a855f7]">
            <Crown className="w-4 h-4" />
            <span className="font-medium">Dev Wallet</span>
          </div>
          <div className="text-[10px] text-[#d1d4dc]/70 mt-1 flex items-center gap-2">
            <span className="font-mono">{shortAddr(data.devWallet)}</span>
            <a
              href={`https://solscan.io/account/${data.devWallet}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#a855f7] hover:underline"
            >
              View
            </a>
          </div>
        </div>
      )}

      {/* Cluster Details */}
      {data.clusters && data.clusters.length > 0 && (
        <div className={`${embedded ? "mx-3" : "mx-4"} mt-3`}>
          <div className="text-[9px] text-[#d1d4dc]/40 uppercase mb-2">Wallet Clusters by Creation Time</div>
          <div className="space-y-2">
            {data.clusters.map((cluster, idx) => (
              <div
                key={idx}
                className={`p-2 rounded border ${
                  cluster.method === "exact_time"
                    ? "bg-[#ef4444]/10 border-[#ef4444]/30"
                    : cluster.method === "fixed_interval"
                    ? "bg-[#f59e0b]/10 border-[#f59e0b]/30"
                    : cluster.method === "arithmetic_progression"
                    ? "bg-[#a855f7]/10 border-[#a855f7]/30"
                    : "bg-[#3b82f6]/10 border-[#3b82f6]/30"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                        cluster.method === "exact_time"
                          ? "bg-[#ef4444]/20 text-[#ef4444]"
                          : cluster.method === "fixed_interval"
                          ? "bg-[#f59e0b]/20 text-[#f59e0b]"
                          : cluster.method === "arithmetic_progression"
                          ? "bg-[#a855f7]/20 text-[#a855f7]"
                          : "bg-[#3b82f6]/20 text-[#3b82f6]"
                      }`}
                    >
                      {cluster.method === "exact_time" && "Exact Time"}
                      {cluster.method === "fixed_interval" && "Bot Pattern"}
                      {cluster.method === "arithmetic_progression" && "Same Interval"}
                      {cluster.method === "time_bucket" && "Time Window"}
                    </span>
                    <span className="text-[10px] text-[#d1d4dc]/80">{cluster.description}</span>
                  </div>
                  <span className="text-[9px] text-[#d1d4dc]/60">{cluster.addresses.length} wallets</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {cluster.addresses.map((addr) => (
                    <span key={addr} className="text-[9px] font-mono text-[#d1d4dc]/50">
                      {shortAddr(addr)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Holders Table */}
      <div className="mt-3">
        <div className={`grid grid-cols-[30px_1.2fr_0.8fr_0.8fr_0.8fr_0.8fr] gap-2 border-b border-[#1a1a2e] text-[9px] uppercase tracking-wide text-[#d1d4dc]/40 ${embedded ? "px-3 py-2" : "px-4 py-2"}`}>
          <span>#</span>
          <span>Wallet</span>
          <span className="text-right">P&L</span>
          <span className="text-right">ROI</span>
          <span className="text-right">Bought</span>
          <span className="text-right">First Buy</span>
        </div>

        <div className="divide-y divide-[#1a1a2e]/40">
          {data.holders.map((h, i) => (
            <div
              key={h.address}
              className={`grid grid-cols-[30px_1.2fr_0.8fr_0.8fr_0.8fr_0.8fr] gap-2 items-center hover:bg-white/5 ${embedded ? "px-3 py-1.5" : "px-4 py-2"} ${
                h.isDev ? "bg-[#a855f7]/10" : ""
              } ${h.sybilGroup ? "bg-[#f59e0b]/5" : ""}`}
            >
              <span className="text-[#d1d4dc]/40 tabular-nums">{i + 1}</span>

              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px]">{shortAddr(h.address)}</span>
                {h.isDev && <Crown className="w-3 h-3 text-[#a855f7]" />}
                {h.connectedToDev && <LinkIcon className="w-3 h-3 text-[#a855f7]" />}
                {h.sybilGroup && (
                  <span className="text-[9px] px-1 bg-[#f59e0b]/20 text-[#f59e0b] rounded">
                    S{h.sybilGroup}
                  </span>
                )}
                {h.clusterMethod && (
                  <span
                    className={`text-[9px] px-1 rounded ${
                      h.clusterMethod === "exact_time"
                        ? "bg-[#ef4444]/20 text-[#ef4444]"
                        : h.clusterMethod === "fixed_interval"
                        ? "bg-[#f59e0b]/20 text-[#f59e0b]"
                        : h.clusterMethod === "arithmetic_progression"
                        ? "bg-[#a855f7]/20 text-[#a855f7]"
                        : "bg-[#3b82f6]/20 text-[#3b82f6]"
                    }`}
                  >
                    {h.clusterMethod === "exact_time" && "SAME"}
                    {h.clusterMethod === "fixed_interval" && "BOT"}
                    {h.clusterMethod === "arithmetic_progression" && "STEP"}
                    {h.clusterMethod === "time_bucket" && "W"}
                  </span>
                )}
              </div>

              <div className={`text-right font-medium ${h.totalPnl >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                {h.totalPnl >= 0 ? "+" : ""}
                {formatUsd(h.totalPnl)}
              </div>

              <div className={`text-right ${h.roi >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                {formatPct(h.roi)}
              </div>

              <div className="text-right text-[#d1d4dc]/80">{fmtNum(h.totalBought)}</div>

              <div className="text-right text-[#d1d4dc]/60">{formatTimeAgo(h.firstBuyTime)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className={`${embedded ? "px-3 py-2.5" : "px-4 py-3"} border-t border-[#1a1a2e] text-[9px] text-[#d1d4dc]/50`}>
        <div className="flex flex-wrap gap-3">
          <span className="flex items-center gap-1">
            <Crown className="w-3 h-3 text-[#a855f7]" /> Dev
          </span>
          <span className="flex items-center gap-1">
            <LinkIcon className="w-3 h-3 text-[#a855f7]" /> Connected to Dev
          </span>
          <span className="flex items-center gap-1">
            <span className="px-1 bg-[#f59e0b]/20 text-[#f59e0b] rounded">S1</span> Sybil Group
          </span>
        </div>
        <div className="flex flex-wrap gap-3 mt-2 pt-2 border-t border-[#1a1a2e]/50">
          <span className="flex items-center gap-1">
            <span className="px-1 bg-[#ef4444]/20 text-[#ef4444] rounded">SAME</span> Same time
          </span>
          <span className="flex items-center gap-1">
            <span className="px-1 bg-[#f59e0b]/20 text-[#f59e0b] rounded">BOT</span> Fixed interval
          </span>
          <span className="flex items-center gap-1">
            <span className="px-1 bg-[#a855f7]/20 text-[#a855f7] rounded">STEP</span> Same step
          </span>
          <span className="flex items-center gap-1">
            <span className="px-1 bg-[#3b82f6]/20 text-[#3b82f6] rounded">W</span> Time window
          </span>
        </div>
      </div>
    </div>
  );
}
