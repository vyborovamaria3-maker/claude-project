"use client";

import { useEffect, useState } from "react";
import DatabaseDashboard from "./DatabaseDashboardClient";
import { DatabaseAnalyticsPanel } from "./DatabaseAnalyticsPanel";
import SubscriptionClientsPanel from "./SubscriptionClientsPanel";
import type { DatabaseDashboardData } from "./dashboardData";

export default function DatabasePage() {
  const [data, setData] = useState<DatabaseDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch("/api/database/dashboard", { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load dashboard data (${res.status})`);
        const json = (await res.json()) as DatabaseDashboardData;
        setData(json);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load dashboard data");
      }
    }

    load();
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-[1200px] rounded-2xl border border-red-500/20 bg-red-500/8 p-6 text-sm text-red-100">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-[1200px] rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-white/60">
        Loading database dashboard…
      </div>
    );
  }

  return (
    <>
      <DatabaseDashboard data={data} />
      <DatabaseAnalyticsPanel data={data.analytics} />
      <SubscriptionClientsPanel data={data} />
    </>
  );
}
