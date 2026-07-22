"use client";

import { useState } from "react";
import { Search, ExternalLink, CheckCircle2, Globe, Twitter, Send, Loader2, AlertCircle } from "lucide-react";
import Image from "next/image";
import type { TokenMeta } from "./types";

interface Props {
  onContinue: (meta: TokenMeta, mint: string) => void;
}

export default function CTOStep1({ onContinue }: Props) {
  const [tokenAddress, setTokenAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<TokenMeta | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const handleFetch = async () => {
    const mint = tokenAddress.trim();
    if (!mint) return;
    setLoading(true);
    setMeta(null);
    setFetchError(null);
    try {
      const res = await fetch(`/api/token-meta?mint=${encodeURIComponent(mint)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Not found");
      setMeta(data);
    } catch (e: any) {
      setFetchError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const fmtMC = (v: number | null) => {
    if (v == null) return null;
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-base font-semibold text-white">
          Token Address <span className="text-neon-green">*</span>
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={tokenAddress}
            onChange={(e) => { setTokenAddress(e.target.value); setMeta(null); setFetchError(null); }}
            onKeyDown={(e) => e.key === "Enter" && handleFetch()}
            placeholder="Enter any Solana token mint address..."
            className="flex-1 min-w-0 bg-bg-soft/60 border border-bg-border rounded-xl px-5 py-4 text-base text-white placeholder:text-white/30 focus:outline-none focus:border-neon-green/50 font-mono"
          />
          <button
            type="button"
            onClick={handleFetch}
            disabled={!tokenAddress.trim() || loading}
            className="px-5 rounded-xl bg-neon-green/15 border border-neon-green/40 text-neon-green hover:bg-neon-green/25 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center w-14"
            aria-label="Fetch token metadata"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
          </button>
        </div>
        {!meta && !fetchError && (
          <p className="text-center text-sm text-white/40 pt-2">
            Enter the token mint address to fetch metadata automatically.{" "}
            <span className="text-white/30 text-sm">Supports any Solana token (Pump.Fun, Raydium, etc.)</span>
          </p>
        )}
      </div>

      {fetchError && (
        <div className="flex items-center gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/10">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-base text-red-400">{fetchError}</p>
        </div>
      )}

      {meta && (
        <div className="border border-bg-border rounded-2xl p-6 space-y-5 bg-bg-soft/40">
          <div className="flex items-center gap-4">
            {meta.image ? (
              <Image
                src={meta.image}
                alt={meta.name ?? "token"}
                width={64}
                height={64}
                className="rounded-full object-cover shrink-0 border border-bg-border"
                unoptimized
              />
            ) : (
              <div className="w-[64px] h-[64px] rounded-full bg-neon-green/10 border border-neon-green/30 flex items-center justify-center text-neon-green font-bold text-2xl shrink-0">
                {meta.symbol?.[0] ?? "?"}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg font-semibold text-white truncate">{meta.name ?? "Unknown"}</span>
                <span className="text-base text-neon-green font-mono font-semibold">${meta.symbol ?? "—"}</span>
                {meta.verified && <CheckCircle2 className="w-4 h-4 text-neon-green shrink-0" />}
              </div>
              {meta.marketCap != null && (
                <p className="text-sm text-white/50 mt-1">
                  MC: <span className="text-neon-green font-semibold">{fmtMC(meta.marketCap)}</span>
                </p>
              )}
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                {meta.website && (
                  <a href={meta.website} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-neon-green/80 hover:text-neon-green transition">
                    <Globe className="w-4 h-4" /> Website <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {meta.twitter && (
                  <a href={meta.twitter} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-neon-green/80 hover:text-neon-green transition">
                    <Twitter className="w-4 h-4" /> Twitter <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {meta.telegram && (
                  <a href={meta.telegram} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-neon-green/80 hover:text-neon-green transition">
                    <Send className="w-4 h-4" /> Telegram <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {meta.dexUrl && (
                  <a href={meta.dexUrl} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-white/40 hover:text-white/70 transition">
                    View in Terminal <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onContinue(meta, tokenAddress.trim())}
            className="w-full py-4 rounded-xl bg-neon-green text-bg font-semibold text-base hover:shadow-neon-green transition"
          >
            Continue with this token
          </button>
        </div>
      )}
    </div>
  );
}
