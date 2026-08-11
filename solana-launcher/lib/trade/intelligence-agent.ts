import type {
  ChainAnalysis,
  DerivedSocial,
  Market,
  SocialTimeline,
  TimelineItem,
  Tweet,
  TwitterStats,
} from "@/lib/trade/social-intelligence";

export const INTELLIGENCE_SNAPSHOT_VERSION = "social-snapshot-v1";
export const INTELLIGENCE_GRAPH_VERSION = "entity-graph-v1";

export type IntelligenceFeature = {
  key: string;
  group: string;
  label: string;
  value: string | number | null;
  numericValue: number | null;
  source: "derived" | "x" | "telegram" | "market" | "chain";
  confidence: number;
  observedAt: string;
  missing: boolean;
  note?: string;
};

export type IntelligenceNodeType = "token" | "x_account" | "tg_channel" | "url";
export type IntelligenceEdgeType = "mentions" | "calls" | "shared_link" | "copies" | "amplifies";

export type IntelligenceNode = {
  id: string;
  type: IntelligenceNodeType;
  label: string;
  attributes: Record<string, string | number | boolean | null>;
};

export type IntelligenceEdge = {
  id: string;
  source: string;
  target: string;
  type: IntelligenceEdgeType;
  confidence: number;
  evidenceIds: string[];
  attributes: Record<string, string | number | boolean | null>;
};

export type IntelligenceGraph = {
  version: string;
  nodes: IntelligenceNode[];
  edges: IntelligenceEdge[];
  stats: {
    nodes: number;
    edges: number;
    xAccounts: number;
    tgChannels: number;
    sharedLinks: number;
    copyEdges: number;
    amplificationEdges: number;
  };
};

export type IntelligenceEvidence = {
  id: string;
  platform: "x" | "telegram";
  source: string;
  text: string;
  timestamp: string | null;
  url?: string | null;
};

export type AnalysisSnapshot = {
  snapshotId: string;
  version: string;
  graphVersion: string;
  mint: string;
  symbol: string | null;
  tokenName: string | null;
  createdAt: string;
  featureCount: number;
  missingFeatureCount: number;
  features: IntelligenceFeature[];
  graph: IntelligenceGraph;
  evidence: IntelligenceEvidence[];
  rawSummary: {
    xPosts: number;
    telegramMessages: number;
    trades: number;
    chainTruncated: boolean;
    marketAvailable: boolean;
  };
};

function stableHash(value: string) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function entityId(type: IntelligenceNodeType, value: string) {
  return `${type}:${stableHash(value.trim().toLowerCase())}`;
}

function evidenceId(platform: string, source: string, timestamp: string, text: string) {
  return `evidence-${stableHash(`${platform}|${source}|${timestamp}|${text}`)}`;
}

function slug(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9а-яё]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function numericFromDisplay(value: string) {
  const cleaned = value.replace(/[$,%+]/g, "").replace(/\s+/g, "").replace(/,/g, "");
  if (!cleaned || cleaned === "—") return null;
  const match = cleaned.match(/^-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 280);
}

function itemTime(item: TimelineItem) {
  const parsed = Date.parse(item.occurred_at);
  return Number.isFinite(parsed) ? parsed : null;
}

function tweetTime(tweet: Tweet) {
  if (tweet.timestamp == null) return null;
  const value = Number(tweet.timestamp);
  if (!Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function addNode(map: Map<string, IntelligenceNode>, node: IntelligenceNode) {
  if (!map.has(node.id)) map.set(node.id, node);
}

function addEdge(map: Map<string, IntelligenceEdge>, edge: Omit<IntelligenceEdge, "id">) {
  const id = `edge:${stableHash(`${edge.source}|${edge.type}|${edge.target}|${edge.evidenceIds.join(",")}`)}`;
  if (!map.has(id)) map.set(id, { id, ...edge });
}

function explicitCall(item: TimelineItem) {
  const metrics = item.metrics || {};
  return Boolean(metrics.explicit_call || metrics.is_explicit_call || String(item.event_type || "").toLowerCase().includes("call"));
}

function extractUrls(value: string) {
  return Array.from(new Set(value.match(/https?:\/\/[^\s)\]}>,]+/gi) || [])).slice(0, 10);
}

