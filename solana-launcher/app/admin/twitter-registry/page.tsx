"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, Search, Twitter } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Tab = "overview" | "candidates" | "accounts" | "evidence" | "runs" | "config";
type Notice = { kind: "success" | "error"; text: string } | null;

type WindowMetric = {
  new_candidates: number;
  new_evidence: number;
  new_canonical_accounts: number;
  new_posts: number;
  completed_runs: number;
  failed_runs: number;
  promoted: number;
  rescored: number;
  skipped: number;
  source_breakdown: Record<string, number>;
};

type Overview = {
  status: string;
  x_api_configured: boolean;
  x_api_enrichment_enabled: boolean;
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
  metrics: Record<"1h" | "24h" | "7d", WindowMetric>;
};

type ConfigData = {
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
  updated_by: string | null;
};

const PAGE_SIZE = 25;

function dt(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function JsonBlock({ value, label = "Raw JSON" }: { value: unknown; label?: string }) {
  if (value == null) return null;
  return (
    <details className="rounded-xl border border-bg-border bg-bg-elevated p-3 text-xs">
      <summary className="cursor-pointer font-semibold text-content">{label}</summary>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-content-muted">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-bg-border bg-bg-card p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between gap-4 border-b border-bg-border pb-4">
          <h3 className="text-lg font-bold text-content">{title}</h3>
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        </div>
        <div className="space-y-4">{children}</div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elevated p-3 text-sm">
      <div className="text-xs text-content-muted">{label}</div>
      <div className="mt-1 break-all font-medium text-content">{String(value ?? "—")}</div>
    </div>
  );
}

function Pager({ page, total, setPage }: { page: number; total: number; setPage: (value: number) => void }) {
  const start = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const end = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <div className="mt-4 flex items-center justify-between border-t border-bg-border pt-4 text-xs text-content-muted">
      <span>{start}–{end} of {total}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(Math.max(0, page - 1))}>Previous</Button>
        <Button size="sm" variant="outline" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

async function parseResponse(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return payload;
}

export default function TwitterRegistryAdminPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [draft, setDraft] = useState<ConfigData | null>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidatePage, setCandidatePage] = useState(0);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidateStatus, setCandidateStatus] = useState("");
  const [candidateSource, setCandidateSource] = useState("");
  const [candidateMinScore, setCandidateMinScore] = useState("");
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountTotal, setAccountTotal] = useState(0);
  const [accountPage, setAccountPage] = useState(0);
  const [accountSearch, setAccountSearch] = useState("");
  const [evidence, setEvidence] = useState<any[]>([]);
  const [evidenceTotal, setEvidenceTotal] = useState(0);
  const [evidencePage, setEvidencePage] = useState(0);
  const [evidenceSearch, setEvidenceSearch] = useState("");
  const [evidenceSource, setEvidenceSource] = useState("");
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<any>(null);
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/admin/twitter-registry${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
    });
    return parseResponse(response);
  }, []);

  const loadOverview = useCallback(async () => setOverview(await api("/overview")), [api]);
  const loadConfig = useCallback(async () => {
    const value = await api("/config");
    setConfig(value);
    setDraft(value);
  }, [api]);
  const loadRuns = useCallback(async () => setRuns((await api("/runs?limit=25")).items || []), [api]);

  const loadCandidates = useCallback(async () => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(candidatePage * PAGE_SIZE), sort_by: "score", order: "desc" });
    if (candidateSearch.trim()) p.set("search", candidateSearch.trim());
    if (candidateStatus) p.set("status", candidateStatus);
    if (candidateSource) p.set("source", candidateSource);
    if (candidateMinScore.trim()) p.set("min_score", candidateMinScore.trim());
    const value = await api(`/candidates?${p}`);
    setCandidates(value.items || []);
    setCandidateTotal(value.meta?.total || 0);
  }, [api, candidatePage, candidateSearch, candidateStatus, candidateSource, candidateMinScore]);

  const loadAccounts = useCallback(async () => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(accountPage * PAGE_SIZE) });
    if (accountSearch.trim()) p.set("search", accountSearch.trim());
    const value = await api(`/accounts?${p}`);
    setAccounts(value.items || []);
    setAccountTotal(value.meta?.total || 0);
  }, [api, accountPage, accountSearch]);

  const loadEvidence = useCallback(async () => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(evidencePage * PAGE_SIZE) });
    if (evidenceSearch.trim()) p.set("search", evidenceSearch.trim());
    if (evidenceSource) p.set("source_type", evidenceSource);
    const value = await api(`/evidence?${p}`);
    setEvidence(value.items || []);
    setEvidenceTotal(value.meta?.total || 0);
  }, [api, evidencePage, evidenceSearch, evidenceSource]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadOverview(), loadConfig(), loadRuns(), loadCandidates(), loadAccounts(), loadEvidence()]);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to load Twitter Registry" });
    } finally {
      setLoading(false);
    }
  }, [loadOverview, loadConfig, loadRuns, loadCandidates, loadAccounts, loadEvidence]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void loadCandidates().catch(() => undefined); }, [loadCandidates]);
  useEffect(() => { void loadAccounts().catch(() => undefined); }, [loadAccounts]);
  useEffect(() => { void loadEvidence().catch(() => undefined); }, [loadEvidence]);

  const runAction = useCallback(async (name: string, path: string, message: string, body: unknown = {}) => {
    if (!window.confirm(message)) return;
    setPending(name);
    setNotice(null);
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body) });
      setNotice({ kind: "success", text: `Completed${result.run_id ? ` · run #${result.run_id}` : ""}` });
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Action failed" });
    } finally {
      setPending(null);
    }
  }, [api, refresh]);

  const saveConfig = useCallback(async () => {
    if (!draft || !config) return;
    const changed = Object.fromEntries(
      Object.entries(draft).filter(([key, value]) => !["updated_at", "updated_by"].includes(key) && value !== config[key as keyof ConfigData]),
    );
    if (Object.keys(changed).length === 0) return;
    setPending("config");
    setNotice(null);
    try {
      const result = await api("/config", { method: "PATCH", body: JSON.stringify(changed) });
      setConfig(result.config);
      setDraft(result.config);
      setNotice({ kind: "success", text: "Discovery settings saved." });
      await loadOverview();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to save settings" });
    } finally {
      setPending(null);
    }
  }, [api, config, draft, loadOverview]);

  const sources = useMemo(() => {
    const found = new Set<string>();
    Object.values(overview?.metrics || {}).forEach((metric) => Object.keys(metric.source_breakdown || {}).forEach((name) => found.add(name)));
    ["dexscreener", "coinmarketcap", "curated_seed", "public_web", "x_search"].forEach((name) => found.add(name));
    return [...found].sort();
  }, [overview]);

  const openCandidate = async (id: number) => setSelectedCandidate(await api(`/candidates/${id}`));
  const openAccount = async (id: number) => setSelectedAccount(await api(`/accounts/${id}`));

  const tabs: Array<[Tab, string]> = [
    ["overview", "Overview & Health"],
    ["candidates", `Candidates (${candidateTotal})`],
    ["accounts", `Accounts (${accountTotal})`],
    ["evidence", `Evidence (${evidenceTotal})`],
    ["runs", "Discovery Runs"],
    ["config", "Settings"],
  ];

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6 px-4 py-6">
      <section className="rounded-2xl border border-bg-border bg-bg-card p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary-border/60 bg-primary-soft px-3 py-1 text-xs font-semibold text-primary"><Twitter className="h-4 w-4"/> Twitter / X Registry</div>
            <h1 className="text-2xl font-bold text-content">Discovery Control & Registry Intelligence</h1>
            <p className="mt-1 text-sm text-content-muted">Real database state, evidence, scoring, worker history, source controls and safe manual actions.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void refresh()} disabled={loading || pending !== null}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}/> Refresh</Button>
            <Button variant="secondary" disabled={pending !== null} onClick={() => void runAction("rescore", "/actions/rescore", "Rescore the configured candidate queue now?")}>Rescore Queue</Button>
            <Button variant="secondary" disabled={pending !== null} onClick={() => void runAction("public", "/actions/run-public", "Run enabled public discovery sources (DexScreener / CoinMarketCap)?", { trigger: "admin_public" })}>Run Public Discovery</Button>
            <Button disabled={pending !== null} onClick={() => void runAction("full", "/actions/run", "Run the full enabled discovery pipeline now?", { trigger: "admin_full" })}>Run Discovery</Button>
          </div>
        </div>
        {notice && <div className={`mt-4 rounded-xl border p-3 text-sm ${notice.kind === "error" ? "border-danger-border bg-danger-soft text-danger" : "border-success-border bg-success-soft text-success"}`}>{notice.text}</div>}
      </section>

      {overview && !overview.x_api_configured && (
        <div className="flex gap-3 rounded-2xl border border-warning-border bg-warning-soft p-4 text-sm text-warning"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0"/><div><strong>Public discovery mode is active.</strong><div className="mt-1 text-content-muted">X API is not configured. Handles, evidence and scores still work, but canonical promotion is blocked until a reliable stable numeric X user ID is available.</div></div></div>
      )}

      {overview && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Info label="Discovery status" value={`${overview.status} · ${overview.mode}`}/>
          <Info label="Candidates / accounts" value={`${overview.total_candidates} / ${overview.total_accounts}`}/>
          <Info label="Evidence / posts" value={`${overview.total_evidence} / ${overview.total_posts}`}/>
          <Info label="Worker / duration" value={`${overview.worker_id || "—"} · ${overview.last_run_duration_seconds == null ? "—" : `${overview.last_run_duration_seconds.toFixed(1)}s`}`}/>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-bg-border pb-3">{tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`rounded-xl px-4 py-2 text-sm font-semibold ${tab === id ? "bg-primary text-primary-foreground" : "bg-bg-elevated text-content-muted hover:text-content"}`}>{label}</button>)}</div>

      {tab === "overview" && overview && (
        <div className="space-y-6">
          <Card><CardHeader><CardTitle>Velocity</CardTitle><CardDescription>Real database deltas by time window.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-content-muted"><tr><th className="px-3 py-2">Window</th><th>New candidates</th><th>Evidence</th><th>Accounts</th><th>Posts</th><th>Completed</th><th>Failed</th><th>Promoted</th><th>Rescored</th><th>Skipped</th></tr></thead><tbody>{(["1h","24h","7d"] as const).map((window) => { const m = overview.metrics[window]; return <tr key={window} className="border-t border-bg-border"><td className="px-3 py-3 font-semibold">{window}</td><td>{m.new_candidates}</td><td>{m.new_evidence}</td><td>{m.new_canonical_accounts}</td><td>{m.new_posts}</td><td>{m.completed_runs}</td><td>{m.failed_runs}</td><td>{m.promoted}</td><td>{m.rescored}</td><td>{m.skipped}</td></tr>; })}</tbody></table></div></CardContent></Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Health timestamps</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2"><Info label="Last run" value={dt(overview.last_run)}/><Info label="Last success" value={dt(overview.last_successful_run)}/><Info label="Last failure" value={dt(overview.last_failed_run)}/><Info label="Last candidate" value={dt(overview.last_new_candidate)}/><Info label="Last evidence" value={dt(overview.last_new_evidence)}/><Info label="Last promoted account" value={dt(overview.last_promoted_account)}/></CardContent></Card>
            <Card><CardHeader><CardTitle>Sources · last 24h</CardTitle></CardHeader><CardContent className="grid gap-2 sm:grid-cols-2">{Object.entries(overview.metrics["24h"].source_breakdown).sort((a,b)=>b[1]-a[1]).map(([source,count]) => <div key={source} className="flex items-center justify-between rounded-xl border border-bg-border bg-bg-elevated p-3 text-sm"><span>{source}</span><Badge>{count}</Badge></div>)}</CardContent></Card>
          </div>
        </div>
      )}

      {tab === "candidates" && (
        <Card><CardHeader><CardTitle>Discovery Candidates</CardTitle><CardDescription>Server-side frontier with evidence provenance and safe promotion readiness.</CardDescription></CardHeader><CardContent>
          <div className="mb-4 grid gap-2 md:grid-cols-4"><div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-content-faint"/><input value={candidateSearch} onChange={(e)=>{setCandidateSearch(e.target.value);setCandidatePage(0);}} placeholder="Search handle" className="w-full rounded-xl border border-bg-border bg-bg-card py-2 pl-9 pr-3 text-sm"/></div><select value={candidateStatus} onChange={(e)=>{setCandidateStatus(e.target.value);setCandidatePage(0);}} className="rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm"><option value="">All statuses</option>{["queued","processing","retry","accepted","rejected","dead","duplicate"].map(v=><option key={v} value={v}>{v}</option>)}</select><select value={candidateSource} onChange={(e)=>{setCandidateSource(e.target.value);setCandidatePage(0);}} className="rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm"><option value="">All sources</option>{sources.map(v=><option key={v} value={v}>{v}</option>)}</select><input type="number" min="0" max="100" value={candidateMinScore} onChange={(e)=>{setCandidateMinScore(e.target.value);setCandidatePage(0);}} placeholder="Min score" className="rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm"/></div>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-content-muted"><tr><th className="px-3 py-2">Handle</th><th>Status</th><th>Score</th><th>Confidence</th><th>Evidence</th><th>Sources</th><th>X ID</th><th></th></tr></thead><tbody>{candidates.map((item) => <tr key={item.id} className="border-t border-bg-border"><td className="px-3 py-3 font-semibold">{item.username ? `@${item.username}` : item.candidate_key}</td><td><Badge>{item.status}</Badge></td><td>{Number(item.discovery_score || 0).toFixed(1)}</td><td>{Number(item.confidence || 0).toFixed(1)}%</td><td>{item.evidence_count}</td><td className="max-w-52 text-xs">{(item.sources || []).join(", ") || "—"}</td><td className="font-mono text-xs">{item.twitter_id || "—"}</td><td className="space-x-2 text-right"><Button size="sm" variant="outline" onClick={()=>void openCandidate(item.id)}>Details</Button>{!item.account_id && <Button size="sm" disabled={!item.promotion_ready || pending !== null} onClick={()=>void runAction(`promote-${item.id}`, `/actions/candidates/${item.id}/promote`, `Promote ${item.username ? `@${item.username}` : item.candidate_key} to a canonical account?`)}>Promote</Button>}</td></tr>)}</tbody></table></div>
          <Pager page={candidatePage} total={candidateTotal} setPage={setCandidatePage}/>
        </CardContent></Card>
      )}

      {tab === "accounts" && (
        <Card><CardHeader><CardTitle>Canonical Accounts</CardTitle><CardDescription>Stable-ID accounts with registry scores and true detail counts.</CardDescription></CardHeader><CardContent>
          <div className="relative mb-4 max-w-md"><Search className="absolute left-3 top-2.5 h-4 w-4 text-content-faint"/><input value={accountSearch} onChange={(e)=>{setAccountSearch(e.target.value);setAccountPage(0);}} placeholder="Search handle or X ID" className="w-full rounded-xl border border-bg-border bg-bg-card py-2 pl-9 pr-3 text-sm"/></div>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-content-muted"><tr><th className="px-3 py-2">Handle</th><th>X ID</th><th>Type</th><th>Followers</th><th>Alpha</th><th>Trust</th><th>Source</th><th></th></tr></thead><tbody>{accounts.map((item)=><tr key={item.id} className="border-t border-bg-border"><td className="px-3 py-3 font-semibold">@{item.username || item.twitter_id}</td><td className="font-mono text-xs">{item.twitter_id}</td><td>{item.account_type}</td><td>{Number(item.followers_count || 0).toLocaleString()}</td><td>{Number(item.alpha_score || 0).toFixed(1)}</td><td>{Number(item.trust_score || 0).toFixed(1)}</td><td>{item.source}</td><td className="text-right"><Button size="sm" variant="outline" onClick={()=>void openAccount(item.id)}>Details</Button></td></tr>)}</tbody></table></div>
          <Pager page={accountPage} total={accountTotal} setPage={setAccountPage}/>
        </CardContent></Card>
      )}

      {tab === "evidence" && (
        <Card><CardHeader><CardTitle>Discovery Evidence</CardTitle><CardDescription>Source records that caused candidates to enter or remain in the frontier.</CardDescription></CardHeader><CardContent>
          <div className="mb-4 grid gap-2 md:grid-cols-2"><input value={evidenceSearch} onChange={(e)=>{setEvidenceSearch(e.target.value);setEvidencePage(0);}} placeholder="Handle / source reference" className="rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm"/><select value={evidenceSource} onChange={(e)=>{setEvidenceSource(e.target.value);setEvidencePage(0);}} className="rounded-xl border border-bg-border bg-bg-card px-3 py-2 text-sm"><option value="">All sources</option>{sources.map(v=><option key={v} value={v}>{v}</option>)}</select></div>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-content-muted"><tr><th className="px-3 py-2">Candidate</th><th>Source</th><th>Reason</th><th>Reference</th><th>Observed</th><th></th></tr></thead><tbody>{evidence.map((item)=><tr key={item.id} className="border-t border-bg-border"><td className="px-3 py-3 font-semibold">{item.candidate_username ? `@${item.candidate_username}` : item.candidate_key}</td><td>{item.source_type}</td><td>{item.discovery_reason}</td><td className="max-w-72 truncate text-xs" title={item.source_ref}>{item.source_ref}</td><td className="text-xs">{dt(item.observed_at)}</td><td className="text-right"><Button size="sm" variant="outline" onClick={()=>setSelectedEvidence(item)}>Raw</Button></td></tr>)}</tbody></table></div>
          <Pager page={evidencePage} total={evidenceTotal} setPage={setEvidencePage}/>
        </CardContent></Card>
      )}

      {tab === "runs" && (
        <Card><CardHeader><CardTitle>Discovery Run History</CardTitle><CardDescription>Admin and CLI worker executions, including real database deltas and errors.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-content-muted"><tr><th className="px-3 py-2">Run</th><th>Status</th><th>Mode</th><th>Worker</th><th>Started</th><th>Candidates</th><th>Evidence</th><th>Rescored</th><th>Promoted</th><th>Skipped</th><th>Error</th></tr></thead><tbody>{runs.map((item)=><tr key={item.id} className="border-t border-bg-border"><td className="px-3 py-3">#{item.id}</td><td><Badge>{item.status}</Badge></td><td>{item.mode}</td><td className="max-w-44 truncate font-mono text-xs">{item.worker_id || "—"}</td><td className="text-xs">{dt(item.started_at)}</td><td>{item.candidates_created}</td><td>{item.evidence_created}</td><td>{item.rescored}</td><td>{item.promoted}</td><td>{item.skipped}</td><td className="max-w-64 truncate text-xs text-danger" title={item.error || ""}>{item.error || "—"}</td></tr>)}</tbody></table></div></CardContent></Card>
      )}

      {tab === "config" && draft && (
        <Card><CardHeader><CardTitle>Discovery Settings</CardTitle><CardDescription>Validated operational controls only. Secrets, database credentials and API tokens are never editable here.</CardDescription></CardHeader><CardContent className="space-y-6">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{(["discovery_enabled","dexscreener_enabled","coinmarketcap_enabled","seed_discovery_enabled","public_web_enabled","x_api_enrichment_enabled"] as const).map((key)=><label key={key} className="flex items-center justify-between rounded-xl border border-bg-border bg-bg-elevated p-3 text-sm"><span>{key.replaceAll("_", " ")}</span><input type="checkbox" checked={draft[key]} onChange={(e)=>setDraft({...draft,[key]:e.target.checked})}/></label>)}</div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">{(["cmc_limit","rescore_limit","process_limit","network_limit","max_depth","min_relevance","batch_size"] as const).map((key)=><label key={key} className="space-y-1 text-sm"><span className="text-content-muted">{key.replaceAll("_", " ")}</span><input type="number" value={draft[key]} onChange={(e)=>setDraft({...draft,[key]:Number(e.target.value)})} className="w-full rounded-xl border border-bg-border bg-bg-card px-3 py-2"/></label>)}</div>
          <div className="flex flex-wrap items-center justify-between gap-4"><div className="text-xs text-content-muted">Last update: {dt(draft.updated_at)} · by {draft.updated_by || "—"}</div><Button disabled={pending !== null} onClick={()=>void saveConfig()}>Save Settings</Button></div>
        </CardContent></Card>
      )}

      {selectedCandidate && <Modal title={`Candidate ${selectedCandidate.candidate?.username ? `@${selectedCandidate.candidate.username}` : selectedCandidate.candidate?.candidate_key}`} onClose={()=>setSelectedCandidate(null)}><div className="grid gap-3 md:grid-cols-3"><Info label="Status" value={selectedCandidate.candidate?.status}/><Info label="Twitter ID" value={selectedCandidate.candidate?.twitter_id || "—"}/><Info label="Account ID" value={selectedCandidate.candidate?.account_id || "—"}/><Info label="Score" value={selectedCandidate.score?.discovery_score ?? "—"}/><Info label="Confidence" value={selectedCandidate.score?.confidence ?? "—"}/><Info label="Attempts" value={selectedCandidate.candidate?.attempts}/><Info label="First seen" value={dt(selectedCandidate.candidate?.first_seen_at)}/><Info label="Last seen" value={dt(selectedCandidate.candidate?.last_seen_at)}/><Info label="Last error" value={selectedCandidate.candidate?.last_error || "—"}/></div><JsonBlock value={selectedCandidate.score?.components} label="Score components"/><JsonBlock value={selectedCandidate.candidate?.meta} label="Candidate metadata"/><div className="space-y-2"><h4 className="font-semibold">Evidence ({selectedCandidate.evidence?.length || 0})</h4>{(selectedCandidate.evidence || []).map((item: any)=><div key={item.id} className="rounded-xl border border-bg-border p-3 text-xs"><strong>{item.source_type}</strong> · {item.discovery_reason}<div className="text-content-muted">{item.source_ref}</div><JsonBlock value={item.raw}/></div>)}</div></Modal>}

      {selectedAccount && <Modal title={`Account @${selectedAccount.account?.username || selectedAccount.account?.twitter_id}`} onClose={()=>setSelectedAccount(null)}><div className="grid gap-3 md:grid-cols-3"><Info label="X ID" value={selectedAccount.account?.twitter_id}/><Info label="Followers" value={selectedAccount.account?.followers_count}/><Info label="Alpha" value={selectedAccount.score?.alpha_score ?? "—"}/><Info label="Snapshots" value={selectedAccount.snapshots_count}/><Info label="Posts" value={selectedAccount.posts_count}/><Info label="Token stats" value={selectedAccount.token_stats_count}/></div><JsonBlock value={selectedAccount.account?.raw} label="Account raw"/><div><h4 className="mb-2 font-semibold">Recent posts</h4><div className="space-y-2">{(selectedAccount.posts || []).map((post: any)=><div key={post.twitter_post_id} className="rounded-xl border border-bg-border p-3 text-xs"><div className="mb-1 text-content-muted">{dt(post.published_at)} · ♥ {post.likes} · ↻ {post.reposts}</div><div>{post.text}</div></div>)}</div></div></Modal>}

      {selectedEvidence && <Modal title={`Evidence #${selectedEvidence.id}`} onClose={()=>setSelectedEvidence(null)}><div className="grid gap-3 md:grid-cols-2"><Info label="Candidate" value={selectedEvidence.candidate_username ? `@${selectedEvidence.candidate_username}` : selectedEvidence.candidate_key}/><Info label="Source" value={selectedEvidence.source_type}/><Info label="Reference" value={selectedEvidence.source_ref}/><Info label="Reason" value={selectedEvidence.discovery_reason}/></div><JsonBlock value={selectedEvidence.raw}/></Modal>}
    </div>
  );
}
