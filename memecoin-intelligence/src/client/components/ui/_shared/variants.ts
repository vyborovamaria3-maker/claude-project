export type Variant = "solid" | "outline" | "ghost" | "link" | "soft";
export type Color = "neutral" | "primary" | "destructive";
 
export const DEFAULT_VARIANT: Variant = "solid";
export const DEFAULT_COLOR: Color = "neutral";
 
/**
 * Base classes shared by Button and IconButton.
 * Ring width/offset live here; ring *color* lives per variant×color cell below
 * so tailwind-merge resolves to a single ring color.
 */
export const CONTROL_BASE =
  "inline-flex items-center justify-center whitespace-nowrap font-medium cursor-pointer " +
  "rounded-[var(--radius-panel)] " +
  "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-ink-900 " +
  "disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0";
 
/**
 * variant (style treatment) × color (intent) → Tailwind classes.
 * Tuned to the "Signal Room" dark palette — see DESIGN.md.
 * `solid` + `primary` is the acid-lime accent button.
 */
export const VARIANT_COLOR: Record<Variant, Record<Color, string>> = {
  solid: {
    neutral:
      "bg-ink-700 text-chalk hover:bg-ink-600 active:bg-ink-500 focus-visible:ring-ink-500",
    primary:
      "bg-signal text-ink-900 font-semibold hover:bg-signal-dim active:bg-signal-dim focus-visible:ring-signal",
    destructive:
      "bg-ember text-ink-900 font-semibold hover:brightness-110 active:brightness-95 focus-visible:ring-ember",
  },
  outline: {
    neutral:
      "border border-ink-600 bg-transparent text-chalk-dim hover:border-ink-500 hover:text-chalk hover:bg-ink-800 focus-visible:ring-ink-500",
    primary:
      "border border-signal/40 bg-transparent text-signal hover:bg-signal-glow hover:border-signal focus-visible:ring-signal",
    destructive:
      "border border-ember/40 bg-transparent text-ember hover:bg-ember-glow hover:border-ember focus-visible:ring-ember",
  },
  ghost: {
    neutral:
      "text-chalk-dim hover:bg-ink-800 hover:text-chalk active:bg-ink-700 focus-visible:ring-ink-500",
    primary:
      "text-signal hover:bg-signal-glow focus-visible:ring-signal",
    destructive:
      "text-ember hover:bg-ember-glow focus-visible:ring-ember",
  },
  link: {
    neutral:
      "text-chalk-dim underline-offset-4 hover:underline hover:text-chalk focus-visible:ring-ink-500",
    primary:
      "text-signal underline-offset-4 hover:underline focus-visible:ring-signal",
    destructive:
      "text-ember underline-offset-4 hover:underline focus-visible:ring-ember",
  },
  soft: {
    neutral:
      "bg-ink-800 text-chalk-dim hover:bg-ink-700 hover:text-chalk active:bg-ink-600 focus-visible:ring-ink-500",
    primary:
      "bg-signal-glow text-signal hover:bg-signal/25 focus-visible:ring-signal",
    destructive:
      "bg-ember-glow text-ember hover:bg-ember/25 focus-visible:ring-ember",
  },
};
 
export function variantColorClasses(variant: Variant, color: Color): string {
  return VARIANT_COLOR[variant][color];
}
 