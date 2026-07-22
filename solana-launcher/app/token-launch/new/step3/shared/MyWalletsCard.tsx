"use client";

import { useMemo, useState } from "react";
import { loadWallets } from "@/lib/walletStore";
import { X, Plus } from "lucide-react";

function shorten(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}...${addr.slice(-5)}`;
}

const ROLE_COLORS: Record<string, string> = {
  dev: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  bundle: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  snipe: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  both: "bg-purple-500/15 text-purple-300 border-purple-500/40",
};

// data-tag: step3.my_wallets.card
export default function MyWalletsCard({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd?: (publicKeys: string[]) => void;
}) {
  const allWallets = useMemo(() => loadWallets(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allSelected =
    allWallets.length > 0 && selected.size === allWallets.length;

  const toggle = (pk: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allWallets.map((w) => w.publicKey)));
  };

  const handleAdd = () => {
    if (selected.size === 0) return;
    onAdd?.(Array.from(selected));
    onClose();
  };

  return (
    <div
      data-tag="step3.my_wallets.card"
      className="rounded-xl border border-bg-border bg-bg-card/60 p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="text-white font-semibold">My Wallets</div>
        <button
          type="button"
          onClick={onClose}
          className="text-white/40 hover:text-white transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="text-xs text-white/50">
        Select wallets from your global collection to add to this bundle.
      </p>

      <div className="flex items-center justify-between">
        <div className="text-sm text-white/70">
          {selected.size} selected
        </div>
        <button
          type="button"
          data-tag="step3.my_wallets.select_all"
          onClick={toggleAll}
          disabled={allWallets.length === 0}
          className="px-3 py-1.5 rounded-md border border-bg-border bg-bg-soft/60 text-xs text-white/80 hover:border-white/30 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {allSelected ? "Deselect All" : "Select All"}
        </button>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {allWallets.length === 0 ? (
          <div className="text-center text-sm text-white/50 py-8">
            No wallets created yet
          </div>
        ) : (
          allWallets.map((wallet) => {
            const isChecked = selected.has(wallet.publicKey);
            return (
              <label
                key={wallet.publicKey}
                className="flex items-center gap-3 rounded-lg border border-bg-border bg-bg-soft/40 px-3 py-2 cursor-pointer hover:border-white/20 transition"
              >
                <input
                  type="checkbox"
                  data-tag="step3.my_wallets.row.select"
                  checked={isChecked}
                  onChange={() => toggle(wallet.publicKey)}
                  className="w-4 h-4 accent-neon-green shrink-0"
                />
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                    ROLE_COLORS[wallet.role] || ""
                  }`}
                >
                  {wallet.role.toUpperCase()}
                </span>
                <span className="text-sm font-mono text-white/85">
                  {shorten(wallet.publicKey)}
                </span>
                <span className="text-xs text-white/50 ml-auto">
                  {wallet.balance.toFixed(4)} SOL
                </span>
              </label>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          data-tag="step3.my_wallets.cancel"
          onClick={onClose}
          className="flex-1 px-4 py-2 rounded-lg border border-bg-border bg-bg-soft/40 text-sm text-white/80 hover:border-white/30 hover:text-white transition"
        >
          Cancel
        </button>
        <button
          type="button"
          data-tag="step3.my_wallets.add"
          onClick={handleAdd}
          disabled={selected.size === 0}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <Plus className="w-4 h-4" />
          <span>Add Wallets{selected.size > 0 ? ` (${selected.size})` : ""}</span>
        </button>
      </div>
    </div>
  );
}
