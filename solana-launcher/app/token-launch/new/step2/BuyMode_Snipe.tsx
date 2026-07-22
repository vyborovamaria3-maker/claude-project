"use client";

import { Crosshair } from "lucide-react";
import BuyModeCard from "./BuyModeCard";

export const SNIPE_VALUE = "snipe" as const;

// data-tag: step2.mode.snipe
export default function BuyMode_Snipe({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <BuyModeCard
      tag="step2.mode.snipe"
      icon={<Crosshair className="w-5 h-5" />}
      title="Snipe"
      description="Automatically snipe the token immediately after launch with configured wallets"
      selected={selected}
      onSelect={onSelect}
    />
  );
}
