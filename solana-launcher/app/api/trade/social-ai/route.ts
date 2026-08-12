import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type {
  AnalysisSnapshot,
  IntelligenceFeature,
} from "@/lib/trade/intelligence-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const AI_BASE = (
  process.env.MEMECOIN_INTELLIGENCE_URL || "http://host.docker.internal:3001"
).replace(/\/$/, "");
const API_KEY =
  process.env.MEMECOIN_INTELLIGENCE_API_KEY || process.env.INTERNAL_API_KEY || "";
const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(
  /\/$/,
  "",
);
const BACKEND_KEY = process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || "";
const PROMPT_VERSION = "intelligence-qwen-v5-tools";
const MAX_RESEARCH_ENTITIES = 8;

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

type MemoryContext = {
  entities?: Array<{
    key?: string;
    type?: string;
    label?: string;
    occurrence_count?: number;
    first_seen_at?: string;
    last_seen_at?: string;
  }>;
  edges?: Array<{
    source?: string;
    target?: string;
    type?: string;
    occurrence_count?: number;
    avg_confidence?: number;
    max_confidence?: number;
    last_seen_at?: string;
  }>;
  discoveries?: Array<{
    type?: string;
    source?: string | null;
    target?: string | null;
    status?: string;
    confidence?: number;
    rationale?: string;
    created_at?: string;
  }>;
  prior_snapshots?: Array<{
    snapshot_id?: string;
    overall_confidence?: number | null;
    created_at?: string;
  }>;
  stats?: Record<string, number>;
};

type ResearchResult = Record<string, unknown> & {
  tool?: string;
  entity_key?: string;
  found?: boolean;
};

