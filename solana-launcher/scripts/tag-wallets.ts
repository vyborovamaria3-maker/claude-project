import process from "node:process";
import { getDb } from "../lib/trade/db";

type Aggregate = {
  wallet: string;
  reports: number;
  avgPnl: number | null;
  avgRoi: number | null;
  avgWr: number | null;
  avgMigratedPct: number | null;
  avgFastTradesPct: number | null;
  avgSoldGtBoughtPct: number | null;
  avgTotalTokens: number | null;
  totalRockets: number;
  positiveRatio: number; // share of reports with pnl > 0
};

type TagDef = {
  tag: string;
  emoji: string;
  matches: (a: Aggregate) => boolean;
  score: (a: Aggregate) => number;
  reason: (a: Aggregate) => string;
};

function fmt(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

const TAGS: TagDef[] = [
  {
    tag: "whale",
    emoji: "🐋",
    matches: (a) => (a.avgPnl ?? -Infinity) >= 50,
    score: (a) => a.avgPnl ?? 0,
    reason: (a) => `avg PnL ${fmt(a.avgPnl)} SOL across ${a.reports} reports`,
  },
  {
    tag: "profitable",
    emoji: "💰",
    matches: (a) => (a.avgPnl ?? -Infinity) > 0 && (a.avgRoi ?? -Infinity) >= 50,
    score: (a) => (a.avgRoi ?? 0) + (a.avgPnl ?? 0) * 5,
    reason: (a) => `avg PnL ${fmt(a.avgPnl)} SOL, avg ROI ${fmt(a.avgRoi)}%`,
  },
  {
    tag: "high-roi",
    emoji: "🚀",
    matches: (a) => (a.avgRoi ?? -Infinity) >= 200,
    score: (a) => a.avgRoi ?? 0,
    reason: (a) => `avg ROI ${fmt(a.avgRoi)}%`,
  },
  {
    tag: "sharpshooter",
    emoji: "🎯",
    matches: (a) => (a.avgWr ?? -Infinity) >= 70 && a.totalRockets >= 10,
    score: (a) => (a.avgWr ?? 0) + a.totalRockets,
    reason: (a) => `avg WR ${fmt(a.avgWr)}%, rockets ${a.totalRockets}`,
  },
  {
    tag: "sniper",
    emoji: "🏃",
    matches: (a) => (a.avgFastTradesPct ?? -Infinity) >= 70,
    score: (a) => a.avgFastTradesPct ?? 0,
    reason: (a) => `fast trades ${fmt(a.avgFastTradesPct)}%`,
  },
  {
    tag: "diamond-hands",
    emoji: "💎",
    matches: (a) => (a.avgMigratedPct ?? -Infinity) >= 30,
    score: (a) => a.avgMigratedPct ?? 0,
    reason: (a) => `migrated ${fmt(a.avgMigratedPct)}%`,
  },
  {
    tag: "consistent",
    emoji: "📈",
    matches: (a) => a.reports >= 5 && (a.avgPnl ?? -Infinity) > 0 && a.positiveRatio >= 0.6,
    score: (a) => a.reports * (a.positiveRatio * 100),
    reason: (a) => `${a.reports} reports, ${(a.positiveRatio * 100).toFixed(0)}% profitable`,
  },
  {
    tag: "loser",
    emoji: "🩸",
    matches: (a) => (a.avgPnl ?? Infinity) < 0,
    score: (a) => -(a.avgPnl ?? 0),
    reason: (a) => `avg PnL ${fmt(a.avgPnl)} SOL`,
  },
  {
    tag: "rugger",
    emoji: "💀",
    matches: (a) => (a.avgSoldGtBoughtPct ?? -Infinity) >= 80 && (a.avgPnl ?? Infinity) < 0,
    score: (a) => a.avgSoldGtBoughtPct ?? 0,
    reason: (a) => `sold>bought ${fmt(a.avgSoldGtBoughtPct)}%, PnL ${fmt(a.avgPnl)}`,
  },
  {
    tag: "newbie",
    emoji: "🆕",
    matches: (a) => (a.avgTotalTokens ?? Infinity) < 10,
    score: (a) => -(a.avgTotalTokens ?? 0),
    reason: (a) => `avg total tokens ${fmt(a.avgTotalTokens, 1)}`,
  },
];

function loadAggregates(): Aggregate[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT
       wallet,
       COUNT(*) as reports,
       AVG(pnl) as avgPnl,
       AVG(roi) as avgRoi,
       AVG(wr) as avgWr,
       AVG(migrated_pct) as avgMigratedPct,
       AVG(fast_trades_pct) as avgFastTradesPct,
       AVG(sold_gt_bought_pct) as avgSoldGtBoughtPct,
       AVG(total_tokens) as avgTotalTokens,
       COALESCE(SUM(rockets), 0) as totalRockets,
       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as positiveCount
     FROM migration_wallet_rows
     GROUP BY wallet`
  ).all() as Array<{
    wallet: string;
    reports: number;
    avgPnl: number | null;
    avgRoi: number | null;
    avgWr: number | null;
    avgMigratedPct: number | null;
    avgFastTradesPct: number | null;
    avgSoldGtBoughtPct: number | null;
    avgTotalTokens: number | null;
    totalRockets: number;
    positiveCount: number;
  }>;

  return rows.map((row) => ({
    wallet: row.wallet,
    reports: row.reports,
    avgPnl: row.avgPnl,
    avgRoi: row.avgRoi,
    avgWr: row.avgWr,
    avgMigratedPct: row.avgMigratedPct,
    avgFastTradesPct: row.avgFastTradesPct,
    avgSoldGtBoughtPct: row.avgSoldGtBoughtPct,
    avgTotalTokens: row.avgTotalTokens,
    totalRockets: row.totalRockets,
    positiveRatio: row.reports > 0 ? row.positiveCount / row.reports : 0,
  }));
}

function main() {
  const db = getDb();
  console.log("Loading aggregates from migration_wallet_rows…");
  const aggregates = loadAggregates();
  console.log(`Aggregated ${aggregates.length} unique wallets`);

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO wallet_tags (
       wallet, tag, score, reason, reports,
       avg_pnl, avg_roi, avg_wr, avg_migrated_pct, avg_fast_trades_pct, total_rockets, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet, tag) DO UPDATE SET
       score=excluded.score,
       reason=excluded.reason,
       reports=excluded.reports,
       avg_pnl=excluded.avg_pnl,
       avg_roi=excluded.avg_roi,
       avg_wr=excluded.avg_wr,
       avg_migrated_pct=excluded.avg_migrated_pct,
       avg_fast_trades_pct=excluded.avg_fast_trades_pct,
       total_rockets=excluded.total_rockets,
       updated_at=excluded.updated_at`
  );

  const cleanup = db.prepare(`DELETE FROM wallet_tags WHERE wallet = ? AND tag = ?`);

  const counts = new Map<string, number>();

  const tx = db.transaction((rows: Aggregate[]) => {
    for (const agg of rows) {
      for (const tag of TAGS) {
        if (tag.matches(agg)) {
          insert.run(
            agg.wallet,
            tag.tag,
            tag.score(agg),
            `${tag.emoji} ${tag.reason(agg)}`,
            agg.reports,
            agg.avgPnl,
            agg.avgRoi,
            agg.avgWr,
            agg.avgMigratedPct,
            agg.avgFastTradesPct,
            agg.totalRockets,
            now,
          );
          counts.set(tag.tag, (counts.get(tag.tag) ?? 0) + 1);
        } else {
          cleanup.run(agg.wallet, tag.tag);
        }
      }
    }
  });

  console.log("Applying tags…");
  tx(aggregates);

  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\nTag distribution:");
  for (const [tag, count] of summary) {
    console.log(`  ${tag.padEnd(16)} ${count}`);
  }

  const total = db.prepare(`SELECT COUNT(*) as n FROM wallet_tags`).get() as { n: number };
  console.log(`\nTotal wallet_tags rows: ${total.n}`);
}

main();
