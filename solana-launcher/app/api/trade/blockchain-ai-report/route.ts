import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { getBlockchainAiSnapshot } from "@/lib/trade/chain/ai-service";
import { buildUpstreamCompatibleIntelligenceSnapshot } from "@/lib/trade/chain/ai-snapshot";
import { evaluateBlockchainAiReport, type AiReportGuardResult } from "@/lib/trade/chain/ai-report-guard";
import {
  evaluateBlockchainAiClaims,
  normalizeAiClaims,
  type AiClaimAuditResult,
} from "@/lib/trade/chain/ai-claim-validator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const AI_BASE = (process.env.MEMECOIN_INTELLIGENCE_URL || "http://host.docker.internal:3001").replace(/\/$/, "");
const API_KEY = process.env.MEMECOIN_INTELLIGENCE_API_KEY || process.env.INTERNAL_API_KEY || "";
const MAX_AI_SNAPSHOT_BYTES = 450_000;
const REPORT_CACHE_TTL_MS = 60_000;
const REPORT_CACHE_MAX = 500;

type CachedAiReport = {
  expiresAt: number;
  provider: string | null;
  model: string | null;
  result: ReturnType<typeof normalizeAiResult>;
  guard: AiReportGuardResult;
  claimAudit: AiClaimAuditResult;
};
const reportCache = new Map<string, CachedAiReport>();

function pruneReportCache(now: number): void {
  for (const [key, row] of reportCache) if (row.expiresAt <= now) reportCache.delete(key);
  while (reportCache.size > REPORT_CACHE_MAX) {
    const oldest = reportCache.keys().next().value as string | undefined;
    if (!oldest) break;
    reportCache.delete(oldest);
  }
}

function reportFingerprint(snapshot: Awaited<ReturnType<typeof getBlockchainAiSnapshot>>["compact"]): string {
  const evidence = Object.fromEntries(Object.entries(snapshot.dataQuality.evidence).map(([key, row]) => [key, {
    available: row.available,
    complete: row.complete,
    coveragePct: row.coveragePct,
    source: row.source,
    fetchedAt: row.fetchedAt,
  }]));
  const devHistorySection = snapshot.sections.devHistory != null && typeof snapshot.sections.devHistory === "object" && !Array.isArray(snapshot.sections.devHistory)
    ? { ...(snapshot.sections.devHistory as Record<string, unknown>), fetchedAt: undefined }
    : snapshot.sections.devHistory;
  const stable = {
    schemaVersion: snapshot.schemaVersion,
    mint: snapshot.mint,
    asOf: snapshot.asOf,
    headline: snapshot.headline,
    evidence,
    sections: { ...snapshot.sections, devHistory: devHistorySection },
    facts: snapshot.facts,
    unknowns: snapshot.unknowns,
    warnings: snapshot.warnings,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function validMint(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function text(value: unknown, max = 8_000): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!clean) return null;
  return clean.length <= max ? clean : `${clean.slice(0, max)}…[truncated]`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function confidence01(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed < 0) return null;
  if (parsed <= 1) return parsed;
  return parsed <= 100 ? parsed / 100 : null;
}

function stringArray(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => text(row, 2_000)).filter((row): row is string => row != null).slice(0, limit);
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}


const REPORT_SECTION_KEYS = [
  "current_state",
  "market_flow",
  "holders_distribution",
  "wallets_smart_money",
  "bundles_funding_coordination",
  "wash_anomalies",
  "dev_history",
  "temporal_backtest",
  "contradictions",
  "unknowns",
  "final_assessment",
] as const;

function sectionText(value: unknown): string | null {
  const direct = text(value, 6_000);
  if (direct) return direct;
  const row = record(value);
  if (!row) return null;
  return text(row.summary, 6_000) || text(row.text, 6_000) || text(row.assessment, 6_000) || text(row.conclusion, 6_000);
}

