"use client";

import type { StepProps } from "./types";
import StepPlaceholder from "./StepPlaceholder";
import SnipeReviewStep from "./step4/SnipeReviewStep";
import BundleReviewStep from "./step4/BundleReviewStep";
import LaunchBundleSnipeReviewStep from "./step4/LaunchBundleSnipeReviewStep";
import DevOnlyReviewStep from "./step4/DevOnlyReviewStep";
import { SNIPE_VALUE } from "./step2/BuyMode_Snipe";
import { BUNDLE_VALUE } from "./step2/BuyMode_Bundle";
import { LAUNCH_BUNDLE_SNIPE_VALUE } from "./step2/BuyMode_LaunchBundleSnipe";
import { DEV_ONLY_VALUE } from "./step2/BuyMode_DevOnly";

// data-tag: token_launch.new.step4
export default function TLstep_4(props: StepProps) {
  const { data } = props;
  const buyMode = data.buyMode;

  if (buyMode === SNIPE_VALUE) {
    return <SnipeReviewStep {...props} />;
  }

  if (buyMode === BUNDLE_VALUE) {
    return <BundleReviewStep {...props} />;
  }

  if (buyMode === LAUNCH_BUNDLE_SNIPE_VALUE) {
    return <LaunchBundleSnipeReviewStep {...props} />;
  }

  if (buyMode === DEV_ONLY_VALUE) {
    return <DevOnlyReviewStep {...props} />;
  }

  // Default placeholder for unknown modes
  return <StepPlaceholder tag="token_launch.new.step4" title="Review" {...props} />;
}
