"use client";
// data-tag: components.chart.csv_export_button
// CSV export button for chart data

import React, { useCallback } from "react";
import { Download } from "lucide-react";
import { exportCandles, formatExportFilename } from "@/lib/chart/csvExport";
import type { Candle } from "@/lib/chart/types";

interface Props {
  candles: Candle[];
  symbol: string;
  timeframe: string;
  disabled?: boolean;
}

export const CSVExportButton: React.FC<Props> = ({
  candles,
  symbol,
  timeframe,
  disabled = false,
}) => {
  const handleExport = useCallback(() => {
    if (candles.length === 0) return;

    const filename = formatExportFilename(symbol, timeframe);
    exportCandles(candles, filename, {
      includeHeader: true,
      dateFormat: "iso",
    });
  }, [candles, symbol, timeframe]);

  return (
    <button
      onClick={handleExport}
      disabled={disabled || candles.length === 0}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#1a1a2e] text-[#d1d4dc] text-xs hover:bg-[#a855f7]/20 hover:text-[#a855f7] transition disabled:opacity-50 disabled:cursor-not-allowed"
      title="Export to CSV"
    >
      <Download className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">CSV</span>
    </button>
  );
};

export default CSVExportButton;
