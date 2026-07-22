"use client";

import WalletsList, { type SelectedWallet } from "../shared/WalletsList";

// data-tag: step3.snipe.wallets_list
export default function SnipeWalletsList({
  onSelectionChange,
}: {
  onSelectionChange?: (wallets: SelectedWallet[]) => void;
}) {
  return <WalletsList tagPrefix="step3.snipe" mode="snipe" onSelectionChange={onSelectionChange} />;
}
