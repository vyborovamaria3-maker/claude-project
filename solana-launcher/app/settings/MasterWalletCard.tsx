"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Keypair, Connection, PublicKey,
  SystemProgram, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  Copy, Check, Wallet, RefreshCw,
  ArrowDownToLine, ArrowUpFromLine, X, Loader2,
} from "lucide-react";
import type { PhantomInjectedProvider } from "@/types/solana-wallet";

declare global {
  interface Window {
    solana?: PhantomInjectedProvider;
  }
}

const MASTER_WALLET_KEY = "solana-launcher.master-wallet";
const MASTER_SECRET_KEY  = "solana-launcher.master-secret";

function getRpc() {
  return process.env.NEXT_PUBLIC_HELIUS_RPC_URL
    || process.env.NEXT_PUBLIC_RPC_URL
    || "https://api.mainnet-beta.solana.com";
}

function getMasterKeypair(): Keypair | null {
  try {
    const sk = sessionStorage.getItem(MASTER_SECRET_KEY);
    if (!sk) return null;
    return Keypair.fromSecretKey(Buffer.from(sk, "base64"));
  } catch { return null; }
}

function persistMasterSecret(secretKeyBase64: string) {
  sessionStorage.setItem(MASTER_SECRET_KEY, secretKeyBase64);
  localStorage.removeItem(MASTER_SECRET_KEY);
}

function migrateLegacySecret() {
  try {
    const legacy = localStorage.getItem(MASTER_SECRET_KEY);
    if (legacy && !sessionStorage.getItem(MASTER_SECRET_KEY)) {
      persistMasterSecret(legacy);
    }
  } catch {
    // Ignore storage migration failures; wallet generation can still continue.
  }
}

async function connectPhantom(): Promise<PublicKey> {
  if (!window.solana?.isPhantom) throw new Error("Phantom не установлен");
  const { publicKey } = await window.solana.connect();
  return publicKey;
}

type Panel = "none" | "deposit" | "withdraw";

