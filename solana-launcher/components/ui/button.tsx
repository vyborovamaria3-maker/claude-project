import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { siteDesign } from "@/lib/siteDesign";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "site-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border text-sm font-semibold tracking-[0.01em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 active:translate-y-[1px] active:scale-[0.99] transform-gpu",
  {
    variants: {
      variant: {
        default: siteDesign.controls.primaryActionClassName,
        secondary: siteDesign.controls.actionButtonClassName,
        ghost:
          "border-transparent bg-transparent text-content-soft hover:border-bg-border hover:bg-bg-elevated hover:text-content",
        outline:
          "border-bg-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--theme-bg-card)_100%,white_2%),var(--theme-bg-card))] text-content hover:border-primary-border hover:bg-bg-elevated",
        success:
          "border-success-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--theme-success)_18%,transparent),color-mix(in_srgb,var(--theme-success)_8%,transparent))] text-success hover:border-success hover:bg-success/20",
        warning:
          "border-warning-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--theme-warning)_18%,transparent),color-mix(in_srgb,var(--theme-warning)_8%,transparent))] text-warning hover:border-warning hover:bg-warning/20",
        danger:
          "border-danger-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--theme-danger)_18%,transparent),color-mix(in_srgb,var(--theme-danger)_8%,transparent))] text-danger hover:border-danger hover:bg-danger/20",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-11 rounded-xl px-6",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
