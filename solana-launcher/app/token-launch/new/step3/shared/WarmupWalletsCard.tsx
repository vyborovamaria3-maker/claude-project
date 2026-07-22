"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { AlertTriangle, Flame, X, Loader2, Check, RefreshCw, Wallet, Settings, Repeat, ArrowLeftRight, Lock } from "lucide-react";
import { useWallets } from "@/lib/useWallets";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { loadWallets, recoverSecret } from "@/lib/walletStore";
import bs58 from "bs58";

interface WarmupWalletsCardProps {
  onClose?: () => void;
  onFundRequest?: () => void;
}

interface WalletWithBalance {
  publicKey: string;
  balance: number;
  role: string;
  selected: boolean;
}

interface WarmupConfig {
  // Transaction settings
  txCountPerWallet: number;
  minAmount: number;
  maxAmount: number;
  delayBetweenTxs: number; // seconds
  
  // Warmup types
  enableSelfTransfer: boolean;
  enableSwap: boolean;
  enableStake: boolean;
  
  // Advanced
  simulateMode: boolean;
  priorityFee: number;
  randomizeOrder: boolean;
}

function getRpcUrl(): string {
  return (
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}

export default function WarmupWalletsCard({ onClose, onFundRequest }: WarmupWalletsCardProps) {
  const walletsMeta = useWallets();
  const [wallets, setWallets] = useState<WalletWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [warming, setWarming] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Configuration panel state
  const [showConfig, setShowConfig] = useState(true);
  const [config, setConfig] = useState<WarmupConfig>({
    txCountPerWallet: 3,
    minAmount: 0.0001,
    maxAmount: 0.001,
    delayBetweenTxs: 2,
    enableSelfTransfer: true,
    enableSwap: false,
    enableStake: false,
    simulateMode: true, // Default to simulation for safety
    priorityFee: 5000,
    randomizeOrder: true,
  });

  const emptyCount = useMemo(() => wallets.filter((w) => w.balance === 0).length, [wallets]);
  const selectedCount = useMemo(() => wallets.filter((w) => w.selected).length, [wallets]);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // Fetch real balances
  const checkBalances = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const conn = new Connection(getRpcUrl(), "confirmed");
      const withBalances = await Promise.all(
        walletsMeta.map(async (w) => {
          try {
            const balance = await conn.getBalance(new PublicKey(w.publicKey));
            return { ...w, balance: balance / 1e9 };
          } catch {
            return { ...w, balance: 0 };
          }
        })
      );
      setWallets(
        withBalances.map((w) => ({
          publicKey: w.publicKey,
          balance: w.balance,
          role: w.role,
          selected: w.balance > 0 && w.balance < 0.001, // Auto-select low balance wallets
        }))
      );
      addLog(`Checked ${withBalances.length} wallets, ${withBalances.filter((w) => w.balance === 0).length} empty`);
    } catch (e: any) {
      setError(e?.message || "Failed to check balances");
    } finally {
      setChecking(false);
      setLoading(false);
    }
  }, [walletsMeta, addLog]);

  useEffect(() => {
    checkBalances();
  }, [checkBalances]);

  const toggleSelect = (pubkey: string) => {
    setWallets((prev) =>
      prev.map((w) => (w.publicKey === pubkey ? { ...w, selected: !w.selected } : w))
    );
  };

  const selectAll = () => {
    setWallets((prev) => prev.map((w) => ({ ...w, selected: true })));
  };

  const selectLowBalance = () => {
    setWallets((prev) =>
      prev.map((w) => ({ ...w, selected: w.balance > 0 && w.balance < 0.01 }))
    );
  };

  const recoverWalletKeypair = async (publicKey: string): Promise<Keypair | null> => {
    const secret = await recoverSecret(publicKey);
    if (!secret) return null;
    try {
      return Keypair.fromSecretKey(bs58.decode(secret));
    } catch {
      return null;
    }
  };

  // Generate random amount within config range
  const getRandomAmount = (): number => {
    const min = config.minAmount * 1e9;
    const max = config.maxAmount * 1e9;
    const random = Math.random() * (max - min) + min;
    return Math.floor(random);
  };

  // Get random warmup type based on config
  const getRandomWarmupType = (): "selfTransfer" | "swap" | "stake" => {
    const types: ("selfTransfer" | "swap" | "stake")[] = [];
    if (config.enableSelfTransfer) types.push("selfTransfer");
    if (config.enableSwap) types.push("swap");
    if (config.enableStake) types.push("stake");
    
    if (types.length === 0) return "selfTransfer";
    return types[Math.floor(Math.random() * types.length)];
  };

  const performWarmup = async () => {
    const selected = wallets.filter((w) => w.selected);
    if (selected.length === 0) {
      setError("Select at least one wallet to warmup");
      return;
    }

    if (!config.enableSelfTransfer && !config.enableSwap && !config.enableStake) {
      setError("Выберите хотя бы один тип транзакции");
      return;
    }

    setWarming(true);
    setError(null);
    const totalTxs = selected.length * config.txCountPerWallet;
    setProgress({ current: 0, total: totalTxs });
    setLogs([]);
    
    addLog(`=== Настройки разогрева ===`);
    addLog(`Кошельков: ${selected.length}`);
    addLog(`Транзакций на кошелёк: ${config.txCountPerWallet}`);
    addLog(`Сумма: ${config.minAmount}-${config.maxAmount} SOL`);
    addLog(`Режим: ${config.simulateMode ? "СИМУЛЯЦИЯ" : "РЕАЛЬНЫЕ ТРАНЗАКЦИИ"}`);
    addLog(`Типы: ${config.enableSelfTransfer ? "Самоперевод " : ""}${config.enableSwap ? "Своп " : ""}${config.enableStake ? "Стейкинг" : ""}`);
    addLog(`Начинаем разогрев...`);

    const conn = new Connection(getRpcUrl(), "confirmed");
    let txCounter = 0;

    for (let i = 0; i < selected.length; i++) {
      const w = selected[i];

      if (w.balance === 0) {
        addLog(`[${i + 1}/${selected.length}] ${w.publicKey.slice(0, 8)}... пропущен (нет SOL)`);
        continue;
      }

      // Check if wallet has enough balance for all transactions
      const estimatedFees = config.txCountPerWallet * 0.00001; // ~0.00001 SOL per tx
      if (w.balance < estimatedFees) {
        addLog(`[${i + 1}/${selected.length}] ${w.publicKey.slice(0, 8)}... мало SOL для ${config.txCountPerWallet} транзакций`);
        continue;
      }

      try {
        const kp = await recoverWalletKeypair(w.publicKey);
        if (!kp) {
          addLog(`[${i + 1}/${selected.length}] ${w.publicKey.slice(0, 8)}... ошибка (нет доступа к ключу)`);
          continue;
        }

        addLog(`[${i + 1}/${selected.length}] Разогреваем ${w.publicKey.slice(0, 8)}...`);

        // Perform multiple transactions per wallet
        for (let txNum = 0; txNum < config.txCountPerWallet; txNum++) {
          txCounter++;
          setProgress({ current: txCounter, total: totalTxs });

          const warmupType = getRandomWarmupType();
          const amount = getRandomAmount();

          try {
            if (config.simulateMode) {
              // Simulation mode
              await new Promise(r => setTimeout(r, 500)); // Simulate delay
              addLog(`  [${txNum + 1}/${config.txCountPerWallet}] СИМУЛЯЦИЯ: ${warmupType} ${(amount / 1e9).toFixed(6)} SOL`);
              continue;
            }

            const { blockhash } = await conn.getLatestBlockhash();

            if (warmupType === "selfTransfer") {
              // Self-transfer
              const tx = new Transaction({ 
                feePayer: kp.publicKey, 
                recentBlockhash: blockhash 
              }).add(
                SystemProgram.transfer({
                  fromPubkey: kp.publicKey,
                  toPubkey: kp.publicKey,
                  lamports: amount,
                })
              );

              tx.sign(kp);
              const sig = await conn.sendRawTransaction(tx.serialize(), {
                maxRetries: 3,
                skipPreflight: false,
              });
              await conn.confirmTransaction(sig, "confirmed");
              addLog(`  [${txNum + 1}/${config.txCountPerWallet}] Самоперевод OK: ${sig.slice(0, 10)}...`);

            } else if (warmupType === "swap") {
              // Placeholder for swap - would need Jupiter integration
              addLog(`  [${txNum + 1}/${config.txCountPerWallet}] Своп (требует интеграции Jupiter)`);
              
            } else if (warmupType === "stake") {
              // Placeholder for stake - would need stake program integration
              addLog(`  [${txNum + 1}/${config.txCountPerWallet}] Стейкинг (требует интеграции)`);
            }

            // Delay between transactions
            if (txNum < config.txCountPerWallet - 1) {
              await new Promise(r => setTimeout(r, config.delayBetweenTxs * 1000));
            }

          } catch (txError: any) {
            addLog(`  [${txNum + 1}/${config.txCountPerWallet}] Ошибка: ${txError.message?.slice(0, 50) || "unknown"}`);
          }
        }

        addLog(`[${i + 1}/${selected.length}] ${w.publicKey.slice(0, 8)}... готово ✓`);

      } catch (e: any) {
        addLog(`[${i + 1}/${selected.length}] ${w.publicKey.slice(0, 8)}... ошибка: ${e?.message || "unknown"}`);
      }
    }

    addLog("=== Разогрев завершён! ===");
    setWarming(false);
    setProgress(null);
    
    // Refresh balances
    checkBalances();
  };

  // Insufficient balance modal (shown when wallets have 0 balance)
  if (emptyCount > 0 && !warming && !checking) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
        <div className="relative w-full max-w-md glass rounded-2xl p-6 space-y-5">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="mx-auto w-12 h-12 rounded-full bg-yellow-500/20 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-yellow-500" />
            </div>
            <h3 className="text-lg font-semibold text-white">Insufficient Balance</h3>
            <p className="text-sm text-white/60">
              {emptyCount} wallet{emptyCount > 1 ? "s" : ""} have no SOL balance.
            </p>
          </div>

          {/* Fund Required Box */}
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-yellow-500" />
              <span className="text-sm font-medium text-yellow-400">Fund Required</span>
            </div>
            <p className="text-xs text-white/60 leading-relaxed">
              Wallets need SOL to perform warmup transactions. Use the Fund button to distribute SOL to selected wallets first.
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-bg-border text-sm text-white/80 hover:bg-white/5 transition"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onClose?.();
                onFundRequest?.();
              }}
              className="flex-1 px-4 py-2.5 rounded-xl bg-neon-green text-black text-sm font-medium hover:bg-neon-green/90 transition flex items-center justify-center gap-2"
            >
              <Flame className="w-4 h-4" />
              Fund Wallets
            </button>
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-white/10 transition"
          >
            <X className="w-4 h-4 text-white/50" />
          </button>
        </div>
      </div>
    );
  }

  // Main warmup modal
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-xl glass rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Flame className="w-5 h-5 text-neon-green" />
            <h3 className="text-base font-semibold text-white">Wallet Warmup</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowConfig(!showConfig)}
              className={[
                "px-2 py-1 text-xs rounded-lg border transition",
                showConfig 
                  ? "border-neon-green/50 bg-neon-green/10 text-neon-green" 
                  : "border-bg-border text-white/60 hover:text-white"
              ].join(" ")}
            >
              Настройки
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition">
              <X className="w-4 h-4 text-white/50" />
            </button>
          </div>
        </div>

        {/* Configuration Panel */}
        {showConfig && (
          <div className="bg-bg-card/40 border border-bg-border rounded-xl p-4 space-y-4">
            <div className="flex items-center gap-2 text-xs text-white/40 uppercase tracking-wider">
              <Settings className="w-3.5 h-3.5" />
              Настройки разогрева
            </div>
            
            {/* Transaction Count */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/70">Количество транзакций на кошелёк</span>
                <span className="text-neon-green font-mono">{config.txCountPerWallet}</span>
              </div>
              <input
                type="range"
                min="1"
                max="10"
                value={config.txCountPerWallet}
                onChange={(e) => setConfig(c => ({ ...c, txCountPerWallet: parseInt(e.target.value) }))}
                className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-neon-green"
              />
            </div>

            {/* Amount Range */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] text-white/50 uppercase">Min SOL</label>
                <input
                  type="number"
                  step="0.0001"
                  min="0.000001"
                  max="0.1"
                  value={config.minAmount}
                  onChange={(e) => setConfig(c => ({ ...c, minAmount: parseFloat(e.target.value) || 0.0001 }))}
                  className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:border-neon-green/50 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] text-white/50 uppercase">Max SOL</label>
                <input
                  type="number"
                  step="0.0001"
                  min="0.000001"
                  max="0.1"
                  value={config.maxAmount}
                  onChange={(e) => setConfig(c => ({ ...c, maxAmount: parseFloat(e.target.value) || 0.001 }))}
                  className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:border-neon-green/50 outline-none"
                />
              </div>
            </div>

            {/* Delay Between Transactions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/70">Задержка между транзакциями</span>
                <span className="text-neon-green font-mono">{config.delayBetweenTxs}s</span>
              </div>
              <input
                type="range"
                min="1"
                max="60"
                value={config.delayBetweenTxs}
                onChange={(e) => setConfig(c => ({ ...c, delayBetweenTxs: parseInt(e.target.value) }))}
                className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-neon-green"
              />
            </div>

            {/* Warmup Types */}
            <div className="space-y-2">
              <span className="text-[10px] text-white/50 uppercase">Типы транзакций</span>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setConfig(c => ({ ...c, enableSelfTransfer: !c.enableSelfTransfer }))}
                  className={[
                    "px-3 py-1.5 text-xs rounded-lg border transition flex items-center gap-1.5",
                    config.enableSelfTransfer
                      ? "border-neon-green/50 bg-neon-green/10 text-neon-green"
                      : "border-bg-border text-white/50"
                  ].join(" ")}
                >
                  <Repeat className="w-3.5 h-3.5" />
                  Самоперевод
                </button>
                <button
                  onClick={() => setConfig(c => ({ ...c, enableSwap: !c.enableSwap }))}
                  className={[
                    "px-3 py-1.5 text-xs rounded-lg border transition flex items-center gap-1.5",
                    config.enableSwap
                      ? "border-neon-green/50 bg-neon-green/10 text-neon-green"
                      : "border-bg-border text-white/50"
                  ].join(" ")}
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                  Своп
                </button>
                <button
                  onClick={() => setConfig(c => ({ ...c, enableStake: !c.enableStake }))}
                  className={[
                    "px-3 py-1.5 text-xs rounded-lg border transition flex items-center gap-1.5",
                    config.enableStake
                      ? "border-neon-green/50 bg-neon-green/10 text-neon-green"
                      : "border-bg-border text-white/50"
                  ].join(" ")}
                >
                  <Lock className="w-3.5 h-3.5" />
                  Стейкинг
                </button>
              </div>
            </div>

            {/* Advanced Settings */}
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-bg-border">
              <div className="space-y-1">
                <label className="text-[10px] text-white/50 uppercase">Priority Fee (microlamports)</label>
                <input
                  type="number"
                  min="0"
                  max="1000000"
                  step="1000"
                  value={config.priorityFee}
                  onChange={(e) => setConfig(c => ({ ...c, priorityFee: parseInt(e.target.value) || 5000 }))}
                  className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:border-neon-green/50 outline-none"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setConfig(c => ({ ...c, simulateMode: !c.simulateMode }))}
                  className={[
                    "flex-1 px-3 py-1.5 text-xs rounded-lg border transition",
                    config.simulateMode
                      ? "border-yellow-500/50 bg-yellow-500/10 text-yellow-400"
                      : "border-red-500/50 bg-red-500/10 text-red-400"
                  ].join(" ")}
                >
                  {config.simulateMode ? "☑ Симуляция" : "☒ Реальные TX"}
                </button>
              </div>
            </div>

            {/* Preset Buttons */}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setConfig({
                  txCountPerWallet: 1,
                  minAmount: 0.000001,
                  maxAmount: 0.00001,
                  delayBetweenTxs: 1,
                  enableSelfTransfer: true,
                  enableSwap: false,
                  enableStake: false,
                  simulateMode: true,
                  priorityFee: 5000,
                  randomizeOrder: false,
                })}
                className="px-2 py-1 text-[10px] rounded border border-bg-border hover:border-white/20 text-white/50"
              >
                Лёгкий
              </button>
              <button
                onClick={() => setConfig({
                  txCountPerWallet: 5,
                  minAmount: 0.0001,
                  maxAmount: 0.001,
                  delayBetweenTxs: 5,
                  enableSelfTransfer: true,
                  enableSwap: true,
                  enableStake: false,
                  simulateMode: true,
                  priorityFee: 10000,
                  randomizeOrder: true,
                })}
                className="px-2 py-1 text-[10px] rounded border border-bg-border hover:border-white/20 text-white/50"
              >
                Средний
              </button>
              <button
                onClick={() => setConfig({
                  txCountPerWallet: 10,
                  minAmount: 0.001,
                  maxAmount: 0.01,
                  delayBetweenTxs: 10,
                  enableSelfTransfer: true,
                  enableSwap: true,
                  enableStake: true,
                  simulateMode: true,
                  priorityFee: 20000,
                  randomizeOrder: true,
                })}
                className="px-2 py-1 text-[10px] rounded border border-bg-border hover:border-white/20 text-white/50"
              >
                Агрессивный
              </button>
            </div>
          </div>
        )}

        <p className="text-xs text-white/50">
          Warmup отправляет транзакции для активации кошельков. Всегда начинайте с симуляции!
        </p>

        {/* Controls */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={selectAll}
            className="px-3 py-1.5 text-xs rounded-lg border border-bg-border hover:border-neon-green/50 text-white/80"
          >
            Select All
          </button>
          <button
            onClick={selectLowBalance}
            className="px-3 py-1.5 text-xs rounded-lg border border-bg-border hover:border-neon-green/50 text-white/80"
          >
            Select Low Balance
          </button>
          <button
            onClick={checkBalances}
            disabled={checking}
            className="px-3 py-1.5 text-xs rounded-lg border border-bg-border hover:border-neon-green/50 text-white/80 flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} />
            Refresh Balances
          </button>
        </div>

        {/* Wallet List */}
        <div className="flex-1 overflow-y-auto space-y-1 min-h-[150px] max-h-[300px]">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-white/50 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading wallets...
            </div>
          ) : wallets.length === 0 ? (
            <p className="text-sm text-white/50 text-center py-8">No wallets found</p>
          ) : (
            wallets.map((w) => (
              <div
                key={w.publicKey}
                onClick={() => !warming && toggleSelect(w.publicKey)}
                className={[
                  "flex items-center gap-3 p-3 rounded-lg border transition cursor-pointer",
                  w.selected
                    ? "border-neon-green/50 bg-neon-green/10"
                    : "border-bg-border bg-bg-card/40 hover:border-white/20",
                  warming && "pointer-events-none opacity-70",
                  w.balance === 0 && "opacity-50",
                ].join(" ")}
              >
                <div
                  className={[
                    "w-4 h-4 rounded border flex items-center justify-center transition",
                    w.selected ? "bg-neon-green border-neon-green" : "border-white/30",
                  ].join(" ")}
                >
                  {w.selected && <Check className="w-3 h-3 text-black" />}
                </div>

                <Wallet className="w-4 h-4 text-white/50" />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-white truncate">{w.publicKey}</p>
                  <p className="text-[10px] text-white/40 uppercase">{w.role}</p>
                </div>

                <div className="text-right">
                  <p className={["text-sm font-mono", w.balance === 0 ? "text-red-400" : "text-neon-green"].join(" ")}>
                    {w.balance.toFixed(6)} SOL
                  </p>
                  {w.balance === 0 && <p className="text-[10px] text-red-400/70">Needs funding</p>}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Progress */}
        {progress && (
          <div className="bg-bg-card/60 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-white/60">Progress</span>
              <span className="text-neon-green">{progress.current} / {progress.total}</span>
            </div>
            <div className="h-1.5 bg-bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-neon-green transition-all"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Logs */}
        {logs.length > 0 && (
          <div className="bg-black/40 rounded-lg p-3 font-mono text-[10px] space-y-1 max-h-[120px] overflow-y-auto">
            {logs.map((log, i) => (
              <p key={i} className={log.includes("failed") ? "text-red-400" : "text-white/70"}>
                {log}
              </p>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={warming}
            className="px-4 py-2.5 rounded-xl border border-bg-border text-sm text-white/80 hover:bg-white/5 transition disabled:opacity-50"
          >
            Close
          </button>
          <button
            onClick={performWarmup}
            disabled={warming || selectedCount === 0}
            className="flex-1 px-4 py-2.5 rounded-xl bg-neon-green text-black text-sm font-medium hover:bg-neon-green/90 transition flex flex-col items-center justify-center disabled:opacity-50 leading-tight"
          >
            {warming ? (
              <>
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Разогрев...
                </span>
              </>
            ) : (
              <>
                <span className="flex items-center gap-2">
                  <Flame className="w-4 h-4" />
                  Разогреть {selectedCount > 0 && `(${selectedCount})`}
                </span>
                <span className="text-[10px] opacity-70 mt-0.5">
                  {config.simulateMode ? "Симуляция" : "Реальный"} • {config.txCountPerWallet} tx × {selectedCount || 0} = {(config.txCountPerWallet * (selectedCount || 0))} всего
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
