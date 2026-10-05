"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Loader2,
  RefreshCcw,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import {
  fetchTeraGramDiscovery,
  type TeraGramGraphCandidate,
} from "@/lib/teragramInvite";

type Verdict = "strong" | "medium" | "weak" | "reject";
type Disposition = "accepted" | "review" | "discarded" | "failed";

interface RecentAnalysis {
  channel: string;
  messagesAnalyzed: number;
  signalMessages: number;
  solanaMessages: number;
  memecoinMessages: number;
  callMessages: number;
  contractMessages: number;
  pumpfunMessages: number;
  solanaContracts: string[];
  evmContracts: string[];
  essenceScore: number;
  verdict: Verdict;
  reasons: string[];
}

interface ValidationResult {
  username: string;
  historicalDiscoveryScore: number;
  alive: boolean;
  accepted: boolean;
  review: boolean;
  disposition: Disposition;
  analysis?: RecentAnalysis;
  error?: string;
}

interface ValidationResponse {
  status: "validated" | "rate_limited";
  total: number;
  checked: number;
  alive: number;
  accepted: number;
  review: number;
  discarded: number;
  failed: number;
  results: ValidationResult[];
  error?: string;
  code?: string;
}

interface Props {
  onAddSources?: (usernames: string[]) => void;
}

function dispositionClass(disposition: Disposition): string {
  switch (disposition) {
    case "accepted":
      return "border-green-500/30 bg-green-500/10 text-green-300";
    case "review":
      return "border-yellow-500/30 bg-yellow-500/10 text-yellow-200";
    case "failed":
      return "border-red-500/30 bg-red-500/10 text-red-300";
    default:
      return "border-bg-border bg-bg-elevated text-content-muted";
  }
}

