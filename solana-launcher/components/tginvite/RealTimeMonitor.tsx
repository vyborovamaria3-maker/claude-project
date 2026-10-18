"use client";

import { useEffect, useState } from "react";
import { Activity, AlertCircle, Clock, RefreshCw } from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";
import { parseTGInviteAuditJobs, type TGInviteAuditJob } from "@/lib/tginvite-monitor-data";

/**
 * This UI reports only owner-scoped, server-recorded TGInvite audit entries.
 * The current backend cannot dispatch invitations: no fake live counters,
 * timers, account statuses, completion events or synthetic updates.
 */
export default function RealTimeMonitor() {
  const [jobs, setJobs] = useState<TGInviteAuditJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/tginvite/jobs?limit=50", {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Audit ledger unavailable");
        const parsed = parseTGInviteAuditJobs(await response.json());
        if (!controller.signal.aborted) {
          setJobs(parsed);
          setError(null);
        }
      } catch {
        if (!controller.signal.aborted) {
          setJobs([]);
          setError("The server-owned TGInvite audit ledger could not be loaded. No invitation result can be verified.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh]);

  const blocked = jobs.filter((job) => job.status === "blocked_transport").length;
  const cancelled = jobs.filter((job) => job.status === "cancelled").length;

  return (
    <section className="space-y-6" aria-label="TGInvite server audit monitor">
      <div className={siteDesign.page.panelClassName}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold">
              <Activity className="h-5 w-5 text-[color:var(--theme-primary)]" />
              Telegram audit monitor
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-content-muted">
              Records below come from your authenticated server-side audit ledger, not
              browser simulations. The invitation transport is not enabled, so these
              jobs cannot be counted as sent messages or joined users.
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => { setLoading(true); setRefresh((value) => value + 1); }}
            className={siteDesign.controls.actionButtonClassName}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: "Audit jobs (last 50)", value: error ? "—" : loading ? "…" : String(jobs.length) },
          { label: "Blocked (not sent)", value: error ? "—" : loading ? "…" : String(blocked) },
          { label: "Cancelled (not sent)", value: error ? "—" : loading ? "…" : String(cancelled) },
          { label: "Verified invitations sent", value: "—" },
        ].map((card) => (
          <div key={card.label} className={siteDesign.page.panelClassName}>
            <p className="text-xs text-content-muted">{card.label}</p>
            <div className="mt-2 text-2xl font-bold">{card.value}</div>
          </div>
        ))}
      </div>

      {error && (
        <div role="alert" className="flex gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className={siteDesign.page.panelClassName}>
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Clock className="h-5 w-5" />
          Server audit entries
        </h3>
        {!error && !loading && jobs.length === 0 && (
          <p className="mt-4 text-sm text-content-muted" role="status">
            No audit jobs exist in the current result. This does not mean invitations have been sent.
          </p>
        )}
        {loading && <p className="mt-4 text-sm text-content-muted" role="status">Loading server audit records…</p>}
        {!error && !loading && jobs.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-bg-border text-content-muted">
                <tr>
                  <th scope="col" className="py-3 pr-4">Created</th>
                  <th scope="col" className="py-3 pr-4">Destination</th>
                  <th scope="col" className="py-3 pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr className="border-b border-bg-border" key={job.id}>
                    <td className="py-3 pr-4">{new Date(job.created_at).toLocaleString()}</td>
                    <td className="py-3 pr-4 font-mono">{job.destination_chat_id}</td>
                    <td className="py-3 pr-4">
                      {job.status === "blocked_transport" ? "Blocked — never sent" : "Cancelled — never sent"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-content-muted">
          A confirmed join-request link is not an invitation receipt. No live invitation rate,
          conversion chart, or recipient-success counter is available in the current server.
        </p>
      </div>
    </section>
  );
}
