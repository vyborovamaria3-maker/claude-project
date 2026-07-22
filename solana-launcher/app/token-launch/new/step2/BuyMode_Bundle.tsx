"use client";

import { Package } from "lucide-react";
import BuyModeCard from "./BuyModeCard";

export const BUNDLE_VALUE = "bundle" as const;

// data-tag: step2.mode.bundle
export default function BuyMode_Bundle({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <BuyModeCard
      tag="step2.mode.bundle"
      icon={<Package className="w-5 h-5" />}
      title="Bundle"
      description="Bundle multiple buy transactions together in a single block for better execution"
      selected={selected}
      onSelect={onSelect}
    />
  );
}
 