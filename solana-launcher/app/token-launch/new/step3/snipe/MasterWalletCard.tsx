"use client";

import { Wallet, RefreshCw } from "lucide-react";
import { masterWallet } from "@/lib/mockData";

// data-tag: step3.snipe.master_wallet
export default function MasterWalletCard() {
  // mocked address — заменишь на данные из подключённого кошелька
  const address = "B6zpAU...ow3hiB";
  const provider = "Phantom";

  return (
    <div
      data-tag="step3.snipe.master_wallet"
      className="rounded-xl border border-neon-green/40 bg-neon-green/5 px-5 py-4 flex items-center gap-4"
    >
      <div className="w-11 h-11 shrink-0 rounded-full bg-bg-card/60 border border-bg-border flex items-center justify-center text-white/70">
        <Wallet className="w-5 h-5" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-white/80">Master Wallet ({provider})</span>
          <span
            data-tag="step3.snipe.master_wallet.connected"
            className="px-2 py-0.5 rounded bg-neon-green/15 border border-neon-green/40 text-[11px] text-neon-green"
          >
            Connected
          </span>
        </div>
        <div data-tag="step3.snipe.master_wallet.address" className="text-xs text-white/50 mt-1 font-mono">
          {address}
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className="text-[11px] uppercase tracking-widest text-white/50">Balance</div>
        <div className="mt-0.5 flex items-center gap-2 justify-end">
          <span className="text-neon-green font-semibold">{masterWallet.balanceSol.toFixed(4)} SOL</span>
          <button
            type="button"
            data-tag="step3.snipe.master_wallet.refresh"
            aria-label="Refresh master balance"
            className="text-white/50 hover:text-white transition"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
