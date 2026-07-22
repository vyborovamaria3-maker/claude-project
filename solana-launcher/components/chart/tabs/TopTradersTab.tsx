"use client";
import React, { useEffect, useState } from "react";
import { TabLoading, TabError, TabEmpty, TabTable, shortAddr, fmtUsd, timeAgo } from "./_shared";

interface Trader { address: string; boughtUsd: number; soldUsd: number; pnlUsd: number; txCount: number; lastTradeTs: number; }

export default function TopTradersTab({ mint }: { mint: string }) {
  const [data, setData] = useState<Trader[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mint) return;
    setData(null); setErr(null);
    let cancel = false;
    fetch(`/api/token-traders?mint=${encodeURIComponent(mint)}`)
      .then(r => r.json())
      .then(j => { if (!cancel) j.error ? setErr(j.error) : setData(j.traders ?? []); })
      .catch(e => { if (!cancel) setErr(String(e)); });
    return () => { cancel = true; };
  }, [mint]);

  if (err) return <TabError message={`Ошибка: ${err}`} />;
  if (!data) return <TabLoading />;
  if (data.length === 0) return <TabEmpty message="Сделок за 24h не найдено" />;

  const rows = data.map(t => [
    <a key="a" href={`https://solscan.io/account/${t.address}`} target="_blank" rel="noopener noreferrer" className="text-[#a855f7] hover:underline">
      {shortAddr(t.address, 6, 6)}
    </a>,
    <span key="b" className="tabular-nums text-[#a855f7]">{fmtUsd(t.boughtUsd)}</span>,
    <span key="s" className="tabular-nums text-[#10b981]">{fmtUsd(t.soldUsd)}</span>,
    <span key="p" className={`tabular-nums font-semibold ${t.pnlUsd >= 0 ? "text-[#10b981]" : "text-[#ef5350]"}`}>{fmtUsd(t.pnlUsd)}</span>,
    <span key="tx" className="tabular-nums text-[#d1d4dc]/60">{t.txCount}</span>,
    <span key="t" className="text-[#d1d4dc]/40">{t.lastTradeTs ? timeAgo(t.lastTradeTs) : "—"}</span>,
  ]);

  return (
    <TabTable
      headers={["Trader", "Bought", "Sold", "PnL", "Trades", "Last"]}
      rows={rows}
      colTemplate="1.5fr 1fr 1fr 1fr 70px 60px"
    />
  );
}
