"use client";

import WalletsList, { type SelectedWallet } from "../shared/WalletsList";

// data-tag: step3.bundle.wallets_list
export default function BundleWalletsList({
  onSelectionChange,
}: {
  onSelectionChange?: (wallets: SelectedWallet[]) => void;
}) {
  return <WalletsList tagPrefix="step3.bundle" mode="bundle" onSelectionChange={onSelectionChange} />;
}