export default function MasterWalletCard() {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [copiedPub, setCopiedPub] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [panel, setPanel] = useState<Panel>("none");

  const [depositAmt, setDepositAmt] = useState("");
  const [depositing, setDepositing] = useState(false);
  const [depositErr, setDepositErr] = useState<string | null>(null);
  const [depositOk, setDepositOk] = useState<string | null>(null);

  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawErr, setWithdrawErr] = useState<string | null>(null);
  const [withdrawOk, setWithdrawOk] = useState<string | null>(null);

  const fetchBalance = useCallback(async (pk: string) => {
    setBalanceLoading(true);
    try {
      const conn = new Connection(getRpc(), "confirmed");
      const lamports = await conn.getBalance(new PublicKey(pk));
      setBalance(lamports / LAMPORTS_PER_SOL);
    } catch {
      setBalance(null);
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    migrateLegacySecret();
    const pk = localStorage.getItem(MASTER_WALLET_KEY);
    if (pk) { setPubkey(pk); fetchBalance(pk); }
  }, [fetchBalance]);

  const generate = () => {
    const kp = Keypair.generate();
    const pk = kp.publicKey.toBase58();
    const sk = Buffer.from(kp.secretKey).toString("base64");
    localStorage.setItem(MASTER_WALLET_KEY, pk);
    persistMasterSecret(sk);
    setPubkey(pk);
    setBalance(null);
    setConfirming(false);
    setPanel("none");
  };

  const copyPub = () => {
    if (!pubkey) return;
    navigator.clipboard.writeText(pubkey);
    setCopiedPub(true);
    setTimeout(() => setCopiedPub(false), 1500);
  };

  const togglePanel = (p: Panel) => {
    setPanel(prev => prev === p ? "none" : p);
    setDepositErr(null); setDepositOk(null);
    setWithdrawErr(null); setWithdrawOk(null);
  };

  const doDeposit = async () => {
    const amtSol = parseFloat(depositAmt);
    if (isNaN(amtSol) || amtSol <= 0 || !pubkey) { setDepositErr("Введи корректную сумму."); return; }
    setDepositing(true); setDepositErr(null); setDepositOk(null);
    try {
      const phantomPk = await connectPhantom();
      const conn = new Connection(getRpc(), "confirmed");
      const lamports = Math.floor(amtSol * LAMPORTS_PER_SOL);
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: phantomPk, toPubkey: new PublicKey(pubkey), lamports })
      );
      tx.feePayer = phantomPk;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const signed = await window.solana!.signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      setDepositOk(sig);
      setDepositAmt("");
      fetchBalance(pubkey);
    } catch (e: any) {
      setDepositErr(e?.message || "Ошибка");
    } finally {
      setDepositing(false);
    }
  };

  const doWithdraw = async () => {
    const amtSol = parseFloat(withdrawAmt);
    if (isNaN(amtSol) || amtSol <= 0) { setWithdrawErr("Введи корректную сумму."); return; }
    setWithdrawing(true); setWithdrawErr(null); setWithdrawOk(null);
    try {
      const phantomPk = await connectPhantom();
      const master = getMasterKeypair();
      if (!master) throw new Error("Мастер-ключ не найден в браузере. Пересоздай кошелёк.");
      const conn = new Connection(getRpc(), "confirmed");
      const lamports = Math.floor(amtSol * LAMPORTS_PER_SOL);
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: master.publicKey, toPubkey: phantomPk, lamports })
      );
      tx.feePayer = master.publicKey;
      const { blockhash } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.sign(master);
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      setWithdrawOk(sig);
      setWithdrawAmt("");
      if (pubkey) fetchBalance(pubkey);
    } catch (e: any) {
      setWithdrawErr(e?.message || "Ошибка");
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div className="surface-panel p-5 md:p-6 space-y-4 w-full" data-tag="settings.master_wallet">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Wallet className="w-4 h-4 text-[color:var(--theme-primary)]" />
        <h2 className="text-sm font-semibold text-white">Master Wallet</h2>
        {pubkey && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs font-mono text-[color:var(--theme-primary)]">
              {balance === null ? "—" : `${balance.toFixed(4)} SOL`}
            </span>
            <button type="button" onClick={() => pubkey && fetchBalance(pubkey)} disabled={balanceLoading}
              className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition disabled:opacity-40">
              <RefreshCw className={`w-3.5 h-3.5 ${balanceLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
        )}
      </div>

      {!pubkey ? (
        <div className="space-y-3">
          <p className="text-xs text-white/50">Master wallet не создан. Нажмите кнопку чтобы сгенерировать.</p>
          <button type="button" onClick={generate}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)] border border-[color-mix(in_srgb,var(--theme-primary)_40%,transparent)] text-[color:var(--theme-primary)] text-sm font-semibold hover:bg-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] transition">
            <RefreshCw className="w-4 h-4" /> Generate Wallet
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Public key */}
          <div>
            <label className="text-xs uppercase tracking-widest text-white/50">Public Key</label>
            <div className="mt-1.5 flex items-center gap-2">
              <p className="flex-1 font-mono text-xs text-white bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2.5 truncate">{pubkey}</p>
              <button type="button" onClick={copyPub}
                className="shrink-0 p-2.5 rounded-lg bg-bg-soft/60 border border-bg-border hover:border-[color-mix(in_srgb,var(--theme-primary)_50%,transparent)] transition" title="Copy">
                {copiedPub ? <Check className="w-4 h-4 text-[color:var(--theme-primary)]" /> : <Copy className="w-4 h-4 text-white/60" />}
              </button>
            </div>
          </div>

          {/* Deposit / Withdraw buttons */}
          <div className="flex gap-2">
            <button type="button" onClick={() => togglePanel("deposit")}
              className={["flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-semibold transition",
                panel === "deposit" ? "border-[color-mix(in_srgb,var(--theme-primary)_50%,transparent)] bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)] text-[color:var(--theme-primary)]" : "border-bg-border bg-bg-soft/40 text-white/70 hover:border-white/20 hover:text-white"
              ].join(" ")}>
              <ArrowDownToLine className="w-4 h-4" /> Deposit
            </button>
            <button type="button" onClick={() => togglePanel("withdraw")}
              className={["flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-semibold transition",
                panel === "withdraw" ? "border-red-400/50 bg-red-500/10 text-red-300" : "border-bg-border bg-bg-soft/40 text-white/70 hover:border-white/20 hover:text-white"
              ].join(" ")}>
              <ArrowUpFromLine className="w-4 h-4" /> Withdraw
            </button>
          </div>

          {/* Deposit panel */}
          {panel === "deposit" && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] bg-[color-mix(in_srgb,var(--theme-primary)_5%,transparent)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[color:var(--theme-primary)] flex items-center gap-1.5">
                  <ArrowDownToLine className="w-3.5 h-3.5" /> Пополнение через Phantom
                </p>
                <button type="button" onClick={() => setPanel("none")} className="text-white/30 hover:text-white transition"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-white/40">Phantom подпишет перевод SOL с твоего кошелька на мастер-адрес.</p>
              <div className="space-y-2">
                <label className="text-xs text-white/40 flex items-center justify-between">
                  <span>Сумма (SOL)</span>
                </label>
                <input type="number" min="0" step="0.01" placeholder="0.00" value={depositAmt}
                  onChange={e => setDepositAmt(e.target.value)}
                  className="w-full bg-bg-soft/60 border border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] rounded-lg px-3 py-2.5 text-xs font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-[color-mix(in_srgb,var(--theme-primary)_50%,transparent)]" />
              </div>
              {depositErr && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{depositErr}</p>}
              {depositOk && (
                <div className="text-xs text-neon-green bg-neon-green/5 border border-neon-green/20 rounded-lg px-3 py-2 space-y-1">
                  <p className="font-semibold">Успешно пополнено!</p>
                  <p className="font-mono text-white/40 break-all">{depositOk}</p>
                </div>
              )}
              <button type="button" onClick={doDeposit} disabled={depositing}
                className="w-full py-2.5 rounded-lg bg-neon-green text-bg text-sm font-semibold hover:shadow-neon-green disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2">
                {depositing ? <><Loader2 className="w-4 h-4 animate-spin" /> Отправка...</> : <><ArrowDownToLine className="w-4 h-4" /> Connect Phantom & Deposit</>}
              </button>
            </div>
          )}

          {/* Withdraw panel */}
          {panel === "withdraw" && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5">
                  <ArrowUpFromLine className="w-3.5 h-3.5" /> Вывод на Phantom
                </p>
                <button type="button" onClick={() => setPanel("none")} className="text-white/30 hover:text-white transition"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-white/40">SOL будет отправлен на адрес твоего Phantom-кошелька автоматически.</p>
              <div className="space-y-2">
                <label className="text-xs text-white/40 flex items-center justify-between">
                  <span>Сумма (SOL)</span>
                  {balance !== null && (
                    <button type="button" onClick={() => setWithdrawAmt((Math.max(0, balance - 0.001)).toFixed(6))}
                      className="text-neon-green text-xs hover:underline">
                      Max ({(Math.max(0, balance - 0.001)).toFixed(4)})
                    </button>
                  )}
                </label>
                <input type="number" min="0" step="0.01" placeholder="0.00" value={withdrawAmt}
                  onChange={e => setWithdrawAmt(e.target.value)}
                  className="w-full bg-bg-soft/60 border border-red-500/20 rounded-lg px-3 py-2.5 text-xs font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-red-400/50" />
              </div>
              {withdrawErr && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{withdrawErr}</p>}
              {withdrawOk && (
                <div className="text-xs text-neon-green bg-neon-green/5 border border-neon-green/20 rounded-lg px-3 py-2 space-y-1">
                  <p className="font-semibold">Успешно выведено!</p>
                  <p className="font-mono text-white/40 break-all">{withdrawOk}</p>
                </div>
              )}
              <button type="button" onClick={doWithdraw} disabled={withdrawing}
                className="w-full py-2.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-300 text-sm font-semibold hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center justify-center gap-2">
                {withdrawing ? <><Loader2 className="w-4 h-4 animate-spin" /> Отправка...</> : <><ArrowUpFromLine className="w-4 h-4" /> Connect Phantom & Withdraw</>}
              </button>
            </div>
          )}

          {/* Regenerate */}
          {!confirming ? (
            <button type="button" onClick={() => setConfirming(true)}
              className="text-xs text-white/30 hover:text-white/60 transition underline underline-offset-2">
              Regenerate wallet
            </button>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
              <p className="flex-1 text-xs text-red-200">Старый кошелёк будет заменён. Ключ в браузере перезапишется.</p>
              <button type="button" onClick={generate}
                className="px-3 py-1.5 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 text-xs font-semibold hover:bg-red-500/30 transition">Да</button>
              <button type="button" onClick={() => setConfirming(false)}
                className="px-3 py-1.5 rounded-lg border border-bg-border text-white/50 text-xs hover:text-white transition">Нет</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
