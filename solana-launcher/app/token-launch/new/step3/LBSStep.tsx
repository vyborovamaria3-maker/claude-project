"use client";

import type { StepProps } from "../types";
import MasterWalletCard from "./snipe/MasterWalletCard";
import SnipeStatsGrid from "./snipe/SnipeStatsGrid";
import BundleActionsBar from "./bundle/BundleActionsBar";
import LBSWalletsList from "./lbs/LBSWalletsList";

// data-tag: token_launch.new.step3.lbs
export default function LBSStep({ next, prev }: StepProps) {
  return (
    <div data-tag="token_launch.new.step3.lbs" className="space-y-5">
      <MasterWalletCard />
      <SnipeStatsGrid />
      <BundleActionsBar defaultRole="both" />
      <LBSWalletsList />

      <div className="flex items-center justify-between pt-6">
        <button
          type="button"
          data-tag="step3.lbs.back"
          onClick={prev}
          className="px-6 py-2 rounded-lg border border-bg-border text-white/70 hover:border-white/30 hover:text-white transition text-sm"
        >
          Back
        </button>
        <button
          type="button"
          data-tag="step3.lbs.continue"
          onClick={next}
          className="px-12 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
