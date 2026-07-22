"use client";

import type { ReactNode } from "react";
import { Activity, ShieldCheck, Users } from "lucide-react";
import type { DatabaseDashboardData } from "./dashboardData";

type SubscriptionClientRow = DatabaseDashboardData["subscriptionClients"][number];

function formatDateTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDaysRemaining(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value < 0) return `${Math.abs(value)}d expired`;
  return `${value}d left`;
}

function formatRelativeDays(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value}d`;
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("ru-RU");
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

function MetricTable({
  rows,
}: {
  rows: Array<{ metric: string; value: ReactNode; hint?: ReactNode }>;
}) {
  return (
    <div className="surface-table overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-white/40">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Metric</th>
            <th className="px-3 py-2 text-left font-medium">Value</th>
            <th className="px-3 py-2 text-left font-medium">Hint</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric} className="border-t border-bg-border/70">
              <td className="px-3 py-2 text-white">{row.metric}</td>
              <td className="px-3 py-2 text-white/80">{row.value}</td>
              <td className="px-3 py-2 text-white/40">{row.hint ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SubscriptionClientsPanel({ data }: { data: DatabaseDashboardData }) {
  const clients = data.subscriptionClients;
  const tableCountsByName = new Map(data.tableCounts.map((row) => [row.table, row.rows]));

  return (
    <section className="mt-6 space-y-6" data-tag="page.database.subscriptions">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Users className="h-4 w-4" />}
            title="Subscription clients"
            subtitle="Users who bought the monthly plan through Telegram Mini App."
          />

          <MetricTable
            rows={[
              { metric: "Total subscribers", value: formatCount(data.subscriptionSummary.totalSubscribers), hint: "users with active subscription records" },
              { metric: "Active", value: formatCount(data.subscriptionSummary.activeSubscribers), hint: "not expired yet" },
              { metric: "Expiring soon", value: formatCount(data.subscriptionSummary.expiringSoonSubscribers), hint: "expires within 7 days" },
              { metric: "Expired", value: formatCount(data.subscriptionSummary.expiredSubscribers), hint: "already expired" },
            ]}
          />

          <div className="surface-table overflow-hidden">
            <div className="max-h-[440px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 text-white/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">ID</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Telegram</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Login</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Plan</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Purchased</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Expires</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Left</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Age</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Last login</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Login gap</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Last IP</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">IPs</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="px-3 py-6 text-center text-white/40">
                        No subscription clients yet.
                      </td>
                    </tr>
                  ) : (
                    clients.map((row: SubscriptionClientRow) => (
                      <tr key={row.id} className="border-t border-bg-border/70">
                        <td className="px-3 py-2 font-mono text-xs text-white/80">{row.id}</td>
                        <td className="px-3 py-2 text-white/80">
                          <div>{row.telegramUsername ? `@${row.telegramUsername}` : "—"}</div>
                          <div className="text-[11px] text-white/35">{row.telegramId ?? "—"}</div>
                        </td>
                        <td className="px-3 py-2 text-white/80">{row.login ?? "—"}</td>
                        <td className="px-3 py-2 text-white/80">{row.plan}</td>
                        <td className="px-3 py-2 text-white/80">{formatDateTime(row.purchaseAt)}</td>
                        <td className="px-3 py-2 text-white/80">{formatDateTime(row.subscriptionExpiresAt)}</td>
                        <td className="px-3 py-2 text-white/80">{formatDaysRemaining(row.daysRemaining)}</td>
                        <td className="px-3 py-2 text-white/80">{formatRelativeDays(row.daysSincePurchase)}</td>
                        <td className="px-3 py-2 text-white/80">{formatDateTime(row.lastLoginAt)}</td>
                        <td className="px-3 py-2 text-white/80">{formatRelativeDays(row.daysSinceLastLogin)}</td>
                        <td className="px-3 py-2 text-white/80">{row.lastIp ?? "—"}</td>
                        <td className="px-3 py-2 text-right text-white/80">{row.ipCount}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                              row.status === "active"
                                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                                : row.status === "expiring"
                                  ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                                  : row.status === "expired"
                                    ? "border-red-400/30 bg-red-400/10 text-red-200"
                                    : "border-white/20 bg-white/5 text-white/60"
                            }`}
                          >
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className={panelClass("space-y-4")}>
          <SectionTitle
            icon={<Activity className="h-4 w-4" />}
            title="On-chain snapshot"
            subtitle="Tables already populated from blockchain collection and ETL jobs."
          />
          <MetricTable
            rows={[
              { metric: "tokens", value: formatCount(tableCountsByName.get("tokens") ?? 0), hint: "mint registry" },
              { metric: "token_metrics", value: formatCount(tableCountsByName.get("token_metrics") ?? 0), hint: "price and liquidity history" },
              { metric: "wallets", value: formatCount(tableCountsByName.get("wallets") ?? 0), hint: "wallet registry" },
              { metric: "wallet_trades", value: formatCount(tableCountsByName.get("wallet_trades") ?? 0), hint: "wallet trade history" },
              { metric: "wallet_links", value: formatCount(tableCountsByName.get("wallet_links") ?? 0), hint: "wallet graph links" },
              { metric: "market_events", value: formatCount(tableCountsByName.get("market_events") ?? 0), hint: "launch / migration / trade events" },
            ]}
          />

          <div className="rounded-xl border border-sky-400/20 bg-sky-400/10 p-4">
            <div className="mb-2 flex items-center gap-2 text-sky-200">
              <ShieldCheck className="h-4 w-4" />
              <h3 className="text-sm font-semibold">What this panel adds</h3>
            </div>
            <p className="text-sm text-sky-50/80">
              It keeps subscription clients separate from blockchain analytics, so you can audit who paid, when access expires, how often each subscriber signs in, and whether the account looks fresh or stale.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
