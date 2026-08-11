// data-tag: lib.chart.config
// Unified chart configuration to ensure consistency across components.
// Chart surfaces inherit the global site theme instead of owning a fixed dark palette.

import { ColorType, type IChartApi } from "lightweight-charts";

function themeVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export const CHART_COLORS = {
  // Transparent canvas lets the chart inherit its container/site background immediately.
  get background() { return "transparent"; },
  get grid() { return themeVar("--theme-bg-border", "#1f1f2e"); },
  get text() { return themeVar("--theme-content-muted", "#9ca3af"); },
  up: "#26a69a",      // semantic market color: intentionally theme-independent
  down: "#ef5350",    // semantic market color: intentionally theme-independent
  get crosshair() { return themeVar("--theme-content-faint", "#5c5c7a"); },
  get crosshairLabel() { return themeVar("--theme-bg-overlay", "#2a2a3e"); },
  get border() { return themeVar("--theme-bg-border", "#1a1a2e"); },
  get accent() { return themeVar("--theme-primary", "#a855f7"); },
} as const;

export function applyChartTheme(chart: IChartApi | null) {
  if (!chart) return;
  chart.applyOptions({
    layout: {
      background: { type: ColorType.Solid, color: CHART_COLORS.background },
      textColor: CHART_COLORS.text,
    },
    grid: {
      vertLines: { color: CHART_COLORS.grid },
      horzLines: { color: CHART_COLORS.grid },
    },
    crosshair: {
      vertLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.crosshairLabel },
      horzLine: { color: CHART_COLORS.crosshair, labelBackgroundColor: CHART_COLORS.crosshairLabel },
    },
    rightPriceScale: { borderColor: CHART_COLORS.border },
    timeScale: { borderColor: CHART_COLORS.border },
  });
}

export const CHART_DIMENSIONS = {
  minBarSpacing: 0.3,
  rightOffset: 2,
  barSpacingDesktop: 6,
  barSpacingMobile: 4,
  volumeScaleMargins: { top: 0.82, bottom: 0 },
  priceScaleMargins: { top: 0.05, bottom: 0 },
} as const;

export const CHART_FONTS = {
  family: "'Inter', sans-serif",
  size: 11,
} as const;

// Re-export formatters to maintain backward compatibility
export { formatMcap, formatPrice, formatVolume, formatChange } from "./formatters";

// Format number with K/M/B suffix
export function formatNumber(v: number | null | undefined): string {
  if (!v || !isFinite(v)) return "—";
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return v.toFixed(0);
}

// Format USD value
export function formatUsd(v: number | null | undefined): string {
  if (!v || !isFinite(v)) return "—";
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

// Format SOL amount
export function formatSol(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(2)}K SOL`;
  if (v >= 0.01) return `${v.toFixed(2)} SOL`;
  return `${(v * 1000).toFixed(2)}m SOL`;
}

// Format age from timestamp
export function formatAge(createdAt: number | null | undefined): string {
  if (!createdAt) return "—";
  const secs = Math.floor((Date.now() - createdAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}
