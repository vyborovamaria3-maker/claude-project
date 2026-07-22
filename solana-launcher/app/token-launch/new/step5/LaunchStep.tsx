"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import bs58 from "bs58";
import { authHeaders } from "@/lib/clientAuth";
import { Rocket, Loader2, CheckCircle, AlertCircle, ExternalLink, Download, ChevronDown, ChevronUp, Search } from "lucide-react";
import type { StepProps } from "../types";
import PumpFunChart from "@/components/PumpFunChart";
import { loadWallets, recoverSecret } from "@/lib/walletStore";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

interface LaunchStepProps extends StepProps {
  tag?: string;
}

function SolAmount({ value }: { value: number }) {
  return <span className="font-mono text-white">{value.toFixed(6)} SOL</span>;
}

// data-tag: token_launch.new.step5.launch
export default function LaunchStep({ data, prev, tag = "token_launch.new.step5" }: LaunchStepProps) {
  const router = useRouter();
  const [isLaunching, setIsLaunching] = useState(false);
  const [keysExported, setKeysExported] = useState(false);
  const [showAdvancedLayout, setShowAdvancedLayout] = useState(false);
  const [result, setResult] = useState<{ success: boolean; signature?: string; error?: string } | null>(null);
  const [chartMint, setChartMint] = useState<string>(data.tokenMint || data.mint || "");
  const [mintInput, setMintInput] = useState<string>(data.tokenMint || data.mint || "");

  const tokenName = data.tokenName || data.name || "";
  const tokenSymbol = data.tokenSymbol || data.symbol || "";
  const buyMode: string = data.buyMode || "snipe";
  const devBuy: number = data.devBuy ?? 0;
  const slippage: number = data.slippage ?? 15;
  const jitoTier: string = data.jitoTier ?? "Backend Policy";
  const landingProfile: string = data.landingProfile ?? "Backend Policy";
  const priorityFee: number = data.priorityFee ?? 0;
  const platform: string = data.platform || "Pump.fun";
  const launchMode: string = data.launchMode || "Classic";

  const selectedWallets: { address: string; amount: number }[] = data.selectedWallets ?? [];
  const snipeWallets: { address: string; amount: number }[] = data.snipeWallets ?? [];

  const totalBundleSol = useMemo(() => selectedWallets.reduce((s, w) => s + (w.amount ?? 0), 0), [selectedWallets]);
  const totalSnipeSol = useMemo(() => snipeWallets.reduce((s, w) => s + (w.amount ?? 0), 0), [snipeWallets]);
  const totalBuyBudget = devBuy + totalBundleSol + totalSnipeSol;

  const jitoTierLabel = jitoTier === "normal" ? "Normal" : jitoTier === "premium" ? "Premium" : jitoTier === "whale" ? "Whale" : "Backend Policy";
  const landingLabel = landingProfile === "balanced" ? "Balanced" : landingProfile === "ultra_fast" ? "Ultra Fast" : "Backend Policy";
  const buyModeLabel = buyMode === "snipe" ? "Snipe" : buyMode === "bundle" ? "Bundle" : buyMode === "launch_bundle_snipe" ? "Launch + Bundle + Snipe" : buyMode === "dev_only" ? "Dev Buy Only" : buyMode;

  // Checklist
  const hasMetadata = !!(tokenName && tokenSymbol);
  const hasDevWallet = typeof data.devWalletAddress === "string" && data.devWalletAddress.length > 0;
  const hasWallets = selectedWallets.length > 0 || buyMode === "dev_only" || buyMode === "snipe";
  const settingsConfigured = true;
  const walletsBacked = keysExported;
  const hasEnoughSol = totalBuyBudget > 0 || buyMode === "dev_only";

  const checklist = [
    { label: "Token metadata", ok: hasMetadata, link: true },
    { label: "Dev wallet created", ok: hasDevWallet, link: false },
    { label: "Wallets configured", ok: hasWallets, link: true },
    { label: "Settings configured", ok: settingsConfigured, link: false },
    { label: "Wallet keys backed up", ok: walletsBacked, link: false },
    { label: "Enough SOL for launch (dev + bundle)", ok: hasEnoughSol, link: false },
  ];

  const canLaunch = checklist.every((c) => c.ok);

  // Advanced features summary
  const advancedFeatures = [
    { label: "Anti Sniper", enabled: !!(data.antiSniperEnabled) },
    { label: "Smart Sell (after launch)", enabled: !!(data.smartSellEnabled) },
    { label: `Auto TP (after launch)${data.tpLevels?.length ? ` (${data.tpLevels.length})` : ""}`, enabled: !!(data.autoTpEnabled) },
    { label: "Retry", enabled: !!(data.autoRetryCount && data.autoRetryCount > 0) },
  ];

  const handleExportKeys = () => {
    const walletData = {
      devWallet: data.devWallet || data.devWalletAddress || "",
      bundleWallets: selectedWallets,
      snipeWallets: snipeWallets,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(walletData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wallet-keys-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setKeysExported(true);
  };

  const handleLaunch = async () => {
    setIsLaunching(true);
    setResult(null);
    try {
      const devWalletAddress = data.devWalletAddress || loadWallets().find((w) => w.role === "dev")?.publicKey;
      if (!devWalletAddress) throw new Error("Dev wallet not found");
      const creatorSecretKey = await recoverSecret(devWalletAddress);
      if (!creatorSecretKey) throw new Error("Dev wallet private key is unavailable. Export/import wallet keys first.");
      const creatorKeypair = Keypair.fromSecretKey(bs58.decode(creatorSecretKey));
      const mintKeypair = Keypair.generate();

      const createResponse = await fetch("/api/bundler/create-token", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          name: tokenName,
          symbol: tokenSymbol,
          description: data.description || "",
          image: data.imagePreview || data.image || "",
          twitter: data.xUrl || data.twitter || "",
          telegram: data.telegram || "",
          website: data.website || "",
          creatorPublicKey: creatorKeypair.publicKey.toBase58(),
          mintPublicKey: mintKeypair.publicKey.toBase58(),
          priorityFee,
        }),
      });
      const createData = await createResponse.json();
      if (!createResponse.ok || !createData.success || !createData.transaction) {
        throw new Error(createData.error || "Failed to create token transaction");
      }

      const unsignedTx = VersionedTransaction.deserialize(Buffer.from(createData.transaction, "base64"));
      unsignedTx.sign([creatorKeypair, mintKeypair]);
      const signedTransaction = Buffer.from(unsignedTx.serialize()).toString("base64");

      const submitResponse = await fetch("/api/bundler/submit-tx", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          transaction: signedTransaction,
          skipPreflight: false,
          maxRetries: 3,
        }),
      });
      const submitData = await submitResponse.json();
      if (!submitResponse.ok || !submitData.success) {
        throw new Error(submitData.error || "Failed to submit token transaction");
      }

      const mint = createData.mint || "";
      setChartMint(mint);
      setMintInput(mint);
      setResult({ success: true, signature: submitData.signature });
      router.push(`/token-launch/chart?mint=${encodeURIComponent(mint)}`);
    } catch (e) {
      setResult({ success: false, error: e instanceof Error ? e.message : "Unknown error" });
      setIsLaunching(false);
    }
  };

  return (
    <div data-tag={tag} className="space-y-5">

      {/* Pre-launch Checklist */}
      <div className="border border-bg-border rounded-xl p-5 space-y-3 bg-bg-card">
        <h3 className="text-sm font-semibold text-white">Pre-launch Checklist</h3>
        <div className="space-y-2">
          {checklist.map((item) => (
            <div key={item.label} className="flex items-center gap-2.5">
              {item.ok ? (
                <CheckCircle className="w-4 h-4 text-neon-green flex-shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
              )}
              <span className={["text-sm", item.ok ? "text-white" : item.link ? "text-neon-green underline cursor-pointer" : "text-white/60"].join(" ")}>
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Token Preview */}
      <div className="border border-bg-border rounded-xl p-5 bg-bg-card">
        <h3 className="text-sm font-semibold text-white mb-3">Token Preview</h3>
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl bg-bg-soft border border-bg-border flex items-center justify-center flex-shrink-0 overflow-hidden">
            {data.imagePreview ? (
              <img src={data.imagePreview} alt="token" className="w-full h-full object-cover" />
            ) : (
              <span className="text-white/30 text-xl font-bold">?</span>
            )}
          </div>
          <div>
            <p className="text-base font-bold text-white">{tokenName || "Unnamed Token"}</p>
            <p className="text-sm text-white/50">${tokenSymbol || "???"}</p>
          </div>
        </div>
      </div>

      {/* Launch Configuration */}
      <div className="border border-bg-border rounded-xl p-5 bg-bg-card">
        <h3 className="text-sm font-semibold text-white mb-4">Launch Configuration</h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <p className="text-xs text-white/50 mb-1">Platform</p>
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded bg-bg-soft border border-bg-border flex items-center justify-center overflow-hidden">
                <span className="text-[8px] text-white/50">P</span>
              </div>
              <span className="text-sm font-semibold text-white">{platform}</span>
            </div>
          </div>
          <div>
            <p className="text-xs text-white/50 mb-1">Mode</p>
            <p className="text-sm font-semibold text-white">{launchMode}</p>
          </div>
          <div>
            <p className="text-xs text-white/50 mb-1">Buy Mode</p>
            <p className="text-sm font-semibold text-white">{buyModeLabel}</p>
          </div>
          <div>
            <p className="text-xs text-white/50 mb-1">Slippage</p>
            <p className="text-sm font-semibold text-white">{slippage}%</p>
          </div>
          <div>
            <p className="text-xs text-white/50 mb-1">Jito Tip Tier</p>
            <p className="text-sm font-semibold text-white">{jitoTierLabel}</p>
          </div>
          <div>
            <p className="text-xs text-white/50 mb-1">Landing Profile</p>
            <p className="text-sm font-semibold text-white">{landingLabel}</p>
          </div>
        </div>
      </div>

      {/* Advanced execution layout (collapsible) */}
      <div className="border border-bg-border rounded-xl overflow-hidden bg-bg-card">
        <button
          onClick={() => setShowAdvancedLayout(!showAdvancedLayout)}
          className="w-full flex items-center justify-between px-5 py-3 hover:bg-bg-soft/30 transition"
        >
          <div className="flex items-center gap-2">
            {showAdvancedLayout ? <ChevronUp className="w-4 h-4 text-white/50" /> : <ChevronDown className="w-4 h-4 text-white/50" />}
            <span className="text-sm font-medium text-white">Advanced: execution layout</span>
          </div>
          <span className="text-xs text-white/40">How txs are packed into waves (server). Not buy size, not price prediction.</span>
        </button>

        {showAdvancedLayout && (
          <div className="px-5 pb-5 space-y-5 border-t border-bg-border">
            {/* Planned buys */}
            <div className="space-y-3 pt-4">
              <div>
                <p className="text-sm font-semibold text-white">Planned buys (Step 3)</p>
                <p className="text-xs text-white/40 mt-0.5">SOL you intend to spend on purchases from Step 3 — not the minimum balance the engine requires on each wallet. For required SOL vs live balances, use <span className="text-neon-green">Launch readiness</span> below.</p>
              </div>
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Dev buy</span>
                  <SolAmount value={devBuy} />
                </div>
                {(buyMode === "bundle" || buyMode === "launch_bundle_snipe") && (
                  <div className="flex items-center justify-between">
                    <span className="text-white/60">Bundle buys</span>
                    <SolAmount value={totalBundleSol} />
                  </div>
                )}
                {(buyMode === "snipe" || buyMode === "launch_bundle_snipe") && (
                  <div className="flex items-center justify-between">
                    <span className="text-white/60">Snipe buys</span>
                    <SolAmount value={totalSnipeSol} />
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-bg-border pt-1.5 mt-1">
                  <span className="text-white font-semibold">Total buy budget</span>
                  <SolAmount value={totalBuyBudget} />
                </div>
              </div>
              <div className="space-y-1.5 text-sm border-t border-bg-border pt-3">
                <p className="text-xs font-semibold text-white/40 uppercase tracking-wide mb-1">Fee Budget (Settings)</p>
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Dynamic Jito tip (estimate)</span>
                  <SolAmount value={0} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/60">Priority fee budget</span>
                  <SolAmount value={priorityFee} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Backup Wallet Keys */}
      <div className={["border rounded-xl p-5 space-y-3 bg-bg-card", keysExported ? "border-neon-green/40" : "border-bg-border"].join(" ")}>
        <div className="flex items-start gap-2">
          <div className={["w-4 h-4 rounded-full border-2 mt-0.5 flex-shrink-0", keysExported ? "border-neon-green bg-neon-green/20" : "border-neon-green"].join(" ")} />
          <div>
            <p className="text-sm font-semibold text-white">Backup Wallet Keys</p>
            <p className="text-xs text-white/50 mt-0.5">Export and securely store the launch wallet keys before continuing.</p>
          </div>
        </div>
        <button
          onClick={handleExportKeys}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-bg-border text-sm text-white hover:border-white/30 transition"
        >
          <Download className="w-4 h-4" />
          Export Keys
        </button>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={keysExported}
            onChange={(e) => setKeysExported(e.target.checked)}
            className="w-4 h-4 accent-neon-green rounded"
          />
          <span className="text-sm text-white/70">I have exported and securely stored my wallet keys</span>
        </label>
      </div>

      {/* Advanced Features */}
      <div className="border border-bg-border rounded-xl p-5 bg-bg-card">
        <h3 className="text-sm font-semibold text-white mb-3">Advanced Features</h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2">
          {advancedFeatures.map((f) => (
            <div key={f.label} className="flex items-center gap-2">
              <span className={["w-2 h-2 rounded-full flex-shrink-0", f.enabled ? "bg-neon-green" : "bg-white/20"].join(" ")} />
              <span className={["text-sm", f.enabled ? "text-white" : "text-white/40"].join(" ")}>{f.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className={["rounded-xl p-4 text-sm", result.success ? "bg-neon-green/10 border border-neon-green/30" : "bg-red-500/10 border border-red-500/30"].join(" ")}>
          <div className="flex items-start gap-2">
            {result.success ? <CheckCircle className="w-5 h-5 text-neon-green flex-shrink-0" /> : <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />}
            <div>
              <p className={result.success ? "text-neon-green" : "text-red-400 font-medium"}>
                {result.success ? "Token launch initiated!" : "Launch failed"}
              </p>
              {result.success && result.signature && (
                <p className="text-white/60 mt-1">
                  Tx:{" "}
                  <a href={`https://solscan.io/tx/${result.signature}`} target="_blank" rel="noopener noreferrer" className="text-neon-green hover:underline inline-flex items-center gap-1">
                    {result.signature.slice(0, 20)}... <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              )}
              {!result.success && result.error && <p className="text-white/60 mt-1">{result.error}</p>}
            </div>
          </div>
        </div>
      )}

      {/* Live price chart */}
      {result?.success && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
              <input
                type="text"
                value={mintInput}
                onChange={e => setMintInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && mintInput.trim() && setChartMint(mintInput.trim())}
                placeholder="Введи mint адрес любой монеты…"
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-bg-soft border border-bg-border text-sm text-white placeholder:text-white/30 outline-none focus:border-neon-green/50 transition font-mono"
              />
            </div>
            <button
              type="button"
              onClick={() => mintInput.trim() && setChartMint(mintInput.trim())}
              className="px-4 py-2 rounded-lg bg-neon-green/10 border border-neon-green/30 text-neon-green text-sm font-semibold hover:bg-neon-green/20 transition"
            >
              Открыть
            </button>
          </div>
          {chartMint && <PumpFunChart key={chartMint} mint={chartMint} />}
          {!chartMint && (
            <div className="flex items-center justify-center py-16 glass rounded-xl border border-bg-border">
              <p className="text-sm text-white/30">Введи mint адрес для отображения графика</p>
            </div>
          )}
        </div>
      )}

      {/* Validation warning */}
      {!canLaunch && (
        <div className="flex items-center gap-2 p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10">
          <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
          <span className="text-sm text-yellow-400">Please complete all required fields before launching.</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <button type="button" onClick={prev} disabled={isLaunching} className="px-6 py-2 rounded-lg border border-bg-border text-white/70 hover:border-white/30 hover:text-white transition text-sm disabled:opacity-50">
          Back
        </button>
        <button
          type="button"
          onClick={handleLaunch}
          disabled={isLaunching}
          className="px-10 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition text-sm disabled:opacity-40 flex items-center gap-2"
        >
          {isLaunching ? <><Loader2 className="w-4 h-4 animate-spin" /> Launching...</> : <><Rocket className="w-4 h-4" /> Launch Token</>}
        </button>
      </div>
    </div>
  );
}
