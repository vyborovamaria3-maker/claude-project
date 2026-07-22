"use client";

import { useWallets } from "@/lib/useWallets";

type Stat = {
  tag: string;
  label: string;
  value: string;
  withSol?: boolean;
};

// data-tag: step3.snipe.stats
export default function SnipeStatsGrid() {
  const wallets = useWallets();
  const totalBalance = wallets.reduce((sum, w) => sum + w.balance, 0);
  const stats: Stat[] = [
    { tag: "step3.snipe.stat.total_wallets", label: "Total Wallets", value: String(wallets.length) },
    { tag: "step3.snipe.stat.selected", label: "Selected", value: "0" },
    { tag: "step3.snipe.stat.total_balance", label: "Total Balance", value: totalBalance.toFixed(4), withSol: true },
    { tag: "step3.snipe.stat.total_buy", label: "Total Buy", value: "0.0000", withSol: true },
    { tag: "step3.snipe.stat.total_snipe", label: "Total Snipe", value: "0.0000", withSol: true },
  ];

  return (
    <div data-tag="step3.snipe.stats" className="grid grid-cols-2 md:grid-cols-5 gap-3">
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