function normalizeAiResult(value: unknown) {
  const raw = record(value) ?? {};
  const intelligence = record(raw.finalIntelligence) ?? {};
  const rawSections = record(raw.sections) ?? record(raw.sectionReports) ?? {};
  const sectionReports = Object.fromEntries(REPORT_SECTION_KEYS.map((key) => [
    key,
    sectionText(rawSections[key]) || sectionText(raw[key]),
  ])) as Record<(typeof REPORT_SECTION_KEYS)[number], string | null>;
  const risks = Array.isArray(raw.risks)
    ? raw.risks.slice(0, 24).map((item) => {
        const row = record(item) ?? {};
        return {
          severity: text(row.severity, 64),
          confidence: confidence01(row.confidence),
          label: text(row.label, 512),
          type: text(row.type, 256),
          explanation: text(row.explanation, 2_000),
          rationale: text(row.rationale, 2_000),
        };
      }).filter((row) => row.label || row.type || row.explanation || row.rationale).slice(0, 12)
    : [];
  const contradictions = Array.isArray(raw.contradictions)
    ? raw.contradictions.slice(0, 24).map((item) => {
        const row = record(item) ?? {};
        return { statement: text(row.statement, 2_000), confidence: confidence01(row.confidence) };
      }).filter((row) => row.statement).slice(0, 12)
    : [];
  const normalizedClaims = normalizeAiClaims(raw.claims, 40);
  return {
    summary: text(raw.summary, 12_000),
    overallConfidence: confidence01(raw.overallConfidence),
    reasoningSummary: stringArray(raw.reasoningSummary, 12),
    finalIntelligence: {
      marketState: text(intelligence.marketState, 4_000),
      socialState: text(intelligence.socialState, 4_000),
      manipulationAssessment: text(intelligence.manipulationAssessment, 4_000),
      bullCase: text(intelligence.bullCase, 4_000),
      bearCase: text(intelligence.bearCase, 4_000),
      unknowns: stringArray(intelligence.unknowns, 16),
      confidence: confidence01(intelligence.confidence),
    },
    risks,
    contradictions,
    whatWouldChangeConclusion: stringArray(raw.whatWouldChangeConclusion, 12),
    sectionReports,
    claims: normalizedClaims.claims,
    claimParseIssues: normalizedClaims.parseIssues,
  };
}

function verificationSummary(guard: AiReportGuardResult, claimAudit: AiClaimAuditResult) {
  const rejected = guard.status === "reject" || claimAudit.status === "reject";
  const status = rejected
    ? "reject"
    : claimAudit.status === "missing"
      ? "text_guard_only"
      : guard.status === "warn" || claimAudit.status === "partial"
        ? "warn"
        : "verified";
  const confidenceCandidates = [guard.effectiveConfidence01, claimAudit.effectiveConfidence01]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    status: status as "verified" | "warn" | "text_guard_only" | "reject",
    usable: !rejected,
    effectiveConfidence01: confidenceCandidates.length ? Math.min(...confidenceCandidates) : null,
    textGuardStatus: guard.status,
    claimAuditStatus: claimAudit.status,
    claimVerificationMode: claimAudit.mode,
  };
}

function hasAiContent(result: ReturnType<typeof normalizeAiResult>): boolean {
  return Boolean(
    result.summary
    || result.finalIntelligence.marketState
    || result.finalIntelligence.manipulationAssessment
    || result.finalIntelligence.bullCase
    || result.finalIntelligence.bearCase
    || result.finalIntelligence.unknowns.length
    || result.reasoningSummary.length
    || result.risks.length
    || result.contradictions.length
    || result.whatWouldChangeConclusion.length
    || result.claims.length
    || Object.values(result.sectionReports).some(Boolean),
  );
}

