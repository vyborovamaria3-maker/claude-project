"use client";

import { useState, useMemo } from "react";
import { X, Send, Wallet, ShieldCheck, Loader2 } from "lucide-react";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { loadWallets, recoverSecret, importWallet } from "@/lib/walletStore";

const MASTER_WALLET_KEY = "solana-launcher.master-wallet";

interface Recipient {
  publicKey: PublicKey;
  lamports: number;
}

function getRpcUrl(): string {
  return (
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://api.mainnet-beta.solana.com"
  );
}

function getOrCreateMasterPubkey(): string {
  if (typeof window === "undefined") return "";
  let pk = localStorage.getItem(MASTER_WALLET_KEY);
  return pk || "";
}

async function ensureMasterWallet(): Promise<Keypair> {
  let pkStr = getOrCreateMasterPubkey();
  if (pkStr) {
    const secret = await recoverSecret(pkStr);
    if (secret) {
      return Keypair.fromSecretKey(bs58.decode(secret));
    }
  }
  // Create new master wallet
  const kp = Keypair.generate();
  await importWallet(kp.publicKey.toBase58(), kp.secretKey, "dev");
  localStorage.setItem(MASTER_WALLET_KEY, kp.publicKey.toBase58());
  return kp;
}

async function getPhantom(): Promise<any> {
  const w = window as any;
  const provider = w?.phantom?.solana || w?.solana;
  if (!provider?.isPhantom) {
    throw new Error("Phantom wallet not detected. Install Phantom extension.");
  }
  if (!provider.publicKey) {
    await provider.connect();
  }
  return provider;
}

async function runDirectFromPhantom({
  recipients,
  onStatus,
}: {
  recipients: Recipient[];
  onStatus: (s: string) => void;
}) {
  onStatus("Connecting to Phantom...");
  const phantom = await getPhantom();
  const conn = new Connection(getRpcUrl(), "confirmed");

  onStatus(`Building transaction for ${recipients.length} transfers...`);
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: phantom.publicKey, recentBlockhash: blockhash });
  for (const r of recipients) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: phantom.publicKey,
        toPubkey: r.publicKey,
        lamports: r.lamports,
      })
    );
  }

  onStatus("Awaiting Phantom signature...");
  const { signature } = await phantom.signAndSendTransaction(tx);
  onStatus(`Confirming ${signature.slice(0, 8)}...`);
  await conn.confirmTransaction(signature, "confirmed");
}

async function runConfidentialFromUI({
  recipients,
  totalLamports,
  onStatus,
}: {
  recipients: Recipient[];
  totalLamports: number;
  onStatus: (s: string) => void;
}) {
  onStatus("Preparing master wallet...");
  const master = await ensureMasterWallet();

  onStatus("Connecting to Phantom...");
  const phantom = await getPhantom();
  const conn = new Connection(getRpcUrl(), "confirmed");

  // 1. Phantom -> master deposit
  onStatus(`Depositing ${(totalLamports / 1e9).toFixed(4)} SOL to master...`);
  const { blockhash } = await conn.getLatestBlockhash();
  const depositTx = new Transaction({ feePayer: phantom.publicKey, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({
      fromPubkey: phantom.publicKey,
      toPubkey: master.publicKey,
      lamports: totalLamports + 2_000_000, // +0.002 SOL buffer for fees & rent
    })
  );
  const { signature: depSig } = await phantom.signAndSendTransaction(depositTx);
  await conn.confirmTransaction(depSig, "confirmed");

  // 2. Compress + compressed transfers via Light Protocol (lazy import)
  onStatus("Loading Light Protocol SDK...");
  const { runConfidentialFund } = await import("@/lib/confidentialFund");
  onStatus("Compressing on master (ZK Compression)...");
  await runConfidentialFund({
    masterKeypair: master,
    recipients,
    totalLamports,
    onProgress: (step) => {
      if (step.kind === "compress") {
        onStatus(`Compressing ${(step.lamports / 1e9).toFixed(4)} SOL...`);
      } else if (step.kind === "transfer") {
        onStatus(
          `Confidential transfer ${step.index}/${step.total} → ${step.recipient.slice(0, 6)}...`
        );
      }
    },
  });
}

// ============= SIMULATION (dry-run, no real on-chain tx) =============

function fakeSig(): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 88; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function simulateDirect({
  recipients,
  onLog,
}: {
  recipients: Recipient[];
  onLog: (line: string) => void;
}) {
  onLog("[sim] Connecting to Phantom...");
  await sleep(400);
  onLog(`[sim] Building tx with ${recipients.length} transfers...`);
  await sleep(600);
  onLog("[sim] Awaiting Phantom signature...");
  await sleep(800);
  const sig = fakeSig();
  onLog(`[sim] Broadcast tx: ${sig.slice(0, 16)}...`);
  await sleep(700);
  onLog(`[sim] ✓ Confirmed. ${recipients.length} wallets funded.`);
}

async function simulateConfidential({
  recipients,
  totalLamports,
  onLog,
}: {
  recipients: Recipient[];
  totalLamports: number;
  onLog: (line: string) => void;
}) {
  onLog("[sim] Preparing master wallet...");
  await sleep(400);
  const masterMock = fakeSig().slice(0, 44);
  onLog(`[sim] Master: ${masterMock.slice(0, 8)}...${masterMock.slice(-6)}`);
  await sleep(300);

  onLog("[sim] Connecting to Phantom...");
  await sleep(400);
  onLog(
    `[sim] Phantom → master deposit: ${(totalLamports / 1e9).toFixed(4)} SOL`
  );
  await sleep(700);
  onLog(`[sim] Deposit confirmed: ${fakeSig().slice(0, 16)}...`);
  await sleep(400);

  onLog(`[sim] 🛡 Compressing ${(totalLamports / 1e9).toFixed(4)} SOL via Light Protocol...`);
  await sleep(900);
  onLog(`[sim] ZK proof generated. Compressed account created.`);
  await sleep(400);

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    onLog(
      `[sim] Confidential transfer ${i + 1}/${recipients.length} → ${r.publicKey
        .toBase58()
        .slice(0, 6)}...${r.publicKey.toBase58().slice(-4)} (${(
        r.lamports / 1e9
      ).toFixed(4)} SOL)`
    );
    await sleep(450);
  }
  onLog(`[sim] ✓ All confidential transfers complete. On-chain link broken.`);
}

