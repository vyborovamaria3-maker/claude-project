import { getPeriodStats } from "@/lib/mockData";

type Props = {
  period: string;
};

export default function PnLTable({ period }: Props) {
  const ps = getPeriodStats(period);

  const COLS = [
    {
      key: "totalPnl",
      label: "TOTAL PNL",
      tag: "pnl.total_pnl",
      value: (ps.pnl.sol >= 0 ? "+" : "") + ps.pnl.sol.toFixed(3) + " SOL",
    },
    {
      key: "dailyVolume",
      label: "DAILY VOLUME",
      tag: "pnl.daily_volume",
      value: ps.tradingVolume.sol.toFixed(2) + " SOL",
    },
    {
      key: "avgAth",
      label: "AVG ATH",
      tag: "pnl.avg_ath",
      value: "$" + ps.averageAthUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }),
    },
    {
      key: "tokenLaunches",
      label: "TOKEN LAUNCHES",
      tag: "pnl.token_launches",
      value: String(ps.tokensCreated),
    },
    {
      key: "fees",
      label: "TOTAL FEES",
      tag: "pnl.total_fees",
      value: ps.feesPaid.sol.toFixed(3) + " SOL",
    },
    {
      key: "migrations",
      label: "MIGRATIONS",
      tag: "pnl.migrations",
      value: `${ps.migrations} (${(ps.migrationRate * 100).toFixed(0)}%)`,
    },
    {
      key: "winRate",
      label: "WIN RATE",
      tag: "pnl.win_rate",
      value: (ps.winRate * 100).toFixed(1) + "%",
    },
    {
      key: "activeTokens",
      label: "ACTIVE TOKENS",
      tag: "pnl.active_tokens",
      value: String(ps.activeTokens),
    },
    {
      key: "avgHold",
      label: "AVG HOLD",
      tag: "pnl.avg_hold",
      value: ps.avgHoldMinutes.toFixed(0) + " min",
    },
    {
      key: "bestTrade",
      label: "BEST TRADE",
      tag: "pnl.best_trade",
      value: (ps.bestTradePnlSol >= 0 ? "+" : "") + ps.bestTradePnlSol.toFixed(3) + " SOL",
    },
  ];

  return (
    <div data-tag="pnl.realized_overview" className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
      {COLS.map((c) => (
        <div
          key={c.key}
          data-tag={c.tag}
          className="glass p-3 border border-bg-border"
        >
          <div className="text-[10px] uppercase tracking-widest text-white/40">{c.label}</div>
          <div className="mt-1 text-base font-semibold text-white">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
