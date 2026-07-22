"use client";

import { User } from "lucide-react";
import BuyModeCard from "./BuyModeCard";

export const DEV_ONLY_VALUE = "dev_only" as const;

// data-tag: step2.mode.dev_only
export default function BuyMode_DevOnly({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <BuyModeCard
      tag="step2.mode.dev_only"
      icon={<User className="w-5 h-5" />}
      title="Dev Buy Only"
      description="Only the dev wallet will buy tokens at launch, no additional bundle or snipe"
      selected={selected}
      onSelect={onSelect}
    />
  );
}
