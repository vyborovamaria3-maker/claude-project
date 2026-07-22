"use client";
import React, { useEffect, useState } from "react";
import { TabLoading, TabError, TabEmpty } from "./_shared";

export default function DcaTab({ mint }: { mint: string }) {
  const [data, setData] = useState<unknown[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!mint) return;
    setData(null); setErr(null);
    let cancel = false;
    fetch(`/api/token-dca?mint=${encodeURIComponent(mint)}`)
      .then(r => r.json())
      .then(j => { if (!cancel) j.error ? setErr(j.error) : setData(j.positions ?? []); })
      .catch(e => { if (!cancel) setErr(String(e)); });
    return () => { cancel = true; };
  }, [mint]);

  if (err) return <TabError message={`Ошибка: ${err}`} />;
  if (!data) return <TabLoading />;
  if (data.length === 0) return <TabEmpty message="Активных DCA позиций нет (Jupiter)" />;

  return (
    <div className="p-4 text-[11px] text-[#d1d4dc]/60">
      Найдено DCA: {data.length}
      <pre className="mt-2 text-[10px] overflow-auto max-h-60 bg-[#1a1a2e]/40 p-2 rounded">
        {JSON.stringify(data.slice(0, 10), null, 2)}
      </pre>
    </div>
  );
}
