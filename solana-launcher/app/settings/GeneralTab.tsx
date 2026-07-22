"use client";

// data-tag: settings.general
export default function GeneralTab() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white">General</h2>
        <p className="text-sm text-white/40 mt-0.5">Global preferences and default behaviour.</p>
      </div>
      <div className="surface-panel p-6 rounded-xl border border-bg-border">
        <p className="text-sm text-white/30">Coming soon — RPC endpoint, slippage, priority fees.</p>
      </div>
    </div>
  );
}
