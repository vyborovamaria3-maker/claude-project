"use client";
import React, { useEffect, useState } from "react";
import { TabLoading, TabError, TabEmpty, shortAddr, fmtNum } from "./_shared";
import { Info } from "lucide-react";

interface Holder { address: string; tokenAccount: string; amount: number; pct: number; }

interface HoldersResponse {
  holders: Holder[];
  totalSupply: number;
  error?: string;
}

// Direct client-side fetch to GMGN (bypasses server-side blocks)
async function fetchGmgnClient(mint: string): Promise<HoldersResponse | null> {
  try {

    // Try multiple GMGN endpoints
    const endpoints = [
      `https://gmgn.ai/defi/quotation/v1/tokens/solana/${mint}`,
      `https://gmgn.ai/api/v1/tokens/solana/${mint}`,
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
          },
          // Add cache buster
          cache: "no-store",
        });


        if (!res.ok) continue;

        const raw = await res.json();

        // Parse various response formats
        const data = raw.data || raw;
        if (!data || typeof data !== 'object') continue;

        const holderCount = data.holder_count || data.holders || data.holderCount || 0;
        const topHolders = data.top_holders || data.topHolders || data.holders_list || [];

        if (topHolders.length > 0 || holderCount > 0) {
          const totalSupply = parseFloat(data.total_supply || data.totalSupply || "1000000000");

          const holders: Holder[] = topHolders.slice(0, 20).map((h: any) => ({
            address: h.address || h.owner || h.wallet,
            tokenAccount: h.address || h.tokenAccount,
            amount: parseFloat(h.balance || h.amount || h.uiAmount || "0"),
            pct: h.percentage || h.pct || (parseFloat(h.balance || "0") / totalSupply) * 100,
          }));

          return { holders, totalSupply: holderCount || totalSupply };
        }
      } catch (e) {
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

export default function HoldersTab({ mint }: { mint: string }) {
  const [data, setData] = useState<HoldersResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!mint) return;
    setData(null);
    setErr(null);
    setLoading(true);


    let cancel = false;

    // First try our API
    fetch(`/api/token-holders?mint=${encodeURIComponent(mint)}`)
      .then(r => {
        return r.json();
      })
      .then(async (j: HoldersResponse) => {
        if (cancel) return;

        if (j.error) {
          setErr(j.error);
        } else if (j.holders && j.holders.length > 0) {
          setData(j);
        } else {
          // API returned empty, try direct GMGN client-side
          const gmgnData = await fetchGmgnClient(mint);
          if (gmgnData && (gmgnData.holders.length > 0 || gmgnData.totalSupply > 0)) {
            setData(gmgnData);
          } else {
            // Both failed, show what we have
            setData(j);
          }
        }
      })
      .catch(async e => {
        if (cancel) return;

        // API failed completely, try direct GMGN
        const gmgnData = await fetchGmgnClient(mint);
        if (gmgnData && (gmgnData.holders.length > 0 || gmgnData.totalSupply > 0)) {
          setData(gmgnData);
        } else {
          if (!cancel) setErr(String(e));
        }
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });

    return () => { cancel = true; };
  }, [mint]);

  if (loading) return <TabLoading />;

  // Special handling for bonding curve tokens
  if (err?.includes("bonding curve") || err?.includes("not found on-chain")) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <Info className="w-8 h-8 text-[#a855f7]/60 mb-3" />
        <p className="text-[11px] text-[#d1d4dc]/60 max-w-xs">
          РҐРѕР»РґРµСЂС‹ РЅРµРґРѕСЃС‚СѓРїРЅС‹ РґР»СЏ С‚РѕРєРµРЅРѕРІ РЅР° bonding curve.
          Р”Р°РЅРЅС‹Рµ РїРѕСЏРІСЏС‚СЃСЏ РїРѕСЃР»Рµ РјРёРіСЂР°С†РёРё РЅР° DEX.
        </p>
      </div>
    );
  }

  if (err) return <TabError message={`РћС€РёР±РєР°: ${err}`} />;

  // If we have data but no holders, it might be a bonding curve token
  // where API returned empty top_holders but token exists
  if (data && data.holders.length === 0) {
    if (data.totalSupply > 0) {
      // Token exists but no top holders data - likely bonding curve
      return (
        <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
          <Info className="w-8 h-8 text-[#a855f7]/60 mb-3" />
          <p className="text-[11px] text-[#d1d4dc]/60 max-w-xs">
            Р”Р°РЅРЅС‹Рµ Рѕ С‚РѕРї-С…РѕР»РґРµСЂР°С… РЅРµРґРѕСЃС‚СѓРїРЅС‹ РґР»СЏ СЌС‚РѕРіРѕ С‚РѕРєРµРЅР°.
            Р’СЃРµРіРѕ С…РѕР»РґРµСЂРѕРІ: {data.totalSupply.toLocaleString()} (РёСЃС‚РѕСЂРёС‡РµСЃРєРёРµ РґР°РЅРЅС‹Рµ РѕРіСЂР°РЅРёС‡РµРЅС‹).
          </p>
        </div>
      );
    }
    return <TabEmpty />;
  }

  if (!data) return <TabEmpty />;

  return (
    <div className="text-[11px]">
      <div className="grid grid-cols-[40px_1.5fr_1fr_1fr] gap-3 px-4 py-2 border-b border-[#1a1a2e] text-[9px] uppercase tracking-wide text-[#d1d4dc]/40">
        <span>#</span><span>Address</span><span className="text-right">Amount</span><span className="text-right">Supply %</span>
      </div>
      <div className="divide-y divide-[#1a1a2e]/40">
        {data.holders.map((h, i) => (
          <div key={h.tokenAccount} className="grid grid-cols-[40px_1.5fr_1fr_1fr] gap-3 px-4 py-1.5 items-center hover:bg-white/5">
            <span className="text-[#d1d4dc]/40 tabular-nums">{i + 1}</span>
            <a href={`https://solscan.io/account/${h.address}`} target="_blank" rel="noopener noreferrer" className="text-[#a855f7] hover:underline truncate">
              {shortAddr(h.address, 6, 6)}
            </a>
            <span className="text-right tabular-nums">{fmtNum(h.amount)}</span>
            <div className="text-right">
              <span className="tabular-nums font-semibold">{h.pct.toFixed(2)}%</span>
              <div className="h-1 mt-0.5 bg-[#1a1a2e] rounded overflow-hidden">
                <div className="h-full bg-[#a855f7]" style={{ width: `${Math.min(100, h.pct)}%` }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
