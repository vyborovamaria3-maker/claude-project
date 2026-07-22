"use client";

import { useState, useMemo } from "react";
import { AlertTriangle, Shield, TrendingUp, Clock, RotateCcw, Zap } from "lucide-react";
import type { StepProps } from "../types";

type JitoTier = "normal" | "premium" | "whale";
type LandingProfile = "balanced" | "ultra_fast";
type AdvancedTab = "anti_sniper" | "smart_sell" | "auto_tp" | "retry";
type AntiSniperAction = "stop_buying" | "sell_half" | "sell_all";
type MonitoringMode = "sniper_based" | "time_based";
type StopMode = "first_success" | "last_success";
type TpTriggerType = "mcap" | "profit" | "roi";
type DelayMode = "new_user" | "advanced";
type SnipeDelayPreset = "instant" | "after_snipers" | "safe_entry" | "late_entry";

interface TpLevel {
  id: string;
  triggerType: TpTriggerType;
  triggerValue: number;
  sellPercent: number;
}

const DELAY_PRESETS: { id: SnipeDelayPreset; title: string; description: string }[] = [
  { id: "instant", title: "Instant", description: "No delay - first in queue" },
  { id: "after_snipers", title: "After Snipers", description: "50-150ms - after main snipers" },
  { id: "safe_entry", title: "Safe Entry", description: "300-700ms - safe entry after volatility" },
  { id: "late_entry", title: "Late Entry", description: "0.8-1.5 sec - late entry, less risk" },
];

