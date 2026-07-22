"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Search,
  SlidersHorizontal,
  Package,
  Wallet,
  Rocket,
  Play,
  Settings,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { useBundlerReal } from "@/hooks/useBundlerReal";
import type { TokenMetadata } from "@/lib/bundler/types";

interface Bundle {
  id: string;
  name: string;
  wallets: number;
  solSpent: number;
  pnl: number;
  status: "active" | "completed" | "failed" | "pending";
  createdAt: string;
  mint?: string;
}

// data-tag: page.bundles
export default function BundlesPage() {
  const router = useRouter();
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"dashboard" | "wallets" | "history" | "launch">("dashboard");
  const [launchForm, setLaunchForm] = useState<TokenMetadata>({
    name: "",
    symbol: "",
    description: "",
  });
  const [buyAmounts, setBuyAmounts] = useState<string>("0.1,0.1,0.1,0.1");
  const [walletCount, setWalletCount] = useState(4);
  const [notice, setNotice] = useState<{ type: "info" | "success" | "error"; message: string } | null>(null);

  // Real bundler hook
  const {
    wallets,
    lpWallet,
    activeBundle,
    isLoading,
    error,
    generateLPWallet,
    generateWallets,
    clearWallets,
    launchWithBundle,
  } = useBundlerReal();

  const filtered = bundles.filter((b) =>
    b.name.toLowerCase().includes(search.toLowerCase())
  );

  const totalLaunches = bundles.length;
  const bestLaunch = bundles.length > 0 ? Math.max(...bundles.map((b) => b.pnl)) : 0;
  const totalPnl = bundles.reduce((sum, b) => sum + b.pnl, 0);

  const createBundle = () => router.push("/token-launch");

  const handleGenerateWallets = () => {
    const count = Math.floor(walletCount);
    if (!Number.isFinite(count) || count < 1 || count > 24) {
      setNotice({ type: "error", message: "Wallet count must be between 1 and 24." });
      return;
    }
    generateWallets(count);
    setNotice({ type: "success", message: `Generated ${count} bundler wallet${count === 1 ? "" : "s"}.` });
  };

  const handleGenerateLP = () => {
    generateLPWallet();
    setNotice({ type: "success", message: "LP creator wallet generated. Save the key before launch." });
  };

  const handleLaunch = async () => {
    setNotice(null);
    if (!lpWallet || wallets.length === 0) {
      setNotice({ type: "error", message: "Generate LP wallet and bundler wallets first." });
      return;
    }

    const amounts = buyAmounts.split(",").map((s) => parseFloat(s.trim()));
    if (amounts.some((a) => !Number.isFinite(a) || a <= 0)) {
      setNotice({ type: "error", message: "Buy amounts must be positive numbers separated by commas." });
      return;
    }
    if (amounts.length !== wallets.length) {
      setNotice({ type: "error", message: `Add exactly ${wallets.length} buy amount${wallets.length === 1 ? "" : "s"} to match generated wallets.` });
      return;
    }

    const result = await launchWithBundle(launchForm, amounts);

    if (result.success && result.mint) {
      const newBundle: Bundle = {
        id: Math.random().toString(36).slice(2),
        name: `${launchForm.symbol} Launch`,
        wallets: wallets.length,
        solSpent: amounts.reduce((a, b) => a + b, 0),
        pnl: 0,
        status: "active",
        createdAt: new Date().toISOString(),
        mint: result.mint,
      };
      setBundles((prev) => [newBundle, ...prev]);
      setNotice({ type: "success", message: `Bundle launch created for ${launchForm.symbol}.` });
    } else {
      setNotice({ type: "error", message: result.error || "Bundle launch failed. Check wallet balances and API response." });
    }
  };

  return (
    <div data-tag="page.bundles" className="w-full min-w-0 max-w-[1400px] mx-auto space-y-6 py-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Bundles</h1>
        <p className="text-sm text-white/50 mt-1">Manage your token launch bundles</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
        {[
          { label: "Total Launches", value: totalLaunches, prefix: "" },
          { label: "LP Wallet", value: lpWallet ? "Set" : "Not Set", prefix: "" },
          { label: "Bundler Wallets", value: wallets.length, prefix: "" },
          { label: "Best Launch", value: bestLaunch.toFixed(2), prefix: "◎ " },
          { label: "Total PnL", value: totalPnl.toFixed(2), prefix: "◎ " },
        ].map((stat) => (
          <div key={stat.label} className="surface-panel p-5 flex flex-col gap-2">
            <span className="text-xs text-white/40 uppercase tracking-widest">
              {stat.label}
            </span>
            <span className={`text-2xl font-bold font-mono ${stat.value === "Set" ? "text-[color:var(--theme-primary)]" : stat.value === "Not Set" ? "text-[color:var(--theme-warning)]" : "text-white"}`}>
              {stat.prefix}{stat.value}
            </span>
          </div>
        ))}
      </div>

      {/* Error display */}
      {error && (
        <div className="surface-panel p-4 border border-[color-mix(in_srgb,var(--theme-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--theme-danger)_10%,transparent)]">
          <p className="text-[color:var(--theme-danger)] text-sm">{error}</p>
        </div>
      )}

      {notice && (
        <div
          className={[
            "surface-panel p-4 text-sm",
            notice.type === "error"
              ? "border-[color-mix(in_srgb,var(--theme-danger)_34%,transparent)] text-[color:var(--theme-danger)]"
              : notice.type === "success"
              ? "border-[color-mix(in_srgb,var(--theme-success)_34%,transparent)] text-[color:var(--theme-success)]"
              : "border-[color-mix(in_srgb,var(--theme-primary)_28%,transparent)] text-content-soft",
          ].join(" ")}
          role={notice.type === "error" ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="flex items-center gap-2 border-b border-bg-border">
        {[
          { id: "dashboard", label: "Dashboard", icon: Package },
          { id: "wallets", label: "Wallets", icon: Wallet },
          { id: "launch", label: "Launch", icon: Rocket },
          { id: "history", label: "History", icon: Play },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={[
              "flex items-center gap-2 px-4 py-2 text-sm font-medium transition",
              activeTab === tab.id
                ? "text-[color:var(--theme-primary)] border-b-2 border-[color:var(--theme-primary)]"
                : "text-white/50 hover:text-white",
            ].join(" ")}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active Bundle Status */}
      {activeBundle && (
        <div className="surface-panel p-4 border border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] bg-[color-mix(in_srgb,var(--theme-primary)_5%,transparent)]">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-[color:var(--theme-primary)]">
              Active Bundle
            </h3>
            <span className="text-xs text-white/50">{activeBundle.status}</span>
          </div>
          <div className="w-full bg-bg-card rounded-full h-2 mb-2">
            <div
              className="bg-[color:var(--theme-primary)] h-2 rounded-full transition-all"
              style={{ width: `${activeBundle.progress}%` }}
            />
          </div>
          <div className="text-xs text-white/50 space-y-1">
            {activeBundle.logs.slice(-3).map((log, i) => (
              <div key={i}>{log}</div>
            ))}
          </div>
        </div>
      )}

      {/* Search & filter */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            type="text"
            placeholder="Search bundles..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-bg-card/60 border border-bg-border rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[color-mix(in_srgb,var(--theme-primary)_40%,transparent)]"
          />
        </div>
        <button
          type="button"
          onClick={() => setNotice({ type: "info", message: "Advanced filters are not enabled yet. Use search for now." })}
          className="p-2.5 rounded-lg bg-bg-card/60 border border-bg-border text-white/50 hover:text-white hover:border-white/20 transition"
          title="Filter"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "wallets" && (
        <div className="surface-panel p-6 space-y-6">
          {/* LP Wallet Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">LP Wallet (Creator)</h3>
              {!lpWallet && (
                <button
                  onClick={handleGenerateLP}
                  disabled={isLoading}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-semibold hover:bg-blue-600 transition disabled:opacity-50"
                >
                  <Wallet className="w-4 h-4" /> Generate LP
                </button>
              )}
            </div>
            {lpWallet ? (
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
                <div className="text-xs text-blue-400 mb-1">LP Wallet Address (save this key!)</div>
                <div className="font-mono text-xs text-white/80 truncate">
                  {lpWallet.publicKey.toBase58()}
                </div>
              </div>
            ) : (
              <div className="text-sm text-white/40">Generate LP wallet to create tokens</div>
            )}
          </div>

          <div className="border-t border-bg-border" />

          {/* Bundler Wallets Section */}
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">Bundler Wallets ({wallets.length})</h3>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={24}
                value={walletCount}
                onChange={(e) => setWalletCount(Number(e.target.value))}
                aria-label="Bundler wallet count"
                className="w-20 rounded-lg border border-bg-border bg-bg-card/70 px-3 py-2 text-sm text-white outline-none transition focus:border-[color-mix(in_srgb,var(--theme-primary)_42%,transparent)]"
              />
              <button
                onClick={handleGenerateWallets}
                disabled={isLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-neon-green text-bg text-sm font-semibold hover:shadow-neon-green transition disabled:opacity-50"
              >
                <Wallet className="w-4 h-4" /> Generate
              </button>
              {wallets.length > 0 && (
                <button
                  onClick={clearWallets}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm hover:bg-red-500/20 transition"
                >
                  <Trash2 className="w-4 h-4" /> Clear
                </button>
              )}
            </div>
          </div>

          {wallets.length === 0 ? (
            <div className="text-center py-10 text-white/40">
              <Wallet className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No bundler wallets generated yet</p>
              <p className="text-sm mt-1">Generate wallets for coordinated token launches</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {wallets.map((wallet, i) => (
                <div
                  key={wallet.keypair.publicKey.toBase58()}
                  className="bg-bg-card/50 border border-bg-border rounded-lg p-3"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono text-white/50">
                      #{i + 1}
                    </span>
                    <span className="text-xs text-white/30">{wallet.label}</span>
                  </div>
                  <div className="font-mono text-xs text-white/60 truncate">
                    {wallet.keypair.publicKey.toBase58()}
                  </div>
                  <div className="mt-2 text-xs text-white/40">
                    Balance: ◎ {wallet.solBalance.toFixed(4)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "dashboard" && (
        <>
          {filtered.length === 0 ? (
            <div className="glass flex flex-col items-center justify-center py-20 gap-4">
              <Package className="w-12 h-12 text-white/15" strokeWidth={1} />
              <p className="text-white/40 text-sm">No bundles found</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={createBundle}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-neon-green text-bg text-sm font-semibold hover:shadow-neon-green transition"
                >
                  <Plus className="w-4 h-4" /> Create Bundle
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("wallets")}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-bg-card border border-bg-border text-white text-sm hover:border-white/20 transition"
                >
                  <Settings className="w-4 h-4" /> Manage Wallets
                </button>
              </div>
            </div>
          ) : (
            <div className="glass overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-widest text-white/40 border-b border-bg-border">
                    <th className="px-5 py-3">Name</th>
                    <th className="px-5 py-3">Wallets</th>
                    <th className="px-5 py-3">SOL Spent</th>
                    <th className="px-5 py-3">PnL</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((b) => (
                    <tr
                      key={b.id}
                      className="border-t border-bg-border hover:bg-white/5 transition"
                    >
                      <td className="px-5 py-3 font-medium text-white">{b.name}</td>
                      <td className="px-5 py-3 text-white/60">{b.wallets}</td>
                      <td className="px-5 py-3 font-mono text-white/60">
                        ◎ {b.solSpent.toFixed(3)}
                      </td>
                      <td
                        className={[
                          "px-5 py-3 font-mono font-semibold",
                          b.pnl >= 0 ? "text-neon-green" : "text-red-400",
                        ].join(" ")}
                      >
                        {b.pnl >= 0 ? "+" : ""}◎ {b.pnl.toFixed(2)}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={[
                            "text-[11px] uppercase tracking-wide font-semibold px-2 py-1 rounded-full",
                            b.status === "active"
                              ? "bg-neon-green/10 text-neon-green"
                              : b.status === "completed"
                              ? "bg-blue-500/10 text-blue-400"
                              : b.status === "pending"
                              ? "bg-yellow-500/10 text-yellow-400"
                              : "bg-red-500/10 text-red-400",
                          ].join(" ")}
                        >
                          {b.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-white/40 text-xs">
                        {new Date(b.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Launch Tab */}
      {activeTab === "launch" && (
        <div className="glass p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">Launch Token with Bundle</h3>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${lpWallet ? "text-neon-green" : "text-red-400"}`}>
                LP: {lpWallet ? "✓" : "✗"}
              </span>
              <span className={`text-xs ${wallets.length > 0 ? "text-neon-green" : "text-red-400"}`}>
                Wallets: {wallets.length}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm text-white/60">Token Name</label>
              <input
                type="text"
                value={launchForm.name}
                onChange={(e) => setLaunchForm((prev) => ({ ...prev, name: e.target.value }))}
                className="w-full bg-bg-card border border-bg-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-neon-green/40"
                placeholder="My Token"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-white/60">Symbol</label>
              <input
                type="text"
                value={launchForm.symbol}
                onChange={(e) => setLaunchForm((prev) => ({ ...prev, symbol: e.target.value }))}
                className="w-full bg-bg-card border border-bg-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-neon-green/40"
                placeholder="TOKEN"
                maxLength={10}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-white/60">Description</label>
            <textarea
              value={launchForm.description}
              onChange={(e) => setLaunchForm((prev) => ({ ...prev, description: e.target.value }))}
              className="w-full bg-bg-card border border-bg-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-neon-green/40 h-20"
              placeholder="Token description..."
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm text-white/60">Buy Amounts (SOL per wallet, comma-separated)</label>
            <input
              type="text"
              value={buyAmounts}
              onChange={(e) => setBuyAmounts(e.target.value)}
              className="w-full bg-bg-card border border-bg-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-neon-green/40"
              placeholder="0.1,0.1,0.1,0.1"
            />
            <p className="text-xs text-white/40">Example: 0.1,0.1,0.1,0.1 = 4 wallets buying 0.1 SOL each</p>
          </div>

          <button
            onClick={handleLaunch}
            disabled={isLoading || !lpWallet || wallets.length === 0 || !launchForm.name || !launchForm.symbol}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-bg/30 border-t-bg rounded-full animate-spin" />
                Launching...
              </>
            ) : (
              <>
                <Rocket className="w-5 h-5" />
                Launch Token with Bundle
              </>
            )}
          </button>

          {activeBundle && (
            <div className="mt-4 p-4 bg-bg-card/50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-white">Status: {activeBundle.status}</span>
                <span className="text-xs text-white/50">{activeBundle.progress.toFixed(0)}%</span>
              </div>
              <div className="w-full bg-bg-border rounded-full h-2 mb-3">
                <div
                  className="bg-neon-green h-2 rounded-full transition-all"
                  style={{ width: `${activeBundle.progress}%` }}
                />
              </div>
              <div className="space-y-1 text-xs text-white/50 max-h-32 overflow-y-auto">
                {activeBundle.logs.map((log, i) => (
                  <div key={i} className="font-mono">{log}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* History Tab */}
      {activeTab === "history" && (
        <div className="glass p-6">
          {bundles.length === 0 ? (
            <div className="p-10 text-center text-white/40">
              <Play className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No launches yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {bundles.map((bundle) => (
                <div key={bundle.id} className="bg-bg-card/50 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-white">{bundle.name}</span>
                      <span
                        className={[
                          "text-[10px] uppercase px-2 py-0.5 rounded-full",
                          bundle.status === "active"
                            ? "bg-neon-green/10 text-neon-green"
                            : bundle.status === "completed"
                            ? "bg-blue-500/10 text-blue-400"
                            : "bg-red-500/10 text-red-400",
                        ].join(" ")}
                      >
                        {bundle.status}
                      </span>
                    </div>
                    {bundle.mint && (
                      <a
                        href={`https://solscan.io/token/${bundle.mint}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-neon-green hover:underline"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View Token
                      </a>
                    )}
                  </div>
                  <div className="text-sm text-white/60">
                    {bundle.wallets} wallets • ◎ {bundle.solSpent.toFixed(3)} spent •{" "}
                    {new Date(bundle.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
