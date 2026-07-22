// data-tag: lib.chart.csv_export
// CSV export utilities for OHLCV data

import type { Candle } from "./types";

export interface CSVExportOptions {
  filename?: string;
  includeHeader?: boolean;
  delimiter?: string;
  dateFormat?: "unix" | "iso" | "local";
}

/** Format candle data as CSV string */
export function candlesToCSV(
  candles: Candle[],
  options: CSVExportOptions = {}
): string {
  const {
    includeHeader = true,
    delimiter = ",",
    dateFormat = "iso",
  } = options;

  const rows: string[] = [];

  // Header
  if (includeHeader) {
    rows.push(["time", "time_iso", "open", "high", "low", "close", "volume"].join(delimiter));
  }

  // Data rows
  for (const c of candles) {
    let timeValue: string;
    switch (dateFormat) {
      case "unix":
        timeValue = String(c.time);
        break;
      case "iso":
        timeValue = new Date(c.time * 1000).toISOString();
        break;
      case "local":
        timeValue = new Date(c.time * 1000).toLocaleString();
        break;
    }

    rows.push([
      String(c.time),
      timeValue,
      c.open.toString(),
      c.high.toString(),
      c.low.toString(),
      c.close.toString(),
      c.volume.toString(),
    ].join(delimiter));
  }

  return rows.join("\n");
}

/** Download CSV data as file */
export function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

/** Export candles directly to file */
export function exportCandles(
  candles: Candle[],
  filename: string,
  options?: CSVExportOptions
): void {
  const csv = candlesToCSV(candles, options);
  const finalFilename = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  downloadCSV(csv, finalFilename);
}

/** Format file name with token and date */
export function formatExportFilename(
  symbol: string,
  timeframe: string,
  extension = "csv"
): string {
  const date = new Date().toISOString().split("T")[0];
  const cleanSymbol = symbol.replace(/[^a-zA-Z0-9]/g, "_");
  return `${cleanSymbol}_${timeframe}_${date}.${extension}`;
}

/** Export with formatted filename */
export function quickExport(
  candles: Candle[],
  symbol: string,
  timeframe: string,
  options?: CSVExportOptions
): void {
  const filename = formatExportFilename(symbol, timeframe);
  exportCandles(candles, filename, options);
}
