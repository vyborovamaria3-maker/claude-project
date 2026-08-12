import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type { AnalysisSnapshot, IntelligenceFeature } from "@/lib/trade/intelligence-agent";
import {
  enrichSnapshotWithMemory,
  loadMemoryContext,
  researchCandidates,
  researchMeta,
  runBoundedResearch,
} from "@/lib/trade/intelligence-research-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const AI_BASE = (
  process.env.MEMECOIN_INTELLIGENCE_URL || "http://host.docker.internal:3001"
).replace(/\/$/, "");
const API_KEY =
  process.env.MEMECOIN_INTELLIGENCE_API_KEY || process.env.INTERNAL_API_KEY || "";
const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(/\/$/, "");
const BACKEND_KEY = process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || "";
const REQUEST_BUDGET_MS = 112_000;
const MAX_DYNAMIC_RESEARCH_ROUNDS = 3;
const INTELLIGENCE_PROMPT_VERSION = "intelligence-qwen-v7-critic";

type TimelineItem = {
  source_handle?: string | null;
  source_name?: string | null;
  text?: string;
  occurred_at?: string;
  metrics?: Record<string, unknown> | null;
};

type RequestBody = {
  mint?: string;
  symbol?: string;
  tokenName?: string;
  timeline?: TimelineItem[];
  snapshot?: AnalysisSnapshot;
};

type QwenResult = {
  summary?: string;
  overallConfidence?: number;
  finalIntelligence?: Record<string, unknown>;
  discoveredRelationships?: Array<{
    source?: string;
    target?: string;
    confidence?: number;
  }>;
  campaignHypothesis?: {
    likelyOriginators?: string[];
    amplifiers?: string[];
    label?: string;
    confidence?: number;
    narrative?: string;
  };
};

type QwenEnvelope = Record<string, unknown> & {
  result?: QwenResult;
  provider?: unknown;
  model?: unknown;
};

type AdvancedReport = Record<string, unknown> & {
  layers?: {
    dedicated_critic?: { required?: boolean };
    dynamic_research_budget?: {
      recommended_research_rounds?: number;
      recommended_entity_budget?: number;
    };
    research_planner?: {
      candidates?: Array<{
        entity?: string;
        expected_information_gain?: number;
      }>;
    };
    [key: string]: unknown;
  };
};

type ResearchRun = Awaited<ReturnType<typeof runBoundedResearch>>;

