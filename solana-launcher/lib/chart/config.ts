// data-tag: lib.chart.config
// Unified chart configuration to ensure consistency across components

export const CHART_COLORS = {
  background: "#0a0a0f",
  grid: "#1f1f2e",
  text: "#9ca3af",
  up: "#26a69a",      // Green for up (GMGN/TV style)
  down: "#ef5350",    // Red for down (GMGN/TV style)
  crosshair: "#5c5c7a",
  crosshairLabel: "#2a2a3e",
  border: "#1a1a2e",
  accent: "#a855f7",  // Purple for UI accents
} as const;

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
