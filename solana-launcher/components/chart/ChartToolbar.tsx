"use client";
// data-tag: components.chart.toolbar

import React from "react";
import { RotateCcw, ZoomIn } from "lucide-react";
import { TIMEFRAMES, type Timeframe } from "@/lib/chart/types";

interface Props {
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  onResetZoom: () => void;
  onFitCurrent?: () => void;
}

const ChartToolbar = React.memo(function ChartToolbar({ timeframe, onTimeframeChange, onResetZoom, onFitCurrent }: Props) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[#2a2a4a]">
      <div className="flex items-center gap-0.5">
        {TIMEFRAMES.map(tf => (
          <button
            key={tf}
            type="button"
            onClick={() => onTimeframeChange(tf)}
            className={[
              "px-2.5 py-1 rounded text-[11px] font-semibold transition-colors",
              timeframe === tf
                ? "bg-[#4a9eff]/20 text-[#4a9eff] border border-[#4a9eff]/30"
                : "text-[#d1d4dc]/60 hover:text-[#d1d4dc] hover:bg-white/5",
            ].join(" ")}
          >
            {tf}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        {onFitCurrent && (
          <button
            type="button"
            onClick={onFitCurrent}
            title="Приблизить к текущим свечам"
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[#d1d4dc]/40 hover:text-[#d1d4dc] hover:bg-white/5 transition-colors"
          >
            <ZoomIn className="w-3 h-3" />
            <span className="hidden sm:inline">Fit</span>
          </button>
        )}
        <button
          type="button"
          onClick={onResetZoom}
          title="Сбросить зум"
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[#d1d4dc]/40 hover:text-[#d1d4dc] hover:bg-white/5 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          <span className="hidden sm:inline">Reset</span>
        </button>
      </div>
    </div>
  );
});

export default ChartToolbar;
