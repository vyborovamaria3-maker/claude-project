"use client";

import { Rocket } from "lucide-react";
import BuyModeCard from "./BuyModeCard";

export const LAUNCH_BUNDLE_SNIPE_VALUE = "launch_bundle_snipe" as const;

// data-tag: step2.mode.launch_bundle_snipe
export default function BuyMode_LaunchBundleSnipe({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <BuyModeCard
      tag="step2.mode.launch_bundle_snipe"
      icon={<Rocket className="w-5 h-5" />}
      title="Launch + Bundle + Snipe"
      description="Create token, bundle initial buys, then optionally send a snipe bundle after launch"
      selected={selected}
      onSelect={onSelect}
    />
  );
}
