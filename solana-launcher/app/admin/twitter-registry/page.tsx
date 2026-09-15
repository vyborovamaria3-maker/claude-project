"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Twitter, RefreshCw, Play, CheckCircle2, AlertTriangle, ShieldAlert, Database, Search, Filter, Layers, Activity, Clock, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Overview {
  status: string;
  x_api_configured: boolean;
  mode: string;
  total_candidates: number;
  candidate_status_counts: Record<string, number>;
  total_accounts: number;
  total_evidence: number;
  total_posts: number;
  last_run: string | null;
  last_successful_run: string | null;
  last_failed_run: string | null;
  last_new_candidate: string | null;
  last_new_evidence: string | null;
  last_promoted_account: string | null;
  last_run_duration_seconds: number | null;
  worker_id: string | null;
}

interface CandidateItem {
  id: number;
  candidate_key: string;
  twitter_id: string | null;
  username: string | null;
  display_name: string | null;
  status: string;
  priority: number;
  depth: number;
  relevance_hint: number;
  account_id: number | null;
  attempts: number;
  last_error: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  discovery_score: number;
  confidence: number;
  promotion_ready: boolean;
}

interface AccountItem {
  id: number;
  twitter_id: string;
  username: string | null;
  display_name: string | null;
  account_type: string;
  status: string;
  followers_count: number;
  following_count: number;
  tweet_count: number;
  verified: boolean;
  source: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  alpha_score: number;
  trust_score: number;
  influence_score: number;
}

interface RunItem {
  id: number;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  worker_id: string | null;
  mode: string;
  trigger: string;
  candidates_created: number;
  evidence_created: number;
  rescored: number;
  promoted: number;
  failed: number;
  error: string | null;
}

interface ConfigData {
  discovery_enabled: boolean;
  dexscreener_enabled: boolean;
  coinmarketcap_enabled: boolean;
  seed_discovery_enabled: boolean;
  public_web_enabled: boolean;
  x_api_enrichment_enabled: boolean;
  cmc_limit: number;
  rescore_limit: number;
  process_limit: number;
  network_limit: number;
  max_depth: number;
  min_relevance: number;
  batch_size: number;
  updated_at: string | null;
}

