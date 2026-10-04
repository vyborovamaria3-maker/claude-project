"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrainCircuit, RefreshCw, ShieldAlert } from "lucide-react";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type ReportResponse = {
  available?: boolean;
  usable?: boolean;
  mint?: string;
  error?: string;
  provider?: string | null;
  model?: string | null;
  latencyMs?: number;
  snapshotBytes?: number;
  upstreamSnapshotBytes?: number;
  aiCacheHit?: boolean;
  result?: {
    summary?: string;
    overallConfidence?: number | null;
    reasoningSummary?: string[];
    finalIntelligence?: {
      marketState?: string;
      socialState?: string;
      manipulationAssessment?: string;
      bullCase?: string;
      bearCase?: string;
      unknowns?: string[];
      confidence?: number;
    };
    sourceAssessments?: Record<string, unknown>;
    risks?: Array<{ severity?: string; confidence?: number; label?: string; type?: string; explanation?: string; rationale?: string }>;
    contradictions?: Array<{ statement?: string; confidence?: number }>;
    whatWouldChangeConclusion?: string[];
    sectionReports?: Record<string, string | null>;
    claims?: Array<{
      id?: string;
      claim?: string;
      claimType?: string;
      evidenceKeys?: string[];
      evidenceAssertions?: Array<{ key?: string; operator?: string; value?: string | number | boolean | null; tolerance?: number | null }>;
      confidence01?: number | null;
      timeScope?: string;
      qualifiers?: string[];
    }>;
    [key: string]: unknown;
  };
  reportGuard?: {
    status?: "pass" | "warn" | "reject";
    evidenceQuality01?: number;
    confidenceCap01?: number;
    reportedConfidence01?: number | null;
    effectiveConfidence01?: number | null;
    violations?: Array<{ code?: string; severity?: "medium" | "high" | "critical"; message?: string; excerpt?: string }>;
  };
  verification?: {
    status?: "verified" | "warn" | "text_guard_only" | "reject";
    usable?: boolean;
    effectiveConfidence01?: number | null;
    textGuardStatus?: string;
    claimAuditStatus?: string;
    claimVerificationMode?: string;
  };
  claimAudit?: {
    contractVersion?: string;
    status?: "verified" | "partial" | "missing" | "reject";
    mode?: "claim_verified" | "text_guard_only";
    confidenceCap01?: number;
    effectiveConfidence01?: number | null;
    claimsReceived?: number;
    claimsVerified?: number;
    claimsWarned?: number;
    claimsRejected?: number;
    evidenceKeysAvailable?: number;
    parseIssues?: Array<{ index?: number; code?: string; message?: string }>;
    violations?: Array<{ code?: string; severity?: "medium" | "high" | "critical"; claimId?: string; message?: string; evidenceKeys?: string[] }>;
    claims?: Array<{
      id?: string;
      claim?: string;
      claimType?: string;
      timeScope?: string;
      status?: "verified" | "warn" | "reject";
      evidenceKeys?: string[];
      evidenceAssertions?: Array<{ key?: string; operator?: string; value?: string | number | boolean | null; tolerance?: number | null }>;
      validEvidenceKeys?: string[];
      unknownEvidenceKeys?: string[];
      unavailableEvidenceKeys?: string[];
      evidenceCap01?: number;
      reportedConfidence01?: number | null;
      effectiveConfidence01?: number | null;
      violations?: Array<{ code?: string; severity?: string; message?: string }>;
    }>;
  };
  snapshotMeta?: {
    schemaVersion?: string;
    generatedAt?: number;
    asOf?: number;
    devFetchedAt?: number | null;
    sourceSkewMs?: number | null;
    cacheSource?: "cache" | "inflight" | "fresh" | "unknown";
    evidenceCompletenessPct?: number | null;
    unknowns?: number;
    warnings?: number;
    payloadBytes?: number;
    payloadTruncated?: boolean;
    compactionLevel?: "standard" | "aggressive" | "emergency" | "minimal";
  };
};

function pct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

function compactBytes(value: number | undefined) {
  if (!Number.isFinite(value)) return "—";
  return value! < 1024 ? `${value} B` : `${(value! / 1024).toFixed(1)} KB`;
}

function Card({ title, text }: { title: string; text?: string | null }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-card p-3">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-content-faint">{title}</div>
      <div className="mt-1 text-xs leading-5 text-content-muted">{text || "—"}</div>
    </div>
  );
}

