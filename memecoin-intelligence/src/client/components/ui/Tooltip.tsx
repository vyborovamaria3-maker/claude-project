import type { PropsWithChildren } from 'react';
// No tooltip primitives are currently rendered by the application. Keeping a
// zero-cost provider preserves the public component boundary without shipping
// an entire UI runtime in the initial bundle.
export function TooltipProvider({ children }: PropsWithChildren<{ delay?: number }>) { return children; }
