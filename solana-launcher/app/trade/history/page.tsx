// data-tag: page.trade.history
"use client";

import { Fragment, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { History as HistoryIcon, Coins, Wallet as WalletIcon, ExternalLink, Search } from "lucide-react";
import clsx from "clsx";

interface MintRow {
  mint: string;
  firstAnalyzedAt: number;
  lastAnalyzedAt: number;
  analysesCount: number;
  totalVolumeSol: number | null;
  totalTrades: number | null;
  uniqueWallets: number | null;
  devAddress: string | null;
}

interface WalletRow {
  address: string;
  totalVolumeSol: number;
  totalPnlSol: number;
  tokensTraded: number;
  totalBuys: number;
  totalSells: number;
  firstSeen: number | null;
  lastUpdatedAt: number;
}

interface WalletDetail {
  stats: WalletRow | null;
  tokens: Array<{
    mint: string; buys: number; sells: number; volumeSol: number;
    pnlSol: number; pnlPercent: number; isFresh: boolean; isWash: boolean;
    bundleId: string | null; updatedAt: number;
  }>;
}

type Tab = "mints" | "wallets";

export default function HistoryPage() {
  const [tab, setTab] = useState<Tab>("mints");
  const [mints, setMints] = useState<MintRow[] | null>(null);
  const [wallets, setWallets] = useState<WalletRow[] | null>(null);
  const [walletOrder, setWalletOrder] = useState<"pnl" | "volume">("pnl");
  const [filter, setFilter] = useState("");
  const [openWallet, setOpenWallet] = useState<string | null>(null);
  const [walletDetail, setWalletDetail] = useState<WalletDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const loadMints = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/trade/history?kind=mints&limit=200");
      const j = await r.json();
      setMints(j.mints ?? []);
    } finally { setLoading(false); }
  }, []);

  const loadWallets = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/trade/history?kind=wallets&order=${walletOrder}&limit=200`);
      const j = await r.json();
      setWallets(j.wallets ?? []);
    } finally { setLoading(false); }
  }, [walletOrder]);

  useEffect(() => {
    if (tab === "mints" && mints === null) loadMints();
    if (tab === "wallets") loadWallets();
  }, [tab, walletOrder, loadMints, loadWallets, mints]);

  const toggleWallet = async (addr: string) => {
    if (openWallet === addr) {
      setOpenWallet(null);
      setWalletDetail(null);
      return;
    }
    setOpenWallet(addr);
    setWalletDetail(null);
    const r = await fetch(`/api/trade/history?kind=wallet&address=${addr}`);
    const j = await r.json();
    setWalletDetail(j);
  };

  const filteredMints = mints?.filter((m) =>
    !filter || m.mint.toLowerCase().includes(filter.toLowerCase()) ||
    (m.devAddress?.toLowerCase().includes(filter.toLowerCase()))
  );
  const filteredWallets = wallets?.filter((w) =>
    !filter || w.address.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-4" data-tag="trade.history">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2 text-white">
          <HistoryIcon className="w-6 h-6 text-neon-purple" />
          History
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => setTab("mints")}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition",
              tab === "mints"
                ? "bg-neon-purple/15 text-neon-purple border-neon-purple/40"
                : "bg-white/5 text-white/60 border-bg-border hover:text-white"
            )}
          ><Coins className="w-3.5 h-3.5" />Tokens {mints ? `(${mints.length})` : ""}</button>
          <button
            onClick={() => setTab("wallets")}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition",
              tab === "wallets"
                ? "bg-neon-purple/15 text-neon-purple border-neon-purple/40"
                : "bg-white/5 text-white/60 border-bg-border hover:text-white"
            )}
          ><WalletIcon className="w-3.5 h-3.5" />Wallets {wallets ? `(${wallets.length})` : ""}</button>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={tab === "mints" ? "Filter by mint or dev address..." : "Filter by wallet address..."}
            className="w-full bg-bg-card border border-bg-border rounded-md pl-9 pr-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-neon-purple/50"
          />
        </div>
        {tab === "wallets" && (
          <div className="flex gap-1">
            <button
              onClick={() => setWalletOrder("pnl")}
              className={clsx("px-3 py-2 rounded-md text-xs border", walletOrder === "pnl" ? "bg-neon-green/10 text-neon-green border-neon-green/30" : "bg-white/5 text-white/50 border-bg-border")}
            >By PnL</button>
            <button
              onClick={() => setWalletOrder("volume")}
              className={clsx("px-3 py-2 rounded-md text-xs border", walletOrder === "volume" ? "bg-neon-purple/10 text-neon-purple border-neon-purple/30" : "bg-white/5 text-white/50 border-bg-border")}
            >By Volume</button>
          </div>
        )}
      </div>

      {loading && <p className="text-white/50 text-sm">Loading...</p>}

      {/* Mints table */}
      {tab === "mints" && filteredMints && (
        filteredMints.length === 0 ? (
          <p className="text-white/40 text-sm py-8 text-center">No analyses yet. Go to <Link href="/trade/analysis" className="text-neon-purple hover:underline">Analysis</Link> and search for a mint.</p>
        ) : (
          <div className="bg-bg-card border border-bg-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-white/5 text-white/50">
                <tr>
                  <th className="text-left px-3 py-2">Mint</th>
                  <th className="text-right px-3 py-2">Last analyzed</th>
                  <th className="text-right px-3 py-2"># Runs</th>
                  <th className="text-right px-3 py-2">Volume (SOL)</th>
                  <th className="text-right px-3 py-2">Trades</th>
                  <th className="text-right px-3 py-2">Wallets</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filteredMints.map((m) => (
                  <tr key={m.mint} className="border-t border-bg-border hover:bg-white/5">
                    <td className="px-3 py-2 font-mono text-white/80">{m.mint.slice(0, 6)}…{m.mint.slice(-6)}</td>
                    <td className="px-3 py-2 text-right text-white/60">{fmtTime(m.lastAnalyzedAt)}</td>
                    <td className="px-3 py-2 text-right text-white/80">{m.analysesCount}</td>
                    <td className="px-3 py-2 text-right text-white">{m.totalVolumeSol?.toFixed(2) ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-white/70">{m.totalTrades ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-white/70">{m.uniqueWallets ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/trade/analysis?mint=${m.mint}`} className="text-neon-purple hover:underline inline-flex items-center gap-1">
                        Re-analyze <ExternalLink className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Wallets table */}
      {tab === "wallets" && filteredWallets && (
        filteredWallets.length === 0 ? (
          <p className="text-white/40 text-sm py-8 text-center">No wallets in DB yet.</p>
        ) : (
          <div className="bg-bg-card border border-bg-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-white/5 text-white/50">
                <tr>
                  <th className="text-left px-3 py-2">Wallet</th>
                  <th className="text-right px-3 py-2">PnL (SOL)</th>
                  <th className="text-right px-3 py-2">Volume (SOL)</th>
                  <th className="text-right px-3 py-2">Tokens</th>
                  <th className="text-right px-3 py-2">B / S</th>
                  <th className="text-right px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filteredWallets.map((w) => {
                  const isOpen = openWallet === w.address;
                  return (
                    <Fragment key={w.address}>
                      <tr
                        onClick={() => toggleWallet(w.address)}
                        className={clsx("border-t border-bg-border cursor-pointer hover:bg-white/5", isOpen && "bg-white/5")}
                      >
                        <td className="px-3 py-2 font-mono text-white/80">{w.address.slice(0, 6)}…{w.address.slice(-6)}</td>
                        <td className={clsx("px-3 py-2 text-right font-semibold", w.totalPnlSol >= 0 ? "text-neon-green" : "text-neon-red")}>
                          {w.totalPnlSol >= 0 ? "+" : ""}{w.totalPnlSol.toFixed(3)}
                        </td>
                        <td className="px-3 py-2 text-right text-white">{w.totalVolumeSol.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-white/80">{w.tokensTraded}</td>
                        <td className="px-3 py-2 text-right text-white/60">{w.totalBuys} / {w.totalSells}</td>
                        <td className="px-3 py-2 text-right text-white/50">{fmtTime(w.lastUpdatedAt)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-bg/40">
                          <td colSpan={6} className="px-4 py-3">
                            {!walletDetail ? (
                              <p className="text-white/50 text-xs">Loading...</p>
                            ) : (
                              <div className="space-y-2">
                                <p className="text-white/60 text-xs">Tokens traded by this wallet:</p>
                                <table className="w-full text-xs">
                                  <thead className="text-white/40">
                                    <tr>
                                      <th className="text-left px-2 py-1">Mint</th>
                                      <th className="text-right px-2 py-1">PnL SOL</th>
                                      <th className="text-right px-2 py-1">Vol SOL</th>
                                      <th className="text-right px-2 py-1">B / S</th>
                                      <th className="text-right px-2 py-1">Flags</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {walletDetail.tokens.map((t) => (
                                      <tr key={t.mint} className="border-t border-bg-border/50">
                                        <td className="px-2 py-1">
                                          <Link href={`/trade/analysis?mint=${t.mint}`} className="font-mono text-neon-purple hover:underline">
                                            {t.mint.slice(0, 6)}…{t.mint.slice(-6)}
                                          </Link>
                                        </td>
                                        <td className={clsx("px-2 py-1 text-right", t.pnlSol >= 0 ? "text-neon-green" : "text-neon-red")}>
                                          {t.pnlSol >= 0 ? "+" : ""}{t.pnlSol.toFixed(3)}
                                        </td>
                                        <td className="px-2 py-1 text-right text-white/70">{t.volumeSol.toFixed(2)}</td>
                                        <td className="px-2 py-1 text-right text-white/60">{t.buys}/{t.sells}</td>
                                        <td className="px-2 py-1 text-right">
                                          {t.isFresh && <span className="px-1.5 py-0.5 rounded bg-neon-yellow/15 text-neon-yellow mr-1">fresh</span>}
                                          {t.isWash && <span className="px-1.5 py-0.5 rounded bg-neon-red/15 text-neon-red mr-1">wash</span>}
                                          {t.bundleId && <span className="px-1.5 py-0.5 rounded bg-neon-purple/15 text-neon-purple">bundle</span>}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
