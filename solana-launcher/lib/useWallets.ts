"use client";

import { useEffect, useState } from "react";
import { loadWallets, WALLETS_EVENT, type WalletMeta } from "./walletStore";

export function useWallets(): WalletMeta[] {
  const [wallets, setWallets] = useState<WalletMeta[]>([]);

  useEffect(() => {
    const refresh = () => setWallets(loadWallets());
    refresh();
    window.addEventListener(WALLETS_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(WALLETS_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return wallets;
}
