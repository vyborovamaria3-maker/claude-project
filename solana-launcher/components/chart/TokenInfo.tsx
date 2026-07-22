"use client";
// data-tag: components.chart.token_info

import React from "react";
import { formatMcap, formatChange, formatVolume } from "@/lib/chart/formatters";

interface Props {
  symbol: string;
  name: string;
  lastPrice: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  isOnline: boolean;
}

const TokenInfo = React.memo(function TokenInfo({
  symbol, name, lastPrice, change24h, volume24h, high24h, low24h, isOnline,
}: Props) {
  const up = change24h >= 0;
  const changeColor = up ? "text-[#26a69a]" : "text-[#ef5350]";
  const changeBg = up ? "bg-[#26a69a]/10 border-[#26a69a]/20" : "bg-[#ef5350]/10 border-[#ef5350]/20";

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-[#2a2a4a]">
      {/* Left: ticker + price */}
      <div className="flex items-start gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-white">{symbol || "—"}</span>
            {name && <span className="text-xs text-[#d1d4dc]/50">{name}</span>}
          </div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-xl font-semibold text-white tabular-nums">
              {formatMcap(lastPrice)}
            </span>
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded border tabular-nums ${changeColor} ${changeBg}`}>
              {formatChange(change24h)}
            </span>
          </div>
        </div>

        {/* 24h stats */}
        <div className="hidden sm:flex items-center gap-4 mt-1">
          <div>
            <p className="text-[10px] text-[#d1d4dc]/40 uppercase tracking-wide">24h H</p>
            <p className="text-xs font-medium text-[#26a69a] tabular-nums">{formatMcap(high24h)}</p>
          </div>
          <div>
            <p className="text-[10px] text-[#d1d4dc]/40 uppercase tracking-wide">24h L</p>
            <p className="text-xs font-medium text-[#ef5350] tabular-nums">{formatMcap(low24h)}</p>
          </div>
          <div>
            <p className="text-[10px] text-[#d1d4dc]/40 uppercase tracking-wide">Vol 24h</p>
            <p className="text-xs font-medium text-[#d1d4dc] tabular-nums">{formatVolume(volume24h)} SOL</p>
          </div>
        </div>
      </div>

      {/* Right: WS status */}
      <div className="flex items-center gap-1.5 mt-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isOnline ? "bg-[#26a69a] animate-pulse" : "bg-[#ef5350]"}`} />
        <span className="text-[11px] text-[#d1d4dc]/50">{isOnline ? "Live" : "Offline"}</span>
      </div>
    </div>
  );
});

export default TokenInfo;
