"use client";

import { useState, Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import PumpFunChart from "@/components/PumpFunChart";

// data-tag: page.token_launch.chart

function ChartContent() {
  const params = useSearchParams();
  const [mintInput, setMintInput] = useState(params.get("mint") ?? "");
  const [chartMint, setChartMint] = useState(params.get("mint") ?? "");

  const open = () => {
    const m = mintInput.trim();
    if (!m) return;
    // Clear any stale caches before loading new token
    if (typeof window !== "undefined") {
      // Clear Next.js router cache for this path to force fresh data
      const url = new URL(window.location.href);
      url.searchParams.set("mint", m);
      window.history.replaceState(null, "", url.toString());
    }
    // Force re-mount by setting empty first, then new mint on next tick
    if (chartMint === m) {
      setChartMint("");
      setTimeout(() => setChartMint(m), 0);
    } else {
      setChartMint(m);
    }
  };

  return (
    <div className="w-full space-y-4">
      {/* Search bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            id="mint-search"
            name="mint"
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            data-lpignore="true"
            data-form-type="other"
            value={mintInput}
            onChange={e => setMintInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && open()}
            placeholder="Введи mint адрес монеты…"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-bg-soft border border-bg-border text-sm text-white placeholder:text-white/30 outline-none focus:border-neon-green/50 transition font-mono"
          />
        </div>
        <button
          type="button"
          onClick={open}
          className="px-5 py-2.5 rounded-xl bg-neon-green/10 border border-neon-green/30 text-neon-green text-sm font-semibold hover:bg-neon-green/20 transition"
        >
          Открыть
        </button>
      </div>

      {/* Chart */}
      {chartMint ? (
        <PumpFunChart key={chartMint} mint={chartMint} />
      ) : (
        <div className="flex items-center justify-center py-32 glass rounded-xl border border-bg-border">
          <p className="text-sm text-white/30">Введи mint адрес для отображения графика</p>
        </div>
      )}
    </div>
  );
}

export default function ChartPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-32">
        <p className="text-sm text-white/30">Загрузка…</p>
      </div>
    }>
      <ChartContent />
    </Suspense>
  );
}
