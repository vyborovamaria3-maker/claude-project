"use client";
import React, { useEffect, useState } from "react";
import { TabLoading, TabError, TabEmpty, TabTable, shortAddr, fmtUsd } from "./_shared";

interface Pool {
  dexId: string; pairAddress: string; base: string; quote: string;
  priceUsd: number; liquidityUsd: number; volume24h: number;
  buys24h: number; sells24h: number; url?: string;
}

export default function PoolTab({ mint }: { mint: string }) {
  const [data, setData] = useState<Pool[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mint) return;
    setData(null); setErr(null);
    let cancel = false;
    fetch(`/api/token-pool?mint=${encodeURIComponent(mint)}`)
      .then(r => r.json())
      .then(j => { if (!cancel) j.error ? setErr(j.error) : setData(j.pools ?? []); })
      .catch(e => { if (!cancel) setErr(String(e)); });
    return () => { cancel = true; };
  }, [mint]);

  if (err) return <TabError message={`Ошибка: ${err}`} />;
  if (!data) return <TabLoading />;
  if (data.length === 0) return <TabEmpty message="Пулы не найдены (новый токен?)" />;

  const rows = data.map(p => [
    <span key="d" className="text-white capitalize">{p.dexId}</span>,
    <a key="p" href={p.url} target="_blank" rel="noopener noreferrer" className="text-[#a855f7] hover:underline">
      {shortAddr(p.pairAddress, 4, 4)}
    </a>,
    <span key="pr" className="tabular-nums">{fmtUsd(p.priceUsd)}</span>,
    <span key="l" className="tabular-nums">{fmtUsd(p.liquidityUsd)}</span>,
    <span key="v" className="tabular-nums">{fmtUsd(p.volume24h)}</span>,
    <span key="b" className="tabular-nums text-[#a855f7]">{p.buys24h}</span>,
    <span key="s" className="tabular-nums text-[#10b981]">{p.sells24h}</span>,
  ]);

  return (
    <TabTable
      headers={["DEX", "Pair", "Price", "Liquidity", "Vol 24h", "Buys", "Sells"]}
      rows={rows}
      colTemplate="1fr 1fr 1fr 1fr 1fr 70px 70px"
    />
  );
}