// data-tag: token_launch.new.step4.launch_bundle_snipe
export default function LaunchBundleSnipeReviewStep({ data, update, next, prev }: StepProps) {
  // Snipe delay
  const [delayMode, setDelayMode] = useState<DelayMode>(data.snipeDelayMode ?? "new_user");
  const [delayPreset, setDelayPreset] = useState<SnipeDelayPreset>(data.snipeDelayPreset ?? "instant");
  const [delayMin, setDelayMin] = useState<number>(data.delayMin ?? 0);
  const [delayMax, setDelayMax] = useState<number>(data.delayMax ?? 5000);

  // Bundle/Execution
  const [jitoTier, setJitoTier] = useState<JitoTier>(data.jitoTier ?? "normal");
  const [landingProfile, setLandingProfile] = useState<LandingProfile>(data.landingProfile ?? "balanced");
  const [slippage, setSlippage] = useState<number>(data.slippage ?? 15);
  const [priorityFee, setPriorityFee] = useState<number>(data.priorityFee ?? 0);
  const [pumpFunCashback, setPumpFunCashback] = useState<boolean>(data.pumpFunCashback ?? false);
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>("anti_sniper");

  // Anti Sniper
  const [antiSniperEnabled, setAntiSniperEnabled] = useState<boolean>(data.antiSniperEnabled ?? false);
  const [antiSniperThreshold, setAntiSniperThreshold] = useState<number>(data.antiSniperThreshold ?? 5);
  const [antiSniperAction, setAntiSniperAction] = useState<AntiSniperAction>(data.antiSniperAction ?? "stop_buying");
  const [monitoringMode, setMonitoringMode] = useState<MonitoringMode>(data.monitoringMode ?? "sniper_based");
  const [stopMode, setStopMode] = useState<StopMode>(data.stopMode ?? "last_success");

  // Smart Sell
  const [smartSellEnabled, setSmartSellEnabled] = useState<boolean>(data.smartSellEnabled ?? false);
  const [smartSellPercent, setSmartSellPercent] = useState<number>(data.smartSellPercent ?? 100);
  const [smartSellStopBelow, setSmartSellStopBelow] = useState<number>(data.smartSellStopBelow ?? 0);
  const [smartSellMinSol, setSmartSellMinSol] = useState<number>(data.smartSellMinSol ?? 0);
  const [smartSellMinMcap, setSmartSellMinMcap] = useState<number>(data.smartSellMinMcap ?? 0);

  // Auto TP
  const [autoTpEnabled, setAutoTpEnabled] = useState<boolean>(data.autoTpEnabled ?? false);
  const [autoTpSellDevFirst, setAutoTpSellDevFirst] = useState<boolean>(data.autoTpSellDevFirst ?? false);
  const [autoTpSellDevAfter, setAutoTpSellDevAfter] = useState<number>(data.autoTpSellDevAfter ?? -1);
  const [autoTpSellAllAfter, setAutoTpSellAllAfter] = useState<number>(data.autoTpSellAllAfter ?? -1);
  const [tpLevels, setTpLevels] = useState<TpLevel[]>(data.tpLevels ?? [
    { id: "1", triggerType: "mcap", triggerValue: 0, sellPercent: 100 },
  ]);

  // Retry
  const [autoRetryCount, setAutoRetryCount] = useState<number>(data.autoRetryCount ?? 0);

  const selectedWallets: { address: string; amount: number }[] = data.selectedWallets ?? [];
  const snipeWallets: { address: string; amount: number }[] = data.snipeWallets ?? [];
  const devBuy: number = data.devBuy ?? 0;
  const totalSol = useMemo(() => selectedWallets.reduce((s, w) => s + (w.amount ?? 0), 0), [selectedWallets]);
  const totalSnipeSol = useMemo(() => snipeWallets.reduce((s, w) => s + (w.amount ?? 0), 0), [snipeWallets]);

  const JITO_TIERS: { id: JitoTier; title: string; description: string }[] = [
    { id: "normal", title: "Normal", description: "Cheapest default. Uses the documented 1000-lamport floor." },
    { id: "premium", title: "Premium", description: "Manual higher tip preset for busier launches." },
    { id: "whale", title: "Whale", description: "Highest preset for crowded launches." },
  ];

  const LANDING_PROFILES: { id: LandingProfile; title: string; description: string }[] = [
    { id: "balanced", title: "Balanced", description: "Cheap baseline without extra landing multiplier." },
    { id: "ultra_fast", title: "Ultra Fast", description: "Adds extra landing aggressiveness when you need it." },
  ];

  const handleContinue = () => {
    update({
      snipeDelayMode: delayMode, snipeDelayPreset: delayPreset, delayMin, delayMax,
      jitoTier, landingProfile, slippage, priorityFee, pumpFunCashback,
      antiSniperEnabled, antiSniperThreshold, antiSniperAction, monitoringMode, stopMode,
      smartSellEnabled, smartSellPercent, smartSellStopBelow, smartSellMinSol, smartSellMinMcap,
      autoTpEnabled, autoTpSellDevFirst, autoTpSellDevAfter, autoTpSellAllAfter, tpLevels,
      autoRetryCount,
    });
    next();
  };

  return (
    <div data-tag="token_launch.new.step4.launch_bundle_snipe" className="space-y-6">

      {/* ── Snipe Settings ── */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-white">Snipe Settings</h2>

        <div className="bg-bg-card/40 border border-bg-border rounded-xl p-4">
          <p className="text-sm text-white/60 leading-relaxed">
            Snipes use the same dynamic Jito tier and landing profile as the launch flow below. There is no separate raw tip override here anymore.
          </p>
        </div>

        {/* Snipe Delay */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-white" />
            <h3 className="text-sm font-semibold text-white">Snipe Delay</h3>
          </div>
          <p className="text-xs text-yellow-400 flex items-center gap-1.5">
            <Zap className="w-3 h-3" />
            In launch mode, own snipers now wait for the main launch wave, then fire after one random delay sampled from this range.
          </p>

          {/* Mode Tabs */}
          <div className="grid grid-cols-2 bg-bg-card/40 border border-bg-border rounded-lg p-1">
            {(["new_user", "advanced"] as DelayMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setDelayMode(mode)}
                className={["py-2 text-sm rounded-md transition", delayMode === mode ? "bg-bg-soft text-white border border-neon-green" : "text-white/50 hover:text-white"].join(" ")}
              >
                {mode === "new_user" ? "New User" : "Advanced"}
              </button>
            ))}
          </div>

          {/* Advanced range */}
          {delayMode === "advanced" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70">Delay range (random)</span>
                <span className="text-sm font-mono text-neon-green">{delayMin}ms - {delayMax}ms</span>
              </div>
              <div className="flex items-center gap-3">
                <input type="number" value={delayMin === 0 ? "" : delayMin} placeholder="0" onChange={(e) => setDelayMin(e.target.value === "" ? 0 : Math.min(Number(e.target.value), delayMax))} className="w-24 bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-neon-green/50 outline-none" />
                <span className="text-white/50 text-sm">to</span>
                <input type="number" value={delayMax === 0 ? "" : delayMax} placeholder="0" onChange={(e) => setDelayMax(e.target.value === "" ? 0 : Math.max(Number(e.target.value), delayMin))} className="w-24 bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-neon-green/50 outline-none" />
                <span className="text-white/50 text-sm">ms</span>
              </div>
              <div className="relative h-5 flex items-center">
                <div className="absolute w-full h-1.5 rounded-full bg-bg-border" />
                <div className="absolute h-1.5 rounded-full bg-neon-green" style={{ left: `${(delayMin / 10000) * 100}%`, right: `${100 - (delayMax / 10000) * 100}%` }} />
                <input type="range" min={0} max={10000} step={50} value={delayMin} onChange={(e) => setDelayMin(Math.min(Number(e.target.value), delayMax - 50))} className="absolute w-full h-1.5 opacity-0 cursor-pointer z-10" />
                <input type="range" min={0} max={10000} step={50} value={delayMax} onChange={(e) => setDelayMax(Math.max(Number(e.target.value), delayMin + 50))} className="absolute w-full h-1.5 opacity-0 cursor-pointer z-10" />
                <div className="absolute w-4 h-4 rounded-full bg-neon-green border-2 border-white shadow-md z-20 -translate-x-1/2" style={{ left: `${(delayMin / 10000) * 100}%` }} />
                <div className="absolute w-4 h-4 rounded-full bg-neon-green border-2 border-white shadow-md z-20 -translate-x-1/2" style={{ left: `${(delayMax / 10000) * 100}%` }} />
              </div>
              <p className="text-xs text-white/40">Applied as one random start delay before the sniper phase begins. 1000ms = 1 second.</p>
            </div>
          )}

          {/* New User presets */}
          {delayMode === "new_user" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {DELAY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => setDelayPreset(preset.id)}
                  className={["text-left p-4 rounded-xl border transition", delayPreset === preset.id ? "border-neon-green bg-neon-green/10" : "border-bg-border bg-bg-card/40 hover:border-white/20"].join(" ")}
                >
                  <p className={["text-sm font-semibold mb-1", delayPreset === preset.id ? "text-neon-green" : "text-white"].join(" ")}>{preset.title}</p>
                  <p className="text-xs text-white/50">{preset.description}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Bundle Settings ── */}
      <div className="space-y-4 pt-2 border-t border-white/10">
        <h2 className="text-base font-semibold text-white">Bundle Settings</h2>

        {/* Selected Buy Wallets */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Selected Buy Wallets</p>
              <p className="text-xs text-white/50 mt-0.5">Use the wallet checkboxes in Step 3 to choose which wallets participate in the bundle buy</p>
            </div>
            <span className="text-sm font-semibold text-neon-green">{selectedWallets.length} selected</span>
          </div>

          {/* 3-column stat cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="glass p-4 space-y-1">
              <p className="text-sm text-white/60">Total SOL to Buy</p>
              <p className="text-2xl font-bold text-white font-mono">{totalSol.toFixed(6)} SOL</p>
              <p className="text-xs text-white/40 mt-2">Derived from selected launch wallets</p>
            </div>
            <div className="glass p-4 space-y-1">
              <p className="text-sm text-white/60">Dev Buy Amount</p>
              <p className="text-2xl font-bold text-white font-mono">{devBuy.toFixed(6)} SOL</p>
              <p className="text-xs text-white/40 mt-2">Derived from the dev wallet amount</p>
            </div>
            <div className="glass p-4 space-y-1">
              <p className="text-sm text-white/60">Total SOL to Snipe</p>
              <p className="text-2xl font-bold text-white font-mono">{totalSnipeSol.toFixed(6)} SOL</p>
              <p className="text-xs text-white/40 mt-2">Sum of configured snipe amounts</p>
            </div>
          </div>

          {/* Per-wallet */}
          <div className="glass p-4 space-y-2">
            <p className="text-sm font-semibold text-white">Per-wallet launch amounts</p>
            <p className="text-xs text-white/50">Derived from selected launch wallets on Step 3. Edit wallet amounts <span className="text-neon-green">there</span> to change the total bundle buy.</p>
            {selectedWallets.length === 0 ? (
              <p className="text-xs text-white/30">No selected bundle wallets yet.</p>
            ) : (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {selectedWallets.map((w, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="font-mono text-white/50 truncate">{w.address}</span>
                    <span className="font-mono text-white ml-2">{w.amount.toFixed(4)} SOL</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Fund warning */}
          <div className="flex items-start gap-3 p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10">
            <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-yellow-400">Fund wallets before launch</p>
              <p className="text-xs text-yellow-400/70 mt-0.5">Go back to Step 3 and use "Fund" button to distribute SOL from your Phantom wallet to bundle wallets</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Execution Settings ── */}
      <div className="space-y-4 pt-2 border-t border-white/10">
        <h3 className="text-sm font-semibold text-white">Execution Settings</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <p className="text-sm font-medium text-white">Jito Tip Tier</p>
            <div className="space-y-2">
              {JITO_TIERS.map((tier) => (
                <button key={tier.id} onClick={() => setJitoTier(tier.id)} className={["text-left w-full p-3 rounded-xl border transition", jitoTier === tier.id ? "border-neon-green bg-neon-green/10" : "border-bg-border bg-bg-card/40 hover:border-white/20"].join(" ")}>
                  <p className={["text-sm font-semibold", jitoTier === tier.id ? "text-neon-green" : "text-white"].join(" ")}>{tier.title}</p>
                  <p className="text-xs text-white/50 mt-0.5">{tier.description}</p>
                </button>
              ))}
            </div>
            <p className="text-xs text-neon-green/70 leading-relaxed">Review still shows the backend-applied values, but the default launch preset here is now the cheapest valid one instead of an expensive hidden policy.</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-white">Landing Profile</p>
            <div className="space-y-2">
              {LANDING_PROFILES.map((profile) => (
                <button key={profile.id} onClick={() => setLandingProfile(profile.id)} className={["text-left w-full p-3 rounded-xl border transition", landingProfile === profile.id ? "border-neon-green bg-neon-green/10" : "border-bg-border bg-bg-card/40 hover:border-white/20"].join(" ")}>
                  <p className={["text-sm font-semibold", landingProfile === profile.id ? "text-neon-green" : "text-white"].join(" ")}>{profile.title}</p>
                  <p className="text-xs text-white/50 mt-0.5">{profile.description}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── General Settings ── */}
      <div className="space-y-4 pt-2 border-t border-white/10">
        <div>
          <h3 className="text-sm font-semibold text-white">General Settings</h3>
          <p className="text-xs text-white/40 mt-0.5">Launch uses its own fee controls now. Cheapest defaults start at protocol-valid minimums, and you can raise them here when you need faster landing.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="glass p-4 space-y-2">
            <p className="text-sm font-medium text-white">Slippage (%)</p>
            <input type="number" min={0} max={100} value={slippage} onChange={(e) => setSlippage(Math.min(100, Math.max(0, Number(e.target.value))))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-neon-green/50 outline-none" />
            <p className="text-xs text-white/40">Default 15%.</p>
          </div>
          <div className="glass p-4 space-y-2">
            <p className="text-sm font-medium text-white">Priority fee budget (SOL)</p>
            <input type="number" min={0} step={0.000001} value={priorityFee === 0 ? "" : priorityFee} placeholder="0" onChange={(e) => setPriorityFee(e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono focus:border-neon-green/50 outline-none" />
            <p className="text-xs text-white/40">Default 0.000000 SOL. Use 0 for the cheapest Jito bundle path.</p>
          </div>
        </div>
      </div>

      {/* ── Advanced Settings ── */}
      <div className="space-y-4 pt-2 border-t border-white/10">
        <h3 className="text-sm font-semibold text-white">Advanced Settings</h3>
        <div className="flex items-center justify-between px-4 py-3 rounded-xl border border-bg-border bg-bg-card/40">
          <span className="text-sm text-white">Pump.fun cashback</span>
          <button onClick={() => setPumpFunCashback(!pumpFunCashback)} className={["w-10 h-5 rounded-full relative transition", pumpFunCashback ? "bg-neon-green" : "bg-bg-border"].join(" ")}>
            <span className={["absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", pumpFunCashback ? "left-[22px]" : "left-0.5"].join(" ")} />
          </button>
        </div>
        <div className="grid grid-cols-4 bg-bg-card/40 border border-bg-border rounded-lg p-1">
          {(["anti_sniper", "smart_sell", "auto_tp", "retry"] as AdvancedTab[]).map((tab) => (
            <button key={tab} onClick={() => setAdvancedTab(tab)} className={["py-2 text-xs rounded-md transition", advancedTab === tab ? "bg-bg-soft text-white font-semibold" : "text-white/50 hover:text-white"].join(" ")}>
              {tab === "anti_sniper" ? "Anti Sniper" : tab === "smart_sell" ? "Smart Sell" : tab === "auto_tp" ? "Auto TP" : "Retry"}
            </button>
          ))}
        </div>

        {advancedTab === "anti_sniper" && (
          <div className="space-y-5">
            <div className="flex items-center justify-between py-1">
              <div className="flex items-start gap-2">
                <Shield className="w-4 h-4 text-neon-green mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white">Anti Sniper Status</p>
                  <p className="text-xs text-white/50">Auto sell if external snipers acquire too much supply</p>
                </div>
              </div>
              <button onClick={() => setAntiSniperEnabled(!antiSniperEnabled)} className={["w-10 h-5 rounded-full relative transition flex-shrink-0", antiSniperEnabled ? "bg-neon-green" : "bg-bg-border"].join(" ")}>
                <span className={["absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", antiSniperEnabled ? "left-[22px]" : "left-0.5"].join(" ")} />
              </button>
            </div>
            {antiSniperEnabled && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Threshold %</p>
                  <div className="relative flex items-center">
                    <input type="number" min={0} max={100} value={antiSniperThreshold} onChange={(e) => setAntiSniperThreshold(Math.min(100, Math.max(0, Number(e.target.value))))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono pr-8 focus:border-neon-green/50 outline-none" />
                    <span className="absolute right-3 text-sm text-white/40">%</span>
                  </div>
                  <p className="text-xs text-white/40">Sell if external snipers acquire this % of supply (0-100)</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Action</p>
                  <div className="grid grid-cols-3 gap-2">
                    {(["stop_buying", "sell_half", "sell_all"] as AntiSniperAction[]).map((a) => (
                      <button key={a} onClick={() => setAntiSniperAction(a)} className={["py-2.5 text-sm rounded-lg border font-medium transition", antiSniperAction === a ? "bg-neon-green text-bg border-neon-green" : "bg-transparent text-white/70 border-bg-border hover:border-white/30"].join(" ")}>
                        {a === "stop_buying" ? "Stop Buying" : a === "sell_half" ? "Sell Half" : "Sell All"}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-white/40 leading-relaxed">Uses the same pump.fun / on-chain trade feed as your activity list. When foreign BUY share crosses the threshold, Stop Buying logs only; Sell Half / Sell All run automatic sells from bundle wallets.</p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Monitoring Mode</p>
                  <div className="grid grid-cols-2 gap-2">
                    {(["sniper_based", "time_based"] as MonitoringMode[]).map((m) => (
                      <button key={m} onClick={() => setMonitoringMode(m)} className={["py-2.5 text-sm rounded-lg border font-medium transition", monitoringMode === m ? "bg-neon-green text-bg border-neon-green" : "bg-transparent text-white/70 border-bg-border hover:border-white/30"].join(" ")}>
                        {m === "sniper_based" ? "Sniper-Based" : "Time-Based"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Stop Mode</p>
                  <div className="grid grid-cols-2 gap-2">
                    {(["first_success", "last_success"] as StopMode[]).map((m) => (
                      <button key={m} onClick={() => setStopMode(m)} className={["py-2.5 text-sm rounded-lg border font-medium transition", stopMode === m ? "bg-neon-green text-bg border-neon-green" : "bg-transparent text-white/70 border-bg-border hover:border-white/30"].join(" ")}>
                        {m === "first_success" ? "First Success" : "Last Success"}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-white/40">Monitor until snipers complete (works with sniper wallets)</p>
                </div>
                <div className="border border-bg-border rounded-xl p-4">
                  <p className="text-sm font-semibold text-white mb-1">Automations</p>
                  <p className="text-xs text-white/50">Configure Volume/Bump/Sniper after launch from the bundle page.</p>
                </div>
              </div>
            )}
          </div>
        )}

        {advancedTab === "smart_sell" && (
          <div className="space-y-5">
            <div className="flex items-center justify-between py-1">
              <div className="flex items-start gap-2">
                <TrendingUp className="w-4 h-4 text-neon-green mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white">Smart Sell Status</p>
                  <p className="text-xs text-white/50">Auto sell on external buys</p>
                </div>
              </div>
              <button onClick={() => setSmartSellEnabled(!smartSellEnabled)} className={["w-10 h-5 rounded-full relative transition flex-shrink-0", smartSellEnabled ? "bg-neon-green" : "bg-bg-border"].join(" ")}>
                <span className={["absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", smartSellEnabled ? "left-[22px]" : "left-0.5"].join(" ")} />
              </button>
            </div>
            {smartSellEnabled && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Sell % on Buy</p>
                  <div className="relative flex items-center">
                    <input type="number" min={0} max={100} value={smartSellPercent} onChange={(e) => setSmartSellPercent(Math.min(100, Math.max(0, Number(e.target.value))))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono pr-8 focus:border-neon-green/50 outline-none" />
                    <span className="absolute right-3 text-sm text-white/40">%</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Stop If Holding Below</p>
                  <input type="number" min={0} value={smartSellStopBelow} onChange={(e) => setSmartSellStopBelow(Math.max(0, Number(e.target.value)))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono focus:border-neon-green/50 outline-none" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Min SOL to Activate</p>
                  <div className="relative flex items-center">
                    <input type="number" min={0} step={0.01} value={smartSellMinSol} onChange={(e) => setSmartSellMinSol(Math.max(0, Number(e.target.value)))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono pr-12 focus:border-neon-green/50 outline-none" />
                    <span className="absolute right-3 text-sm text-white/40">SOL</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">Min Market Cap to Activate</p>
                  <div className="relative flex items-center">
                    <input type="number" min={0} value={smartSellMinMcap} onChange={(e) => setSmartSellMinMcap(Math.max(0, Number(e.target.value)))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono pr-8 focus:border-neon-green/50 outline-none" />
                    <span className="absolute right-3 text-sm text-white/40">$</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {advancedTab === "auto_tp" && (
          <div className="space-y-5">
            <div className="flex items-center justify-between py-1">
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 text-neon-green mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white">AutoTP Status</p>
                  <p className="text-xs text-white/50">Auto take profit at targets</p>
                </div>
              </div>
              <button onClick={() => setAutoTpEnabled(!autoTpEnabled)} className={["w-10 h-5 rounded-full relative transition flex-shrink-0", autoTpEnabled ? "bg-neon-green" : "bg-bg-border"].join(" ")}>
                <span className={["absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", autoTpEnabled ? "left-[22px]" : "left-0.5"].join(" ")} />
              </button>
            </div>
            {autoTpEnabled && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-white">Sell Dev First</p>
                    <p className="text-xs text-neon-green/80">Prioritize creator wallet when selling</p>
                  </div>
                  <button onClick={() => setAutoTpSellDevFirst(!autoTpSellDevFirst)} className={["w-10 h-5 rounded-full relative transition flex-shrink-0", autoTpSellDevFirst ? "bg-neon-green" : "bg-bg-border"].join(" ")}>
                    <span className={["absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", autoTpSellDevFirst ? "left-[22px]" : "left-0.5"].join(" ")} />
                  </button>
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold text-white">Sell Dev After (ms)</p>
                  <input type="number" value={autoTpSellDevAfter} onChange={(e) => setAutoTpSellDevAfter(Number(e.target.value))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono focus:border-neon-green/50 outline-none" />
                  <p className="text-xs text-white/40">Auto-sell creator wallet after N milliseconds (-1 to disable)</p>
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold text-white">Sell All After (ms)</p>
                  <input type="number" value={autoTpSellAllAfter} onChange={(e) => setAutoTpSellAllAfter(Number(e.target.value))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono focus:border-neon-green/50 outline-none" />
                  <p className="text-xs text-white/40">Auto-sell all wallets after N milliseconds (-1 to disable)</p>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-white">TP Levels ({tpLevels.length}/3)</p>
                    {tpLevels.length < 3 && (
                      <button onClick={() => setTpLevels(p => [...p, { id: Date.now().toString(), triggerType: "mcap", triggerValue: 0, sellPercent: 100 }])} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-bg-border text-xs text-white/70 hover:border-white/30 hover:text-white transition">
                        + Add Level
                      </button>
                    )}
                  </div>
                  {tpLevels.map((level, idx) => (
                    <div key={level.id} className="border border-bg-border rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-white">TP Level {idx + 1}</p>
                        <button onClick={() => setTpLevels(p => p.filter(l => l.id !== level.id))} className="p-1 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400 transition">
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        <p className="text-xs text-white/60">Trigger Type</p>
                        <div className="grid grid-cols-3 gap-1.5">
                          {(["mcap", "profit", "roi"] as TpTriggerType[]).map((t) => (
                            <button key={t} onClick={() => setTpLevels(p => p.map(l => l.id === level.id ? { ...l, triggerType: t } : l))} className={["py-2 text-sm rounded-lg border font-medium transition", level.triggerType === t ? "bg-neon-green text-bg border-neon-green" : "bg-transparent text-white/70 border-bg-border hover:border-white/30"].join(" ")}>
                              {t === "mcap" ? "MCap" : t === "profit" ? "Profit" : "ROI"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <p className="text-xs text-white/60">{level.triggerType === "mcap" ? "Market Cap ($)" : level.triggerType === "profit" ? "Profit (SOL)" : "ROI (x)"}</p>
                        <div className="relative flex items-center">
                          <input type="number" value={level.triggerValue === 0 ? "" : level.triggerValue} placeholder="0" onChange={(e) => setTpLevels(p => p.map(l => l.id === level.id ? { ...l, triggerValue: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) } : l))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono pr-8 focus:border-neon-green/50 outline-none" />
                          <span className="absolute right-3 text-sm text-white/40">{level.triggerType === "mcap" ? "$" : level.triggerType === "profit" ? "SOL" : "x"}</span>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <p className="text-xs text-white/60">Sell %</p>
                        <div className="relative flex items-center">
                          <input type="number" value={level.sellPercent === 0 ? "" : level.sellPercent} placeholder="0" onChange={(e) => setTpLevels(p => p.map(l => l.id === level.id ? { ...l, sellPercent: e.target.value === "" ? 0 : Math.min(100, Math.max(0, Number(e.target.value))) } : l))} className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white font-mono pr-8 focus:border-neon-green/50 outline-none" />
                          <span className="absolute right-3 text-sm text-white/40">%</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {advancedTab === "retry" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-start gap-2">
                <RotateCcw className="w-4 h-4 text-neon-green mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-white">Auto Retry</p>
                  <p className="text-xs text-white/50">Retry on transaction failure</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setAutoRetryCount(c => Math.max(0, c - 1))} className="w-8 h-8 rounded-lg border border-bg-border bg-bg-card/40 text-white hover:border-white/30 transition flex items-center justify-center text-lg">−</button>
                <span className="w-10 text-center text-sm font-mono text-white">{autoRetryCount}</span>
                <button onClick={() => setAutoRetryCount(c => Math.min(10, c + 1))} className="w-8 h-8 rounded-lg border border-bg-border bg-bg-card/40 text-white hover:border-white/30 transition flex items-center justify-center text-lg">+</button>
              </div>
            </div>
            <p className="text-xs text-neon-green/80">Number of retry attempts (0-10). Set to 0 to disable.</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t border-white/10">
        <button type="button" onClick={prev} className="px-6 py-2 rounded-lg border border-bg-border text-white/70 hover:border-white/30 hover:text-white transition text-sm">Back</button>
        <button type="button" onClick={handleContinue} className="px-12 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition">Continue</button>
      </div>
    </div>
  );
}