function friendlyBlockchainAiError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "AI API не вернул ответ. Детерминированный on-chain анализ продолжает работать независимо от AI.";
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return "AI-анализ временно недоступен: источник отвечает слишком долго.";
  }
  return message || "Blockchain AI report временно недоступен.";
}

export default function BlockchainAiReportPanel({ mint }: { mint: string }) {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (refresh = false) => {
    if (!MINT_RE.test(mint)) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/trade/blockchain-ai-report", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint, refresh }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as ReportResponse;
      if (requestSeq !== requestSeqRef.current) return;
      if (payload.mint && payload.mint !== mint) throw new Error("stale blockchain AI response ignored");
      if (!response.ok || payload.available === false) throw new Error(payload.error || `HTTP ${response.status}`);
      setData(payload);
    } catch (caught) {
      if (controller.signal.aborted || requestSeq !== requestSeqRef.current) return;
      setError(friendlyBlockchainAiError(caught));
    } finally {
      if (requestSeq === requestSeqRef.current) setLoading(false);
    }
  }, [mint]);

  useEffect(() => {
    abortRef.current?.abort();
    requestSeqRef.current += 1;
    setData(null);
    setError(null);
    if (!MINT_RE.test(mint)) {
      setLoading(false);
      return;
    }
    void load(false);
    return () => abortRef.current?.abort();
  }, [load, mint]);

  const result = data?.result;
  const intelligence = result?.finalIntelligence;
  const reportGuard = data?.reportGuard;
  const claimAudit = data?.claimAudit;
  const guardViolations = Array.isArray(reportGuard?.violations) ? reportGuard!.violations!.slice(0, 8) : [];
  const claimViolations = Array.isArray(claimAudit?.violations) ? claimAudit!.violations!.slice(0, 8) : [];
  const auditedClaims = Array.isArray(claimAudit?.claims) ? claimAudit!.claims!.slice(0, 10) : [];
  const reasoning = Array.isArray(result?.reasoningSummary) ? result!.reasoningSummary!.slice(0, 8) : [];
  const risks = Array.isArray(result?.risks) ? result!.risks!.slice(0, 8) : [];
  const contradictions = Array.isArray(result?.contradictions) ? result!.contradictions!.slice(0, 8) : [];
  const change = Array.isArray(result?.whatWouldChangeConclusion) ? result!.whatWouldChangeConclusion!.slice(0, 8) : [];
  const structuredSections: Array<[string, string]> = result?.sectionReports
    ? Object.entries(result.sectionReports)
        .flatMap(([key, value]) => typeof value === "string" && value.trim() ? [[key, value] as [string, string]] : [])
        .slice(0, 11)
    : [];

  return (
    <section className="surface-panel rounded-2xl border border-bg-border p-4" data-tag="trade.blockchain_ai_report">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <BrainCircuit className="mt-0.5 h-4 w-4 text-primary" />
          <div>
            <h2 className="text-sm font-semibold text-content">AI-анализ блокчейна</h2>
            <p className="mt-1 text-[10px] leading-4 text-content-faint">
              V1 + V3.4 + V3.5 + DEV History V3 · Report Guard + Claim Contract V1 · evidence-aware snapshot.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-bg-border bg-bg-elevated px-3 py-2 text-[11px] font-semibold text-content-muted hover:text-content disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Анализирую…" : "Обновить AI"}
        </button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : !data ? (
        <div className="text-xs text-content-faint">{loading ? "Собираю единый blockchain snapshot и передаю AI…" : "Ожидается blockchain snapshot."}</div>
      ) : (
        <div className="space-y-4">
          {reportGuard?.status && reportGuard.status !== "pass" && (
            <div className={`rounded-xl border p-3 text-xs ${reportGuard.status === "reject" ? "border-danger/30 bg-danger/5 text-danger" : "border-warning/30 bg-warning/5 text-warning"}`}>
              <div className="font-semibold">AI reasoning guard: {reportGuard.status.toUpperCase()}</div>
              <div className="mt-1 leading-5">
                Evidence cap {pct((reportGuard.confidenceCap01 ?? 0) * 100)}. {guardViolations.map((row) => row.message || row.code || "unsupported claim").join(" · ")}
              </div>
            </div>
          )}
          {claimAudit?.status && claimAudit.status !== "verified" && (
            <div className={`rounded-xl border p-3 text-xs ${claimAudit.status === "reject" ? "border-danger/30 bg-danger/5 text-danger" : "border-warning/30 bg-warning/5 text-warning"}`}>
              <div className="font-semibold">Claim verification: {claimAudit.status.toUpperCase()}</div>
              <div className="mt-1 leading-5">
                {claimAudit.mode === "text_guard_only"
                  ? "Модель не вернула structured claims[]: отчёт проверен только text-guard и confidence ограничена."
                  : `${claimAudit.claimsVerified ?? 0}/${claimAudit.claimsReceived ?? 0} claims verified · warned ${claimAudit.claimsWarned ?? 0} · rejected ${claimAudit.claimsRejected ?? 0}.`}
                {claimViolations.length ? ` ${claimViolations.map((row) => row.message || row.code || "claim issue").join(" · ")}` : ""}
              </div>
            </div>
          )}
          <div className={`rounded-xl border p-4 ${data.usable === false ? "border-danger/30 bg-danger/5" : "border-primary/20 bg-primary/5"}`}>
            <div className={`text-[9px] font-semibold uppercase tracking-wider ${data.usable === false ? "text-danger" : "text-primary"}`}>
              {data.usable === false ? "AI output blocked by reasoning guard" : "Current blockchain assessment"}
            </div>
            <p className="mt-2 text-sm leading-6 text-content-soft">{result?.summary || intelligence?.marketState || "AI вернул структурированный отчёт без общего summary."}</p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Card title="Market state" text={intelligence?.marketState} />
            <Card title="Manipulation / coordination" text={intelligence?.manipulationAssessment} />
            <Card title="Supports / bull case" text={intelligence?.bullCase} />
            <Card title="Risks / bear case" text={intelligence?.bearCase} />
            <Card title="Unknowns" text={intelligence?.unknowns?.join(" · ")} />
            <Card
              title="AI confidence"
              text={(() => {
                const confidence = data.verification?.effectiveConfidence01 ?? claimAudit?.effectiveConfidence01 ?? reportGuard?.effectiveConfidence01 ?? intelligence?.confidence ?? result?.overallConfidence;
                const suffix = [
                  reportGuard?.status && reportGuard.status !== "pass" ? `guard ${reportGuard.status}` : null,
                  claimAudit?.status && claimAudit.status !== "verified" ? `claims ${claimAudit.status}` : null,
                ].filter(Boolean).join(" · ");
                return confidence == null ? `—${suffix ? ` · ${suffix}` : ""}` : `${pct(confidence * 100)}${suffix ? ` · ${suffix}` : ""}`;
              })()}
            />
          </div>

          {reasoning.length > 0 && (
            <div className="rounded-xl border border-bg-border bg-bg-card p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">Почему AI так решил</div>
              <div className="mt-2 space-y-1.5">{reasoning.map((row, index) => <div key={`${index}-${row.slice(0, 24)}`} className="text-xs leading-5 text-content-muted">• {row}</div>)}</div>
            </div>
          )}

          {(risks.length > 0 || contradictions.length > 0 || change.length > 0) && (
            <div className="grid gap-3 xl:grid-cols-3">
              <Card title="Risks" text={risks.map((row) => row.explanation || row.rationale || row.label || row.type || "risk").join(" · ")} />
              <Card title="Contradictions" text={contradictions.map((row) => row.statement || "contradiction").join(" · ")} />
              <Card title="Что изменит вывод" text={change.join(" · ")} />
            </div>
          )}

          {claimAudit && (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Card title="Claim contract" text={claimAudit.contractVersion || "blockchain-claim-v1"} />
              <Card title="Verification mode" text={claimAudit.mode || "—"} />
              <Card title="Evidence keys catalog" text={claimAudit.evidenceKeysAvailable == null ? "—" : String(claimAudit.evidenceKeysAvailable)} />
              <Card title="Claim confidence cap" text={claimAudit.confidenceCap01 == null ? "—" : pct(claimAudit.confidenceCap01 * 100)} />
            </div>
          )}

          {Array.isArray(claimAudit?.parseIssues) && claimAudit.parseIssues.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
              <div className="font-semibold">Claim parse issues</div>
              <div className="mt-1 leading-5">{claimAudit.parseIssues.slice(0, 8).map((row) => row.message || row.code || `claim ${row.index ?? "?"}`).join(" · ")}</div>
            </div>
          )}

          {auditedClaims.length > 0 && (
            <div className="rounded-xl border border-bg-border bg-bg-card p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-content-faint">Verified AI claims</div>
              <div className="mt-2 space-y-2">
                {auditedClaims.map((row, index) => (
                  <div key={`${row.id || index}-${index}`} className="rounded-lg border border-bg-border/70 bg-bg-elevated/40 p-2.5">
                    <div className="flex flex-wrap items-center gap-2 text-[9px] uppercase tracking-wide text-content-faint">
                      <span>{row.status || "—"}</span>
                      <span>{row.claimType || "claim"}</span>
                      <span>{row.timeScope || "unspecified"}</span>
                      <span>{row.effectiveConfidence01 == null ? "confidence —" : `effective ${pct(row.effectiveConfidence01 * 100)}`}</span>
                      <span>{row.evidenceCap01 == null ? "cap —" : `cap ${pct(row.evidenceCap01 * 100)}`}</span>
                      <span>{row.evidenceKeys?.length ?? 0} evidence keys</span>
                    </div>
                    <div className="mt-1 text-xs leading-5 text-content-muted">{row.claim || "—"}</div>
                    {row.evidenceKeys?.length ? <div className="mt-1 break-all font-mono text-[9px] leading-4 text-content-faint">{row.evidenceKeys.slice(0, 10).join(" · ")}</div> : null}
                    {row.evidenceAssertions?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {row.evidenceAssertions.slice(0, 8).map((assertion, assertionIndex) => (
                          <span key={`${assertion.key || assertionIndex}-${assertionIndex}`} className="rounded border border-primary/15 bg-primary/5 px-1.5 py-0.5 font-mono text-[9px] text-content-faint">
                            {assertion.key || "?"} {assertion.operator || "?"}{assertion.operator === "is_null" || assertion.operator === "not_null" ? "" : ` ${String(assertion.value ?? "null")}`}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {(row.unknownEvidenceKeys?.length || row.unavailableEvidenceKeys?.length || row.violations?.length) ? (
                      <div className="mt-2 text-[9px] leading-4 text-warning">
                        {[
                          row.unknownEvidenceKeys?.length ? `unknown keys: ${row.unknownEvidenceKeys.join(", ")}` : null,
                          row.unavailableEvidenceKeys?.length ? `unavailable: ${row.unavailableEvidenceKeys.join(", ")}` : null,
                          row.violations?.length ? row.violations.map((violation) => violation.message || violation.code || "violation").join(" · ") : null,
                        ].filter(Boolean).join(" · ")}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          {structuredSections.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {structuredSections.map(([key, value]) => (
                <Card key={key} title={key.replaceAll("_", " ")} text={value} />
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-bg-border pt-3 text-[9px] text-content-faint">
            <span>snapshot {data.snapshotMeta?.schemaVersion || "—"}</span>
            <span>evidence {pct(data.snapshotMeta?.evidenceCompletenessPct)}</span>
            <span>unknowns {data.snapshotMeta?.unknowns ?? "—"}</span>
            <span>warnings {data.snapshotMeta?.warnings ?? "—"}</span>
            <span>payload {compactBytes(data.snapshotBytes)}</span>
            <span>compact {data.snapshotMeta?.compactionLevel || "—"}{data.snapshotMeta?.payloadTruncated ? " · truncated" : ""}</span>
            <span>upstream {compactBytes(data.upstreamSnapshotBytes)}</span>
            <span>latency {data.latencyMs == null ? "—" : `${data.latencyMs} ms`}</span>
            <span>cache {data.snapshotMeta?.cacheSource || "—"}</span>
            <span>AI cache {data.aiCacheHit ? "hit" : "miss"}</span>
            <span>guard {reportGuard?.status || "—"}{guardViolations.length ? ` · ${guardViolations.length}` : ""}</span>
            <span>claims {claimAudit?.status || "—"}{claimAudit?.claimsReceived != null ? ` · ${claimAudit.claimsVerified ?? 0}/${claimAudit.claimsReceived}` : ""}</span>
            <span>verification {data.verification?.status || "—"}</span>
            <span>source skew {data.snapshotMeta?.sourceSkewMs == null ? "—" : `${Math.round(data.snapshotMeta.sourceSkewMs / 1000)}s`}</span>
            <span>{data.provider || "AI"}{data.model ? ` · ${data.model}` : ""}</span>
          </div>
        </div>
      )}
    </section>
  );
}
