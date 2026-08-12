import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type { AnalysisSnapshot } from "@/lib/trade/intelligence-agent";
import {
  enrichSnapshotWithMemory,
  loadMemoryContext,
  persistIntelligenceMemory,
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
  discoveredRelationships?: Array<{
    source?: string;
    target?: string;
    confidence?: number;
  }>;
  campaignHypothesis?: {
    likelyOriginators?: string[];
    amplifiers?: string[];
  };
};

type QwenEnvelope = Record<string, unknown> & {
  result?: QwenResult;
  provider?: unknown;
  model?: unknown;
};

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
      ...(snapshot ? { intelligenceSnapshot: snapshot } : {}),
    },
    persist: false,
  };
}

async function runQwen(
  payload: NonNullable<ReturnType<typeof aiPayload>>,
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
    signal: AbortSignal.timeout(55_000),
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
): Promise<Record<string, unknown> | null> {
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
          persist: true,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
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

    let result = await runQwen(firstPayload);
    const candidates = analysisSnapshot
      ? researchCandidates(analysisSnapshot, result)
      : [];
    let boundedResearch: Awaited<ReturnType<typeof runBoundedResearch>> | null = null;
    let researchRound = 0;

    if (analysisSnapshot && candidates.length) {
      const before = analysisSnapshot.features.length;
      boundedResearch = await runBoundedResearch(analysisSnapshot, candidates);
      analysisSnapshot = boundedResearch.snapshot;
      if (analysisSnapshot.features.length > before) {
        const secondPayload = aiPayload(analysisSnapshot, timeline, mint, body);
        if (secondPayload) {
          result = await runQwen(secondPayload);
          researchRound = 1;
        }
      }
    }

    const [memoryWrite, advancedIntelligence] = snapshot && analysisSnapshot
      ? await Promise.all([
          persistIntelligenceMemory(snapshot, analysisSnapshot, result),
          buildAdvancedReport(analysisSnapshot, result),
        ])
      : [{ status: "skipped" }, null] as const;

    return NextResponse.json(
      {
        agent: "qwen",
        available: true,
        analysisMode: analysisSnapshot ? "full_intelligence" : "telegram_only",
        snapshotId: snapshot?.snapshotId || null,
        memory: {
          loaded: Boolean(initialMemory),
          stats: initialMemory?.stats || null,
          write: memoryWrite,
          researchRound,
          researchCandidates: candidates,
          tools: researchMeta(boundedResearch),
        },
        advancedIntelligence,
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