export default function TwitterRegistryAdminPage() {
  const [activeTab, setActiveTab] = useState<"overview" | "candidates" | "accounts" | "evidence" | "runs" | "config">("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [candidates, setCandidates] = useState<CandidateItem[]>([]);
  const [candidateTotal, setCandidateTotal] = useState<number>(0);
  const [candidatePage, setCandidatePage] = useState<number>(0);
  const [candidateStatusFilter, setCandidateStatusFilter] = useState<string>("");
  const [candidateSearch, setCandidateSearch] = useState<string>("");

  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [accountTotal, setAccountTotal] = useState<number>(0);
  const [runs, setRuns] = useState<RunItem[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [selectedCandidateDetail, setSelectedCandidateDetail] = useState<any | null>(null);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/twitter-registry/overview");
      if (res.ok) {
        setOverview(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch overview", err);
    }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/twitter-registry/config");
      if (res.ok) {
        setConfig(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch config", err);
    }
  }, []);

  const fetchCandidates = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        limit: "25",
        offset: String(candidatePage * 25),
      });
      if (candidateStatusFilter) params.append("status", candidateStatusFilter);
      if (candidateSearch) params.append("search", candidateSearch);

      const res = await fetch(`/api/admin/twitter-registry/candidates?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setCandidates(data.items);
        setCandidateTotal(data.meta.total);
      }
    } catch (err) {
      console.error("Failed to fetch candidates", err);
    }
  }, [candidatePage, candidateStatusFilter, candidateSearch]);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/twitter-registry/accounts?limit=25");
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.items);
        setAccountTotal(data.meta.total);
      }
    } catch (err) {
      console.error("Failed to fetch accounts", err);
    }
  }, []);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/twitter-registry/runs?limit=20");
      if (res.ok) {
        const data = await res.json();
        setRuns(data.items);
      }
    } catch (err) {
      console.error("Failed to fetch runs", err);
    }
  }, []);

  const loadAllData = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      fetchOverview(),
      fetchConfig(),
      fetchCandidates(),
      fetchAccounts(),
      fetchRuns(),
    ]);
    setLoading(false);
  }, [fetchOverview, fetchConfig, fetchCandidates, fetchAccounts, fetchRuns]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  useEffect(() => {
    fetchCandidates();
  }, [candidatePage, candidateStatusFilter, candidateSearch, fetchCandidates]);

  const handleRunDiscovery = async () => {
    setActionLoading(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/twitter-registry/actions/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "admin_ui" }),
      });
      const data = await res.json();
      if (res.ok) {
        setNotice({ type: "success", message: `Discovery run completed successfully. Created candidates: ${data.summary?.seed_discovered || 0}` });
        loadAllData();
      } else {
        setNotice({ type: "error", message: data.detail || "Failed to execute discovery run" });
      }
    } catch (err) {
      setNotice({ type: "error", message: "Network error executing discovery run" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRescore = async () => {
    setActionLoading(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/twitter-registry/actions/rescore", {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        setNotice({ type: "success", message: `Successfully rescored ${data.stats?.rescored || 0} candidates.` });
        loadAllData();
      } else {
        setNotice({ type: "error", message: data.detail || "Failed to rescore" });
      }
    } catch (err) {
      setNotice({ type: "error", message: "Network error during rescore" });
    } finally {
      setActionLoading(false);
    }
  };

  const handlePromote = async (candidateId: number) => {
    setActionLoading(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/twitter-registry/actions/candidates/${candidateId}/promote`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        setNotice({ type: "success", message: `Candidate successfully promoted to canonical account ID ${data.account_id}` });
        loadAllData();
      } else {
        setNotice({ type: "error", message: data.detail || "Promotion failed" });
      }
    } catch (err) {
      setNotice({ type: "error", message: "Network error during promotion" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateConfig = async (newConfig: Partial<ConfigData>) => {
    setActionLoading(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/twitter-registry/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      const data = await res.json();
      if (res.ok) {
        setConfig(data.config);
        setNotice({ type: "success", message: "Discovery configuration updated successfully." });
      } else {
        setNotice({ type: "error", message: data.detail || "Failed to update config" });
      }
    } catch {
      setNotice({ type: "error", message: "Network error updating config" });
    } finally {
      setActionLoading(false);
    }
  };

  const viewCandidateDetail = async (id: number) => {
    try {
      const res = await fetch(`/api/admin/twitter-registry/candidates/${id}`);
      if (res.ok) {
        setSelectedCandidateDetail(await res.json());
      }
    } catch (err) {
      console.error("Failed to load candidate detail", err);
    }
  };

  return (
    <div className="w-full max-w-[1480px] mx-auto space-y-6 py-6 px-4">
      {/* Hero Section */}
      <section className="surface-panel-hero relative overflow-hidden p-6 rounded-2xl border border-bg-border bg-[linear-gradient(160deg,color-mix(in_srgb,var(--theme-bg-elevated)_100%,white_4%),var(--theme-bg-card)_72%)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary-border/60 bg-primary-soft px-3 py-1 text-xs font-semibold text-primary">
              <Twitter className="h-4 w-4" />
              Twitter / X Registry Intelligence
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-content">
              Twitter Registry & Discovery Control
            </h1>
            <p className="text-sm text-content-muted max-w-2xl">
              Monitor candidate queues, evidence trails, discovery scores, canonical account promotion, and live worker health.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={loadAllData} disabled={loading || actionLoading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="secondary" onClick={handleRescore} disabled={actionLoading}>
              Rescore Queue
            </Button>
            <Button onClick={handleRunDiscovery} disabled={actionLoading}>
              <Play className="h-4 w-4 fill-current" />
              Run Discovery
            </Button>
          </div>
        </div>

        {/* Notice Banner */}
        {notice && (
          <div className={`mt-4 p-3 rounded-xl border text-sm flex items-center gap-2 ${notice.type === "success" ? "border-success-border bg-success-soft text-success" : "border-danger-border bg-danger-soft text-danger"}`}>
            {notice.type === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
            <span>{notice.message}</span>
          </div>
        )}
      </section>

      {/* Public Mode Warning Banner if X API not configured */}
      {overview && !overview.x_api_configured && (
        <div className="rounded-2xl border border-warning-border bg-warning-soft p-4 text-warning flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="space-y-1 text-sm">
            <p className="font-semibold">Public Discovery Mode Active (X API: Not Configured)</p>
            <p className="text-content-muted">
              Stable numeric X user IDs may be unavailable via public web & DexScreener/CMC sources, so some candidates cannot yet be promoted to canonical accounts until stable IDs are resolved or X API is configured.
            </p>
          </div>
        </div>
      )}

      {/* Status / Health Cards */}
      {overview && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Discovery Status</CardDescription>
              <CardTitle className="text-xl capitalize flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${overview.status === "running" ? "bg-success animate-pulse" : overview.status === "failed" ? "bg-danger" : "bg-warning"}`} />
                {overview.status}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-content-muted">
                Mode: <span className="font-mono text-content">{overview.mode}</span> | X API: <span className="font-mono text-content">{overview.x_api_configured ? "true" : "false"}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Candidates Queue</CardDescription>
              <CardTitle className="text-xl font-mono">{overview.total_candidates}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-content-muted flex flex-wrap gap-2">
                <span>Queued: {overview.candidate_status_counts["queued"] || 0}</span>
                <span>Accepted: {overview.candidate_status_counts["accepted"] || 0}</span>
                <span>Retry: {overview.candidate_status_counts["retry"] || 0}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Canonical Accounts</CardDescription>
              <CardTitle className="text-xl font-mono">{overview.total_accounts}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-content-muted">
                Evidence items: {overview.total_evidence} | Posts: {overview.total_posts}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Last Run Duration</CardDescription>
              <CardTitle className="text-xl font-mono">
                {overview.last_run_duration_seconds !== null ? `${overview.last_run_duration_seconds.toFixed(1)}s` : "N/A"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-content-muted truncate">
                Worker: {overview.worker_id || "None"}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs Navigation */}
      <div className="flex flex-wrap gap-2 border-b border-bg-border pb-3">
        {[
          { id: "overview", label: "Overview & Health" },
          { id: "candidates", label: `Candidates (${candidateTotal})` },
          { id: "accounts", label: `Canonical Accounts (${accountTotal})` },
          { id: "runs", label: "Discovery Runs" },
          { id: "config", label: "Discovery Settings" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${activeTab === tab.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-bg-elevated text-content-muted hover:text-content"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {activeTab === "overview" && overview && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-primary" />
                Pipeline Health & Timestamps
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex justify-between border-b border-bg-border pb-2">
                <span className="text-content-muted">Last Run Started:</span>
                <span className="font-mono">{overview.last_run || "Never"}</span>
              </div>
              <div className="flex justify-between border-b border-bg-border pb-2">
                <span className="text-content-muted">Last Successful Run:</span>
                <span className="font-mono">{overview.last_successful_run || "None"}</span>
              </div>
              <div className="flex justify-between border-b border-bg-border pb-2">
                <span className="text-content-muted">Last Failed Run:</span>
                <span className="font-mono">{overview.last_failed_run || "None"}</span>
              </div>
              <div className="flex justify-between border-b border-bg-border pb-2">
                <span className="text-content-muted">Last New Candidate:</span>
                <span className="font-mono">{overview.last_new_candidate || "None"}</span>
              </div>
              <div className="flex justify-between border-b border-bg-border pb-2">
                <span className="text-content-muted">Last New Evidence:</span>
                <span className="font-mono">{overview.last_new_evidence || "None"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-content-muted">Last Promoted Account:</span>
                <span className="font-mono">{overview.last_promoted_account || "None"}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-primary" />
                Candidate Status Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {Object.entries(overview.candidate_status_counts).map(([st, count]) => (
                <div key={st} className="flex items-center justify-between p-3 rounded-xl bg-bg-elevated border border-bg-border">
                  <span className="capitalize font-medium text-content">{st}</span>
                  <Badge variant={st === "accepted" ? "success" : st === "rejected" || st === "dead" ? "danger" : "default"}>
                    {count}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tab: Candidates */}
      {activeTab === "candidates" && (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Discovery Candidates Frontier</CardTitle>
                <CardDescription>Server-side paginated queue of discovered handles and handles pending promotion.</CardDescription>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-content-faint" />
                  <input
                    type="text"
                    placeholder="Search handle..."
                    value={candidateSearch}
                    onChange={(e) => setCandidateSearch(e.target.value)}
                    className="rounded-xl border border-bg-border bg-bg-card pl-9 pr-3 py-2 text-sm text-content outline-none focus:border-primary"
                  />
                </div>
                <select
                  value={candidateStatusFilter}
                  onChange={(e) => setCandidateStatusFilter(e.target.value)}
                  className="rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm text-content outline-none focus:border-primary"
                >
                  <option value="">All Statuses</option>
                  <option value="queued">Queued</option>
                  <option value="processing">Processing</option>
                  <option value="accepted">Accepted (Promoted)</option>
                  <option value="rejected">Rejected</option>
                  <option value="retry">Retry</option>
                  <option value="dead">Dead</option>
                </select>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-bg-border text-content-muted">
                  <tr>
                    <th className="py-3 px-4">Handle</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Score</th>
                    <th className="py-3 px-4">Confidence</th>
                    <th className="py-3 px-4">Twitter ID</th>
                    <th className="py-3 px-4">Last Seen</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bg-border">
                  {candidates.map((c) => (
                    <tr key={c.id} className="hover:bg-bg-elevated/50">
                      <td className="py-3 px-4 font-semibold text-content">
                        {c.username ? `@${c.username}` : c.candidate_key}
                      </td>
                      <td className="py-3 px-4">
                        <Badge variant={c.status === "accepted" ? "success" : c.status === "rejected" ? "danger" : "default"}>
                          {c.status}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 font-mono">{c.discovery_score.toFixed(1)}</td>
                      <td className="py-3 px-4 font-mono">{c.confidence.toFixed(1)}%</td>
                      <td className="py-3 px-4 font-mono text-xs text-content-muted">
                        {c.twitter_id || <span className="text-warning">Unavailable</span>}
                      </td>
                      <td className="py-3 px-4 text-xs text-content-muted">
                        {c.last_seen_at ? new Date(c.last_seen_at).toLocaleString() : "N/A"}
                      </td>
                      <td className="py-3 px-4 text-right space-x-2">
                        <Button size="sm" variant="outline" onClick={() => viewCandidateDetail(c.id)}>
                          Details
                        </Button>
                        {!c.account_id && (
                          <Button
                            size="sm"
                            variant="success"
                            onClick={() => handlePromote(c.id)}
                            disabled={!c.twitter_id || actionLoading}
                            title={!c.twitter_id ? "Stable X user ID required for canonical promotion" : "Promote to canonical account"}
                          >
                            Promote
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {candidates.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-content-muted">
                        No discovery candidates found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="mt-4 flex items-center justify-between border-t border-bg-border pt-4">
              <span className="text-xs text-content-muted">Showing {candidates.length} of {candidateTotal} candidates</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={candidatePage === 0} onClick={() => setCandidatePage(p => Math.max(0, p - 1))}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={(candidatePage + 1) * 25 >= candidateTotal} onClick={() => setCandidatePage(p => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tab: Accounts */}
      {activeTab === "accounts" && (
        <Card>
          <CardHeader>
            <CardTitle>Canonical Twitter Accounts ({accountTotal})</CardTitle>
            <CardDescription>Successfully verified and promoted Twitter/X accounts with stable IDs and crypto metrics.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-bg-border text-content-muted">
                  <tr>
                    <th className="py-3 px-4">Handle</th>
                    <th className="py-3 px-4">Twitter ID</th>
                    <th className="py-3 px-4">Type</th>
                    <th className="py-3 px-4">Followers</th>
                    <th className="py-3 px-4">Alpha Score</th>
                    <th className="py-3 px-4">Verified</th>
                    <th className="py-3 px-4">Last Seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bg-border">
                  {accounts.map((acc) => (
                    <tr key={acc.id} className="hover:bg-bg-elevated/50">
                      <td className="py-3 px-4 font-semibold text-content">@{acc.username || acc.twitter_id}</td>
                      <td className="py-3 px-4 font-mono text-xs">{acc.twitter_id}</td>
                      <td className="py-3 px-4 capitalize">{acc.account_type}</td>
                      <td className="py-3 px-4 font-mono">{acc.followers_count.toLocaleString()}</td>
                      <td className="py-3 px-4 font-mono text-primary">{acc.alpha_score.toFixed(1)}</td>
                      <td className="py-3 px-4">{acc.verified ? <span className="text-success font-semibold">Yes</span> : "No"}</td>
                      <td className="py-3 px-4 text-xs text-content-muted">{acc.last_seen_at ? new Date(acc.last_seen_at).toLocaleString() : "N/A"}</td>
                    </tr>
                  ))}
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-content-muted">No canonical accounts found yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tab: Runs */}
      {activeTab === "runs" && (
        <Card>
          <CardHeader>
            <CardTitle>Discovery Run History</CardTitle>
            <CardDescription>Recent discovery worker executions, triggers, and outcome metrics.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-bg-border text-content-muted">
                  <tr>
                    <th className="py-3 px-4">ID</th>
                    <th className="py-3 px-4">Started At</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Mode</th>
                    <th className="py-3 px-4">Trigger</th>
                    <th className="py-3 px-4">Created</th>
                    <th className="py-3 px-4">Promoted</th>
                    <th className="py-3 px-4">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bg-border">
                  {runs.map((r) => (
                    <tr key={r.id} className="hover:bg-bg-elevated/50">
                      <td className="py-3 px-4 font-mono">#{r.id}</td>
                      <td className="py-3 px-4 text-xs text-content-muted">{r.started_at ? new Date(r.started_at).toLocaleString() : "N/A"}</td>
                      <td className="py-3 px-4">
                        <Badge variant={r.status === "completed" ? "success" : r.status === "failed" ? "danger" : "warning"}>
                          {r.status}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs">{r.mode}</td>
                      <td className="py-3 px-4">{r.trigger}</td>
                      <td className="py-3 px-4 font-mono">{r.candidates_created}</td>
                      <td className="py-3 px-4 font-mono text-success">{r.promoted}</td>
                      <td className="py-3 px-4 text-xs text-danger truncate max-w-[200px]" title={r.error || ""}>{r.error || "None"}</td>
                    </tr>
                  ))}
                  {runs.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-content-muted">No discovery runs recorded yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tab: Config */}
      {activeTab === "config" && config && (
        <Card>
          <CardHeader>
            <CardTitle>Discovery Settings & Parameters</CardTitle>
            <CardDescription>Configure safe execution parameters for Twitter discovery and ingestion cycles.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex items-center justify-between p-4 rounded-xl border border-bg-border bg-bg-elevated">
                <div>
                  <div className="font-semibold text-content">Discovery Enabled</div>
                  <div className="text-xs text-content-muted">Master switch for discovery workers</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.discovery_enabled}
                  onChange={(e) => handleUpdateConfig({ discovery_enabled: e.target.checked })}
                  className="h-5 w-5 accent-primary cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl border border-bg-border bg-bg-elevated">
                <div>
                  <div className="font-semibold text-content">Seed Discovery</div>
                  <div className="text-xs text-content-muted">Load curated crypto media seeds</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.seed_discovery_enabled}
                  onChange={(e) => handleUpdateConfig({ seed_discovery_enabled: e.target.checked })}
                  className="h-5 w-5 accent-primary cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl border border-bg-border bg-bg-elevated">
                <div>
                  <div className="font-semibold text-content">DexScreener / CMC Sources</div>
                  <div className="text-xs text-content-muted">Ingest handles from token market listings</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.coinmarketcap_enabled}
                  onChange={(e) => handleUpdateConfig({ coinmarketcap_enabled: e.target.checked, dexscreener_enabled: e.target.checked })}
                  className="h-5 w-5 accent-primary cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl border border-bg-border bg-bg-elevated">
                <div>
                  <div className="font-semibold text-content">Public Web Scraping</div>
                  <div className="text-xs text-content-muted">Extract X profile links from public sources</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.public_web_enabled}
                  onChange={(e) => handleUpdateConfig({ public_web_enabled: e.target.checked })}
                  className="h-5 w-5 accent-primary cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 pt-4 border-t border-bg-border">
              <div className="space-y-2">
                <label className="text-sm font-medium text-content">Process Limit</label>
                <input
                  type="number"
                  value={config.process_limit}
                  onChange={(e) => handleUpdateConfig({ process_limit: parseInt(e.target.value) || 250 })}
                  className="w-full rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm text-content outline-none focus:border-primary"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-content">Min Relevance Score</label>
                <input
                  type="number"
                  step="0.1"
                  value={config.min_relevance}
                  onChange={(e) => handleUpdateConfig({ min_relevance: parseFloat(e.target.value) || 35.0 })}
                  className="w-full rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm text-content outline-none focus:border-primary"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-content">Max Depth</label>
                <input
                  type="number"
                  value={config.max_depth}
                  onChange={(e) => handleUpdateConfig({ max_depth: parseInt(e.target.value) || 2 })}
                  className="w-full rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm text-content outline-none focus:border-primary"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Candidate Detail Modal / Drawer */}
      {selectedCandidateDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="surface-panel w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-bg-border bg-bg-card p-6 space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-bg-border pb-4">
              <div>
                <h3 className="text-lg font-bold text-content">
                  Candidate: {selectedCandidateDetail.candidate.username ? `@${selectedCandidateDetail.candidate.username}` : selectedCandidateDetail.candidate.candidate_key}
                </h3>
                <p className="text-xs font-mono text-content-muted">ID: {selectedCandidateDetail.candidate.id}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setSelectedCandidateDetail(null)}>
                Close
              </Button>
            </div>

            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 rounded-xl bg-bg-elevated border border-bg-border">
                  <span className="text-xs text-content-muted block">Status</span>
                  <span className="font-semibold capitalize text-content">{selectedCandidateDetail.candidate.status}</span>
                </div>
                <div className="p-3 rounded-xl bg-bg-elevated border border-bg-border">
                  <span className="text-xs text-content-muted block">Discovery Score</span>
                  <span className="font-mono font-bold text-primary">{selectedCandidateDetail.score?.discovery_score || 0}</span>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold text-content text-xs uppercase tracking-wider">Evidence Trail ({selectedCandidateDetail.evidence.length})</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {selectedCandidateDetail.evidence.map((ev: any) => (
                    <div key={ev.id} className="p-3 rounded-xl bg-bg-elevated border border-bg-border text-xs space-y-1">
                      <div className="flex justify-between font-mono text-content-muted">
                        <span>Source: {ev.source_type}</span>
                        <span>{new Date(ev.observed_at).toLocaleString()}</span>
                      </div>
                      <div className="text-content">Reason: {ev.discovery_reason} | Ref: {ev.source_ref}</div>
                    </div>
                  ))}
                </div>
              </div>

              {selectedCandidateDetail.candidate.last_error && (
                <div className="p-3 rounded-xl bg-danger-soft border border-danger-border text-danger text-xs">
                  <span className="font-semibold block">Last Error:</span>
                  {selectedCandidateDetail.candidate.last_error}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