function n(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function stableId(item: TimelineItem, index: number) {
  return `social-${createHash("sha1")
    .update(
      `${item.source_handle || item.source_name || "unknown"}|${item.occurred_at || ""}|${item.text || ""}|${index}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function timelineMessages(timeline: TimelineItem[]) {
  return timeline
    .slice(0, 120)
    .map((item, index) => {
      const metrics = item.metrics || {};
      const channel = String(item.source_handle || item.source_name || "unknown");
      const sentAt =
        item.occurred_at && Number.isFinite(Date.parse(item.occurred_at))
          ? new Date(item.occurred_at).toISOString()
          : new Date().toISOString();
      return {
        id: stableId(item, index),
        channelId: channel.slice(0, 128),
        channelUsername: item.source_handle
          ? String(item.source_handle).replace(/^@/, "").slice(0, 128)
          : null,
        channelTitle: item.source_name
          ? String(item.source_name).slice(0, 256)
          : null,
        senderId: metrics.sender_id
          ? String(metrics.sender_id).slice(0, 128)
          : null,
        text: String(item.text || "").slice(0, 40_000),
        sentAt,
        editedAt: null,
        views: n(metrics.views),
        forwards: n(metrics.forwards),
        reactions: n(metrics.reactions),
        replyToMessageId: metrics.reply_to_message_id
          ? String(metrics.reply_to_message_id).slice(0, 128)
          : null,
        links: [],
      };
    })
    .filter((message) => message.text.trim().length > 0);
}

function snapshotMessages(snapshot: AnalysisSnapshot) {
  return snapshot.evidence
    .slice(0, 180)
    .map((entry) => {
      const isX = entry.platform === "x";
      const sentAt =
        entry.timestamp && Number.isFinite(Date.parse(entry.timestamp))
          ? new Date(entry.timestamp).toISOString()
          : snapshot.createdAt;
      return {
        id: entry.id.slice(0, 128),
        channelId: `${entry.platform}:${entry.source}`.slice(0, 128),
        channelUsername: entry.source.replace(/^@/, "").slice(0, 128),
        channelTitle: isX
          ? `X · ${entry.source}`.slice(0, 256)
          : entry.source.slice(0, 256),
        senderId: null,
        text: entry.text.slice(0, 40_000),
        sentAt,
        editedAt: null,
        views: 0,
        forwards: 0,
        reactions: 0,
        replyToMessageId: null,
        links: entry.url
          ? [entry.url].filter((url) => /^https?:\/\//i.test(url)).slice(0, 1)
          : [],
      };
    })
    .filter((message) => message.text.trim().length > 0);
}

function validateSnapshot(body: RequestBody, mint: string) {
  const snapshot = body.snapshot;
  if (!snapshot) return null;
  if (snapshot.mint !== mint) throw new Error("snapshot_mint_mismatch");
  if (
    !Array.isArray(snapshot.features) ||
    !snapshot.graph ||
    !Array.isArray(snapshot.evidence)
  ) {
    throw new Error("invalid_snapshot");
  }
  if (
    snapshot.features.length > 300 ||
    snapshot.graph.nodes.length > 500 ||
    snapshot.graph.edges.length > 1500 ||
    snapshot.evidence.length > 300
  ) {
    throw new Error("snapshot_too_large");
  }
  return snapshot;
}

function aiPayload(
  snapshot: AnalysisSnapshot | null,
  timeline: TimelineItem[],
  mint: string,
  body: RequestBody,
  options: { role?: "analyst" | "critic"; priorConclusion?: string } = {},
) {
  const messages = snapshot ? snapshotMessages(snapshot) : timelineMessages(timeline);
  if (!messages.length) return null;
  const times = messages
    .map((message) => Date.parse(message.sentAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    messages,
    context: {
      tokenAddress: mint,
      symbol: body.symbol
        ? String(body.symbol).replace(/^\$/, "").slice(0, 32)
        : snapshot?.symbol || null,
      tokenName: body.tokenName
        ? String(body.tokenName).slice(0, 128)
        : snapshot?.tokenName || null,
      windowStart: times.length ? new Date(times[0]).toISOString() : null,
      windowEnd: times.length ? new Date(times[times.length - 1]).toISOString() : null,
      analysisMode: snapshot ? "full_intelligence" : "telegram_only",
      analysisRole: options.role || "analyst",
      priorConclusion: options.priorConclusion?.slice(0, 6_000) || null,
      ...(snapshot ? { intelligenceSnapshot: snapshot } : {}),
    },
    persist: false,
  };
}

async function runQwen(
  payload: NonNullable<ReturnType<typeof aiPayload>>,
  timeoutMs: number,
): Promise<QwenEnvelope> {
  const response = await fetch(`${AI_BASE}/api/telegram-ai/analyze`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY
        ? { "x-api-key": API_KEY, authorization: `Bearer ${API_KEY}` }
        : {}),
    },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(Math.max(5_000, timeoutMs)),
  });
  const result = (await response.json().catch(() => ({}))) as QwenEnvelope;
  if (!response.ok) {
    const message = String(
      result.message || result.error || result.detail || `Qwen HTTP ${response.status}`,
    );
    throw Object.assign(new Error(message), { status: response.status });
  }
  return result;
}

async function buildAdvancedReport(
  snapshot: AnalysisSnapshot,
  result: QwenEnvelope,
  options: {
    persist?: boolean;
    enrich?: boolean;
    role?: "analyst" | "critic";
    timeoutMs?: number;
  } = {},
): Promise<AdvancedReport | null> {
  if (!BACKEND_KEY) return null;
  try {
    const response = await fetch(
      `${BACKEND_BASE}/api/v1/social/intelligence/advanced/report`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Backend-API-Key": BACKEND_KEY,
        },
        body: JSON.stringify({
          snapshot,
          ai_result: result.result || null,
          persist: options.persist ?? true,
          enrich: options.enrich ?? true,
          role: options.role || "analyst",
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs || 8_000),
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as AdvancedReport;
  } catch {
    return null;
  }
}

async function persistMainMemory(
  snapshot: AnalysisSnapshot,
  analysisSnapshot: AnalysisSnapshot,
  result: QwenEnvelope,
) {
  if (!BACKEND_KEY) return { status: "disabled" };
  try {
    const response = await fetch(
      `${BACKEND_BASE}/api/v1/social/intelligence/memory`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Backend-API-Key": BACKEND_KEY,
        },
        body: JSON.stringify({
          snapshot,
          analysis_snapshot: analysisSnapshot,
          ai_result: result.result || null,
          provider: typeof result.provider === "string" ? result.provider : null,
          model: typeof result.model === "string" ? result.model : null,
          prompt_version: INTELLIGENCE_PROMPT_VERSION,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok) return { status: "unavailable" };
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return { status: "unavailable" };
  }
}

async function persistCriticAudit(
  snapshotId: string,
  criticSnapshot: AnalysisSnapshot,
  priorConclusion: string,
  critic: QwenEnvelope,
) {
  if (!BACKEND_KEY) return { status: "disabled" };
  const advancedFeatures = criticSnapshot.features.filter((feature) =>
    feature.key.startsWith("advanced."),
  );
  try {
    const response = await fetch(
      `${BACKEND_BASE}/api/v1/social/intelligence/memory/audit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Backend-API-Key": BACKEND_KEY,
        },
        body: JSON.stringify({
          snapshot_id: snapshotId,
          key: "critic_v1",
          payload: {
            prompt_version: INTELLIGENCE_PROMPT_VERSION,
            advanced_features: advancedFeatures,
            prior_conclusion: priorConclusion,
            result: critic.result || null,
            provider: typeof critic.provider === "string" ? critic.provider : null,
            model: typeof critic.model === "string" ? critic.model : null,
          },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      },
    );
    return { status: response.ok ? "stored" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

function compactPriorConclusion(result: QwenEnvelope) {
  const value = {
    summary: result.result?.summary || null,
    campaignHypothesis: result.result?.campaignHypothesis || null,
    finalIntelligence: result.result?.finalIntelligence || null,
    overallConfidence: result.result?.overallConfidence ?? null,
    discoveredRelationships: (result.result?.discoveredRelationships || []).slice(0, 25),
  };
  return JSON.stringify(value).slice(0, 6_000);
}

function remainingBudget(startedAt: number) {
  return Math.max(0, REQUEST_BUDGET_MS - (Date.now() - startedAt));
}

function advancedFeature(
  snapshot: AnalysisSnapshot,
  layer: string,
  value: unknown,
): IntelligenceFeature {
  const serialized = JSON.stringify(value ?? null).slice(0, 600);
  return {
    key: `advanced.${layer}`,
    group: "Advanced Intelligence",
    label: layer.replaceAll("_", " "),
    value: serialized,
    numericValue: null,
    source: "derived",
    confidence: 0.85,
    observedAt: snapshot.createdAt,
    missing: false,
    note: "Deterministic/historical advanced-intelligence layer; verify evidence before causal claims.",
  };
}

function snapshotWithAdvancedReport(
  snapshot: AnalysisSnapshot,
  report: AdvancedReport | null,
) {
  if (!report?.layers) return snapshot;
  const existing = new Set(snapshot.features.map((item) => item.key));
  const additions = Object.entries(report.layers)
    .filter(([key]) => !existing.has(`advanced.${key}`))
    .map(([key, value]) => advancedFeature(snapshot, key, value))
    .slice(0, Math.max(0, 300 - snapshot.features.length));
  if (!additions.length) return snapshot;
  return {
    ...snapshot,
    featureCount: snapshot.features.length + additions.length,
    features: [...snapshot.features, ...additions],
  };
}

function plannerCandidates(report: AdvancedReport | null) {
  const rows = report?.layers?.research_planner?.candidates || [];
  return rows
    .filter((row) => row.entity)
    .sort(
      (left, right) =>
        Number(right.expected_information_gain || 0) -
        Number(left.expected_information_gain || 0),
    )
    .map((row) => String(row.entity));
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const mint = String(body.mint || "").trim();
  const timeline = Array.isArray(body.timeline) ? body.timeline : [];
  if (!mint) {
    return NextResponse.json({ error: "mint_required" }, { status: 400 });
  }

  let snapshot: AnalysisSnapshot | null;
  try {
    snapshot = validateSnapshot(body, mint);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid_snapshot" },
      { status: 400 },
    );
  }

  try {
    const initialMemory = snapshot ? await loadMemoryContext(snapshot) : null;
    let analysisSnapshot = snapshot
      ? enrichSnapshotWithMemory(snapshot, initialMemory)
      : null;
    const firstPayload = aiPayload(analysisSnapshot, timeline, mint, body);
    if (!firstPayload) {
      return NextResponse.json(
        {
          error: analysisSnapshot
            ? "no_snapshot_evidence_for_ai"
            : "no_telegram_text_for_ai",
        },
        { status: 400 },
      );
    }

    let result = await runQwen(
      firstPayload,
      Math.min(45_000, Math.max(12_000, remainingBudget(startedAt) - 15_000)),
    );
    let researchRound = 0;
    const researchRuns: ResearchRun[] = [];
    const researched = new Set<string>();

    if (analysisSnapshot && remainingBudget(startedAt) > 26_000) {
      const candidates = researchCandidates(analysisSnapshot, result);
      if (candidates.length) {
        const before = analysisSnapshot.features.length;
        const run = await runBoundedResearch(analysisSnapshot, candidates);
        researchRuns.push(run);
        for (const entity of run.requested || []) researched.add(entity);
        analysisSnapshot = run.snapshot;
        if (
          analysisSnapshot.features.length > before &&
          remainingBudget(startedAt) > 18_000
        ) {
          const payload = aiPayload(analysisSnapshot, timeline, mint, body);
          if (payload) {
            result = await runQwen(
              payload,
              Math.min(32_000, Math.max(10_000, remainingBudget(startedAt) - 12_000)),
            );
            researchRound = 1;
          }
        }
      }
    }

    let planningReport: AdvancedReport | null = null;
    if (analysisSnapshot && remainingBudget(startedAt) > 10_000) {
      planningReport = await buildAdvancedReport(analysisSnapshot, result, {
        persist: false,
        enrich: false,
        role: "analyst",
        timeoutMs: 6_000,
      });
    }

    const recommendedRounds = Math.max(
      1,
      Math.min(
        MAX_DYNAMIC_RESEARCH_ROUNDS,
        Number(
          planningReport?.layers?.dynamic_research_budget?.recommended_research_rounds || 1,
        ),
      ),
    );

    for (
      let round = researchRound + 1;
      analysisSnapshot && round <= recommendedRounds && round <= MAX_DYNAMIC_RESEARCH_ROUNDS;
      round++
    ) {
      if (remainingBudget(startedAt) < 25_000) break;
      const qwenCandidates = researchCandidates(analysisSnapshot, result);
      const deterministicCandidates = plannerCandidates(planningReport);
      const candidates = [...new Set([...qwenCandidates, ...deterministicCandidates])]
        .filter((entity) => !researched.has(entity))
        .slice(0, 8);
      if (!candidates.length) break;

      const before = analysisSnapshot.features.length;
      const run = await runBoundedResearch(analysisSnapshot, candidates);
      researchRuns.push(run);
      for (const entity of run.requested || []) researched.add(entity);
      analysisSnapshot = run.snapshot;
      if (analysisSnapshot.features.length <= before) break;
      if (remainingBudget(startedAt) < 16_000) break;

      const payload = aiPayload(analysisSnapshot, timeline, mint, body);
      if (!payload) break;
      result = await runQwen(
        payload,
        Math.min(24_000, Math.max(8_000, remainingBudget(startedAt) - 10_000)),
      );
      researchRound = round;
    }

    const memoryWrite =
      snapshot && analysisSnapshot && remainingBudget(startedAt) > 4_500
        ? await persistMainMemory(snapshot, analysisSnapshot, result)
        : { status: "skipped_budget" };

    let advancedIntelligence: AdvancedReport | null = null;
    let critic: QwenEnvelope | null = null;
    let criticAudit: Record<string, unknown> = { status: "not_run" };
    if (analysisSnapshot && remainingBudget(startedAt) > 12_000) {
      advancedIntelligence = await buildAdvancedReport(analysisSnapshot, result, {
        persist: true,
        enrich: true,
        role: "analyst",
        timeoutMs: Math.min(18_000, Math.max(8_000, remainingBudget(startedAt) - 7_000)),
      });

      const criticSnapshot = snapshotWithAdvancedReport(
        analysisSnapshot,
        advancedIntelligence,
      );
      if (
        advancedIntelligence?.layers?.dedicated_critic?.required &&
        remainingBudget(startedAt) > 14_000
      ) {
        const priorConclusion = compactPriorConclusion(result);
        const criticPayload = aiPayload(criticSnapshot, timeline, mint, body, {
          role: "critic",
          priorConclusion,
        });
        if (criticPayload) {
          try {
            critic = await runQwen(
              criticPayload,
              Math.min(20_000, Math.max(8_000, remainingBudget(startedAt) - 4_000)),
            );
            if (remainingBudget(startedAt) > 4_500) {
              await buildAdvancedReport(criticSnapshot, critic, {
                persist: true,
                enrich: false,
                role: "critic",
                timeoutMs: 4_000,
              });
            }
            if (snapshot && remainingBudget(startedAt) > 4_000) {
              criticAudit = await persistCriticAudit(
                snapshot.snapshotId,
                criticSnapshot,
                priorConclusion,
                critic,
              );
            }
          } catch {
            critic = null;
            criticAudit = { status: "failed" };
          }
        }
      }
    }

    const lastResearch = researchRuns.length
      ? researchRuns[researchRuns.length - 1]
      : null;
    return NextResponse.json(
      {
        agent: "qwen",
        available: true,
        analysisMode: analysisSnapshot ? "full_intelligence" : "telegram_only",
        snapshotId: snapshot?.snapshotId || null,
        requestBudget: {
          maxMs: REQUEST_BUDGET_MS,
          elapsedMs: Date.now() - startedAt,
          remainingMs: remainingBudget(startedAt),
        },
        memory: {
          loaded: Boolean(initialMemory),
          stats: initialMemory?.stats || null,
          write: memoryWrite,
          criticAudit,
          researchRound,
          recommendedResearchRounds: recommendedRounds,
          researchedEntities: [...researched],
          tools: researchMeta(lastResearch),
        },
        advancedIntelligence,
        critic: critic
          ? {
              available: true,
              result: critic.result || null,
              provider: critic.provider || null,
              model: critic.model || null,
            }
          : { available: false },
        ...result,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const rawStatus = (error as { status?: unknown }).status;
    const status = typeof rawStatus === "number" ? rawStatus : 503;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "qwen_unreachable",
        agent: "qwen",
        available: false,
      },
      { status: status === 401 || status === 403 ? status : 503 },
    );
  }
}