function buildEvidence(x: TwitterStats | null, tg: SocialTimeline | null): IntelligenceEvidence[] {
  const rows: IntelligenceEvidence[] = [];
  for (const tweet of x?.topTweets || []) {
    const source = `@${String(tweet.author || "unknown").replace(/^@/, "")}`;
    const ts = tweetTime(tweet);
    const iso = ts == null ? "" : new Date(ts).toISOString();
    rows.push({ id: evidenceId("x", source, iso, tweet.text || ""), platform: "x", source, text: tweet.text || "", timestamp: iso || null });
  }
  for (const item of tg?.timeline || []) {
    if (item.platform && item.platform.toLowerCase() !== "telegram") continue;
    const source = String(item.source_handle || item.source_name || "telegram:unknown");
    rows.push({ id: evidenceId("telegram", source, item.occurred_at || "", item.text || ""), platform: "telegram", source, text: item.text || "", timestamp: item.occurred_at || null, url: item.source_url || null });
  }
  return rows.slice(0, 300);
}

export function buildEntityGraph(mint: string, x: TwitterStats | null, tg: SocialTimeline | null): IntelligenceGraph {
  const nodes = new Map<string, IntelligenceNode>();
  const edges = new Map<string, IntelligenceEdge>();
  const tokenId = entityId("token", mint);
  addNode(nodes, { id: tokenId, type: "token", label: mint, attributes: { mint } });
  const events: Array<{ nodeId: string; time: number; evidence: string; platform: "x" | "telegram" }> = [];
  const textGroups = new Map<string, Array<{ nodeId: string; time: number; evidence: string }>>();
  let sharedLinks = 0;

  for (const tweet of x?.topTweets || []) {
    const handle = `@${String(tweet.author || "unknown").replace(/^@/, "")}`;
    const accountId = entityId("x_account", handle);
    addNode(nodes, { id: accountId, type: "x_account", label: handle, attributes: { suspicious: Boolean(tweet.isSuspicious) } });
    const time = tweetTime(tweet);
    const ts = time == null ? "" : new Date(time).toISOString();
    const ev = evidenceId("x", handle, ts, tweet.text || "");
    addEdge(edges, { source: accountId, target: tokenId, type: "mentions", confidence: 1, evidenceIds: [ev], attributes: { platform: "x" } });
    if (time != null) events.push({ nodeId: accountId, time, evidence: ev, platform: "x" });
    const normalized = normalizeText(tweet.text || "");
    if (normalized.length >= 20) textGroups.set(normalized, [...(textGroups.get(normalized) || []), { nodeId: accountId, time: time || 0, evidence: ev }]);
    for (const url of extractUrls(tweet.text || "")) {
      const urlId = entityId("url", url);
      addNode(nodes, { id: urlId, type: "url", label: url, attributes: { url } });
      addEdge(edges, { source: accountId, target: urlId, type: "shared_link", confidence: 1, evidenceIds: [ev], attributes: {} });
      sharedLinks++;
    }
  }

  for (const item of tg?.timeline || []) {
    if (item.platform && item.platform.toLowerCase() !== "telegram") continue;
    const channel = String(item.source_handle || item.source_name || "telegram:unknown");
    const channelId = entityId("tg_channel", channel);
    addNode(nodes, { id: channelId, type: "tg_channel", label: channel, attributes: {} });
    const time = itemTime(item);
    const ev = evidenceId("telegram", channel, item.occurred_at || "", item.text || "");
    addEdge(edges, { source: channelId, target: tokenId, type: explicitCall(item) ? "calls" : "mentions", confidence: 1, evidenceIds: [ev], attributes: { platform: "telegram" } });
    if (time != null) events.push({ nodeId: channelId, time, evidence: ev, platform: "telegram" });
    const normalized = normalizeText(item.text || "");
    if (normalized.length >= 20) textGroups.set(normalized, [...(textGroups.get(normalized) || []), { nodeId: channelId, time: time || 0, evidence: ev }]);
    const urls = new Set([...(extractUrls(item.text || "")), ...(item.source_url ? [item.source_url] : [])]);
    for (const url of urls) {
      const urlId = entityId("url", url);
      addNode(nodes, { id: urlId, type: "url", label: url, attributes: { url } });
      addEdge(edges, { source: channelId, target: urlId, type: "shared_link", confidence: 1, evidenceIds: [ev], attributes: {} });
      sharedLinks++;
    }
  }

  let copyEdges = 0;
  for (const group of textGroups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.time - b.time);
    const origin = sorted[0];
    for (const target of sorted.slice(1, 8)) {
      if (origin.nodeId === target.nodeId) continue;
      addEdge(edges, { source: origin.nodeId, target: target.nodeId, type: "copies", confidence: 0.94, evidenceIds: [origin.evidence, target.evidence], attributes: { lagSeconds: Math.max(0, Math.round((target.time - origin.time) / 1000)) } });
      copyEdges++;
    }
  }

  events.sort((a, b) => a.time - b.time);
  let amplificationEdges = 0;
  for (let index = 0; index < events.length; index++) {
    const source = events[index];
    for (let next = index + 1; next < Math.min(events.length, index + 15); next++) {
      const target = events[next];
      const lagMs = target.time - source.time;
      if (lagMs > 5 * 60_000) break;
      if (source.nodeId === target.nodeId || source.platform === target.platform) continue;
      addEdge(edges, { source: source.nodeId, target: target.nodeId, type: "amplifies", confidence: Math.max(0.35, 0.8 - lagMs / (10 * 60_000)), evidenceIds: [source.evidence, target.evidence], attributes: { lagSeconds: Math.round(lagMs / 1000), crossPlatform: true } });
      amplificationEdges++;
    }
  }

  const nodeRows = [...nodes.values()];
  const edgeRows = [...edges.values()];
  return { version: INTELLIGENCE_GRAPH_VERSION, nodes: nodeRows, edges: edgeRows, stats: { nodes: nodeRows.length, edges: edgeRows.length, xAccounts: nodeRows.filter((node) => node.type === "x_account").length, tgChannels: nodeRows.filter((node) => node.type === "tg_channel").length, sharedLinks, copyEdges, amplificationEdges } };
}

