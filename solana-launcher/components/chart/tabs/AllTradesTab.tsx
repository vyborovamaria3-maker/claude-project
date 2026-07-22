"use client";
import React from "react";
import { useTradeStream } from "@/hooks/useTradeStream";
import { TabEmpty, TabTable, shortAddr, fmtUsd, timeAgo } from "./_shared";

export default function AllTradesTab({ mint }: { mint: string }) {
  const { trades } = useTradeStream(mint, 200);

  if (trades.length === 0) return <TabEmpty message="Ожидание сделок…" />;

  const rows = trades.map(t => [
    <span key="t" className={`tabular-nums font-semibold ${t.isBuy ? "text-[#a855f7]" : "text-[#10b981]"}`}>
      {t.isBuy ? "Buy" : "Sell"}
    </span>,
    <span key="s" className="tabular-nums">{t.solAmount.toFixed(3)} SOL</span>,
    <span key="u" className="tabular-nums">{fmtUsd(t.priceUsd * t.tokenAmount)}</span>,
    <span key="m" className="tabular-nums">{fmtUsd(t.marketCap)}</span>,
    <a key="a" href={`https://solscan.io/account/${t.signer}`} target="_blank" rel="noopener noreferrer" className="text-[#a855f7] hover:underline">
      {shortAddr(t.signer)}
    </a>,
    <span key="ti" className="text-[#d1d4dc]/60">{timeAgo(t.ts)}</span>,
    <a key="x" href={`https://solscan.io/tx/${t.signature}`} target="_blank" rel="noopener noreferrer" className="text-[#d1d4dc]/40 hover:text-[#d1d4dc]">↗</a>,
  ]);

  return (
    <TabTable
      headers={["Type", "Amount SOL", "USD", "MCap", "Trader", "Time", ""]}
      rows={rows}
      colTemplate="60px 1fr 1fr 1fr 1.2fr 60px 30px"
    />
  );
}
