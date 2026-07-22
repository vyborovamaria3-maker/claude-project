"use client";

import { useEffect, useState, useCallback } from "react";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useI18n } from "@/components/providers/I18nProvider";

const MASTER_WALLET_KEY = "solana-launcher.master-wallet";
const REFRESH_INTERVAL = 30_000;

function getRpc() {
  return process.env.NEXT_PUBLIC_HELIUS_RPC_URL
    || process.env.NEXT_PUBLIC_RPC_URL
    || "https://api.mainnet-beta.solana.com";
}

// data-tag: wallet.master (grid row 2 col 1)
export default function MasterWalletBar() {
  const { t } = useI18n();
  const [balance, setBalance] = useState<number | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);

  const fetchBalance = useCallback(async (pk: string) => {
    try {
      const conn = new Connection(getRpc(), "confirmed");
      const lamports = await conn.getBalance(new PublicKey(pk));
      setBalance(lamports / LAMPORTS_PER_SOL);
    } catch {
      // keep previous value on error
    }
  }, []);

  useEffect(() => {
    const pk = localStorage.getItem(MASTER_WALLET_KEY);
    if (!pk) return;
    setPubkey(pk);
    fetchBalance(pk);
    const id = setInterval(() => fetchBalance(pk), REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [fetchBalance]);

  return (
    <div
      data-tag="wallet.master"
      className="border-r border-b border-bg-border/70 bg-bg/80 backdrop-blur-xl px-5 py-3 flex flex-col justify-center glass-strong"
    >
      <div className="text-[10px] uppercase text-content-faint tracking-widest mb-1">{t("wallet.master.title")}</div>
      <div className="flex items-center gap-2">
        <div className={[
          "w-2 h-2 rounded-full shrink-0",
          pubkey ? "bg-success shadow-neon-green animate-pulse-soft" : "bg-content-faint",
        ].join(" ")} />
        {pubkey ? (
          <>
            <span className="text-lg font-bold text-content font-mono">
              {balance === null ? "..." : balance.toFixed(5)}
            </span>
            <span className="text-sm text-content-muted">SOL</span>
          </>
        ) : (
          <span className="text-sm text-content-faint">{t("wallet.master.notSet")}</span>
        )}
      </div>
    </div>
  );
}
