"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/components/providers/I18nProvider";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  Coins,
  Database,
  FileText,
  Files,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  Users,
} from "lucide-react";
import type { DatabaseDashboardData } from "./dashboardData";

// Database page - client-side rendered with i18n support

type TableCount = DatabaseDashboardData["tableCounts"][number];
type WorkbookKindRow = DatabaseDashboardData["migrationKinds"][number];
type RecentImportRow = DatabaseDashboardData["recentImports"][number];
type RecentTokenRow = DatabaseDashboardData["recentTokens"][number];
type RecentWalletRow = DatabaseDashboardData["recentWallets"][number];
type CreatorRow = DatabaseDashboardData["topCreators"][number];
type WalletStatsRow = DatabaseDashboardData["topWalletStats"][number];
type WalletTokenStatRow = DatabaseDashboardData["topWalletTokenStats"][number];
type AnalyzedMintRow = DatabaseDashboardData["analyzedMints"][number];
type DevWalletRow = DatabaseDashboardData["devWalletsTokens"][number];
type DevForensicsSummaryRow = DatabaseDashboardData["devForensics"][number];
type TwitterAnalysisRow = DatabaseDashboardData["twitterAnalyses"][number];
type TwitterAccountRow = DatabaseDashboardData["twitterAccounts"][number];
type TwitterShillerRow = DatabaseDashboardData["twitterShillers"][number];
type MarketEventRow = DatabaseDashboardData["recentMarketEvents"][number];
type TokenTradeRow = DatabaseDashboardData["recentTokenTrades"][number];
type ApifyRunSummaryRow = DatabaseDashboardData["apifyRuns"][number];
type ApifySyncEventSummaryRow = DatabaseDashboardData["apifySyncEvents"][number];
type MarketCollectorStatus = DatabaseDashboardData["marketStatus"];
type MarketOverview24h = DatabaseDashboardData["marketAgg"];

function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(abs >= 100_000_000_000 ? 0 : 2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 100_000_000 ? 0 : 2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 2)}K`;
  return `${value.toFixed(Number.isInteger(value) ? 0 : 2)}`;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)}%`;
}

function formatSol(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const formatted = formatCompact(value);
  return formatted === "—" ? "—" : `${formatted} SOL`;
}

