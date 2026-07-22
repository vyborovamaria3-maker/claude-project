"use client";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Layers, ExternalLink, Clock } from "lucide-react";

type SubTab = "deposits" | "withdrawals" | "launch";

const SUB_TABS: { id: SubTab; label: string; icon: React.ReactNode }[] = [
  { id: "deposits", label: "Deposits", icon: <ArrowDownLeft className="w-3.5 h-3.5" /> },
  { id: "withdrawals", label: "Withdrawals", icon: <ArrowUpRight className="w-3.5 h-3.5" /> },
  { id: "launch", label: "Launch wallets", icon: <Layers className="w-3.5 h-3.5" /> },
];

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <Clock className="w-8 h-8 text-content-faint/20" />
      <p className="text-sm text-content-muted">{label}</p>
    </div>
  );
}

function TxRow({
  sig,
  amount,
  direction,
  time,
  status,
}: {
  sig: string;
  amount: string;
  direction: "in" | "out";
  time: string;
  status: "success" | "fail" | "pending";
}) {
  const statusCls =
    status === "success" ? "text-success bg-success-soft border-success-border" :
    status === "fail" ? "text-danger bg-danger-soft border-danger-border" :
    "text-warning bg-warning-soft border-warning-border";
  const statusLabel = status === "success" ? "OK" : status === "fail" ? "Fail" : "...";

  return (
    <div className="flex items-center justify-between rounded-xl border border-bg-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--theme-bg-elevated)_100%,white_2%),var(--theme-bg-card)_76%)] px-4 py-3 transition hover:border-primary-border group">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${direction === "in" ? "bg-success-soft" : "bg-danger-soft"}`}>
          {direction === "in" ? <ArrowDownLeft className="w-3.5 h-3.5 text-success" /> : <ArrowUpRight className="w-3.5 h-3.5 text-danger" />}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-mono text-content-soft group-hover:text-content transition">
            {sig.slice(0, 8)}…{sig.slice(-6)}
          </p>
          <p className="text-[11px] text-content-faint mt-0.5">{time}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`text-sm font-semibold ${direction === "in" ? "text-success" : "text-danger"}`}>
          {direction === "in" ? "+" : "-"}{amount} SOL
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${statusCls}`}>{statusLabel}</span>
        <a
          href={`https://solscan.io/tx/${sig}`}
          target="_blank"
          rel="noreferrer"
          className="opacity-0 group-hover:opacity-100 transition text-content-faint hover:text-content"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
    </div>
  );
}

// data-tag: settings.activity
export default function ActivityTab() {
  const [sub, setSub] = useState<SubTab>("deposits");

  const deposits: React.ComponentProps<typeof TxRow>[] = [];
  const withdrawals: React.ComponentProps<typeof TxRow>[] = [];
  const launch: React.ComponentProps<typeof TxRow>[] = [];

  const rows = sub === "deposits" ? deposits : sub === "withdrawals" ? withdrawals : launch;

  return (
    <div className="space-y-5">
      <section className="surface-panel p-5 sm:p-6">
        <h2 className="text-lg font-bold text-content">Activity</h2>
        <p className="text-sm text-content-muted mt-0.5">
          Transaction history for the master wallet and launch wallets.
        </p>
      </section>

      <div className="surface-panel flex flex-wrap items-center gap-2 p-2 w-fit">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSub(t.id)}
            className={[
              "flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200",
              sub === t.id
                ? "border border-primary-border bg-bg-card text-primary shadow-[0_10px_28px_-20px_var(--theme-primary-glow),0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_12%,transparent)]"
                : "border border-transparent bg-transparent text-content-muted hover:text-content hover:border-bg-border hover:bg-bg-soft",
            ].join(" ")}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="surface-panel overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            label={
              sub === "deposits"
                ? "No deposit transactions yet"
                : sub === "withdrawals"
                  ? "No withdrawal transactions yet"
                  : "No launch-wallet transactions yet"
            }
          />
        ) : (
          <div className="p-3 space-y-2">
            {rows.map((r, i) => <TxRow key={i} {...r} />)}
          </div>
        )}
      </div>
    </div>
  );
}
