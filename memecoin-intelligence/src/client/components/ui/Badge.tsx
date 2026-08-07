import * as React from "react";
 
import { cn } from "@/client/lib/utils";
import type { Color } from "./_shared/variants";
 
export type BadgeVariant = "solid" | "soft" | "outline";
 
/** Static (non-interactive) variant×color classes for badges. */
const BADGE_CLASSES: Record<BadgeVariant, Record<Color, string>> = {
  solid: {
    neutral: "bg-ink-600 text-chalk",
    primary: "bg-signal text-ink-900",
    destructive: "bg-ember text-ink-900",
  },
  soft: {
    neutral: "bg-ink-700 text-chalk-dim",
    primary: "bg-signal-glow text-signal",
    destructive: "bg-ember-glow text-ember",
  },
  outline: {
    neutral: "border border-ink-600 text-chalk-dim",
    primary: "border border-signal/40 text-signal",
    destructive: "border border-ember/40 text-ember",
  },
};
 
export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  /** @default "soft" */
  variant?: BadgeVariant;
  /** @default "neutral" */
  color?: Color;
}
 
const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "soft", color = "neutral", ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        BADGE_CLASSES[variant][color],
        className
      )}
      {...props}
    />
  )
);
Badge.displayName = "Badge";
 
export { Badge };
 