type AiEnvelope = Record<string, unknown> & {
  result?: Record<string, unknown>;
  provider?: unknown;
  model?: unknown;
};

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let body: { mint?: string; refresh?: boolean };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const mint = String(body.mint || "").trim();
  if (!validMint(mint)) return NextResponse.json({ error: "invalid mint" }, { status: 400 });

  try {
    const built = await getBlockchainAiSnapshot(mint, { refresh: body.refresh === true });
    const snapshot = built.compact;
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > MAX_AI_SNAPSHOT_BYTES) {
      return NextResponse.json(
        { error: "blockchain AI snapshot exceeds safe model payload limit", bytes: Buffer.byteLength(serialized, "utf8") },
        { status: 413 },
      );
    }

    // The upstream context window ends at report generation time. Individual evidence
    // timestamps remain inside dataQuality/sourceTimes so asynchronous sources keep their
    // own age/skew semantics without fabricating a social message timestamp.
    const upstreamSnapshot = buildUpstreamCompatibleIntelligenceSnapshot(snapshot);
    const upstreamSerialized = JSON.stringify(upstreamSnapshot);
    if (Buffer.byteLength(upstreamSerialized, "utf8") > MAX_AI_SNAPSHOT_BYTES) {
      return NextResponse.json(
        { error: "blockchain AI compatibility snapshot exceeds safe model payload limit", bytes: Buffer.byteLength(upstreamSerialized, "utf8") },
        { status: 413 },
      );
    }
    const sentAt = new Date(snapshot.generatedAt).toISOString();
    const reportCacheKey = reportFingerprint(snapshot);
    pruneReportCache(Date.now());
    if (body.refresh !== true) {
      const cached = reportCache.get(reportCacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const verification = verificationSummary(cached.guard, cached.claimAudit);
        return NextResponse.json({
          available: true,
          usable: verification.usable,
          mint,
          provider: cached.provider,
          model: cached.model,
          latencyMs: Date.now() - startedAt,
          snapshotBytes: Buffer.byteLength(serialized, "utf8"),
          upstreamSnapshotBytes: Buffer.byteLength(upstreamSerialized, "utf8"),
          cacheHit: built.cacheHit,
          cacheAgeMs: built.cacheAgeMs,
          aiCacheHit: true,
          result: cached.result,
          reportGuard: cached.guard,
          claimAudit: cached.claimAudit,
          verification,
          snapshotMeta: {
            schemaVersion: snapshot.schemaVersion,
            generatedAt: snapshot.generatedAt,
            asOf: snapshot.asOf,
            devFetchedAt: snapshot.dataQuality.sourceTimes.devFetchedAt,
            sourceSkewMs: snapshot.dataQuality.sourceTimes.sourceSkewMs,
            cacheSource: snapshot.cache.chainSource,
            evidenceCompletenessPct: snapshot.headline.evidenceCompletenessPct,
            unknowns: snapshot.unknowns.length,
            warnings: snapshot.warnings.length,
            payloadBytes: snapshot.compactMeta.payloadBytes,
            payloadTruncated: snapshot.compactMeta.payloadTruncated,
            compactionLevel: snapshot.compactMeta.compactionLevel,
          },
        });
      }
    }
    const payload = {
      // Snapshot-mode in the existing social-ai path is valid with zero messages.
      // Do not manufacture a Telegram message containing control instructions: that
      // would contaminate the evidence layer as if the instruction were observed data.
      messages: [],
      context: {
        tokenAddress: mint,
        symbol: null,
        tokenName: null,
        windowStart: null,
        windowEnd: sentAt,
        // Reuse the already-proven upstream contract used by social-ai. The blockchain
        // specialization is carried by the structured snapshot + report contract, not by
        // inventing a new analysisMode enum that the upstream may reject.
        analysisMode: "full_intelligence",
        analysisRole: "analyst",
        intelligenceSnapshot: upstreamSnapshot,
      },
      persist: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const abortFromClient = () => controller.abort();
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener("abort", abortFromClient, { once: true });
    let response: Response;
    try {
      response = await fetch(`${AI_BASE}/api/telegram-ai/analyze`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(API_KEY ? { "x-api-key": API_KEY, authorization: `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      req.signal.removeEventListener("abort", abortFromClient);
    }
    const result = await response.json().catch(() => ({})) as AiEnvelope;
    if (!response.ok) {
      const upstreamMessage = text(result.error || result.detail || result.message, 1_000);
      console.error("[blockchain-ai-report] upstream failure", response.status, upstreamMessage || "no detail");
      return NextResponse.json(
        { available: false, error: "AI provider unavailable", upstreamStatus: response.status },
        { status: 502 },
      );
    }

    const normalizedResult = normalizeAiResult(result.result ?? result);
    if (!hasAiContent(normalizedResult)) {
      console.error("[blockchain-ai-report] upstream returned an empty or incompatible report shape");
      return NextResponse.json(
        { available: false, error: "AI provider returned an empty report" },
        { status: 502 },
      );
    }
    const reportGuard = evaluateBlockchainAiReport(snapshot, normalizedResult);
    const reportConfidence = reportGuard.reportedConfidence01;
    const claimAudit = evaluateBlockchainAiClaims({
      snapshot,
      claims: normalizedResult.claims,
      parseIssues: normalizedResult.claimParseIssues,
      globalConfidenceCap01: reportGuard.confidenceCap01,
      reportConfidence01: reportConfidence,
    });
    const provider = typeof result.provider === "string" ? result.provider : null;
    const model = typeof result.model === "string" ? result.model : null;
    reportCache.set(reportCacheKey, {
      expiresAt: Date.now() + REPORT_CACHE_TTL_MS,
      provider,
      model,
      result: normalizedResult,
      guard: reportGuard,
      claimAudit,
    });
    const verification = verificationSummary(reportGuard, claimAudit);

    return NextResponse.json({
      available: true,
      usable: verification.usable,
      mint,
      provider,
      model,
      latencyMs: Date.now() - startedAt,
      snapshotBytes: Buffer.byteLength(serialized, "utf8"),
      upstreamSnapshotBytes: Buffer.byteLength(upstreamSerialized, "utf8"),
      cacheHit: built.cacheHit,
      cacheAgeMs: built.cacheAgeMs,
      aiCacheHit: false,
      result: normalizedResult,
      reportGuard,
      claimAudit,
      verification,
      snapshotMeta: {
        schemaVersion: snapshot.schemaVersion,
        generatedAt: snapshot.generatedAt,
        asOf: snapshot.asOf,
        devFetchedAt: snapshot.dataQuality.sourceTimes.devFetchedAt,
        sourceSkewMs: snapshot.dataQuality.sourceTimes.sourceSkewMs,
        cacheSource: snapshot.cache.chainSource,
        evidenceCompletenessPct: snapshot.headline.evidenceCompletenessPct,
        unknowns: snapshot.unknowns.length,
        warnings: snapshot.warnings.length,
        payloadBytes: snapshot.compactMeta.payloadBytes,
        payloadTruncated: snapshot.compactMeta.payloadTruncated,
        compactionLevel: snapshot.compactMeta.compactionLevel,
      },
    });
  } catch (error) {
    console.error("[blockchain-ai-report] failed", error);
    return NextResponse.json(
      { available: false, error: "blockchain AI report failed" },
      { status: 502 },
    );
  }
}
