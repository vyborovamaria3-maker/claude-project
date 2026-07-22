"use client";

import WalletsList from "../shared/WalletsList";
import LBSWalletRolesCard from "./LBSWalletRolesCard";
import { useWallets } from "@/lib/useWallets";

// data-tag: step3.lbs.wallets_list
export default function LBSWalletsList() {
  const wallets = useWallets();
  const bundleCount = wallets.filter((w) => w.role === "bundle").length;
  const snipeCount = wallets.filter((w) => w.role === "snipe").length;
  const lbsCount = wallets.filter((w) => w.role === "both").length;
  const dboCount = wallets.filter((w) => w.role === "dev").length;

  return (
    <WalletsList
      tagPrefix="step3.lbs"
      mode="lbs"
      extraTopSlot={
        <LBSWalletRolesCard
          bundleCount={bundleCount}
          snipeCount={snipeCount}
          lbsCount={lbsCount}
          dboCount={dboCount}
        />
      }
    />
  );
}
