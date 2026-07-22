"use client";
import React, { useEffect, useState } from "react";
import { TabLoading, TabError, TabEmpty, TabTable, shortAddr, fmtUsd, timeAgo } from "./_shared";

interface Bundle { slot: number; time: string; wallets: string[]; totalUsd: number; trades: number; }

export default function BundlerTab({ mint }: { mint: string }) {
  const [data, setData] = useState<Bundle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mint) return;
    setData(null); setErr(null);
    let cancel = false;
    fetch(`/api/token-bundles?mint=${encodeURIComponent(mint)}`)
      .then(r => r.json())
      .then(j => { if (!cancel) j.error ? setErr(j.error) : setData(j.bundles ?? []); })
      .catch(e => { if (!cancel) setErr(String(e)); });
    return () => { cancel = true; };
  }, [mint]);

  if (err) return <TabError message={`Ошибка: ${err}`} />;
  if (!data) return <TabLoading />;
  if (data.length === 0) return <TabEmpty message="Bundles не обнаружены" />;

  const rows = data.map(b => [
    <span key="s" className="text-[#a855f7] tabular-nums">{b.slot}</span>,
    <span key="w" className="text-[#d1d4dc]/60 tabular-nums">{b.wallets.length}</span>,
    <div key="ws" className="flex gap-1 truncate">
      {b.wallets.slice(0, 3).map(w => (
        <a key={w} href={`https://solscan.io/account/${w}`} target="_blank" rel="noopener noreferrer" className="text-[#a855f7] hover:underline text-[10px]">
          {shortAddr(w, 3, 3)}
        </a>
      ))}
      {b.wallets.length > 3 && <span className="text-[10px] text-[#d1d4dc]/40">+{b.wallets.length - 3}</span>}
    </div>,
    <span key="t" className="tabular-nums">{b.trades}</span>,
    <span key="u" className="tabular-nums font-semibold">{fmtUsd(b.totalUsd)}</span>,
    <span key="ti" className="text-[#d1d4dc]/40">{timeAgo(new Date(b.time).getTime())}</span>,
  ]);

  return (
    <TabTable
      headers={["Slot", "Wallets", "Addresses", "Trades", "Volume", "Time"]}
      rows={rows}
      colTemplate="1fr 60px 1.5fr 70px 1fr 60px"
    />
  );
}
