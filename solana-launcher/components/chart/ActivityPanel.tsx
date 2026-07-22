"use client";
// data-tag: components.chart.activity_panel
// Real-time trades stream (right side panel, GMGN style) with virtualization

import React, { useRef, useCallback } from "react";
import { useTradeStream, type TradeItem } from "@/hooks/useTradeStream";
import { ExternalLink } from "lucide-react";

const ITEM_HEIGHT = 32; // px per trade row

interface Props {
  mint: string;
}

function fmtSol(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(2)}K`;
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3);
  return v.toFixed(4);
}

function fmtUsd(v: number | null): string {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function timeAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function shortAddr(a: string): string {
  if (!a) return "—";
  return `${a.slice(0, 4)}…${a.slice(-3)}`;
}

// Simple virtualization hook - renders only visible items
function useVirtualization<T>(items: T[], itemHeight: number, containerHeight: number, overscan = 5) {
  const [scrollTop, setScrollTop] = React.useState(0);

  const { virtualItems, totalHeight, startIndex } = React.useMemo(() => {
    const totalHeight = items.length * itemHeight;
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const visibleCount = Math.ceil(containerHeight / itemHeight) + overscan * 2;
    const endIndex = Math.min(items.length, startIndex + visibleCount);

    const virtualItems = items.slice(startIndex, endIndex).map((item, index) => ({
      item,
      index: startIndex + index,
      style: { position: 'absolute' as const, top: (startIndex + index) * itemHeight, height: itemHeight },
    }));

    return { virtualItems, totalHeight, startIndex };
  }, [items, itemHeight, containerHeight, scrollTop, overscan]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  return { virtualItems, totalHeight, onScroll, startIndex };
}

const TradeRow = React.memo(function TradeRow({
  trade,
  maxSol,
  style,
}: {
  trade: TradeItem;
  maxSol: number;
  style: React.CSSProperties;
}) {
  const pct = Math.min(100, Math.max(3, (trade.solAmount / maxSol) * 100));
  const fillColor = trade.isBuy ? "rgba(38,166,154,0.22)" : "rgba(239,83,80,0.22)";

  return (
    <li
      className="px-3 py-1.5 hover:bg-white/5 transition-colors relative overflow-hidden w-full"
      style={style}
    >
      <div
        className="absolute inset-y-0 left-0 pointer-events-none"
        style={{ width: `${pct}%`, backgroundColor: fillColor }}
      />
      <div className="relative grid grid-cols-[40px_1fr_auto_auto] gap-2 items-center text-[10px]">
        <span className={`font-bold text-[10px] ${trade.isBuy ? "text-[#26a69a]" : "text-[#ef5350]"}`}>
          {trade.isBuy ? "BUY" : "SELL"}
        </span>
        <div className="flex items-center gap-1 min-w-0">
          <span className={`tabular-nums font-semibold ${trade.isBuy ? "text-[#26a69a]" : "text-[#ef5350]"}`}>
            {fmtSol(trade.solAmount)} SOL
          </span>
          <span className="text-[#d1d4dc]/40 text-[9px]">
            {fmtUsd(trade.priceUsd * trade.tokenAmount)}
          </span>
        </div>
        <a
          href={`https://solscan.io/account/${trade.signer}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#d1d4dc]/40 hover:text-[#d1d4dc] font-mono text-[9px]"
        >
          {shortAddr(trade.signer)}
        </a>
        <span className="text-[#d1d4dc]/30 tabular-nums text-[9px]">{timeAgo(trade.ts)}</span>
      </div>
    </li>
  );
});

const ActivityPanel = React.memo(function ActivityPanel({ mint }: Props) {
  const { trades, isOnline } = useTradeStream(mint, 100);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = React.useState(360);

  // Update container height on mount and resize
  React.useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        setContainerHeight(containerRef.current.clientHeight);
      }
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  // Find max SOL amount in visible trades — used to scale row-fill width
  const maxSol = React.useMemo(
    () => trades.reduce((m, trade) => Math.max(m, trade.solAmount), 0) || 1,
    [trades]
  );

  const { virtualItems, totalHeight, onScroll } = useVirtualization(
    trades,
    ITEM_HEIGHT,
    containerHeight,
    5
  );

  return (
    <aside className="flex flex-col h-full border-l border-[#1a1a2e] bg-[#0a0a14] min-w-0">
      <header className="px-3 py-2 border-b border-[#1a1a2e] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-white">Активность</h3>
          <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? "bg-[#a855f7] animate-pulse" : "bg-[#ef5350]"}`} />
        </div>
        <span className="text-[10px] text-[#d1d4dc]/40">{trades.length}</span>
      </header>

      <div className="px-3 py-1.5 border-b border-[#1a1a2e] grid grid-cols-[1fr_auto_auto] gap-2 text-[9px] text-[#d1d4dc]/40 uppercase tracking-wide">
        <span>Итого</span>
        <span>MCap</span>
        <span>Время</span>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto custom-scrollbar relative"
        onScroll={onScroll}
      >
        {trades.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-[#d1d4dc]/30">
            Ожидание сделок…
          </div>
        ) : (
          <ul className="relative w-full" style={{ height: totalHeight }}>
            {virtualItems.map(({ item: tradeItem, index, style }) => (
              <TradeRow key={tradeItem.signature} trade={tradeItem} maxSol={maxSol} style={style} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
});

export default ActivityPanel;