export function buildAnalysisSnapshot(args: { mint: string; symbol?: string | null; tokenName?: string | null; derived: DerivedSocial; x: TwitterStats | null; tg: SocialTimeline | null; market: Market | null; chain: ChainAnalysis | null }): AnalysisSnapshot {
  const createdAt = new Date().toISOString();
  const features: IntelligenceFeature[] = [];
  for (const group of args.derived.groups) {
    for (const row of group.rows) {
      const missing = row.value === "—" || row.value.trim() === "";
      features.push({ key: `${slug(group.title)}.${slug(row.label)}`, group: group.title, label: row.label, value: missing ? null : row.value, numericValue: missing ? null : numericFromDisplay(row.value), source: "derived", confidence: missing ? 0 : 0.9, observedAt: createdAt, missing, ...(row.note ? { note: row.note } : {}) });
    }
  }
  const headline: Array<[string, string, number]> = [["scores.social", "Social score", args.derived.socialScore], ["scores.x", "X score", args.derived.xScore], ["scores.telegram", "Telegram score", args.derived.tgScore], ["scores.organic", "Organic score", args.derived.organic], ["scores.manipulation", "Manipulation score", args.derived.manipulation], ["scores.social_risk", "Social risk", args.derived.socialRisk], ["scores.early", "Early score", args.derived.early], ["scores.alpha", "Alpha score", args.derived.alpha]];
  for (const [key, label, value] of headline) features.push({ key, group: "Headline scores", label, value, numericValue: value, source: "derived", confidence: 0.9, observedAt: createdAt, missing: false });
  const graph = buildEntityGraph(args.mint, args.x, args.tg);
  const evidence = buildEvidence(args.x, args.tg);
  const snapshotSeed = JSON.stringify({ mint: args.mint, createdAt, features: features.map((feature) => [feature.key, feature.value]), graph: graph.edges.map((edge) => edge.id) });
  return { snapshotId: `snapshot-${stableHash(snapshotSeed)}`, version: INTELLIGENCE_SNAPSHOT_VERSION, graphVersion: INTELLIGENCE_GRAPH_VERSION, mint: args.mint, symbol: args.symbol || null, tokenName: args.tokenName || null, createdAt, featureCount: features.length, missingFeatureCount: features.filter((feature) => feature.missing).length, features, graph, evidence, rawSummary: { xPosts: args.x?.topTweets?.length || 0, telegramMessages: (args.tg?.timeline || []).filter((item) => !item.platform || item.platform.toLowerCase() === "telegram").length, trades: args.chain?.trades?.length || 0, chainTruncated: Boolean(args.chain?.truncated), marketAvailable: Boolean(args.market?.pair) } };
}
