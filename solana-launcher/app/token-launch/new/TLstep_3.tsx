"use client";

import type { StepProps } from "./types";
import StepPlaceholder from "./StepPlaceholder";
import SnipeStep from "./step3/SnipeStep";
import BundleStep from "./step3/BundleStep";
import LBSStep from "./step3/LBSStep";
import DevOnlyStep from "./step3/DevOnlyStep";
import { SNIPE_VALUE } from "./step2/BuyMode_Snipe";
import { BUNDLE_VALUE } from "./step2/BuyMode_Bundle";
import { LAUNCH_BUNDLE_SNIPE_VALUE } from "./step2/BuyMode_LaunchBundleSnipe";
import { DEV_ONLY_VALUE } from "./step2/BuyMode_DevOnly";

// data-tag: token_launch.new.step3
export default function TLstep_3(props: StepProps) {
  const mode = props.data.buyMode;

  if (mode === SNIPE_VALUE) return <SnipeStep {...props} />;
  if (mode === BUNDLE_VALUE) return <BundleStep {...props} />;
  if (mode === LAUNCH_BUNDLE_SNIPE_VALUE) return <LBSStep {...props} />;
  if (mode === DEV_ONLY_VALUE) return <DevOnlyStep {...props} />;

  return <StepPlaceholder tag="token_launch.new.step3" title="Wallets" {...props} />;
}