export function TeraGramLiveValidation({ onAddSources }: Props) {
  const [candidates, setCandidates] = useState<TeraGramGraphCandidate[]>([]);
  const [results, setResults] = useState<ValidationResult[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Omit<ValidationResponse, "results" | "status"> | null>(null);

  const loadCandidates = useCallback(async () => {
    setLoadingCandidates(true);
    setError(null);

    try {
      const response = await fetchTeraGramDiscovery();

      const valid = response.candidates.filter(
        (candidate) => candidate.username && !candidate.flags?.scam && !candidate.flags?.fake,
      );

      setCandidates(valid);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load graph candidates");
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  const accepted = useMemo(
    () => results.filter((row) => row.disposition === "accepted"),
    [results],
  );

  const needsReview = useMemo(
    () => results.filter((row) => row.disposition === "review"),
    [results],
  );

  const rejected = useMemo(
    () => results.filter((row) => row.disposition === "discarded" || row.disposition === "failed"),
    [results],
  );

  const validateAll = useCallback(async () => {
    if (!candidates.length || validating) return;

    setValidating(true);
    setError(null);
    setResults([]);
    setSummary(null);

    try {
      const response = await fetch("/api/tginvite/mtproto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "validateCandidates",
          limit: 100,
          candidates: candidates.map((candidate) => ({
            username: candidate.username,
            historicalDiscoveryScore: candidate.historical_discovery_score,
          })),
        }),
      });

      const payload = (await response.json()) as ValidationResponse;

      if (!response.ok && payload.code !== "FLOOD_WAIT") {
        throw new Error(payload.error || "Live validation failed");
      }

      setResults(payload.results || []);

      setSummary({
        total: payload.total,
        checked: payload.checked,
        alive: payload.alive,
        accepted: payload.accepted,
        review: payload.review,
        discarded: payload.discarded,
        failed: payload.failed,
        error: payload.error,
        code: payload.code,
      });

      if (payload.code === "FLOOD_WAIT") {
        setError(payload.error || "Telegram rate limit reached. Partial results were preserved.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Live validation failed");
    } finally {
      setValidating(false);
    }
  }, [candidates, validating]);

  const addAccepted = useCallback(() => {
    if (!onAddSources) return;
    onAddSources(accepted.map((row) => row.username));
  }, [accepted, onAddSources]);

  return (
    <section className="rounded-2xl border border-bg-border bg-bg-card p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-purple-300" />
            <h3 className="text-lg font-semibold text-content">Live Validation</h3>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-content-muted">
            Re-check historical TeraGram graph candidates against the current Telegram channel and
            its latest 100 messages.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void loadCandidates()}
            disabled={loadingCandidates || validating}
            className="inline-flex items-center gap-2 rounded-xl border border-bg-border px-4 py-2 text-sm text-content disabled:opacity-50"
          >
            {loadingCandidates ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}
            Refresh
          </button>

          <button
            type="button"
            onClick={() => void validateAll()}
            disabled={validating || loadingCandidates || candidates.length === 0}
            className="inline-flex items-center gap-2 rounded-xl bg-purple-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {validating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            {validating
              ? "Validating..."
              : `Live Validate All (${candidates.length})`}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Metric label="Candidates" value={candidates.length} />
        <Metric label="Checked" value={summary?.checked || 0} />
        <Metric label="Alive" value={summary?.alive || 0} />
        <Metric label="Accepted" value={summary?.accepted || 0} />
        <Metric label="Review" value={summary?.review || 0} />
        <Metric label="Failed" value={summary?.failed || 0} />
      </div>

      {validating && (
        <div className="mt-4 rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 text-sm text-purple-100">
          Telegram is checking channels sequentially. Each channel uses the latest 100 live
          messages.
        </div>
      )}

      {error && (
        <div className="mt-4 flex gap-2 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-content-muted">
              Accepted channels require a medium or strong live verdict.
            </div>

            <button
              type="button"
              disabled={accepted.length === 0 || !onAddSources}
              onClick={addAccepted}
              className="inline-flex items-center gap-2 rounded-xl border border-green-500/40 bg-green-500/10 px-4 py-2 text-sm font-semibold text-green-300 disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              Add accepted sources ({accepted.length})
            </button>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-bg-border">
            <table className="min-w-[1000px] w-full text-left text-sm">
              <thead className="bg-bg-elevated text-content-muted">
                <tr>
                  <th className="px-3 py-3">Channel</th>
                  <th className="px-3 py-3">Historical</th>
                  <th className="px-3 py-3">Live</th>
                  <th className="px-3 py-3">Verdict</th>
                  <th className="px-3 py-3">Messages</th>
                  <th className="px-3 py-3">SOL</th>
                  <th className="px-3 py-3">Meme</th>
                  <th className="px-3 py-3">Calls</th>
                  <th className="px-3 py-3">Pump</th>
                  <th className="px-3 py-3">Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-bg-border">
                {results.map((row) => (
                  <tr key={row.username} className="bg-bg-card">
                    <td className="px-3 py-3">
                      <div className="font-medium text-content">@{row.username}</div>
                      {row.error && (
                        <div className="mt-1 max-w-xs truncate text-xs text-red-300">
                          {row.error}
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-3 text-content">
                      {row.historicalDiscoveryScore.toFixed(1)}
                    </td>

                    <td className="px-3 py-3 font-semibold text-content">
                      {row.analysis ? row.analysis.essenceScore.toFixed(1) : "\u2014"}
                    </td>

                    <td className="px-3 py-3 capitalize text-content">
                      {row.analysis?.verdict || "unavailable"}
                    </td>

                    <td className="px-3 py-3 text-content-muted">
                      {row.analysis?.messagesAnalyzed ?? "\u2014"}
                    </td>

                    <td className="px-3 py-3 text-content-muted">
                      {row.analysis?.solanaMessages ?? "\u2014"}
                    </td>

                    <td className="px-3 py-3 text-content-muted">
                      {row.analysis?.memecoinMessages ?? "\u2014"}
                    </td>

                    <td className="px-3 py-3 text-content-muted">
                      {row.analysis?.callMessages ?? "\u2014"}
                    </td>

                    <td className="px-3 py-3 text-content-muted">
                      {row.analysis?.pumpfunMessages ?? "\u2014"}
                    </td>

                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold capitalize ${dispositionClass(row.disposition)}`}
                      >
                        {row.disposition}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <ResultBucket
              title="Accepted"
              count={accepted.length}
              description="Medium or strong. Ready to add as a TG Invite source."
            />
            <ResultBucket
              title="Needs Review"
              count={needsReview.length}
              description="Weak live signal. Keep visible but do not auto-add."
            />
            <ResultBucket
              title="Rejected / unavailable"
              count={rejected.length}
              description="Reject verdict, inaccessible channel or Telegram error."
            />
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elevated p-3">
      <div className="text-xs text-content-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-content">{value}</div>
    </div>
  );
}

function ResultBucket({
  title,
  count,
  description,
}: {
  title: string;
  count: number;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elevated p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="font-semibold text-content">{title}</div>
        <div className="text-xl font-semibold text-content">{count}</div>
      </div>
      <p className="mt-2 text-xs text-content-muted">{description}</p>
    </div>
  );
}
