"use client";

import { useWallets } from "@/lib/useWallets";

// data-tag: step3.bundle.stats
export default function BundleStatsGrid() {
  const wallets = useWallets();
  const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
  const stats = [
    { tag: "step3.bundle.stat.total_wallets", label: "Total Wallets", value: String(wallets.length) },
    { tag: "step3.bundle.stat.selected", label: "Selected", value: "0" },
    { tag: "step3.bundle.stat.total_balance", label: "Total Balance", value: totalBalance.toFixed(4), withSol: true },
    { tag: "step3.bundle.stat.total_buy", label: "Total Buy", value: "0.0000", withSol: true },
  ];

  return (
    <div data-tag="step3.bundle.stats" className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((s) => (
        <div
          key={s.tag}
          data-tag={s.tag}
          className="rounded-xl border border-bg-border bg-bg-card/40 px-4 py-3"
        >
          <div className="text-xs text-white/50">{s.label}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            {s.withSol && <span className="text-neon-green text-sm">≋</span>}
            <span className="text-white font-semibold">{s.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