// ======================================================================

type FundMode = "auto" | "manual" | "equal" | "range";

interface FundWalletsCardProps {
  onClose: () => void;
  defaultRole?: string;
}

// data-tag: step3.fund.card
export default function FundWalletsCard({ onClose }: FundWalletsCardProps) {
  const wallets = useMemo(() => loadWallets(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set(wallets.map((w) => w.publicKey)));
  const [mode, setMode] = useState<FundMode>("auto");
  const [total, setTotal] = useState("0.0093");
  const [minPct, setMinPct] = useState(80);
  const [maxPct, setMaxPct] = useState(120);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [confidential, setConfidential] = useState(false);
  const [simulate, setSimulate] = useState(true);
  const [funding, setFunding] = useState(false);
  const [fundStatus, setFundStatus] = useState<string | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const [fundLog, setFundLog] = useState<string[]>([]);

  const selectedCount = selected.size;
  const totalNum = parseFloat(total) || 0;
  const perWallet = selectedCount > 0 ? totalNum / selectedCount : 0;
  const estimatedFee = 0.000005 * selectedCount; // Base tx fee

  // Range mode: distribute total with random weights between min/max %
  const selectedWallets = wallets.filter((w) => selected.has(w.publicKey));
  const rangeAmounts = useMemo(() => {
    if (mode !== "range" || selectedCount === 0) return new Map<string, number>();
    // Deterministic-ish PRNG seeded with shuffleSeed
    let seed = shuffleSeed + 1;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const baseShare = totalNum / selectedCount;
    const weights = selectedWallets.map(() => {
      const pct = minPct + rand() * (maxPct - minPct);
      return pct / 100;
    });
    const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
    const map = new Map<string, number>();
    selectedWallets.forEach((w, i) => {
      map.set(w.publicKey, baseShare * selectedCount * (weights[i] / weightSum));
    });
    return map;
  }, [mode, selectedCount, totalNum, minPct, maxPct, shuffleSeed, selectedWallets]);

  const toggleAll = () => {
    setSelected(selectedCount === wallets.length ? new Set() : new Set(wallets.map((w) => w.publicKey)));
  };

  const toggleWallet = (pk: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });
  };

  return (
    <div
      data-tag="step3.fund.card"
      className="rounded-xl border border-bg-border bg-bg-card/80 p-5 space-y-4"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="w-5 h-5 text-white/70" />
          <div className="text-white font-semibold">Fund Wallets</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-white/40 hover:text-white transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="text-sm text-white/50">
        Auto: equal split or range spread from a total; Manual: per-wallet amounts.
      </p>

      {/* Fund Wallets Section */}
      <div className="rounded-lg border border-bg-border bg-bg-soft/30 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-white font-medium">Fund Wallets</div>
          <div className="text-sm text-white/50">
            {selectedCount} selected · {selectedCount} receive from Phantom
          </div>
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-2">
          <ModeTab active={mode === "auto"} onClick={() => setMode("auto")}>
            Auto
          </ModeTab>
          <ModeTab active={mode === "manual"} onClick={() => setMode("manual")}>
            Manual
          </ModeTab>
          <span className="text-white/30 mx-1">·</span>
          <ModeTab active={mode === "equal"} onClick={() => setMode("equal")}>
            Equal
          </ModeTab>
          <ModeTab active={mode === "range"} onClick={() => setMode("range")}>
            Range
          </ModeTab>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={toggleAll}
              className="text-sm text-white/70 hover:text-white transition"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-sm text-white/70 hover:text-white transition"
            >
              Deselect All
            </button>
          </div>
        </div>

        {/* Total input */}
        <div>
          <div className="flex items-center justify-between text-xs text-white/50 mb-1.5">
            <span>Total SOL to distribute</span>
            <span className="text-neon-green">Max: {total} SOL</span>
          </div>
          <input
            type="text"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            className="w-full bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-neon-green/50"
          />
        </div>

        {/* Per wallet info (Auto / Equal) */}
        {(mode === "auto" || mode === "equal") && (
          <div className="text-sm text-white/50">
            ~{perWallet.toFixed(4)} SOL per wallet ({selectedCount} receiving)
          </div>
        )}

        {/* Range mode: sliders + wallet amounts */}
        {mode === "range" && (
          <div className="grid grid-cols-[200px_1fr] gap-4">
            {/* Sliders */}
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs text-white/60 mb-1.5">
                  <span>Min %</span>
                  <span className="text-white/80 font-mono">{minPct}</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={maxPct - 5}
                  step={1}
                  value={minPct}
                  onChange={(e) => setMinPct(Number(e.target.value))}
                  className="w-full accent-neon-green"
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-xs text-white/60 mb-1.5">
                  <span>Max %</span>
                  <span className="text-white/80 font-mono">{maxPct}</span>
                </div>
                <input
                  type="range"
                  min={minPct + 5}
                  max={300}
                  step={1}
                  value={maxPct}
                  onChange={(e) => setMaxPct(Number(e.target.value))}
                  className="w-full accent-neon-green"
                />
              </div>
              <button
                type="button"
                data-tag="step3.fund.range.reshuffle"
                onClick={() => setShuffleSeed((s) => s + 1)}
                className="w-full px-3 py-1.5 rounded-md border border-bg-border bg-bg-soft/60 text-xs text-white/80 hover:border-white/30 hover:text-white transition"
              >
                Reshuffle
              </button>
            </div>

            {/* Wallet amount list */}
            <div className="space-y-1 max-h-44 overflow-y-auto">
              {selectedWallets.length === 0 ? (
                <div className="text-xs text-white/40 py-3 text-center">
                  No wallets selected
                </div>
              ) : (
                selectedWallets.map((w) => (
                  <div
                    key={w.publicKey}
                    className="flex items-center justify-between rounded-md border border-bg-border bg-bg-soft/40 px-3 py-1.5"
                  >
                    <span className="text-xs font-mono text-white/70">
                      {w.publicKey.slice(0, 6)}...{w.publicKey.slice(-6)}
                    </span>
                    <span className="text-xs font-mono text-white/85">
                      {(rangeAmounts.get(w.publicKey) || 0).toFixed(4)} SOL
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Estimated Fees */}
        <div className="rounded-lg border border-bg-border bg-bg-card/50 p-3 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-white/60">Estimated Fees</span>
            <span className="text-white/80">~{estimatedFee.toFixed(6)} SOL</span>
          </div>
          <div className="flex items-center justify-between text-xs text-white/40">
            <span>Base tx fee ({selectedCount} wallets)</span>
            <span>~{estimatedFee.toFixed(6)} SOL</span>
          </div>
        </div>

        {/* Wallet list in Manual mode */}
        {mode === "manual" && (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {wallets.map((w) => {
              const isSelected = selected.has(w.publicKey);
              return (
                <label
                  key={w.publicKey}
                  className="flex items-center gap-3 rounded-lg border border-bg-border bg-bg-soft/40 px-3 py-2 cursor-pointer hover:border-white/20 transition"
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleWallet(w.publicKey)}
                    className="w-4 h-4 accent-neon-green shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono text-white/80 truncate">
                      {w.publicKey.slice(0, 6)}...{w.publicKey.slice(-6)}
                    </div>
                    <div className="text-xs text-white/40">
                      Balance: {w.balance.toFixed(4)} SOL
                    </div>
                  </div>
                  <input
                    type="text"
                    placeholder="0.00"
                    disabled={!isSelected}
                    className="w-24 bg-bg-soft/60 border border-bg-border rounded-md px-2 py-1 text-sm text-right focus:outline-none focus:border-neon-green/50 disabled:opacity-40"
                  />
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Simulate toggle */}
      <label
        data-tag="step3.fund.simulate_toggle"
        className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 cursor-pointer hover:border-amber-500/50 transition"
      >
        <input
          type="checkbox"
          checked={simulate}
          onChange={(e) => setSimulate(e.target.checked)}
          className="w-4 h-4 mt-0.5 accent-amber-500 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-amber-300">
            Simulate (dry-run, no real transactions)
          </div>
          <p className="text-xs text-white/50 mt-1 leading-snug">
            Walks through the full UI flow with mock signatures and delays. No SOL is moved
            and Phantom is not contacted. Useful for testing before getting devnet SOL.
          </p>
        </div>
      </label>

      {/* Confidential mode toggle */}
      <label
        data-tag="step3.fund.confidential_toggle"
        className="flex items-start gap-3 rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 cursor-pointer hover:border-purple-500/50 transition"
      >
        <input
          type="checkbox"
          checked={confidential}
          onChange={(e) => setConfidential(e.target.checked)}
          className="w-4 h-4 mt-0.5 accent-purple-500 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-purple-300">
            <ShieldCheck className="w-4 h-4" />
            Confidential transfer (Light Protocol)
          </div>
          <p className="text-xs text-white/50 mt-1 leading-snug">
            Routes funds via a master wallet using ZK Compression. Hides direct on-chain link
            between Phantom and recipients. Requires <code className="text-purple-300">NEXT_PUBLIC_HELIUS_RPC_URL</code> env var.
          </p>
        </div>
      </label>

      {/* Status / error banners */}
      {fundStatus && (
        <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-3 text-sm text-cyan-200 flex items-center gap-2">
          {funding && <Loader2 className="w-4 h-4 animate-spin" />}
          {fundStatus}
        </div>
      )}
      {fundError && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {fundError}
        </div>
      )}

      {/* Log panel */}
      {fundLog.length > 0 && (
        <div
          data-tag="step3.fund.log"
          className="rounded-lg border border-bg-border bg-black/40 p-3 max-h-40 overflow-y-auto font-mono text-xs space-y-1"
        >
          {fundLog.map((line, i) => (
            <div
              key={i}
              className={
                line.includes("✓")
                  ? "text-neon-green"
                  : line.includes("🛡")
                  ? "text-purple-300"
                  : "text-white/60"
              }
            >
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          disabled={funding}
          className="flex-1 px-4 py-2.5 rounded-lg border border-bg-border bg-bg-soft/40 text-sm text-white/80 hover:border-white/30 hover:text-white disabled:opacity-50 transition"
        >
          Close
        </button>
        <button
          type="button"
          data-tag="step3.fund.submit"
          disabled={selectedCount === 0 || funding || totalNum <= 0}
          onClick={async () => {
            setFundError(null);
            setFundStatus(null);
            setFundLog([]);
            setFunding(true);
            const log = (line: string) => {
              setFundStatus(line);
              setFundLog((prev) => [...prev, line]);
            };
            try {
              const recipients: Recipient[] = selectedWallets.map((w) => ({
                publicKey: new PublicKey(w.publicKey),
                lamports: Math.floor(
                  (mode === "range"
                    ? rangeAmounts.get(w.publicKey) || 0
                    : perWallet) * 1_000_000_000
                ),
              }));
              if (simulate) {
                if (confidential) {
                  await simulateConfidential({
                    recipients,
                    totalLamports: Math.floor(totalNum * 1_000_000_000),
                    onLog: log,
                  });
                } else {
                  await simulateDirect({ recipients, onLog: log });
                }
              } else if (confidential) {
                await runConfidentialFromUI({
                  recipients,
                  totalLamports: Math.floor(totalNum * 1_000_000_000),
                  onStatus: log,
                });
                log("Confidential funding complete.");
              } else {
                await runDirectFromPhantom({ recipients, onStatus: log });
                log("Funding complete.");
              }
            } catch (err: any) {
              setFundError(err?.message || "Funding failed");
              setFundStatus(null);
            } finally {
              setFunding(false);
            }
          }}
          className={[
            "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed",
            confidential
              ? "bg-purple-500 text-white hover:shadow-[0_0_20px_rgba(168,85,247,0.5)]"
              : "bg-neon-green text-bg hover:shadow-neon-green",
          ].join(" ")}
        >
          {funding ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : confidential ? (
            <ShieldCheck className="w-4 h-4" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          <span>
            {simulate ? "Simulate " : ""}
            {confidential ? "Confidential Fund" : "Fund from Phantom"}
          </span>
        </button>
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3 py-1.5 rounded-lg text-sm font-medium transition",
        active
          ? "bg-neon-green text-bg"
          : "bg-bg-card/40 text-white/60 hover:text-white hover:bg-bg-card/60",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
