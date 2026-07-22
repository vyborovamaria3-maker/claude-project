"use client";

import { useRef } from "react";
import type { StepProps } from "../types";
import { loadWallets } from "@/lib/walletStore";
import MasterWalletCard from "./snipe/MasterWalletCard";
import SnipeStatsGrid from "./snipe/SnipeStatsGrid";
import SnipeActionsBar from "./snipe/SnipeActionsBar";
import SnipeWalletsList from "./snipe/SnipeWalletsList";
import type { SelectedWallet } from "./shared/WalletsList";

// data-tag: token_launch.new.step3.snipe
export default function SnipeStep({ update, next, prev }: StepProps) {
  const selectedRef = useRef<SelectedWallet[]>([]);

  const handleContinue = () => {
    const allWallets = loadWallets();
    const devWallet = allWallets.find((w) => w.role === "dev");
    const snipeWallets = selectedRef.current.filter(
      (w) => w.address !== devWallet?.publicKey
    );
    const devBuy = devWallet
      ? (selectedRef.current.find((w) => w.address === devWallet.publicKey)?.amount ?? 0)
      : 0;
    const snipeAmountPerWallet =
      snipeWallets.length > 0
        ? snipeWallets.reduce((s, w) => s + w.amount, 0) / snipeWallets.length
        : 0;
    update({
      snipeWallets,
      devBuy,
      devWalletAddress: devWallet?.publicKey ?? "",
      totalWallets: snipeWallets.length,
      snipeAmountPerWallet,
    });
    next();
  };

  return (
    <div data-tag="token_launch.new.step3.snipe" className="space-y-5">
      <MasterWalletCard />
      <SnipeStatsGrid />
      <SnipeActionsBar />
      <SnipeWalletsList onSelectionChange={(w) => { selectedRef.current = w; }} />

      <div className="flex items-center justify-between pt-6">
        <button
          type="button"
          data-tag="step3.snipe.back"
          onClick={prev}
          className="px-6 py-2 rounded-lg border border-bg-border text-white/70 hover:border-white/30 hover:text-white transition text-sm"
        >
          Back
        </button>
        <button
          type="button"
          data-tag="step3.snipe.continue"
          onClick={handleContinue}
          className="px-12 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
