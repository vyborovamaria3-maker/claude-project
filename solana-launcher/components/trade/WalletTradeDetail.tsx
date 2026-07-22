"use client";
// data-tag: components.trade.wallet_trade_detail

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";

// Pump.fun standard supply = 1B tokens. SOL price assumed ~$150 (matches API u-value estimation).
const PUMP_SUPPLY = 1_000_000_000;
const SOL_USD = 150;

export interface CompactTrade {
  ts: number;     // unix sec
  w: string;      // wallet address
  t: 0 | 1;       // 1=buy, 0=sell
  s: number;      // amount SOL
  n: number;      // amount tokens
  p: number;      // price SOL/token
  sig: string;    // signature
  u?: number;     // USD value (approximate)
}

interface Props {
  walletAddress: string;
  allTrades: CompactTrade[];
}

export default function WalletTradeDetail({ walletAddress, allTrades }: Props) {
  const { walletTrades, totals } = useMemo(() => {
    const wt = allTrades
      .filter((t) => t.w === walletAddress)
      .sort((a, b) => a.ts - b.ts);
    const buys = wt.filter((t) => t.t === 1);
    const sells = wt.filter((t) => t.t === 0);
    const totalBuySol = buys.reduce((s, t) => s + t.s, 0);
    const totalSellSol = sells.reduce((s, t) => s + t.s, 0);
    const totalBuyTokens = buys.reduce((s, t) => s + t.n, 0);
    const totalSellTokens = sells.reduce((s, t) => s + t.n, 0);
    const avgBuyPrice = totalBuyTokens > 0 ? totalBuySol / totalBuyTokens : 0;
    const avgSellPrice = totalSellTokens > 0 ? totalSellSol / totalSellTokens : 0;
    return {
      walletTrades: wt,
      totals: {
        buys: buys.length,
        sells: sells.length,
        totalBuySol,
        totalSellSol,
        totalBuyTokens,
        totalSellTokens,
        avgBuyPrice,
        avgSellPrice,
      },
    };
  }, [walletAddress, allTrades]);

  if (walletTrades.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-white/40">Нет трейдов для этого кошелька</div>
    );
  }

  return (
    <div className="space-y-3 px-1 pt-2 pb-1" data-tag="trade.wallet_detail">
      {/* Chart */}
      <PriceChart trades={allTrades} highlightWallet={walletAddress} />

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <SummaryBox
          label="Куплено"
          value={`${totals.totalBuySol.toFixed(3)} SOL`}
          sub={`${formatTokens(totals.totalBuyTokens)} tok · avg ${formatPrice(totals.avgBuyPrice)}`}
          tone="success"
        />
        <SummaryBox
          label="Продано"
          value={`${totals.totalSellSol.toFixed(3)} SOL`}
          sub={`${formatTokens(totals.totalSellTokens)} tok · avg ${formatPrice(totals.avgSellPrice)}`}
          tone="danger"
        />
        <SummaryBox
          label="Buys / Sells"
          value={`${totals.buys} / ${totals.sells}`}
          sub={`${walletTrades.length} \u0432\u0441\u0435\u0433\u043e`}
        />
        <SummaryBox
          label="Net SOL"
          value={`${(totals.totalSellSol - totals.totalBuySol >= 0 ? "+" : "")}${(totals.totalSellSol - totals.totalBuySol).toFixed(3)}`}
          tone={totals.totalSellSol - totals.totalBuySol >= 0 ? "success" : "danger"}
        />
      </div>

      {/* Trades table */}
      <div className="rounded-md border border-bg-border overflow-hidden">
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-white/5 sticky top-0">
              <tr className="text-white/50">
                <th className="px-3 py-2 text-left font-medium">Время</th>
                <th className="px-3 py-2 text-center font-medium">Тип</th>
                <th className="px-3 py-2 text-right font-medium">MC</th>
                <th className="px-3 py-2 text-right font-medium">SOL</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-center font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {walletTrades.map((t) => (
                <tr key={t.sig} className="border-t border-bg-border hover:bg-white/3">
                  <td className="px-3 py-1.5 text-white/70 whitespace-nowrap">
                    {formatTime(t.ts)}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    {t.t === 1 ? (
                      <span className="text-success font-semibold">BUY</span>
                    ) : (
                      <span className="text-[color:var(--theme-danger)] font-semibold">SELL</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right text-white/80 font-mono">
                    ${formatMC(priceToMC(t.p))}
                  </td>
                  <td className="px-3 py-1.5 text-right text-white">
                    {t.s.toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-white/70">
                    {formatTokens(t.n)}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <a
                      href={`https://solscan.io/tx/${t.sig}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/40 hover:text-[color:var(--theme-secondary)] inline-flex"
                      title="Open transaction on Solscan"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Price chart with buy/sell markers ────────────────────────
function PriceChart({
  trades,
  highlightWallet,
}: {
  trades: CompactTrade[];
  highlightWallet: string;
}) {
  const W = 800;
  const H = 200;
  const PAD = { top: 10, right: 8, bottom: 18, left: 56 };

  const [hover, setHover] = useState<{ trade: CompactTrade; x: number; y: number } | null>(null);

  const sorted = useMemo(() => [...trades].sort((a, b) => a.ts - b.ts), [trades]);
  if (sorted.length < 2) {
    return (
      <div className="text-xs text-white/40 text-center py-8 border border-bg-border rounded-md">
        Недостаточно данных для графика
      </div>
    );
  }

  const minTs = sorted[0].ts;
  const maxTs = sorted[sorted.length - 1].ts;
  const tsRange = Math.max(1, maxTs - minTs);
  const prices = sorted.map((t) => t.p);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const pRange = Math.max(maxP - minP, maxP * 0.001 || 1e-12);

  const xOf = (ts: number) =>
    PAD.left + ((ts - minTs) / tsRange) * (W - PAD.left - PAD.right);
  const yOf = (p: number) =>
    PAD.top + (1 - (p - minP) / pRange) * (H - PAD.top - PAD.bottom);

  const pathD = sorted
    .map((t, i) => `${i === 0 ? "M" : "L"}${xOf(t.ts).toFixed(1)},${yOf(t.p).toFixed(1)}`)
    .join(" ");

  const walletTrades = sorted.filter((t) => t.w === highlightWallet);

  // Y-axis: show in MC instead of raw price
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const p = minP + f * pRange;
    return { y: yOf(p), label: formatMC(priceToMC(p)) };
  });

  return (
    <div className="rounded-md border border-bg-border bg-bg/40 p-2 relative">
      <div className="flex items-center gap-3 mb-1 text-[10px] text-white/50">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-success" /> BUY
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[color:var(--theme-danger)]" /> SELL
        </span>
        <span className="ml-auto">
          {walletTrades.length} трейдов · {formatTime(minTs)} → {formatTime(maxTs)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-44"
        onMouseLeave={() => setHover(null)}
      >
        {/* Grid */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <text x={PAD.left - 4} y={t.y + 3} textAnchor="end" fontSize={9} fill="rgba(255,255,255,0.4)">
              {t.label}
            </text>
          </g>
        ))}

        <path d={pathD} fill="none" stroke="rgba(150,120,255,0.45)" strokeWidth={1} />

        {/* Wallet markers */}
        {walletTrades.map((t) => {
          const cx = xOf(t.ts);
          const cy = yOf(t.p);
          const isBuy = t.t === 1;
          const r = Math.max(3, Math.min(10, Math.sqrt(t.s) * 4));
          const isHover = hover?.trade.sig === t.sig;
          return (
            <g
              key={t.sig}
              onMouseEnter={() => setHover({ trade: t, x: cx, y: cy })}
              onMouseLeave={() => setHover((h) => (h?.trade.sig === t.sig ? null : h))}
              style={{ cursor: "pointer" }}
            >
              <circle cx={cx} cy={cy} r={Math.max(r + 4, 12)} fill="transparent" />
              <circle
                cx={cx}
                cy={cy}
                r={isHover ? r + 2 : r}
                fill={isBuy ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)"}
                stroke={isHover ? "#fff" : isBuy ? "#22c55e" : "#ef4444"}
                strokeWidth={isHover ? 2 : 1.5}
                style={{ transition: "all 120ms" }}
              />
            </g>
          );
        })}

        {/* Vertical guide line on hover */}
        {hover && (
          <line
            x1={hover.x} x2={hover.x}
            y1={PAD.top} y2={H - PAD.bottom}
            stroke="rgba(255,255,255,0.15)"
            strokeDasharray="3 3"
            strokeWidth={1}
            pointerEvents="none"
          />
        )}

        <text x={PAD.left} y={H - 4} fontSize={9} fill="rgba(255,255,255,0.4)">{formatTime(minTs)}</text>
        <text x={W - PAD.right} y={H - 4} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="end">
          {formatTime(maxTs)}
        </text>
      </svg>

      {/* Custom HTML tooltip — positioned over the SVG using viewBox-to-percent mapping */}
      {hover && (
        <div
          className="absolute pointer-events-none z-10"
          style={{
            left: `calc(${(hover.x / W) * 100}% + 8px)`,
            top: `calc(${(hover.y / H) * 100}% - 4px)`,
            transform: hover.x > W * 0.7 ? "translate(calc(-100% - 16px), -100%)" : "translateY(-100%)",
          }}
        >
          <TradeTooltip trade={hover.trade} />
        </div>
      )}
    </div>
  );
}

function TradeTooltip({ trade }: { trade: CompactTrade }) {
  const isBuy = trade.t === 1;
  const mc = priceToMC(trade.p);
  const usd = trade.u ?? trade.s * SOL_USD;
  return (
    <div
      className={`min-w-[180px] rounded-lg border backdrop-blur-md shadow-2xl px-3 py-2.5 text-xs ${
        isBuy
          ? "bg-success/10 border-success/40 shadow-success/20"
          : "bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)] border-[color-mix(in_srgb,var(--theme-danger)_40%,transparent)] shadow-[color-mix(in_srgb,var(--theme-danger)_20%,transparent)]"
      }`}
      style={{ background: isBuy ? "rgba(8,28,18,0.92)" : "rgba(36,12,15,0.92)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 pb-1.5 border-b border-white/10">
        <span className={`font-bold uppercase tracking-wider text-[11px] ${isBuy ? "text-success" : "text-[color:var(--theme-danger)]"}`}>
          {isBuy ? "● BUY" : "● SELL"}
        </span>
        <span className="text-white/40 text-[10px]">{formatTime(trade.ts)}</span>
      </div>

      {/* MC — primary metric */}
      <div className="pt-2 pb-1">
        <div className="text-[9px] text-white/40 uppercase tracking-wider">Market Cap</div>
        <div className="text-base font-bold text-white">${formatMC(mc)}</div>
      </div>

      {/* SOL + USD */}
      <div className="grid grid-cols-2 gap-2 pt-1.5 border-t border-white/10 mt-1">
        <div>
          <div className="text-[9px] text-white/40 uppercase">SOL</div>
          <div className="text-xs font-mono text-white">{trade.s.toFixed(4)}</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] text-white/40 uppercase">USD</div>
          <div className="text-xs font-mono text-white">${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}</div>
        </div>
      </div>
    </div>
  );
}

// ── helpers ──
function SummaryBox({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "success" | "danger";
}) {
  const valColor =
    tone === "success" ? "text-success" : tone === "danger" ? "text-[color:var(--theme-danger)]" : "text-white";
  return (
    <div className="px-3 py-2 rounded-md bg-white/5 border border-bg-border">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className={`text-sm font-semibold mt-0.5 ${valColor}`}>{value}</div>
      {sub && <div className="text-[10px] text-white/45 mt-0.5">{sub}</div>}
    </div>
  );
}

function formatPrice(p: number): string {
  if (p === 0) return "0";
  if (p < 1e-6) return p.toExponential(2);
  if (p < 0.001) return p.toFixed(8);
  return p.toFixed(6);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// price (SOL/token) → market cap in USD assuming pump.fun standard 1B supply
function priceToMC(priceSol: number): number {
  return priceSol * SOL_USD * PUMP_SUPPLY;
}

function formatMC(usd: number): string {
  if (!isFinite(usd) || usd <= 0) return "0";
  if (usd >= 1_000_000_000) return `${(usd / 1_000_000_000).toFixed(2)}B`;
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `${(usd / 1_000).toFixed(1)}k`;
  return usd.toFixed(0);
}