function formatDateTime(value: number | null | undefined): string {
  if (!value) return "—";
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(timestamp).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function short(value: string, length = 6): string {
  if (!value) return "—";
  return value.length <= length * 2 + 3 ? value : `${value.slice(0, length)}…${value.slice(-length)}`;
}

function panelClass(extra = "") {
  return `surface-panel p-4 ${extra}`;
}

function SectionTitle({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <div className="flex items-center gap-2 text-white">
          <span className="surface-chip text-[11px] font-semibold text-white/85">{icon}</span>
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        </div>
        {subtitle && <p className="mt-1 text-xs text-white/45 max-w-3xl">{subtitle}</p>}
      </div>
    </div>
  );
}

function DataTable({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="surface-table max-h-[480px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr>
            {headers.map((header, index) => (
              <th key={`${header}-${index}`} className="px-3 py-2 text-left font-medium whitespace-nowrap text-white/40">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function TableRow({ children }: { children: React.ReactNode }) {
  return <tr className="border-t border-bg-border/70">{children}</tr>;
}

function TableCell({
  children,
  right = false,
  colSpan,
  className = "",
}: {
  children: ReactNode;
  right?: boolean;
  colSpan?: number;
  className?: string;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`px-3 py-2 whitespace-nowrap ${right ? "text-right" : "text-left"} ${className} text-white/80`}
    >
      {children}
    </td>
  );
}

function KeyValueTable({ rows }: { rows: Array<{ metric: string; value: ReactNode; hint?: ReactNode }> }) {
  return (
    <DataTable headers={["Показатель", "Значение", "Подсказка"]}>
      {rows.map((row) => (
        <TableRow key={row.metric}>
          <TableCell>{row.metric}</TableCell>
          <TableCell>{row.value}</TableCell>
          <TableCell>{row.hint ?? "—"}</TableCell>
        </TableRow>
      ))}
    </DataTable>
  );
}
export default function DatabaseDashboard({ data }: { data: DatabaseDashboardData }) {
  const { t } = useI18n();
  const tableCountsByName = new Map(data.tableCounts.map((row) => [row.table, row.rows]));
  const {
    migrationKinds,
    recentImports,
    recentTokens,
    recentWallets,
    topMigrationTokens,
    topMigrationWallets,
    worstMigrationWallets,
    topCreators,
    topWalletStats,
    topWalletTokenStats,
    analyzedMints,
    devWalletsTokens,
    devWalletsMigration,
    devWallets300k,
    devTokens,
    devForensics,
    twitterAnalyses,
    twitterAccounts,
    twitterShillers,
    twitterSummary,
    recentMarketEvents,
    recentTokenTrades,
    apifyRuns,
    apifySyncEvents,
    marketStatus,
    marketAgg,
  } = data;

  return (
    <div className="space-y-6" data-tag="page.database">
      <section className={panelClass("space-y-5") }>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="surface-chip text-xs font-semibold text-white/85">
              <Database className="h-3.5 w-3.5" />
              {t("database.title")}
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-white">{t("database.title")}</h1>
            <p className="max-w-3xl text-sm text-white/50">
              {t("database.description")}
            </p>
          </div>
          <div className="space-y-3 lg:min-w-[340px]">
            <h3 className="text-sm font-semibold text-white">{t("database.quickCommands")}</h3>
            <DataTable headers={[t("database.command"), t("database.purpose")]}>
              <TableRow>
                <TableCell className="font-mono">npm run db:report</TableCell>
                <TableCell>{t("db.reportPurpose")}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-mono">npm run db:audit</TableCell>
                <TableCell>{t("db.auditPurpose")}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-mono">npm run migrations:import</TableCell>
                <TableCell>{t("db.importPurpose")}</TableCell>
              </TableRow>
            </DataTable>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-white">{t("database.summary")}</h3>
          <KeyValueTable
            rows={[
              { metric: t("database.integrity"), value: <span className="text-emerald-300">{data.integrity}</span>, hint: "PRAGMA SQLite" },
              {
                metric: t("database.foreignKeys"),
                value: data.foreignKeyViolations.length === 0 ? <span className="text-emerald-300">{t("database.ok")}</span> : <span className="text-amber-300">{data.foreignKeyViolations.length} {t("database.problems")}</span>,
                hint: "foreign_key_check",
              },
              { metric: t("database.tables"), value: data.tableCounts.length.toString(), hint: t("database.allTables") },
              { metric: t("database.rows"), value: formatCompact(data.totalRows), hint: t("database.totalRows") },
              { metric: t("database.marketEvents"), value: formatCompact(data.marketStatus.events), hint: formatDateTime(data.marketStatus.lastEventAt) },
              { metric: t("database.apifyRuns"), value: formatCompact(data.apifyRuns.length), hint: t("database.recentActorRuns") },
            ]}
          />
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Bot className="h-4 w-4" />}
            title="X / Twitter"
            subtitle="Stored token analyses, account suspicion, and shiller history already collected by the social pipeline."
          />
          <KeyValueTable
            rows={[
              { metric: "Analyses", value: formatCompact(twitterSummary.totalAnalyses), hint: "stored token-level runs" },
              { metric: "Risky analyses", value: formatCompact(twitterSummary.riskyAnalyses), hint: "medium/high bot risk" },
              { metric: "Tweets", value: formatCompact(twitterSummary.totalTweets), hint: "captured tweet rows" },
              { metric: "Views", value: formatCompact(twitterSummary.totalViews), hint: "sum of captured views" },
              { metric: "Accounts", value: formatCompact(twitterSummary.totalAccounts), hint: "unique tracked accounts" },
              { metric: "Bot accounts", value: formatCompact(twitterSummary.botAccounts), hint: "flagged by scoring" },
              { metric: "Promoters", value: formatCompact(twitterSummary.promoterAccounts), hint: "subscription/promo accounts" },
            ]}
          />
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Latest analyses</h3>
            <DataTable headers={["Mint", "Risk", "Tweets", "Views", "Accounts", "Score", "Time"]}>
              {twitterAnalyses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                twitterAnalyses.map((row: TwitterAnalysisRow) => (
                  <TableRow key={row.id}>
                    <TableCell>{short(row.mint ?? "—")}</TableCell>
                    <TableCell>{row.botManipulationRisk}</TableCell>
                    <TableCell right>{formatCompact(row.totalTweets)}</TableCell>
                    <TableCell right>{formatCompact(row.totalViews)}</TableCell>
                    <TableCell right>{formatCompact(row.uniqueAccounts)}</TableCell>
                    <TableCell right>{formatCompact(row.botManipulationScore)}</TableCell>
                    <TableCell>{formatDateTime(row.analyzedAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Users className="h-4 w-4" />}
            title="Twitter accounts"
            subtitle="The same store also keeps account-level bot scoring and the strongest shiller links."
          />
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Top accounts</h3>
            <DataTable headers={["Handle", "Score", "Followers", "Posts", "Bot", "Promo", "Last seen"]}>
              {twitterAccounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                twitterAccounts.map((row: TwitterAccountRow) => (
                  <TableRow key={row.handle}>
                    <TableCell>{short(row.handle)}</TableCell>
                    <TableCell right>{formatCompact(row.botScore)}</TableCell>
                    <TableCell right>{formatCompact(row.followers)}</TableCell>
                    <TableCell right>{formatCompact(row.postsCount)}</TableCell>
                    <TableCell>{row.isBot ? "yes" : "no"}</TableCell>
                    <TableCell>{row.isSubscriptionPromoter ? "yes" : "no"}</TableCell>
                    <TableCell>{formatDateTime(row.lastSeenAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Top shillers</h3>
            <DataTable headers={["Mint", "Handle", "Tweets", "Views", "Likes", "Bot", "First", "Last"]}>
              {twitterShillers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                twitterShillers.map((row: TwitterShillerRow) => (
                  <TableRow key={`${row.mint}-${row.handle}`}>
                    <TableCell>{short(row.mint)}</TableCell>
                    <TableCell>{short(row.handle)}</TableCell>
                    <TableCell right>{formatCompact(row.tweetsCount)}</TableCell>
                    <TableCell right>{formatCompact(row.totalViews)}</TableCell>
                    <TableCell right>{formatCompact(row.totalLikes)}</TableCell>
                    <TableCell>{row.isBot ? "yes" : "no"}</TableCell>
                    <TableCell>{formatDateTime(row.firstTweetedAt)}</TableCell>
                    <TableCell>{formatDateTime(row.lastTweetedAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<FileText className="h-4 w-4" />}
            title={t("database.tables")}
            subtitle={t("database.allTables")}
          />
          <DataTable headers={[t("database.tables"), t("database.rows")]}>
            {data.tableCounts.map((row) => (
              <TableRow key={row.table}>
                <TableCell>{row.table}</TableCell>
                <TableCell right>{row.rows === null ? "—" : row.rows.toLocaleString("ru-RU")}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Files className="h-4 w-4" />}
            title={t("database.tokenMigrations")}
            subtitle={t("database.description")}
          />
          <KeyValueTable
            rows={[
              { metric: "Импорт-файлы", value: formatCompact(tableCountsByName.get("migration_xlsx_files") ?? 0), hint: "уникальные пути к файлам" },
              { metric: "Строки токенов", value: formatCompact(tableCountsByName.get("migration_token_rows") ?? 0), hint: "распарсенные token-отчёты" },
              { metric: "Строки кошельков", value: formatCompact(tableCountsByName.get("migration_wallet_rows") ?? 0), hint: "распарсенные wallet-отчёты" },
            ]}
          />
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.migrationTypes")}</h3>
            <DataTable headers={[t("database.file"), t("database.rowsCount"), t("database.tokenRows"), t("database.walletRows")]}>
              {data.migrationKinds.length > 0 ? (
                data.migrationKinds.map((row) => (
                  <TableRow key={row.workbookKind}>
                    <TableCell>{row.workbookKind}</TableCell>
                    <TableCell right>{formatCompact(row.files)}</TableCell>
                    <TableCell right>{formatCompact(row.tokenRows)}</TableCell>
                    <TableCell right>{formatCompact(row.walletRows)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4}>{t("database.noData")}</TableCell>
                </TableRow>
              )}
            </DataTable>
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.recentImports")}</h3>
            <DataTable headers={[t("database.file"), t("database.sheet"), t("database.rowsCount"), t("database.rows"), t("database.tokens"), t("database.wallet"), t("database.importedAt")]}>
              {data.recentImports.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                data.recentImports.map((row) => (
                  <TableRow key={`${row.fileName}-${row.importedAt}`}>
                    <TableCell>{row.fileName}</TableCell>
                    <TableCell>{row.workbookKind}</TableCell>
                    <TableCell right>{formatCompact(row.sheetCount)}</TableCell>
                    <TableCell right>{formatCompact(row.totalRows)}</TableCell>
                    <TableCell right>{formatCompact(row.tokenRows)}</TableCell>
                    <TableCell right>{formatCompact(row.walletRows)}</TableCell>
                    <TableCell>{formatDateTime(row.importedAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>
      </section>

      <section className={panelClass("space-y-4")}>
        <SectionTitle
          icon={<Sparkles className="h-4 w-4" />}
          title={t("database.recentImports")}
          subtitle={t("database.description")}
        />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.tokenRows")}</h3>
            <DataTable headers={[t("database.token"), t("database.ticker"), t("database.creator"), t("database.maxMc"), t("database.buyers")]}>
              {recentTokens.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                recentTokens.map((row) => (
                  <TableRow key={`${row.fileName}-${row.tokenAddress}`}>
                    <TableCell>{short(row.tokenAddress)}</TableCell>
                    <TableCell>{row.ticker ?? "—"}</TableCell>
                    <TableCell>{short(row.creator ?? "—")}</TableCell>
                    <TableCell right>{formatCompact(row.marketCapMax ?? row.currentMc)}</TableCell>
                    <TableCell right>{formatCompact(row.totalUniqueBuyers)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.walletRows")}</h3>
            <DataTable headers={[t("database.wallet"), t("database.pnl"), t("database.roi"), t("database.tokens"), t("database.migrated")]}>
              {recentWallets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                recentWallets.map((row) => (
                  <TableRow key={`${row.fileName}-${row.sheetName}-${row.rowIndex}-${row.wallet}`}>
                    <TableCell>{short(row.wallet)}</TableCell>
                    <TableCell right>{formatNumber(row.pnl)}</TableCell>
                    <TableCell right>{formatPercent(row.roi)}</TableCell>
                    <TableCell right>{formatCompact(row.totalTokens)}</TableCell>
                    <TableCell right>{formatCompact(row.migratedTokens)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Coins className="h-4 w-4" />}
            title="Recent market events"
            subtitle="Latest on-chain launch, migration, and trade records collected from the blockchain pipeline."
          />
          <DataTable headers={["Kind", "Mint", "Trader", "SOL", "MC", "Source", "Observed"]}>
            {recentMarketEvents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>{t("database.noData")}</TableCell>
              </TableRow>
            ) : (
              recentMarketEvents.map((row: MarketEventRow) => (
                <TableRow key={row.eventId}>
                  <TableCell>{row.kind}</TableCell>
                  <TableCell>{short(row.mint ?? "—")}</TableCell>
                  <TableCell>{short(row.trader ?? "—")}</TableCell>
                  <TableCell right>{formatSol(row.amountSol)}</TableCell>
                  <TableCell right>{formatSol(row.marketCapSol)}</TableCell>
                  <TableCell>{row.source}</TableCell>
                  <TableCell>{formatDateTime(row.observedAt)}</TableCell>
                </TableRow>
              ))
            )}
          </DataTable>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Activity className="h-4 w-4" />}
            title="Recent token trades"
            subtitle="Normalized trade rows stored for wallet and token-level analytics."
          />
          <DataTable headers={["Mint", "Trader", "Type", "SOL", "Tokens", "Price", "Observed"]}>
            {recentTokenTrades.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>{t("database.noData")}</TableCell>
              </TableRow>
            ) : (
              recentTokenTrades.map((row: TokenTradeRow) => (
                <TableRow key={`${row.mint}-${row.signature}`}>
                  <TableCell>{short(row.mint)}</TableCell>
                  <TableCell>{short(row.trader)}</TableCell>
                  <TableCell>{row.type}</TableCell>
                  <TableCell right>{formatSol(row.amountSol)}</TableCell>
                  <TableCell right>{formatCompact(row.amountTokens)}</TableCell>
                  <TableCell right>{formatSol(row.priceSol)}</TableCell>
                  <TableCell>{formatDateTime(row.timestamp)}</TableCell>
                </TableRow>
              ))
            )}
          </DataTable>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<TrendingUp className="h-4 w-4" />}
            title={t("database.leaderboard")}
            subtitle={t("database.description")}
          />
          <div className="space-y-6">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-white">{t("database.tokenRows")}</h3>
              <DataTable headers={[t("database.token"), t("database.ticker"), t("database.creator"), t("database.maxMc"), t("database.buyers")]}>
                {topMigrationTokens.map((row) => (
                  <TableRow key={row.tokenAddress}>
                    <TableCell>{short(row.tokenAddress)}</TableCell>
                    <TableCell>{row.ticker ?? "—"}</TableCell>
                    <TableCell>{short(row.creator ?? "—")}</TableCell>
                    <TableCell right>{formatCompact(row.marketCapMax ?? row.currentMc)}</TableCell>
                    <TableCell right>{formatCompact(row.totalUniqueBuyers)}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-white">{t("database.leaderboard")}</h3>
                <DataTable headers={[t("database.wallet"), t("database.pnl"), t("database.roi")]}>
                  {topMigrationWallets.map((row) => (
                    <TableRow key={row.wallet}>
                      <TableCell>{short(row.wallet)}</TableCell>
                      <TableCell right>{formatNumber(row.pnl)}</TableCell>
                      <TableCell right>{formatPercent(row.roi)}</TableCell>
                    </TableRow>
                  ))}
                </DataTable>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-white">{t("database.performance")}</h3>
                <DataTable headers={[t("database.wallet"), t("database.pnl"), t("database.roi")]}>
                  {worstMigrationWallets.map((row) => (
                    <TableRow key={row.wallet}>
                      <TableCell>{short(row.wallet)}</TableCell>
                      <TableCell right>{formatNumber(row.pnl)}</TableCell>
                      <TableCell right>{formatPercent(row.roi)}</TableCell>
                    </TableRow>
                  ))}
                </DataTable>
              </div>
            </div>
          </div>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Users className="h-4 w-4" />}
            title={t("database.devWallets")}
            subtitle={t("database.description")}
          />
          <KeyValueTable
            rows={[
              { metric: "По токенам", value: formatCompact(devWalletsTokens.length), hint: "сортировка по общему числу токенов" },
              { metric: "По миграции", value: formatCompact(devWalletsMigration.length), hint: "сортировка по rate миграции" },
              { metric: "По 300k", value: formatCompact(devWallets300k.length), hint: "сортировка по rate 300k" },
            ]}
          />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.leaderboard")}</h3>
            <DataTable headers={[t("database.creator"), t("database.tokens"), t("database.migrated"), t("database.maxMc")]}>
              {topCreators.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                topCreators.map((row) => (
                  <TableRow key={row.creator}>
                    <TableCell>{short(row.creator)}</TableCell>
                    <TableCell right>{formatCompact(row.tokens)}</TableCell>
                    <TableCell right>{formatCompact(row.migrated)}</TableCell>
                    <TableCell right>{formatCompact(row.avgMcap)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-white">{t("database.devWallets")}</h3>
              <DataTable headers={[t("database.wallet"), t("database.tokens"), t("database.migrated"), "300k"]}>
                {devWalletsTokens.map((row: DevWalletRow) => (
                  <TableRow key={row.address}>
                    <TableCell>{short(row.address)}</TableCell>
                    <TableCell right>{formatCompact(row.totalTokens)}</TableCell>
                    <TableCell right>{formatCompact(row.migratedCount)}</TableCell>
                    <TableCell right>{formatCompact(row.reached300kCount)}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-white">{t("database.migrationSpeed")}</h3>
              <DataTable headers={[t("database.wallet"), t("database.migrated"), "300k", "Hour"]}>
                {devWalletsMigration.map((row: DevWalletRow) => (
                  <TableRow key={row.address}>
                    <TableCell>{short(row.address)}</TableCell>
                    <TableCell right>{formatPercent(row.migrationRate * 100)}</TableCell>
                    <TableCell right>{formatPercent(row.rate300k * 100)}</TableCell>
                    <TableCell right>{row.bestLaunchHour === null ? "—" : `${row.bestLaunchHour}:00`}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Bot className="h-4 w-4" />}
            title={t("database.devTokens")}
            subtitle={t("database.description")}
          />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.devTokens")}</h3>
            <DataTable headers={[t("database.token"), t("database.ticker"), t("database.creator"), "ATH", t("database.migrated")]}>
              {devTokens.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                devTokens.map((row) => (
                  <TableRow key={`${row.creator}-${row.mint}`}>
                    <TableCell>{short(row.mint)}</TableCell>
                    <TableCell>{row.symbol ?? row.name ?? "—"}</TableCell>
                    <TableCell>{short(row.creator)}</TableCell>
                    <TableCell right>{formatCompact(row.athUsd ?? row.marketCapUsd)}</TableCell>
                    <TableCell right>{row.reached300k ? "да" : "нет"}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.forensics")}</h3>
            <DataTable headers={[t("database.creator"), t("database.token"), t("database.tokens"), t("database.migrated"), "Share"]}>
              {devForensics.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                devForensics.map((row) => (
                  <TableRow key={`${row.creator}-${row.analyzedAt}`}>
                    <TableCell>{short(row.creator)}</TableCell>
                    <TableCell>{short(row.sourceMint ?? "—")}</TableCell>
                    <TableCell right>{formatCompact(row.totalCreatedTokens)}</TableCell>
                    <TableCell right>{formatCompact(row.totalMigratedTokens)}</TableCell>
                    <TableCell right>{formatPercent(row.migrationRate * 100)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Wallet className="h-4 w-4" />}
            title={t("database.analytics")}
            subtitle={t("database.description")}
          />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.leaderboard")}</h3>
            <DataTable headers={[t("database.wallet"), t("database.pnl"), "Volume", t("database.tokens"), "Buys/Sells"]}>
              {topWalletStats.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                topWalletStats.map((row) => (
                  <TableRow key={row.address}>
                    <TableCell>{short(row.address)}</TableCell>
                    <TableCell right>{formatNumber(row.totalPnlSol)}</TableCell>
                    <TableCell right>{formatSol(row.totalVolumeSol)}</TableCell>
                    <TableCell right>{formatCompact(row.tokensTraded)}</TableCell>
                    <TableCell right>{formatCompact(row.totalBuys)}/{formatCompact(row.totalSells)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.tokenRows")}</h3>
            <DataTable headers={[t("database.wallet"), "Mint", t("database.pnl"), "Volume", "Status"]}>
              {topWalletTokenStats.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                topWalletTokenStats.map((row) => (
                  <TableRow key={`${row.address}-${row.mint}`}>
                    <TableCell>{short(row.address)}</TableCell>
                    <TableCell>{short(row.mint)}</TableCell>
                    <TableCell right>{formatNumber(row.pnlSol)}</TableCell>
                    <TableCell right>{formatSol(row.volumeSol)}</TableCell>
                    <TableCell right>{`${row.isFresh ? "чистый" : ""}${row.isWash ? (row.isFresh ? ", " : "") + "подозрительный" : ""}` || "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.mints")}</h3>
            <DataTable headers={["Mint", t("database.analytics"), "Volume", t("database.wallet"), "Dev"]}>
              {analyzedMints.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                analyzedMints.map((row) => (
                  <TableRow key={row.mint}>
                    <TableCell>{short(row.mint)}</TableCell>
                    <TableCell right>{formatCompact(row.analysesCount)}</TableCell>
                    <TableCell right>{formatSol(row.totalVolumeSol)}</TableCell>
                    <TableCell right>{formatCompact(row.uniqueWallets)}</TableCell>
                    <TableCell>{short(row.devAddress ?? "—")}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<BarChart3 className="h-4 w-4" />}
            title={t("database.marketCollector")}
            subtitle={t("database.description")}
          />
          <KeyValueTable
            rows={[
              { metric: t("database.marketEvents"), value: formatCompact(marketStatus.events), hint: "all market events" },
              { metric: t("database.launches"), value: formatCompact(marketStatus.launches), hint: "collector launches" },
              { metric: t("database.migrations"), value: formatCompact(marketStatus.migrations), hint: "collector migrations" },
              { metric: "Trades", value: formatCompact(marketStatus.trades), hint: "collector trades" },
              { metric: "24h " + t("database.launches"), value: formatCompact(marketAgg.launched), hint: "from market_events" },
              { metric: "24h " + t("database.migrations"), value: formatCompact(marketAgg.migrated), hint: "from market_events" },
              { metric: "24h Volume", value: formatSol(marketAgg.totalVolumeSol), hint: "trading volume" },
              { metric: "24h Traders", value: formatCompact(marketAgg.totalTraders), hint: "unique traders" },
              { metric: "24h Active", value: formatCompact(marketAgg.activeTokens), hint: "active tokens" },
              { metric: "Avg mcap", value: formatSol(marketAgg.avgMarketCapSol), hint: `${formatCompact(marketAgg.sampledMarketCaps)} samples` },
            ]}
          />
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.status")}</h3>
            <DataTable headers={[t("database.source"), t("database.status")]}>
              <TableRow>
                <TableCell>{t("database.lastEvent")}</TableCell>
                <TableCell>{formatDateTime(marketStatus.lastEventAt)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Total events</TableCell>
                <TableCell>{formatCompact(marketStatus.events)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>{t("database.launches")} / {t("database.migrations")} / Trades</TableCell>
                <TableCell>
                  {formatCompact(marketStatus.launches)} / {formatCompact(marketStatus.migrations)} / {formatCompact(marketStatus.trades)}
                </TableCell>
              </TableRow>
            </DataTable>
          </div>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<RefreshCcw className="h-4 w-4" />}
            title={t("database.apifyRuns")}
            subtitle={t("database.description")}
          />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.apifyRuns")}</h3>
            <DataTable headers={[t("database.runId"), "Actor", t("database.status"), t("database.datasetId"), t("database.importedAt")]}>
              {apifyRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                apifyRuns.map((row) => (
                  <TableRow key={row.runId}>
                    <TableCell>{short(row.runId)}</TableCell>
                    <TableCell>{short(row.actorId)}</TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell>{short(row.defaultDatasetId ?? "—")}</TableCell>
                    <TableCell>{formatDateTime(row.lastSyncedAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.apifyRuns")}</h3>
            <DataTable headers={[t("database.source"), t("database.runId"), t("database.status"), "Items", t("database.tokens")]}>
              {apifySyncEvents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                apifySyncEvents.map((row) => (
                  <TableRow key={`${row.source}-${row.createdAt}`}>
                    <TableCell>{row.source}</TableCell>
                    <TableCell>{short(row.runId ?? "—")}</TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell right>{formatCompact(row.importedItems)}</TableCell>
                    <TableCell right>{formatCompact(row.importedTokens)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Clock3 className="h-4 w-4" />}
            title={t("database.migrationTypes")}
            subtitle={t("database.description")}
          />
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">{t("database.recentImports")}</h3>
            <DataTable headers={[t("database.file"), "Type", t("database.sheet"), t("database.rows"), t("database.importedAt")]}>
              {data.recentImports.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>{t("database.noData")}</TableCell>
                </TableRow>
              ) : (
                data.recentImports.map((row) => (
                  <TableRow key={`${row.fileName}-${row.importedAt}`}>
                    <TableCell>{row.fileName}</TableCell>
                    <TableCell>{row.workbookKind}</TableCell>
                    <TableCell right>{formatCompact(row.sheetCount)}</TableCell>
                    <TableCell right>{formatCompact(row.totalRows)}</TableCell>
                    <TableCell>{formatDateTime(row.importedAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </DataTable>
          </div>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<AlertTriangle className="h-4 w-4" />}
            title="Быстрые команды"
            subtitle="Команды для аудита и репорта базы данных из терминала."
          />
          <div className="grid grid-cols-1 gap-3 text-sm text-white/70">
            <div className="surface-panel-hero px-3 py-3">
              <div className="text-xs uppercase tracking-[0.18em] text-white/35">Отчёт</div>
              <div className="mt-1 font-mono text-white">npm run db:report</div>
            </div>
            <div className="surface-panel-hero px-3 py-3">
              <div className="text-xs uppercase tracking-[0.18em] text-white/35">Аудит</div>
              <div className="mt-1 font-mono text-white">npm run db:audit</div>
            </div>
            <div className="surface-panel-hero px-3 py-3">
              <div className="text-xs uppercase tracking-[0.18em] text-white/35">Импорт XLSX</div>
              <div className="mt-1 font-mono text-white">npm run migrations:import</div>
            </div>
            <div className="surface-panel-hero px-3 py-3 text-xs text-white/45">
              Файл БД: <span className="text-white/70">{data.dbPath}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