type ResearchContext = {
  entities_requested?: string[];
  tool_calls?: number;
  results?: ResearchResult[];
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

async function loadMemoryContext(
  snapshot: AnalysisSnapshot,
  entityKeys = snapshot.graph.nodes.map((node) => node.id).slice(0, 80),
  maxEdges = 100,
): Promise<MemoryContext | null> {
  if (!BACKEND_KEY) return null;
  try {
    const response = await fetch(
      `${BACKEND_BASE}/api/v1/social/intelligence/context`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Backend-API-Key": BACKEND_KEY,
        },
        body: JSON.stringify({
          entity_keys: entityKeys,
          mint: snapshot.mint,
          max_entities: 40,
          max_edges: maxEdges,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(3_500),
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as MemoryContext;
  } catch {
    return null;
  }
}

async function loadResearchContext(
  snapshot: AnalysisSnapshot,
  entityKeys: string[],
): Promise<ResearchContext | null> {
  if (!BACKEND_KEY || !entityKeys.length) return null;
  try {
    const response = await fetch(
      `${BACKEND_BASE}/api/v1/social/intelligence/research`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Backend-API-Key": BACKEND_KEY,
        },
        body: JSON.stringify({
          entity_keys: entityKeys.slice(0, MAX_RESEARCH_ENTITIES),
          current_mint: snapshot.mint,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as ResearchContext;
  } catch {
    return null;
  }
}

function derivedFeature(
  key: string,
  group: string,
  label: string,
  value: string | number,
  observedAt: string,
  confidence: number,
  note: string,
): IntelligenceFeature {
  return {
    key,
    group,
    label,
    value,
    numericValue: typeof value === "number" ? value : null,
    source: "derived",
    confidence,
    observedAt,
    missing: false,
    note,
  };
}

function memoryFeature(
  key: string,
  label: string,
  value: string | number,
  observedAt: string,
  confidence = 0.75,
) {
  return derivedFeature(
    key,
    "Historical Memory",
    label,
    value,
    observedAt,
    confidence,
    "Historical memory: prior observation/hypothesis, not current proof.",
  );
}

function researchFeature(
  key: string,
  label: string,
  value: string | number,
  observedAt: string,
  confidence = 0.8,
) {
  return derivedFeature(
    key,
    "Agent Research",
    label,
    value,
    observedAt,
    confidence,
    "Read-only research result. Similarity is not identity, control, funding or causality proof.",
  );
}

function enrichSnapshotWithMemory(
  snapshot: AnalysisSnapshot,
  memory: MemoryContext | null,
  researchRound = 0,
): AnalysisSnapshot {
  if (!memory) return snapshot;
  const additions: IntelligenceFeature[] = [];
  const observedAt = snapshot.createdAt;
  const stats = memory.stats || {};

  for (const [key, value] of Object.entries(stats)) {
    if (Number.isFinite(value)) {
      additions.push(
        memoryFeature(
          `memory.stats.${key}`,
          `Memory ${key}`,
          value,
          observedAt,
          0.9,
        ),
      );
    }
  }

  for (const entity of (memory.entities || []).slice(0, 35)) {
    if (!entity.key) continue;
    const hash = createHash("sha1").update(entity.key).digest("hex").slice(0, 12);
    additions.push(
      memoryFeature(
        `memory.entity.${hash}.occurrences`,
        `${entity.label || entity.key} · prior token appearances`,
        Number(entity.occurrence_count || 0),
        observedAt,
        0.85,
      ),
    );
  }

  for (const edge of (memory.edges || []).slice(0, researchRound ? 120 : 55)) {
    const hash = createHash("sha1")
      .update(`${edge.source}|${edge.type}|${edge.target}`)
      .digest("hex")
      .slice(0, 12);
    const summary = [
      `${edge.source || "?"} --${edge.type || "related"}--> ${edge.target || "?"}`,
      `seen on ${edge.occurrence_count || 0} token(s)`,
      `avg confidence ${Number(edge.avg_confidence || 0).toFixed(2)}`,
    ].join("; ");
    additions.push(
      memoryFeature(
        `memory.edge.${hash}`,
        "Historical graph edge",
        summary.slice(0, 500),
        observedAt,
        Math.max(0.35, Math.min(0.95, Number(edge.avg_confidence || 0.6))),
      ),
    );
  }

  for (const discovery of (memory.discoveries || []).slice(
    0,
    researchRound ? 80 : 35,
  )) {
    const hash = createHash("sha1")
      .update(
        `${discovery.type}|${discovery.source}|${discovery.target}|${discovery.created_at}`,
      )
      .digest("hex")
      .slice(0, 12);
    const summary = [
      `${discovery.status || "hypothesis"}: ${discovery.type || "discovery"}`,
      `${discovery.source || ""} -> ${discovery.target || ""}`,
      discovery.rationale || "",
    ].join("; ");
    additions.push(
      memoryFeature(
        `memory.discovery.${hash}`,
        "Historical AI discovery",
        summary.slice(0, 500),
        observedAt,
        Math.max(0.25, Math.min(0.9, Number(discovery.confidence || 0.5))),
      ),
    );
  }

  if (researchRound) {
    additions.unshift(
      memoryFeature(
        `memory.research.round_${researchRound}`,
        "Agent research round",
        researchRound,
        observedAt,
        1,
      ),
    );
  }

  return appendFeatures(snapshot, additions);
}

function compactValue(value: unknown, max = 500) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "").slice(0, max);
}

function researchFeatures(
  snapshot: AnalysisSnapshot,
  research: ResearchContext | null,
): IntelligenceFeature[] {
  if (!research?.results?.length) return [];
  const observedAt = snapshot.createdAt;
  const additions: IntelligenceFeature[] = [];
  for (const item of research.results.slice(0, 30)) {
    if (!item.found) continue;
    const tool = String(item.tool || "research");
    const entity = String(item.entity_key || "unknown");
    const hash = createHash("sha1")
      .update(`${tool}|${entity}`)
      .digest("hex")
      .slice(0, 12);

    if (tool === "expand_wallet") {
      additions.push(
        researchFeature(
          `research.wallet.${hash}`,
          `${entity} · wallet history`,
          compactValue({
            wallet: item.wallet,
            trades: Array.isArray(item.trades) ? item.trades.slice(0, 15) : [],
            wallet_links: Array.isArray(item.wallet_links)
              ? item.wallet_links.slice(0, 12)
              : [],
          }),
          observedAt,
          0.88,
        ),
      );
    } else if (tool === "funding_graph") {
      additions.push(
        researchFeature(
          `research.funding.${hash}`,
          `${entity} · funding / similarity graph`,
          compactValue({
            funding_evidence_available: item.funding_evidence_available,
            verified_funding_edges: Array.isArray(item.verified_funding_edges)
              ? item.verified_funding_edges.slice(0, 10)
              : [],
            similarity_links_not_funding_proof: Array.isArray(
              item.similarity_links_not_funding_proof,
            )
              ? item.similarity_links_not_funding_proof.slice(0, 10)
              : [],
          }),
          observedAt,
          item.funding_evidence_available ? 0.9 : 0.65,
        ),
      );
    } else if (tool === "expand_x_account") {
      additions.push(
        researchFeature(
          `research.x.${hash}`,
          `${entity} · X history`,
          compactValue({
            account: item.account,
            recent_mentions: Array.isArray(item.recent_mentions)
              ? item.recent_mentions.slice(0, 20).map((entry) => {
                  const row = entry as Record<string, unknown>;
                  return {
                    mint: row.mint,
                    symbol: row.symbol,
                    occurred_at: row.occurred_at,
                    event_type: row.event_type,
                  };
                })
              : [],
          }),
          observedAt,
          0.82,
        ),
      );
    } else if (tool === "expand_tg_channel") {
      additions.push(
        researchFeature(
          `research.tg.${hash}`,
          `${entity} · Telegram history`,
          compactValue({
            channel: item.channel,
            recent_calls: Array.isArray(item.recent_calls)
              ? item.recent_calls.slice(0, 20)
              : [],
          }),
          observedAt,
          0.9,
        ),
      );
    } else if (tool === "related_launches") {
      additions.push(
        researchFeature(
          `research.launches.${hash}`,
          `${entity} · related launches`,
          compactValue({
            launches: Array.isArray(item.launches) ? item.launches.slice(0, 25) : [],
          }),
          observedAt,
          0.86,
        ),
      );
    }
  }
  return additions;
}

function appendFeatures(
  snapshot: AnalysisSnapshot,
  additions: IntelligenceFeature[],
): AnalysisSnapshot {
  const existing = new Set(snapshot.features.map((feature) => feature.key));
  const selected = additions
    .filter((feature) => !existing.has(feature.key))
    .slice(0, Math.max(0, 300 - snapshot.features.length));
  return {
    ...snapshot,
    featureCount: snapshot.features.length + selected.length,
    features: [...snapshot.features, ...selected],
  };
}

function enrichSnapshotWithResearch(
  snapshot: AnalysisSnapshot,
  research: ResearchContext | null,
) {
  return appendFeatures(snapshot, researchFeatures(snapshot, research));
}

function researchCandidates(snapshot: AnalysisSnapshot, envelope: QwenEnvelope): string[] {
  const result = envelope.result;
  if (!result) return [];
  const byId = new Set(snapshot.graph.nodes.map((node) => node.id));
  const byLabel = new Map(
    snapshot.graph.nodes.map((node) => [node.label.toLowerCase(), node.id]),
  );
  const resolved: string[] = [];
  const resolve = (value: string | undefined) => {
    if (!value) return;
    if (byId.has(value)) {
      resolved.push(value);
      return;
    }
    const id = byLabel.get(value.toLowerCase());
    if (id) resolved.push(id);
  };

  for (const relationship of result.discoveredRelationships || []) {
    if (Number(relationship.confidence || 0) < 0.55) continue;
    resolve(relationship.source);
    resolve(relationship.target);
  }
  for (const value of result.campaignHypothesis?.likelyOriginators || []) {
    resolve(value);
  }
  for (const value of result.campaignHypothesis?.amplifiers || []) {
    resolve(value);
  }
  return [...new Set(resolved)].slice(0, MAX_RESEARCH_ENTITIES);
}

function aiPayload(
  snapshot: AnalysisSnapshot | null,
  timeline: TimelineItem[],
  mint: string,
  body: RequestBody,
) {
  const messages = snapshot ? snapshotMessages(snapshot) : timelineMessages(timeline);
  if (!messages.length) return null;
  const windowTimes = messages
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
      windowStart: windowTimes.length
        ? new Date(windowTimes[0]).toISOString()
        : null,
      windowEnd: windowTimes.length
        ? new Date(windowTimes[windowTimes.length - 1]).toISOString()
        : null,
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

async function persistMemory(
  snapshot: AnalysisSnapshot,
  analysisSnapshot: AnalysisSnapshot,
  aiEnvelope: QwenEnvelope,
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
          ai_result: aiEnvelope.result || null,
          provider:
            typeof aiEnvelope.provider === "string" ? aiEnvelope.provider : null,
          model: typeof aiEnvelope.model === "string" ? aiEnvelope.model : null,
          prompt_version: PROMPT_VERSION,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!response.ok) return { status: "error", http: response.status };
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return { status: "unavailable" };
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
    const memoryContext = snapshot ? await loadMemoryContext(snapshot) : null;
    let analysisSnapshot = snapshot
      ? enrichSnapshotWithMemory(snapshot, memoryContext)
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
    let researchMemory: MemoryContext | null = null;
    let researchTools: ResearchContext | null = null;
    let researchRound = 0;

    if (analysisSnapshot && candidates.length && BACKEND_KEY) {
      [researchMemory, researchTools] = await Promise.all([
        loadMemoryContext(analysisSnapshot, candidates, 300),
        loadResearchContext(analysisSnapshot, candidates),
      ]);
      const before = analysisSnapshot.features.length;
      analysisSnapshot = enrichSnapshotWithMemory(
        analysisSnapshot,
        researchMemory,
        1,
      );
      analysisSnapshot = enrichSnapshotWithResearch(
        analysisSnapshot,
        researchTools,
      );
      if (analysisSnapshot.features.length > before) {
        const secondPayload = aiPayload(analysisSnapshot, timeline, mint, body);
        if (secondPayload) {
          result = await runQwen(secondPayload);
          researchRound = 1;
        }
      }
    }

    const memoryWrite = snapshot && analysisSnapshot
      ? await persistMemory(snapshot, analysisSnapshot, result)
      : { status: "skipped" };
    const toolNames = [
      ...new Set(
        (researchTools?.results || [])
          .map((item) => String(item.tool || ""))
          .filter(Boolean),
      ),
    ];
    return NextResponse.json(
      {
        agent: "qwen",
        available: true,
        analysisMode: analysisSnapshot ? "full_intelligence" : "telegram_only",
        snapshotId: snapshot?.snapshotId || null,
        memory: {
          loaded: Boolean(memoryContext),
          stats: memoryContext?.stats || null,
          write: memoryWrite,
          researchRound,
          researchCandidates: candidates,
          researchStats: researchMemory?.stats || null,
          tools: {
            enabled: Boolean(BACKEND_KEY),
            calls: researchTools?.tool_calls || 0,
            names: toolNames,
          },
        },
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
