import * as React from "react";
 
import { cn } from "@/client/lib/utils";
import { SIZES, DEFAULT_SIZE, type ControlSize } from "./_shared/sizes";
 
export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** @default "md" — shares heights with Button/Select so controls line up. */
  size?: ControlSize;
}
 
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size = DEFAULT_SIZE, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex w-full border border-ink-600 bg-ink-700 text-chalk transition-colors duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-chalk-faint hover:border-ink-500 focus-visible:outline-none focus-visible:border-signal/50 focus-visible:ring-2 focus-visible:ring-signal/30 disabled:cursor-not-allowed disabled:opacity-40",
          SIZES[size],
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";
 
export { Input };
 