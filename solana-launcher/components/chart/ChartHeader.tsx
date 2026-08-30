"use client";
// data-tag: components.chart.header
// Extended header with token metadata + 6 metric columns (GMGN style)

import React, { useEffect, useState, useMemo } from "react";
import { Copy, ExternalLink, Download, Globe, Send } from "lucide-react";
import { exportCandles, formatExportFilename } from "@/lib/chart/csvExport";
import type { Candle } from "@/lib/chart/types";
import { formatUsd, formatNumber, formatAge, formatMcap as fmtMcapConfig } from "@/lib/chart/config";

interface Props {
  mint: string;
  symbol: string;
  name: string;
  lastPrice: number;
  change24h: number;
  isOnline: boolean;
  candles?: Candle[];
  timeframe?: string;
}

interface PairInfo {
  symbol: string;
  name: string;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number;
  volumeH24: number;
  volumeH6: number;
  volumeH1: number;
  volumeM5: number;
  fdv: number | null;
  marketCap: number | null;
  totalVolumeSol: number | null;
  totalFeesSol: number | null;
  totalVolumeUsd: number | null;
  solPrice: number | null;
  imageUrl?: string;
  buysH1: number;
  sellsH1: number;
  buysH24: number;
  sellsH24: number;
  createdAt: number | null;
  uniqueTraders: number | null;
  bcProgress: number | null;
  bcMigrated: boolean | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

// Re-export from config for backward compatibility
const fmtMcap = fmtMcapConfig;

const ChartHeader = React.memo(function ChartHeader({
  mint, symbol, name, lastPrice, change24h, isOnline,
  candles = [], timeframe = "1m",
}: Props) {
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/token-ohlcv?mint=${encodeURIComponent(mint)}&_=${Date.now()}`, { cache: "no-store" });
        const data = await r.json();
        if (!cancelled && data.pair) setPair({ ...data.pair });
      } catch {}
    };
    load();
    const timer = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [mint]);

  const up = change24h >= 0;
  const changeColor = up ? "text-[#a855f7]" : "text-[#10b981]";
  const changeBg = up ? "bg-[#a855f7]/10 border-[#a855f7]/20" : "bg-[#10b981]/10 border-[#10b981]/20";

  const displaySymbol = pair?.symbol || symbol || "вЂ”";
  const displayName = pair?.name || name || "";
  const displayPrice = pair?.priceUsd ?? lastPrice;

  const handleCopy = () => {
    navigator.clipboard.writeText(mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const handleExport = () => {
    if (candles.length === 0) return;
    const filename = formatExportFilename(displaySymbol, timeframe);
    exportCandles(candles, filename, { includeHeader: true, dateFormat: "iso" });
  };

  // Memoized formatted values for performance
  const feeStr = useMemo(() => {
    const feeSol = pair?.totalFeesSol;
    if (!feeSol || feeSol <= 0) return "вЂ”";
    if (feeSol >= 1000) return `${(feeSol / 1000).toFixed(2)}K SOL`;
    if (feeSol >= 0.01) return `${feeSol.toFixed(2)} SOL`;
    return `${(feeSol * 1000).toFixed(2)}m SOL`;
  }, [pair?.totalFeesSol]);

  const metrics = useMemo(() => ({
    mcap: fmtMcap(pair?.marketCap || (displayPrice * 1_000_000_000)),
    vol24h: formatUsd(pair?.volumeH24),
    vol1h: formatUsd(pair?.volumeH1),
    liquidity: formatUsd(pair?.liquidityUsd),
    traders: formatNumber(pair?.uniqueTraders),
    age: formatAge(pair?.createdAt),
  }), [pair, displayPrice]);

  const buys1 = pair?.buysH1 ?? 0;
  const sells1 = pair?.sellsH1 ?? 0;
  const totalTxns1 = buys1 + sells1;
  const buyPct = totalTxns1 > 0 ? Math.round((buys1 / totalTxns1) * 100) : 50;

  return (
    <div className="flex flex-col overflow-hidden border-b border-[#1a1a2e] bg-[#0a0a14]">
      {/* Row 1: identity + price + live */}
      <div className="grid grid-cols-1 gap-3 px-4 pt-3 pb-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        {/* Token identity */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#a855f7] to-[#10b981] flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {displaySymbol.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="max-w-[160px] truncate text-sm font-bold text-white">{displaySymbol}</span>
              <span className="text-[11px] text-[#d1d4dc]/40 truncate max-w-[120px]">{displayName}</span>
              {pair?.bcMigrated === false && pair.bcProgress !== null && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#a855f7]/20 text-[#a855f7] font-semibold">
                  BC {pair.bcProgress}%
                </span>
              )}
              {pair?.bcMigrated === true && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#10b981]/20 text-[#10b981] font-semibold">
                  MIGRATED
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              <span className="text-[10px] text-[#d1d4dc]/40 font-mono">{mint.slice(0, 4)}вЂ¦{mint.slice(-4)}</span>
              <button type="button" onClick={handleCopy} className="p-0.5 rounded text-[#d1d4dc]/30 hover:text-[#d1d4dc] transition" title="Copy mint">
                <Copy className="w-2.5 h-2.5" />
              </button>
              <a href={`https://solscan.io/token/${mint}`} target="_blank" rel="noopener noreferrer" className="p-0.5 rounded text-[#d1d4dc]/30 hover:text-[#d1d4dc] transition" title="Solscan">
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
              {pair?.twitter && (
                <a href={pair.twitter} target="_blank" rel="noopener noreferrer" className="p-0.5 rounded text-[#d1d4dc]/30 hover:text-[#1d9bf0] transition" title="Twitter/X">
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                </a>
              )}
              {pair?.telegram && (
                <a href={pair.telegram} target="_blank" rel="noopener noreferrer" className="p-0.5 rounded text-[#d1d4dc]/30 hover:text-[#0088cc] transition" title="Telegram">
                  <Send className="w-2.5 h-2.5" />
                </a>
              )}
              {pair?.website && (
                <a href={pair.website} target="_blank" rel="noopener noreferrer" className="p-0.5 rounded text-[#d1d4dc]/30 hover:text-[#d1d4dc] transition" title="Website">
                  <Globe className="w-2.5 h-2.5" />
                </a>
              )}
              {copied && <span className="text-[9px] text-[#a855f7]">copied</span>}
            </div>
          </div>
        </div>

        {/* Price */}
        <div className="flex min-w-0 flex-wrap items-center gap-3 lg:justify-end">
          <div className="min-w-0">
            <span className="block truncate text-2xl font-bold text-white tabular-nums">{fmtMcap(displayPrice)}</span>
          </div>

          {/* Age */}
          {pair?.createdAt && (
            <div className="text-left lg:text-center">
              <div className="text-[10px] text-[#d1d4dc]/40 uppercase tracking-wide">Age</div>
              <div className="text-xs font-semibold text-[#d1d4dc]/70 tabular-nums">{metrics.age}</div>
            </div>
          )}

          {/* Live + Export */}
          <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0">
            <button
              onClick={handleExport}
              disabled={candles.length === 0}
              className="flex items-center gap-1 px-2 py-1 rounded bg-[#1a1a2e] text-[#d1d4dc] text-[10px] hover:bg-[#a855f7]/20 transition disabled:opacity-50"
              title="Export to CSV"
            >
              <Download className="w-3 h-3" />
              CSV
            </button>
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isOnline ? "bg-[#a855f7] animate-pulse" : "bg-[#ef5350]"}`} />
              <span className="text-[10px] text-[#d1d4dc]/50">{isOnline ? "Live" : "Offline"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Row 2: metrics */}
      <div className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-3 lg:grid-cols-6 xl:grid-cols-8">
        <Metric label="MCap" value={metrics.mcap} />
        <Metric label="24h Vol" value={metrics.vol24h} />
        <Metric label="1h Vol" value={metrics.vol1h} />
        <Metric label="Liquidity" value={metrics.liquidity} />
        <Metric label="Total Fees" value={feeStr} />
        {pair?.uniqueTraders != null && pair.uniqueTraders > 0 && (
          <Metric label="Traders" value={metrics.traders} />
        )}

        {/* Buy/Sell pressure bar */}
        {totalTxns1 > 0 && (
          <div className="min-w-0 rounded-md border border-white/5 bg-white/[0.025] px-2 py-1.5 text-left">
            <div className="text-[10px] text-[#d1d4dc]/40 uppercase tracking-wide">
              B/S 1h
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[10px] text-[#10b981] tabular-nums font-semibold">{buys1}</span>
              <div className="w-16 h-1.5 rounded-full overflow-hidden bg-[#ef5350]/30">
                <div
                  className="h-full rounded-full bg-[#10b981]"
                  style={{ width: `${buyPct}%` }}
                />
              </div>
              <span className="text-[10px] text-[#ef5350] tabular-nums font-semibold">{sells1}</span>
            </div>
          </div>
        )}

        {/* Bonding curve progress bar */}
        {pair?.bcMigrated === false && pair.bcProgress !== null && (
          <div className="min-w-0 rounded-md border border-white/5 bg-white/[0.025] px-2 py-1.5 text-left">
            <div className="text-[10px] text-[#d1d4dc]/40 uppercase tracking-wide">Bonding Curve</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="w-20 h-1.5 rounded-full overflow-hidden bg-[#1a1a2e]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#a855f7] to-[#10b981] transition-all"
                  style={{ width: `${pair.bcProgress}%` }}
                />
              </div>
              <span className="text-[10px] text-[#d1d4dc]/70 tabular-nums">{pair.bcProgress}%</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-white/5 bg-white/[0.025] px-2 py-1.5 text-left">
      <div className="text-[10px] text-[#d1d4dc]/40 uppercase tracking-wide">{label}</div>
      <div className="truncate text-xs font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}

export default ChartHeader;
