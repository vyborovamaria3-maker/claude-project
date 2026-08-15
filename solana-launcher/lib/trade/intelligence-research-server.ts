import "server-only";

import { createHash } from "node:crypto";
import type {
  AnalysisSnapshot,
} from "@/lib/trade/intelligence-agent-provenance";
import { buildProvenanceFeature } from "@/lib/trade/intelligence-agent-provenance";

export const INTELLIGENCE_PROMPT_VERSION = "intelligence-qwen-v6-tools-evidence";
export const MAX_RESEARCH_ENTITIES = 8;
const MAX_NEIGHBOR_ENTITIES = 4;
const BACKEND_BASE = (process.env.BACKEND_URL || "http://backend:8000").replace(
  /\/$/,
  "",
);
const BACKEND_KEY = process.env.BACKEND_API_KEY || process.env.INTERNAL_API_KEY || "";
const ALLOWED_ENTITY_PREFIXES = [
  "wallet:",
  "x_account:",
  "tg_channel:",
  "token:",
] as const;

type MemoryContext = {
  entities?: Array<{
    key?: string;
    type?: string;
    label?: string;
    occurrence_count?: number;
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

type QwenEnvelopeLike = {
  result?: {
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
  provider?: unknown;
  model?: unknown;
};

function isAllowedEntityKey(value: string) {
  return ALLOWED_ENTITY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

async function backendPost<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<T | null> {
  if (!BACKEND_KEY) return null;
  try {
    const response = await fetch(`${BACKEND_BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Backend-API-Key": BACKEND_KEY,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function researchEnabled() {
  return Boolean(BACKEND_KEY);
}

export async function loadMemoryContext(
  snapshot: AnalysisSnapshot,
  entityKeys = snapshot.graph.nodes.map((node) => node.id).slice(0, 80),
  maxEdges = 100,
) {
  return backendPost<MemoryContext>(
    "/api/v1/social/intelligence/context",
    {
      entity_keys: entityKeys,
      mint: snapshot.mint,
      max_entities: 40,
      max_edges: maxEdges,
    },
    3_500,
  );
}

async function loadResearchContext(
  snapshot: AnalysisSnapshot,
  entityKeys: string[],
) {
  const keys = [...new Set(entityKeys)]
    .filter(isAllowedEntityKey)
    .slice(0, MAX_RESEARCH_ENTITIES);
  if (!keys.length) return null;
  return backendPost<ResearchContext>(
    "/api/v1/social/intelligence/research",
    { entity_keys: keys, current_mint: snapshot.mint },
    5_000,
  );
}

function feature(
  key: string,
  group: string,
  label: string,
  value: string | number,
  observedAt: string,
  confidence: number,
  note: string,
): AnalysisSnapshot["features"][number] {
  return buildProvenanceFeature({
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
  });
}

function appendFeatures(
  snapshot: AnalysisSnapshot,
  additions: AnalysisSnapshot["features"],
) {
  const existing = new Set(snapshot.features.map((item) => item.key));
  const selected = additions
    .filter((item) => !existing.has(item.key))
    .slice(0, Math.max(0, 300 - snapshot.features.length));
  return {
    ...snapshot,
    featureCount: snapshot.features.length + selected.length,
    features: [...snapshot.features, ...selected],
  };
}

export function enrichSnapshotWithMemory(
  snapshot: AnalysisSnapshot,
  memory: MemoryContext | null,
  researchRound = 0,
) {
  if (!memory) return snapshot;
  const observedAt = snapshot.createdAt;
  const additions: AnalysisSnapshot["features"] = [];
  for (const [key, value] of Object.entries(memory.stats || {})) {
    if (!Number.isFinite(value)) continue;
    additions.push(
      feature(
        `memory.stats.${key}`,
        "Historical Memory",
        `Memory ${key}`,
        value,
        observedAt,
        0.9,
        "Historical prior, not current proof.",
      ),
    );
  }
  for (const entity of (memory.entities || []).slice(0, 35)) {
    if (!entity.key) continue;
    const hash = createHash("sha1").update(entity.key).digest("hex").slice(0, 12);
    additions.push(
      feature(
        `memory.entity.${hash}.occurrences`,
        "Historical Memory",
        `${entity.label || entity.key} · prior token appearances`,
        Number(entity.occurrence_count || 0),
        observedAt,
        0.85,
        "Distinct-token historical occurrence count, not identity/control proof.",
      ),
    );
  }
  for (const edge of (memory.edges || []).slice(0, researchRound ? 120 : 55)) {
    const hash = createHash("sha1")
      .update(`${edge.source}|${edge.type}|${edge.target}`)
      .digest("hex")
      .slice(0, 12);
    additions.push(
      feature(
        `memory.edge.${hash}`,
        "Historical Memory",
        "Historical graph edge",
        [
          `${edge.source || "?"} --${edge.type || "related"}--> ${edge.target || "?"}`,
          `seen on ${edge.occurrence_count || 0} token(s)`,
          `avg confidence ${Number(edge.avg_confidence || 0).toFixed(2)}`,
        ].join("; ").slice(0, 500),
        observedAt,
        Math.max(0.35, Math.min(0.95, Number(edge.avg_confidence || 0.6))),
        "Historical graph prior; reconfirm with current evidence.",
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
    additions.push(
      feature(
        `memory.discovery.${hash}`,
        "Historical Memory",
        "Historical AI discovery",
        [
          `${discovery.status || "hypothesis"}: ${discovery.type || "discovery"}`,
          `${discovery.source || ""} -> ${discovery.target || ""}`,
          discovery.rationale || "",
        ].join("; ").slice(0, 500),
        observedAt,
        Math.max(0.25, Math.min(0.9, Number(discovery.confidence || 0.5))),
        "Prior AI hypothesis; never independent confirmation of itself.",
      ),
    );
  }
  if (researchRound) {
    additions.unshift(
      feature(
        `memory.research.round_${researchRound}`,
        "Historical Memory",
        "Agent research round",
        researchRound,
        observedAt,
        1,
        "Bounded read-only research pass.",
      ),
    );
  }
  return appendFeatures(snapshot, additions);
}

function compact(value: unknown, max = 500) {
  return String(
    typeof value === "string" ? value : JSON.stringify(value) || "",
  ).slice(0, max);
}

function researchFeature(
  snapshot: AnalysisSnapshot,
  tool: string,
  entity: string,
  value: unknown,
  confidence: number,
) {
  const hash = createHash("sha1")
    .update(`${tool}|${entity}`)
    .digest("hex")
    .slice(0, 12);
  return feature(
    `research.${tool}.${hash}`,
    "Agent Research",
    `${entity} · ${tool}`,
    compact(value),
    snapshot.createdAt,
    confidence,
    "Read-only DB research. Similarity is not identity, control, funding or causality proof.",
  );
}

function researchFeatures(
  snapshot: AnalysisSnapshot,
  research: ResearchContext | null,
) {
  if (!research?.results?.length) return [];
  const additions: AnalysisSnapshot["features"] = [];
  for (const item of research.results.slice(0, 30)) {
    if (!item.found) continue;
    const tool = String(item.tool || "research");
    const entity = String(item.entity_key || "unknown");
    if (tool === "expand_wallet") {
      additions.push(
        researchFeature(
          snapshot,
          tool,
          entity,
          {
            wallet: item.wallet,
            trades: Array.isArray(item.trades) ? item.trades.slice(0, 15) : [],
            wallet_links: Array.isArray(item.wallet_links)
              ? item.wallet_links.slice(0, 12)
              : [],
          },
          0.88,
        ),
      );
    } else if (tool === "funding_graph") {
      additions.push(
        researchFeature(
          snapshot,
          tool,
          entity,
          {
            funding_evidence_available: item.funding_evidence_available,
            explicit_funding_evidence: Array.isArray(item.explicit_funding_evidence)
              ? item.explicit_funding_evidence.slice(0, 10)
              : [],
            similarity_links_not_funding_proof: Array.isArray(
              item.similarity_links_not_funding_proof,
            )
              ? item.similarity_links_not_funding_proof.slice(0, 10)
              : [],
          },
          item.funding_evidence_available ? 0.88 : 0.65,
        ),
      );
    } else if (tool === "expand_x_account") {
      const mentions = Array.isArray(item.recent_mentions)
        ? item.recent_mentions.slice(0, 20).map((entry) => {
            const row = entry as Record<string, unknown>;
            return {
              mint: row.mint,
              symbol: row.symbol,
              occurred_at: row.occurred_at,
              event_type: row.event_type,
            };
          })
        : [];
      additions.push(
        researchFeature(
          snapshot,
          tool,
          entity,
          { account: item.account, recent_mentions: mentions },
          0.82,
        ),
      );
    } else if (tool === "expand_tg_channel") {
      additions.push(
        researchFeature(
          snapshot,
          tool,
          entity,
          {
            channel: item.channel,
            recent_calls: Array.isArray(item.recent_calls)
              ? item.recent_calls.slice(0, 20)
              : [],
          },
          0.9,
        ),
      );
    } else if (tool === "related_launches") {
      additions.push(
        researchFeature(
          snapshot,
          tool,
          entity,
          {
            launches: Array.isArray(item.launches) ? item.launches.slice(0, 25) : [],
          },
          0.86,
        ),
      );
    }
  }
  return additions;
}

export function researchCandidates(
  snapshot: AnalysisSnapshot,
  envelope: QwenEnvelopeLike,
) {
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
  for (const value of result.campaignHypothesis?.likelyOriginators || []) resolve(value);
  for (const value of result.campaignHypothesis?.amplifiers || []) resolve(value);
  return [...new Set(resolved)].slice(0, MAX_RESEARCH_ENTITIES);
}

function historicalNeighbors(
  snapshot: AnalysisSnapshot,
  candidates: string[],
  memory: MemoryContext | null,
) {
  if (!memory?.edges?.length) return [];
  const selected = new Set(candidates);
  const current = new Set(snapshot.graph.nodes.map((node) => node.id));
  const neighbors: string[] = [];
  for (const edge of memory.edges) {
    const source = edge.source || "";
    const target = edge.target || "";
    const other = selected.has(source)
      ? target
      : selected.has(target)
        ? source
        : "";
    if (!other || current.has(other) || !isAllowedEntityKey(other)) continue;
    if (
      Number(edge.occurrence_count || 0) < 2 &&
      Number(edge.max_confidence || 0) < 0.7
    ) {
      continue;
    }
    neighbors.push(other);
  }
  return [...new Set(neighbors)].slice(0, MAX_NEIGHBOR_ENTITIES);
}

export async function runBoundedResearch(
  snapshot: AnalysisSnapshot,
  candidates: string[],
) {
  if (!researchEnabled() || !candidates.length) {
    return {
      snapshot,
      memory: null,
      tools: null,
      requested: candidates,
      neighborCandidates: [] as string[],
    };
  }
  const primary = candidates.slice(0, MAX_RESEARCH_ENTITIES - MAX_NEIGHBOR_ENTITIES);
  const memory = await loadMemoryContext(snapshot, primary, 300);
  const neighborCandidates = historicalNeighbors(snapshot, primary, memory);
  const requested = [
    ...new Set([
      ...primary,
      ...neighborCandidates,
      ...candidates.slice(primary.length),
    ]),
  ].slice(0, MAX_RESEARCH_ENTITIES);
  const tools = await loadResearchContext(snapshot, requested);

  // Tool observations are more specific than repeated memory edges, so reserve feature
  // budget for them before adding the expanded historical memory layer.
  let enriched = appendFeatures(snapshot, researchFeatures(snapshot, tools));
  enriched = enrichSnapshotWithMemory(enriched, memory, 1);
  return { snapshot: enriched, memory, tools, requested, neighborCandidates };
}

export async function persistIntelligenceMemory(
  snapshot: AnalysisSnapshot,
  analysisSnapshot: AnalysisSnapshot,
  envelope: QwenEnvelopeLike,
) {
  if (!BACKEND_KEY) return { status: "disabled" };
  const result = await backendPost<Record<string, unknown>>(
    "/api/v1/social/intelligence/memory",
    {
      snapshot,
      analysis_snapshot: analysisSnapshot,
      ai_result: envelope.result || null,
      provider: typeof envelope.provider === "string" ? envelope.provider : null,
      model: typeof envelope.model === "string" ? envelope.model : null,
      prompt_version: INTELLIGENCE_PROMPT_VERSION,
    },
    4_000,
  );
  return result || { status: "unavailable" };
}

export function researchMeta(
  research: Awaited<ReturnType<typeof runBoundedResearch>> | null,
) {
  const results = research?.tools?.results || [];
  return {
    enabled: researchEnabled(),
    calls: research?.tools?.tool_calls || 0,
    names: [
      ...new Set(results.map((item) => String(item.tool || "")).filter(Boolean)),
    ],
    requested: research?.requested || [],
    historicalNeighbors: research?.neighborCandidates || [],
    memoryStats: research?.memory?.stats || null,
  };
}
