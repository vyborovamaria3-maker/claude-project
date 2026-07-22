"use client";

import { useState } from "react";
import { Copy, Trash2, Coins } from "lucide-react";
import { setDev, removeWallet, type WalletMeta, type WalletRole } from "@/lib/walletStore";

type Mode = "snipe" | "bundle" | "lbs" | "dev_only";

const ROLE_BADGES: Record<WalletRole, { label: string; cls: string }> = {
  dev: { label: "DBO", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
  bundle: { label: "BUNDLE", cls: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40" },
  snipe: { label: "SNIPE", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" },
  both: { label: "LBS", cls: "bg-purple-500/15 text-purple-300 border-purple-500/40" },
};

function shorten(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}...${addr.slice(-5)}`;
}

// data-tag: step3.wallet_row
export default function WalletRow({
  wallet,
  selected,
  onToggle,
  onAmountChange,
  mode,
}: {
  wallet: WalletMeta;
  selected: boolean;
  onToggle: () => void;
  onAmountChange?: (amount: number) => void;
  mode: Mode;
}) {
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const isDev = wallet.role === "dev";

  const amountLabel =
    isDev ? "Dev buy" : mode === "snipe" ? "Snipe SOL" : "Bundle SOL";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <div
      data-tag="step3.wallet_row"
      data-role={wallet.role}
      className="rounded-xl border border-bg-border bg-bg-card/40 p-4 flex items-center gap-4"
    >
      <input
        type="checkbox"
        data-tag="step3.wallet_row.select"
        checked={selected}
        onChange={onToggle}
        className="w-4 h-4 accent-neon-green shrink-0"
      />

      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <RoleBadge role={wallet.role} />
        </div>
        <div className="flex items-center gap-2 text-sm font-mono text-white/85">
          <span>›</span>
          <span data-tag="step3.wallet_row.address">{shorten(wallet.publicKey)}</span>
          <button
            type="button"
            data-tag="step3.wallet_row.copy"
            onClick={handleCopy}
            title={copied ? "Copied!" : "Copy address"}
            className="text-white/40 hover:text-white transition"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-white/60">
          <Coins className="w-3.5 h-3.5 text-neon-green" />
          <span data-tag="step3.wallet_row.balance">
            {wallet.balance.toFixed(4)} SOL
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {!isDev && (
          <button
            type="button"
            data-tag="step3.wallet_row.set_dev"
            onClick={() => setDev(wallet.publicKey)}
            className="px-3 py-1.5 rounded-md border border-bg-border bg-bg-soft/60 text-xs text-white/80 hover:border-white/30 hover:text-white transition"
          >
            Set as Dev
          </button>
        )}

        <div className="text-right">
          <div className="text-xs text-white/50 mb-1">{amountLabel}</div>
          <input
            data-tag="step3.wallet_row.amount"
            type="text"
            placeholder="Custom"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              onAmountChange?.(parseFloat(e.target.value) || 0);
            }}
            className="w-28 bg-bg-soft/60 border border-bg-border rounded-md px-2.5 py-1.5 text-sm text-right focus:outline-none focus:border-neon-green/50"
          />
          <div className="text-[10px] text-white/40 mt-1">Exact max 0.0000 SOL</div>
        </div>

        <button
          type="button"
          data-tag="step3.wallet_row.remove"
          onClick={() => removeWallet(wallet.publicKey)}
          title="Remove wallet"
          className="text-white/40 hover:text-red-400 transition"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: WalletRole }) {
  const cfg = ROLE_BADGES[role];
  return (
    <span
      className={`px-2 py-0.5 rounded text-[10px] font-bold border ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}
