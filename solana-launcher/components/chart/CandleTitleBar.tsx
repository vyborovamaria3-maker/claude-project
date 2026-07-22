"use client";
// data-tag: components.chart.candle_title_bar
// Shows OHLC of hovered (or last) candle, GMGN style

import React from "react";
import { formatPrice, formatMcap } from "@/lib/chart/formatters";
import type { Candle } from "@/lib/chart/types";

interface Props {
  symbol: string;
  timeframe: string;
  candle: Candle | null;
}

const CandleTitleBar = React.memo(function CandleTitleBar({ symbol, timeframe, candle }: Props) {
  if (!candle) {
    return (
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[#1a1a2e] bg-[#0a0a14] text-[11px]">
        <span className="text-[#d1d4dc]/40">—</span>
      </div>
    );
  }

  const change = candle.open > 0 ? ((candle.close - candle.open) / candle.open) * 100 : 0;
  const up = candle.close >= candle.open;
  const color = up ? "text-[#26a69a]" : "text-[#ef5350]";

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[#1a1a2e] bg-[#0a0a14] text-[11px] font-mono">
      <span className="text-white/80 font-semibold">{symbol || "—"} · {timeframe}</span>
      <span className="text-[#d1d4dc]/40">
        ОТКР <span className={`${color} font-semibold`}>{formatPrice(candle.open)}</span>
      </span>
      <span className="text-[#d1d4dc]/40">
        МАКС <span className={`${color} font-semibold`}>{formatPrice(candle.high)}</span>
      </span>
      <span className="text-[#d1d4dc]/40">
        МИН <span className={`${color} font-semibold`}>{formatPrice(candle.low)}</span>
      </span>
      <span className="text-[#d1d4dc]/40">
        ЗАКР <span className={`${color} font-semibold`}>{formatPrice(candle.close)}</span>
      </span>
      <span className={`${color} font-semibold`}>
        ({change >= 0 ? "+" : ""}{change.toFixed(2)}%)
      </span>
      <span className="text-[#d1d4dc]/40">
        MCAP <span className="text-[#a78bfa] font-semibold">{formatMcap(candle.close)}</span>
      </span>
    </div>
  );
});

export default CandleTitleBar;
