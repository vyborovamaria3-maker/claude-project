"use client";
// data-tag: components.chart.activity_panel
// Real-time trades stream (right side panel, GMGN style) with virtualization.

import React, { useCallback, useRef } from "react";
import { ExternalLink } from "lucide-react";
import { useTradeStream, type TradeItem } from "@/hooks/useTradeStream";

const ITEM_HEIGHT = 34;

interface Props {
  mint: string;
}

function fmtSol(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function timeAgo(timestamp: number, now: number): string {
  const normalized = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const diff = Math.max(0, Math.floor((now - normalized) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function shortAddr(value: string): string {
  if (!value) return "—";
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

function useVirtualization<T>(items: T[], itemHeight: number, containerHeight: number, overscan = 5) {
  const [scrollTop, setScrollTop] = React.useState(0);

  const { virtualItems, totalHeight } = React.useMemo(() => {
    const totalHeight = items.length * itemHeight;
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const visibleCount = Math.ceil(containerHeight / itemHeight) + overscan * 2;
    const endIndex = Math.min(items.length, startIndex + visibleCount);
    const virtualItems = items.slice(startIndex, endIndex).map((item, index) => ({
      item,
      index: startIndex + index,
      style: {
        position: "absolute" as const,
        top: (startIndex + index) * itemHeight,
        height: itemHeight,
      },
    }));
    return { virtualItems, totalHeight };
  }, [items, itemHeight, containerHeight, scrollTop, overscan]);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  return { virtualItems, totalHeight, onScroll };
}

const TradeRow = React.memo(function TradeRow({
  trade,
  maxSol,
  now,
  style,
}: {
  trade: TradeItem;
  maxSol: number;
  now: number;
  style: React.CSSProperties;
}) {
  const width = Math.min(100, Math.max(3, (trade.solAmount / maxSol) * 100));
  const notional = trade.priceUsd > 0 && trade.tokenAmount > 0
    ? trade.priceUsd * trade.tokenAmount
    : null;

  return (
    <li
      className="group relative w-full overflow-hidden border-b border-bg-border/70 px-2.5 transition-colors hover:bg-bg-elevated/60"
      style={style}
    >
      <div
        className="pointer-events-none absolute inset-y-0 left-0 opacity-80"
        style={{
          width: `${width}%`,
          background: trade.isBuy
            ? "color-mix(in srgb, var(--theme-success) 13%, transparent)"
            : "color-mix(in srgb, var(--theme-danger) 13%, transparent)",
        }}
      />
      <div className="relative grid h-full grid-cols-[38px_minmax(76px,1fr)_62px_28px_20px] items-center gap-1.5 text-[9px]">
        <span className={`font-bold tracking-wide ${trade.isBuy ? "text-success" : "text-danger"}`}>
          {trade.isBuy ? "BUY" : "SELL"}
        </span>
        <div className="min-w-0 leading-tight">
          <div className={`truncate font-mono font-semibold tabular-nums ${trade.isBuy ? "text-success" : "text-danger"}`}>
            {fmtSol(trade.solAmount)} SOL
          </div>
          <div className="truncate text-[8px] text-content-faint">{fmtUsd(notional)}</div>
        </div>
        <a
          href={`https://solscan.io/account/${encodeURIComponent(trade.signer)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-mono text-content-faint transition-colors hover:text-content"
          title={trade.signer}
        >
          {shortAddr(trade.signer)}
        </a>
        <span className="text-right font-mono tabular-nums text-content-faint">{timeAgo(trade.ts, now)}</span>
        <a
          href={`https://solscan.io/tx/${encodeURIComponent(trade.signature)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-content-faint transition-colors hover:bg-primary-soft hover:text-primary"
          title="Открыть транзакцию в Solscan"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </li>
  );
});

const ActivityPanel = React.memo(function ActivityPanel({ mint }: Props) {
  const { trades, isOnline } = useTradeStream(mint, 100);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = React.useState(380);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateHeight = () => setContainerHeight(container.clientHeight || 380);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const maxSol = React.useMemo(
    () => trades.reduce((max, trade) => Math.max(max, trade.solAmount), 0) || 1,
    [trades],
  );

  const { virtualItems, totalHeight, onScroll } = useVirtualization(
    trades,
    ITEM_HEIGHT,
    containerHeight,
    5,
  );

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-bg-card" data-tag="components.chart.activity_panel.v3">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-bg-border px-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-content">Транзакции</h3>
            <span className={`h-1.5 w-1.5 rounded-full ${isOnline ? "animate-pulse bg-success" : "bg-danger"}`} />
          </div>
          <div className="mt-0.5 text-[8px] uppercase tracking-[0.14em] text-content-faint">live trade stream</div>
        </div>
        <span className="rounded-md border border-bg-border bg-bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-content-muted">
          {trades.length}
        </span>
      </header>

      <div className="grid h-[27px] shrink-0 grid-cols-[38px_minmax(76px,1fr)_62px_28px_20px] items-center gap-1.5 border-b border-bg-border bg-bg-elevated/45 px-2.5 text-[8px] font-semibold uppercase tracking-wider text-content-faint">
        <span>Side</span>
        <span>Value</span>
        <span>Wallet</span>
        <span className="text-right">Age</span>
        <span />
      </div>

      <div
        ref={containerRef}
        className="custom-scrollbar relative min-h-0 flex-1 overflow-y-auto"
        onScroll={onScroll}
      >
        {trades.length === 0 ? (
          <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 px-4 text-center">
            <span className={`h-2 w-2 rounded-full ${isOnline ? "animate-pulse bg-success" : "bg-content-faint"}`} />
            <div className="text-[11px] text-content-muted">Ожидание live-сделок…</div>
            <div className="text-[9px] text-content-faint">
              {isOnline ? "Новые транзакции появятся здесь без перерисовки всей страницы." : "Источник live-сделок сейчас недоступен."}
            </div>
          </div>
        ) : (
          <ul className="relative w-full" style={{ height: totalHeight }}>
            {virtualItems.map(({ item: tradeItem, style }) => (
              <TradeRow
                key={tradeItem.signature}
                trade={tradeItem}
                maxSol={maxSol}
                now={now}
                style={style}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
});

export default ActivityPanel;
