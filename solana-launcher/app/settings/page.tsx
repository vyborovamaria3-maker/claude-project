"use client";

import { useState } from "react";
import { Settings2 } from "lucide-react";
import { useI18n } from "@/components/providers/I18nProvider";
import MasterWalletCard from "./MasterWalletCard";
import ColorsTab from "./ColorsTab";
import QuickActionsTab from "./QuickActionsTab";
import ActivityTab from "./ActivityTab";
import DiagnosticsTab from "./DiagnosticsTab";
import ApifyTab from "./ApifyTab";

type Tab = "account" | "quick-actions" | "activity" | "colors" | "diagnostics" | "apify";

const TABS: { id: Tab; label: string }[] = [
  { id: "account",       label: "Account" },
  { id: "quick-actions", label: "Quick Actions" },
  { id: "activity",      label: "Activity" },
  { id: "diagnostics",   label: "Diagnostics" },
  { id: "apify",         label: "Apify" },
  { id: "colors",        label: "Colors" },
];

const TAB_LABEL_KEYS: Record<Tab, "settings.tab.account" | "settings.tab.quickActions" | "settings.tab.activity" | "settings.tab.diagnostics" | "settings.tab.apify" | "settings.tab.colors"> = {
  account: "settings.tab.account",
  "quick-actions": "settings.tab.quickActions",
  activity: "settings.tab.activity",
  diagnostics: "settings.tab.diagnostics",
  apify: "settings.tab.apify",
  colors: "settings.tab.colors",
};

// data-tag: page.settings
export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("account");
  const { t } = useI18n();

  return (
    <div data-tag="page.settings" className="w-full max-w-[1480px] mx-auto space-y-6 py-6 sm:py-8 px-0 sm:px-4">
      <section className="surface-panel-hero relative overflow-hidden px-5 py-5 sm:px-6 sm:py-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--page-glow,var(--theme-primary-soft)),transparent_30%),radial-gradient(circle_at_top_right,var(--page-glow-2,var(--theme-cool-glow)),transparent_30%),radial-gradient(circle_at_bottom_right,color-mix(in_srgb,var(--theme-secondary)_8%,transparent),transparent_28%)]" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-content-muted">
              <Settings2 className="h-3.5 w-3.5 text-primary" />
              Control center
            </div>
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight text-content md:text-3xl">{t("settings.title")}</h1>
              <p className="max-w-2xl text-sm leading-6 text-content-muted">{t("settings.description")}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="surface-panel-hero p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {TABS.map((tabItem) => {
            const active = tab === tabItem.id;
            return (
              <button
                key={tabItem.id}
                type="button"
                onClick={() => setTab(tabItem.id)}
                className={[
                  "relative overflow-hidden rounded-2xl border px-4 py-4 text-left transition-all duration-200",
                  active
                    ? "border-primary-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] shadow-[0_16px_42px_-22px_var(--theme-primary-glow),0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_14%,transparent)]"
                    : "border-bg-border bg-[linear-gradient(180deg,var(--theme-bg-elevated),var(--theme-bg-card))] hover:border-primary-border hover:shadow-[0_14px_34px_-24px_var(--theme-primary-glow)]",
                ].join(" ")}
              >
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.08),transparent_40%)]" />
                <div className="relative flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-content-faint">Section</div>
                    <div className="text-base font-semibold text-content" data-tag={"settings.tab." + tabItem.id}>
                      {t(TAB_LABEL_KEYS[tabItem.id])}
                    </div>
                    <div className="text-sm leading-6 text-content-muted">
                      {tabItem.id === "account" && "Wallet access and identity controls."}
                      {tabItem.id === "quick-actions" && "Fast actions and workflow shortcuts."}
                      {tabItem.id === "activity" && "Recent events and usage history."}
                      {tabItem.id === "diagnostics" && "Health checks and runtime signals."}
                      {tabItem.id === "apify" && "Collector and sync integrations."}
                      {tabItem.id === "colors" && "Theme families, gradients, and palette controls."}
                    </div>
                  </div>
                  <div className={[
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border",
                    active ? "border-primary-border bg-bg-soft text-primary shadow-[0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_10%,transparent)]" : "border-bg-border bg-bg-soft text-content-muted",
                  ].join(" ")}>
                    <Settings2 className="h-4 w-4" />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-6">
        {tab === "account" && <AccountTab />}
        {tab === "quick-actions" && <QuickActionsTab />}
        {tab === "activity" && <ActivityTab />}
        {tab === "diagnostics" && <DiagnosticsTab />}
        {tab === "apify" && <ApifyTab />}
        {tab === "colors" && <ColorsTab />}
      </section>
    </div>
  );
}

function AccountTab() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div className="surface-panel px-5 py-5 sm:px-6">
        <h2 className="text-lg font-bold text-content">{t("settings.account.title")}</h2>
        <p className="text-sm text-content-muted mt-0.5">{t("settings.account.description")}</p>
      </div>
      <MasterWalletCard />
    </div>
  );
}
