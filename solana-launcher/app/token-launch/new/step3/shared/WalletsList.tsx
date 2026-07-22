"use client";

import { useMemo, useState } from "react";
import { Search, Wallet } from "lucide-react";
import { useWallets } from "@/lib/useWallets";
import WalletRow from "./WalletRow";

type Mode = "snipe" | "bundle" | "lbs" | "dev_only";

export type SelectedWallet = { address: string; amount: number };

// data-tag: step3.wallets_list
export default function WalletsList({
  tagPrefix,
  mode,
  extraTopSlot,
  onSelectionChange,
}: {
  tagPrefix: string;
  mode: Mode;
  extraTopSlot?: React.ReactNode;
  onSelectionChange?: (wallets: SelectedWallet[]) => void;
}) {
  const wallets = useWallets();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, number>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return wallets;
    return wallets.filter(
      (w) => w.publicKey.toLowerCase().includes(q) || w.role.toLowerCase().includes(q)
    );
  }, [wallets, query]);

  const selectedCount = wallets.filter((w) => selected[w.publicKey]).length;

  const toggle = (publicKey: string) => {
    const next = { ...selected, [publicKey]: !selected[publicKey] };
    setSelected(next);
    if (onSelectionChange) {
      onSelectionChange(
        wallets
          .filter((w) => next[w.publicKey])
          .map((w) => ({ address: w.publicKey, amount: amounts[w.publicKey] ?? 0 }))
      );
    }
  };

  const handleAmountChange = (publicKey: string, amount: number) => {
    const next = { ...amounts, [publicKey]: amount };
    setAmounts(next);
    if (onSelectionChange) {
      onSelectionChange(
        wallets
          .filter((w) => selected[w.publicKey])
          .map((w) => ({ address: w.publicKey, amount: next[w.publicKey] ?? 0 }))
      );
    }
  };

  return (
    <div data-tag={`${tagPrefix}.wallets_list`} className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-white/70">Wallets ({wallets.length})</span>
        <span
          data-tag={`${tagPrefix}.wallets_list.selected_count`}
          className="text-white/50"
        >
          {selectedCount} selected
        </span>
      </div>

      <div
        data-tag={`${tagPrefix}.wallets_list.amount_mode`}
        className="rounded-xl border border-bg-border bg-bg-card/40 p-4 space-y-3"
      >
        <div>
          <div className="text-white font-semibold">Wallet amount mode</div>
          <p className="text-xs text-white/50 mt-1">
            Set SOL for each wallet below, or redistribute selected bundle wallets while keeping
            the current total bundle buy.
          </p>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            data-tag={`${tagPrefix}.wallets_list.search`}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by address or role"
            className="w-full bg-bg-soft/60 border border-bg-border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-neon-green/50"
          />
        </div>

        {extraTopSlot}
      </div>

      {wallets.length === 0 ? (
        <div
          data-tag={`${tagPrefix}.wallets_list.empty`}
          className="rounded-xl border-2 border-dashed border-bg-border px-6 py-12 flex flex-col items-center text-center"
        >
          <Wallet className="w-7 h-7 text-white/40 mb-3" />
          <div className="text-white/70 text-sm">No wallets added yet</div>
          <div className="text-xs text-white/40 mt-1">
            Click +Dev or Create to add wallets
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((w) => (
            <WalletRow
              key={w.publicKey}
              wallet={w}
              selected={!!selected[w.publicKey]}
              onToggle={() => toggle(w.publicKey)}
              onAmountChange={(amt) => handleAmountChange(w.publicKey, amt)}
              mode={mode}
            />
          ))}
          {filtered.length === 0 && (
            <div className="text-center text-sm text-white/50 py-6">
              No wallets match &quot;{query}&quot;
            </div>
          )}
        </div>
      )}
    </div>
  );
}
