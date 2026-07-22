"use client";

import { useRef } from "react";
import type { StepProps } from "../types";
import { loadWallets } from "@/lib/walletStore";
import MasterWalletCard from "./snipe/MasterWalletCard";
import BundleStatsGrid from "./bundle/BundleStatsGrid";
import BundleActionsBar from "./bundle/BundleActionsBar";
import BundleWalletsList from "./bundle/BundleWalletsList";
import type { SelectedWallet } from "./shared/WalletsList";

// data-tag: token_launch.new.step3.bundle
export default function BundleStep({ update, next, prev }: StepProps) {
  const selectedRef = useRef<SelectedWallet[]>([]);

  const handleContinue = () => {
    const allWallets = loadWallets();
    const devWallet = allWallets.find((w) => w.role === "dev");
    const devBuy = devWallet
      ? (selectedRef.current.find((w) => w.address === devWallet.publicKey)?.amount ?? 0)
      : 0;
    const bundleWallets = selectedRef.current.filter(
      (w) => w.address !== devWallet?.publicKey
    );
    update({
      selectedWallets: bundleWallets,
      devBuy,
      devWalletAddress: devWallet?.publicKey ?? "",
      totalWallets: bundleWallets.length,
    });
    next();
  };

  return (
    <div data-tag="token_launch.new.step3.bundle" className="space-y-5">
      <MasterWalletCard />
      <BundleStatsGrid />
      <BundleActionsBar />
      <BundleWalletsList onSelectionChange={(w) => { selectedRef.current = w; }} />

      <div className="flex items-center justify-between pt-6">
        <button
          type="button"
          data-tag="step3.bundle.back"
          onClick={prev}
          className="px-6 py-2 rounded-lg border border-bg-border text-white/70 hover:border-white/30 hover:text-white transition text-sm"
        >
          Back
        </button>
        <button
          type="button"
          data-tag="step3.bundle.continue"
          onClick={handleContinue}
          className="px-12 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
