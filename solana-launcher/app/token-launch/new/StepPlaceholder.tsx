"use client";

import type { StepProps } from "./types";

type Props = StepProps & {
  tag: string;
  title: string;
  isLast?: boolean;
};

// data-tag: token_launch.new.step_placeholder
export default function StepPlaceholder({ tag, title, isLast, prev, next }: Props) {
  return (
    <div data-tag={tag} className="glass p-8 space-y-6">
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        <p className="text-sm text-white/40 mt-2">Coming soon — этот шаг будет реализован позже.</p>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={prev}
          className="px-6 py-2 rounded-lg border border-bg-border text-white/70 hover:border-white/30 hover:text-white transition text-sm"
        >
          Back
        </button>
        {!isLast ? (
          <button
            type="button"
            onClick={next}
            className="px-8 py-2 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition text-sm"
          >
            Continue
          </button>
        ) : (
          <button
            type="button"
            className="px-8 py-2 rounded-lg bg-neon-green text-bg font-semibold hover:shadow-neon-green transition text-sm"
          >
            Launch
          </button>
        )}
      </div>
    </div>
  );
}
