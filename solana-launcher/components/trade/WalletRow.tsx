"use client";
// data-tag: components.trade.wallet_row

import { TrendingUp, TrendingDown, Copy, ExternalLink, Users, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import WalletTradeDetail, { type CompactTrade } from "./WalletTradeDetail";

export interface WalletRowData {
  address: string;
  buys: number;
  sells: number;
  volumeSol: number;
  pnlSol: number;
  pnlPercent: number;
  solBalance: number | null;
  tokenBalanceUsd: number;
  isFresh: boolean;
  isSmart: boolean;
  isWashTrader: boolean;
  washReasons?: string[];
  bundleId?: string;
  relatedCount: number;
}

export default function WalletRow({ w, allTrades }: { w: WalletRowData; allTrades?: CompactTrade[] }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const short = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
  const pnlUp = w.pnlSol >= 0;

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(w.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div
      className="surface-panel rounded-lg border border-bg-border hover:border-[color-mix(in_srgb,var(--theme-secondary)_30%,transparent)] transition overflow-hidden"
      data-tag="trade.wallet_row"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 cursor-pointer"
        data-tag="trade.wallet_row_header"
      >
      <div className="flex flex-wrap items-center gap-2">
        {/* Address */}
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-mono text-white">{short}</span>
          <button onClick={copy} className="text-white/30 hover:text-white" title={copied ? "Copied!" : "Copy address"}>
            <Copy className="w-3 h-3" />
          </button>
          <a
            href={`https://solscan.io/account/${w.address}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-white/30 hover:text-white"
            title="Open Solscan"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-1">
          {w.isFresh && <Badge color="info">🆕 Fresh</Badge>}
          {w.isSmart && <Badge color="purple">🧠 Smart</Badge>}
          {w.bundleId && <Badge color="gray">📦 {w.bundleId}</Badge>}
          {w.isWashTrader && (
            <Badge color="warning" title={w.washReasons?.join("; ")}>
              ⚠️ Wash
            </Badge>
          )}
          {w.relatedCount > 0 && (
            <Badge color="gray">
              <Users className="w-3 h-3 inline mr-0.5" />
              {w.relatedCount}
            </Badge>
          )}
        </div>

        {/* PnL */}
        <div className={"ml-auto flex items-center gap-1 text-sm font-semibold " + (pnlUp ? "text-success" : "text-[color:var(--theme-danger)]")}>
          {pnlUp ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
          {pnlUp ? "+" : ""}
          {w.pnlPercent.toFixed(1)}% ({pnlUp ? "+" : ""}
          {w.pnlSol.toFixed(3)} SOL)
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
        <Metric label="Buys" value={w.buys.toString()} />
        <Metric label="Sells" value={w.sells.toString()} />
        <Metric label="Volume" value={`${w.volumeSol.toFixed(2)} SOL`} />
        <Metric label="Balance" value={w.solBalance == null ? "—" : `${w.solBalance.toFixed(2)} SOL`} />
      </div>

      <div className="mt-2 flex items-center justify-center text-[10px] text-white/35">
        {expanded ? (
          <span className="flex items-center gap-1">Скрыть детали <ChevronUp className="w-3 h-3" /></span>
        ) : (
          <span className="flex items-center gap-1">Показать трейды <ChevronDown className="w-3 h-3" /></span>
        )}
      </div>
      </div>

      {expanded && allTrades && (
        <div className="border-t border-bg-border bg-black/20 px-3 pb-3">
          <WalletTradeDetail walletAddress={w.address} allTrades={allTrades} />
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-white/40">{label}: </span>
      <span className="text-white/85">{value}</span>
    </div>
  );
}

function Badge({
  children,
  color,
  title,
}: {
  children: React.ReactNode;
  color: "info" | "purple" | "warning" | "gray" | "success";
  title?: string;
}) {
  const cls =
    color === "info"
      ? "bg-info/15 text-info border-info/30"
      : color === "purple"
        ? "bg-[color-mix(in_srgb,var(--theme-secondary)_15%,transparent)] text-[color:var(--theme-secondary)] border-[color-mix(in_srgb,var(--theme-secondary)_30%,transparent)]"
        : color === "warning"
          ? "bg-warning/15 text-warning border-warning/30"
          : color === "success"
            ? "bg-success/15 text-success border-success/30"
            : "bg-white/8 text-white/65 border-white/15";
  return (
    <span
      title={title}
      className={"px-1.5 py-0.5 rounded text-[10px] font-semibold border " + cls}
    >
      {children}
    </span>
  );
}
