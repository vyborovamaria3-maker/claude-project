"use client";
import React, { useEffect, useState } from "react";
import { TabLoading, TabError, TabEmpty, shortAddr } from "./_shared";

interface DevToken { mint: string; name: string; symbol: string; image: string; supply: number; }

export default function DevTokensTab({ mint }: { mint: string }) {
  const [data, setData] = useState<DevToken[] | null>(null);
  const [creator, setCreator] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mint) return;
    setData(null); setCreator(null); setErr(null);
    let cancel = false;
    fetch(`/api/token-dev?mint=${encodeURIComponent(mint)}`)
      .then(r => r.json())
      .then(j => {
        if (cancel) return;
        if (j.error) setErr(j.error);
        else { setCreator(j.creator); setData(j.tokens ?? []); }
      })
      .catch(e => { if (!cancel) setErr(String(e)); });
    return () => { cancel = true; };
  }, [mint]);

  if (err) return <TabError message={`Ошибка: ${err}`} />;
  if (!data) return <TabLoading />;

  return (
    <div>
      {creator && (
        <div className="px-4 py-2 border-b border-[#1a1a2e] text-[10px] text-[#d1d4dc]/50 flex items-center gap-2">
          <span>Dev:</span>
          <a href={`https://solscan.io/account/${creator}`} target="_blank" rel="noopener noreferrer" className="text-[#a855f7] hover:underline font-mono">
            {shortAddr(creator, 6, 6)}
          </a>
          <span className="ml-auto">Создано токенов: {data.length}</span>
        </div>
      )}
      {data.length === 0 ? (
        <TabEmpty message="Других токенов нет" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 p-3">
          {data.map(t => (
            <a
              key={t.mint}
              href={`https://solscan.io/token/${t.mint}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 p-2 rounded bg-[#1a1a2e]/40 hover:bg-[#1a1a2e] transition-colors min-w-0"
            >
              {t.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={t.image} alt="" className="w-7 h-7 rounded-full flex-shrink-0 object-cover" />
              ) : (
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#a855f7] to-[#10b981] flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
                  {(t.symbol || "?").slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-white truncate">{t.symbol || "—"}</div>
                <div className="text-[9px] text-[#d1d4dc]/40 truncate">{t.name || shortAddr(t.mint)}</div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
