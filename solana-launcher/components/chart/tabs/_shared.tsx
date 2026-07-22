"use client";
// data-tag: components.chart.tabs.shared
// Shared helpers and primitives for bottom tabs

import React from "react";
import { Loader2 } from "lucide-react";

export function TabLoading() {
  return (
    <div className="flex items-center justify-center py-8 gap-2 text-[11px] text-[#d1d4dc]/40">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Загрузка…
    </div>
  );
}

export function TabError({ message }: { message: string }) {
  return (
    <div className="px-4 py-8 text-center text-[11px] text-[#ef5350]/70">{message}</div>
  );
}

export function TabEmpty({ message = "Нет данных" }: { message?: string }) {
  return (
    <div className="px-4 py-8 text-center text-[11px] text-[#d1d4dc]/40">{message}</div>
  );
}

export function shortAddr(a: string | null | undefined, head = 4, tail = 4): string {
  if (!a) return "—";
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return v.toFixed(0);
}

export function timeAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

interface TableProps {
  headers: string[];
  rows: React.ReactNode[][];
  colTemplate?: string;
}

export function TabTable({ headers, rows, colTemplate }: TableProps) {
  const grid = colTemplate ?? `repeat(${headers.length}, 1fr)`;
  return (
    <div className="text-[11px]">
      <div
        className="grid gap-3 px-4 py-2 border-b border-[#1a1a2e] text-[9px] uppercase tracking-wide text-[#d1d4dc]/40"
        style={{ gridTemplateColumns: grid }}
      >
        {headers.map((h, i) => <span key={i}>{h}</span>)}
      </div>
      <div className="divide-y divide-[#1a1a2e]/40">
        {rows.map((cells, ri) => (
          <div
            key={ri}
            className="grid gap-3 px-4 py-1.5 items-center hover:bg-white/5 transition-colors"
            style={{ gridTemplateColumns: grid }}
          >
            {cells.map((c, ci) => <div key={ci} className="truncate">{c}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}
