// data-tag: lib.chart.formatters

const PUMP_SUPPLY = 1_000_000_000;

/**
 * Format Pump.fun token MCAP from raw price-per-token.
 * If `price` already looks like a MCAP value (>1000) it is used as-is.
 */
export function formatMcap(price: number): string {
  if (!price || !isFinite(price)) return "$0";
  const m = price > 1000 ? price : price * PUMP_SUPPLY;
  if (m >= 1_000_000_000) return `$${(m / 1_000_000_000).toFixed(2)}B`;
  if (m >= 1_000_000)     return `$${(m / 1_000_000).toFixed(2)}M`;
  if (m >= 1_000)         return `$${(m / 1_000).toFixed(2)}K`;
  return `$${m.toFixed(2)}`;
}

export function formatPrice(p: number): string {
  if (!p || !isFinite(p)) return "$0";
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  if (p >= 0.01) return `$${p.toFixed(5)}`;
  if (p >= 0.0001) return `$${p.toFixed(6)}`;
  return `$${p.toExponential(3)}`;
}

export function formatVolume(v: number): string {
  if (!v || !isFinite(v)) return "0";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return v.toFixed(2);
}

export function formatChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function formatChangeUsd(price: number, pct: number): string {
  const abs = Math.abs(price * (pct / 100));
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${formatPrice(abs)}`;
}

export function formatTime(tsSec: number, tf: string): string {
  const d = new Date(tsSec * 1000);
  if (tf === "1d") {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (tf === "1h" || tf === "4h") {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: tf === "1s" || tf === "5s" || tf === "15s" ? "2-digit" : undefined, hour12: false });
}
