"use client";

import { useState } from "react";
import { Copy, CheckCheck, Globe, Twitter, Send, MessageCircle, Coins, TrendingUp, Droplet, Users, Calendar } from "lucide-react";

interface TokenInfoProps {
  mint: string;
  info?: {
    name?: string;
    symbol?: string;
    image?: string;
    description?: string;
    isPumpFun?: boolean;
    isMigrated?: boolean;
    marketCapUsd?: number;
    volume24hUsd?: number;
    liquidityUsd?: number;
    holders?: number;
    createdAt?: number;
    socials: {
      twitter?: string;
      telegram?: string;
      discord?: string;
      website?: string;
    };
  };
}

export default function TokenInfo({ mint, info }: TokenInfoProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Fallback if info is not provided
  const safeInfo = info || {
    name: "Unknown Token",
    symbol: "",
    socials: {}
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-lg bg-white/5 border border-bg-border flex items-center justify-center shrink-0 overflow-hidden">
          {safeInfo.image ? (
            <img src={safeInfo.image} alt={safeInfo.name} className="w-full h-full object-cover" />
          ) : (
            <span className="text-xl">🪙</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-white truncate">
              {safeInfo.name ?? "Unknown"} {safeInfo.symbol && <span className="text-white/50 text-sm">${safeInfo.symbol}</span>}
            </h2>
            {safeInfo.isPumpFun && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[color-mix(in_srgb,var(--theme-secondary)_15%,transparent)] text-[color:var(--theme-secondary)] border border-[color-mix(in_srgb,var(--theme-secondary)_30%,transparent)]">
                Pump.fun
              </span>
            )}
            {safeInfo.isMigrated && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-success/15 text-success border border-success/30">
                Migrated
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[11px] text-white/40 font-mono">{mint.slice(0, 8)}...{mint.slice(-8)}</span>
            <button onClick={copy} className="text-white/30 hover:text-white p-0.5">
              {copied ? <CheckCheck className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
          {safeInfo.description && (
            <p className="text-xs text-white/60 mt-1.5 line-clamp-2">{safeInfo.description}</p>
          )}
        </div>

        {/* Socials */}
        <div className="flex items-center gap-1">
          {safeInfo.socials?.twitter && (
            <SocialLink href={safeInfo.socials.twitter} title="Twitter"><Twitter className="w-3.5 h-3.5" /></SocialLink>
          )}
          {safeInfo.socials?.telegram && (
            <SocialLink href={safeInfo.socials.telegram} title="Telegram"><Send className="w-3.5 h-3.5" /></SocialLink>
          )}
          {safeInfo.socials?.discord && (
            <SocialLink href={safeInfo.socials.discord} title="Discord"><MessageCircle className="w-3.5 h-3.5" /></SocialLink>
          )}
          {safeInfo.socials?.website && (
            <SocialLink href={safeInfo.socials.website} title="Website"><Globe className="w-3.5 h-3.5" /></SocialLink>
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <Stat icon={<Coins className="w-3 h-3" />} label="Price" value={fmtUsd(safeInfo.marketCapUsd)} />
        <Stat icon={<TrendingUp className="w-3 h-3" />} label="Volume 24h" value={fmtUsd(safeInfo.volume24hUsd)} />
        <Stat icon={<Droplet className="w-3 h-3" />} label="Liquidity" value={fmtUsd(safeInfo.liquidityUsd)} />
        <Stat icon={<Users className="w-3 h-3" />} label="Holders" value={safeInfo.holders != null ? safeInfo.holders.toLocaleString() : "—"} />
        <Stat icon={<Calendar className="w-3 h-3" />} label="Created" value={safeInfo.createdAt ? fmtDate(safeInfo.createdAt) : "—"} />
      </div>
    </div>
  );
}

function SocialLink({ href, title, children }: { href: string; title: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="p-1.5 rounded-md bg-white/5 hover:bg-[color-mix(in_srgb,var(--theme-secondary)_15%,transparent)] text-white/60 hover:text-[color:var(--theme-secondary)] border border-bg-border hover:border-[color-mix(in_srgb,var(--theme-secondary)_30%,transparent)] transition"
    >
      {children}
    </a>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md bg-white/5 border border-bg-border px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-white/40 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-xs font-semibold text-white mt-0.5 truncate">{value}</div>
    </div>
  );
}

function fmtUsd(n?: number | null): string {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
