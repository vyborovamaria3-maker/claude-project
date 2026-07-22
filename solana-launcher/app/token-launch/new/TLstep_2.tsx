"use client";

import { useState } from "react";
import type { StepProps } from "./types";
import BuyMode_Snipe, { SNIPE_VALUE } from "./step2/BuyMode_Snipe";
import BuyMode_Bundle, { BUNDLE_VALUE } from "./step2/BuyMode_Bundle";
import BuyMode_LaunchBundleSnipe, { LAUNCH_BUNDLE_SNIPE_VALUE } from "./step2/BuyMode_LaunchBundleSnipe";
import BuyMode_DevOnly, { DEV_ONLY_VALUE } from "./step2/BuyMode_DevOnly";

type BuyMode =
  | typeof SNIPE_VALUE
  | typeof BUNDLE_VALUE
  | typeof LAUNCH_BUNDLE_SNIPE_VALUE
  | typeof DEV_ONLY_VALUE;

// data-tag: token_launch.new.step2
export default function TLstep_2({ data, update, next, prev }: StepProps) {
  const [mode, setMode] = useState<BuyMode>((data.buyMode as BuyMode) ?? BUNDLE_VALUE);

  const handleContinue = () => {
    update({ buyMode: mode });
    next();
  };

  return (
    <div data-tag="token_launch.new.step2" className="space-y-8">
      <p
        data-tag="step2.intro"
        className="text-center text-sm md:text-base text-white/60 max-w-2xl mx-auto"
      >
        Select how you want to buy tokens at launch. Each mode has different strategies and
        requirements.
      </p>

      <div data-tag="step2.modes" className="space-y-3">
        <BuyMode_Snipe selected={mode === SNIPE_VALUE} onSelect={() => setMode(SNIPE_VALUE)} />
        <BuyMode_Bundle selected={mode === BUNDLE_VALUE} onSelect={() => setMode(BUNDLE_VALUE)} />
        <BuyMode_LaunchBundleSnipe
          selected={mode === LAUNCH_BUNDLE_SNIPE_VALUE}
          onSelect={() => setMode(LAUNCH_BUNDLE_SNIPE_VALUE)}
        />
        <BuyMode_DevOnly
          selected={mode === DEV_ONLY_VALUE}
          onSelect={() => setMode(DEV_ONLY_VALUE)}
        />
      </div>

      <div className="flex items-center justify-between pt-6">
        <button
          type="button"
          data-tag="step2.back"
          onClick={prev}
          className="px-6 py-2 rounded-lg border border-bg-border text-white/70 hover:border-white/30 hover:text-white transition text-sm"
        >
          Back
        </button>
        <button
          type="button"
          data-tag="step2.continue"
          onClick={handleContinue}
          className="px-12 py-2.5 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
