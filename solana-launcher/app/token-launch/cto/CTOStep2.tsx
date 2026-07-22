"use client";

import type { TokenMeta } from "./types";

interface Props {
  meta: TokenMeta;
  mint: string;
  onContinue: () => void;
  onBack: () => void;
}

export default function CTOStep2({ meta, mint, onContinue, onBack }: Props) {
  return (
    <div className="space-y-6">
      <div className="glass p-5 rounded-2xl space-y-2">
        <p className="text-xs text-white/50 uppercase tracking-widest">Selected Token</p>
        <p className="text-base font-semibold text-white">{meta.name ?? "Unknown"}</p>
        <p className="text-xs font-mono text-white/40 break-all">{mint}</p>
      </div>

      <div className="glass p-5 rounded-2xl space-y-4">
        <h2 className="text-sm font-semibold text-white">Buy Mode</h2>
        <p className="text-xs text-white/40">Step 2 — configure your buy mode (coming soon)</p>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 py-3 rounded-xl border border-bg-border text-white/60 text-sm font-semibold hover:text-white hover:border-white/30 transition"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 py-3 rounded-xl bg-neon-green text-bg font-semibold text-sm hover:shadow-neon-green transition"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
