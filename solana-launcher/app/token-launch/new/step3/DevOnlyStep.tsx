"use client";

import type { StepProps } from "../types";
import MasterWalletCard from "./snipe/MasterWalletCard";
import BundleStatsGrid from "./bundle/BundleStatsGrid";
import BundleActionsBar from "./bundle/BundleActionsBar";
import BundleWalletsList from "./bundle/BundleWalletsList";

// data-tag: token_launch.new.step3.dev_only
export default function DevOnlyStep({ next }: StepProps) {
  return (
    <div data-tag="token_launch.new.step3.dev_only" className="space-y-5">
      <MasterWalletCard />
      <BundleStatsGrid />
      <BundleActionsBar defaultRole="dev" />
      <BundleWalletsList />

      <div className="flex justify-center pt-6">
        <button
          type="button"
          data-tag="step3.dev_only.continue"
          onClick={next}
          className="px-24 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
