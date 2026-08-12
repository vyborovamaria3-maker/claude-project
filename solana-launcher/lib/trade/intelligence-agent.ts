import type {
  ChainAnalysis,
  DerivedSocial,
  Market,
  SocialTimeline,
  TimelineItem,
  Tweet,
  TwitterStats,
} from "@/lib/trade/social-intelligence";

export const INTELLIGENCE_SNAPSHOT_VERSION = "social-snapshot-v4";
export const INTELLIGENCE_GRAPH_VERSION = "entity-graph-v1.3";

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

export type IntelligenceNodeType =
  | "token"
  | "x_account"
  | "tg_channel"
  | "url"
  | "wallet"
  | "bundle";

export type IntelligenceEdgeType =
  | "mentions"
  | "calls"
  | "shared_link"
  | "copies"
  | "amplifies"
  | "trades"
  | "bundle_member"
  | "mentions_wallet";

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
    wallets: number;
    bundles: number;
    socialWalletLinks: number;
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
    xRiskUniversePosts: number;
    telegramMessages: number;
    telegramMatchedBeforeLimit: number;
    trades: number;
    wallets: number;
    bundles: number;
    chainTruncated: boolean;
    marketAvailable: boolean;
    marketStale: boolean;
  };
};

type GraphEvent = {
  nodeId: string;
  time: number;
  evidence: string;
  platform: "x" | "telegram";
  normalizedText: string;
  urls: Set<string>;
  addresses: Set<string>;
};

function stableHash(value: string) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function entityId(type: IntelligenceNodeType, value: string) {
  return `${type}:${stableHash(value.trim().toLowerCase())}`;
}

function evidenceId(
  platform: string,
  source: string,
  timestamp: string,
  text: string,
) {
  return `evidence-${stableHash(`${platform}|${source}|${timestamp}|${text}`)}`;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9а-яё]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function numericFromDisplay(value: string) {
  const cleaned = value.trim().replace(/[$,%+]/g, "").replace(/,/g, "");
  if (!cleaned || cleaned === "—") return null;
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multiplier = (
    { K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>
  )[String(match[2] || "").toUpperCase()] || 1;
  return base * multiplier;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 280);
}

function textSimilarity(left: string, right: string) {
  const leftTokens = new Set(left.split(" ").filter((token) => token.length >= 3));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length >= 3));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function extractAddresses(value: string) {
  return Array.from(
    new Set(value.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []),
  ).slice(0, 20);
}

function extractUrls(value: string) {
  return Array.from(
    new Set(value.match(/https?:\/\/[^\s)\]}>,]+/gi) || []),
  ).slice(0, 10);
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
  const current = map.get(node.id);
  if (!current) {
    map.set(node.id, node);
    return;
  }
  const attributes = { ...current.attributes };
  for (const [key, value] of Object.entries(node.attributes)) {
    const prior = attributes[key];
    if (typeof value === "boolean" && typeof prior === "boolean") {
      attributes[key] = prior || value;
    } else if (prior == null && value != null) {
      attributes[key] = value;
    }
  }
  map.set(node.id, { ...current, attributes });
}

function addEdge(
  map: Map<string, IntelligenceEdge>,
  edge: Omit<IntelligenceEdge, "id">,
) {
  const evidence = [...new Set(edge.evidenceIds)].sort();
  const id = `edge:${stableHash(
    `${edge.source}|${edge.type}|${edge.target}|${evidence.join(",")}`,
  )}`;
  const current = map.get(id);
  if (!current || edge.confidence > current.confidence) {
    map.set(id, { id, ...edge, evidenceIds: evidence });
  }
}

function explicitCall(item: TimelineItem) {
  const metrics = item.metrics || {};
  return Boolean(
    metrics.explicit_call
      || metrics.is_explicit_call
      || String(item.event_type || "").toLowerCase().includes("call"),
  );
}

function buildEvidence(
  x: TwitterStats | null,
  tg: SocialTimeline | null,
): IntelligenceEvidence[] {
  const rows: IntelligenceEvidence[] = [];
  for (const tweet of x?.topTweets || []) {
    const source = `@${String(tweet.author || "unknown").replace(/^@/, "")}`;
    const ts = tweetTime(tweet);
    const iso = ts == null ? "" : new Date(ts).toISOString();
    rows.push({
      id: evidenceId("x", source, iso, tweet.text || ""),
      platform: "x",
      source,
      text: tweet.text || "",
      timestamp: iso || null,
    });
  }
  for (const item of tg?.timeline || []) {
    if (item.platform && item.platform.toLowerCase() !== "telegram") continue;
    const source = String(
      item.source_handle || item.source_name || "telegram:unknown",
    );
    rows.push({
      id: evidenceId(
        "telegram",
        source,
        item.occurred_at || "",
        item.text || "",
      ),
      platform: "telegram",
      source,
      text: item.text || "",
      timestamp: item.occurred_at || null,
      url: item.source_url || null,
    });
  }
  return rows.slice(0, 300);
}

function sharedValue(left: Set<string>, right: Set<string>) {
  for (const value of left) {
    if (right.has(value)) return value;
  }
  return null;
}

function walletAttributes(wallet: NonNullable<ChainAnalysis["wallets"]>[number]) {
  const fresh = wallet.freshnessVerified ? (wallet.isFresh ?? null) : null;
  const smart = wallet.smartClassificationAvailable
    ? (wallet.isSmart ?? null)
    : null;
  return {
    buys: wallet.buys || 0,
    sells: wallet.sells || 0,
    volumeSol: wallet.volumeSol || 0,
    pnlPercent: wallet.pnlPercent ?? null,
    pnlComplete: wallet.pnlComplete ?? false,
    pnlMethod: wallet.pnlMethod ?? null,
    solBalance: wallet.balanceVerified ? (wallet.solBalance ?? null) : null,
    balanceVerified: wallet.balanceVerified ?? false,
    fresh,
    freshnessVerified: wallet.freshnessVerified ?? false,
    firstSeenGlobal: wallet.firstSeenGlobal ?? null,
    firstSeenOnToken: wallet.firstSeenOnToken ?? null,
    smart,
    smartClassificationAvailable: wallet.smartClassificationAvailable ?? false,
    wash: wallet.isWashTrader ?? null,
    washConfidence: wallet.washConfidence ?? null,
    coBuyProximityCount: wallet.coBuyProximityCount ?? 0,
    coBuyProximityWindowSec: wallet.coBuyProximityWindowSec ?? null,
    bundleId: wallet.bundleId == null ? null : String(wallet.bundleId),
    bundleMethod: wallet.bundleMethod ?? null,
    historyTruncated: wallet.historyTruncated ?? false,
  };
}

export function buildEntityGraph(
  mint: string,
  x: TwitterStats | null,
  tg: SocialTimeline | null,
  chain?: ChainAnalysis | null,
): IntelligenceGraph {
  const nodes = new Map<string, IntelligenceNode>();
  const edges = new Map<string, IntelligenceEdge>();
  const tokenId = entityId("token", mint);
  addNode(nodes, {
    id: tokenId,
    type: "token",
    label: mint,
    attributes: { mint },
  });
  const events: GraphEvent[] = [];
  const textGroups = new Map<
    string,
    Array<{ nodeId: string; time: number; evidence: string }>
  >();
  const walletNodeByAddress = new Map<string, string>();

  for (const wallet of chain?.wallets || []) {
    if (!wallet.address) continue;
    const walletId = entityId("wallet", wallet.address);
    walletNodeByAddress.set(wallet.address.toLowerCase(), walletId);
    addNode(nodes, {
      id: walletId,
      type: "wallet",
      label: wallet.address,
      attributes: walletAttributes(wallet),
    });
    addEdge(edges, {
      source: walletId,
      target: tokenId,
      type: "trades",
      confidence: 1,
      evidenceIds: [],
      attributes: {
        buys: wallet.buys || 0,
        sells: wallet.sells || 0,
        volumeSol: wallet.volumeSol || 0,
        historyTruncated: wallet.historyTruncated ?? chain?.truncated ?? false,
      },
    });
  }

  for (const bundle of chain?.bundles || []) {
    const bundleId = entityId("bundle", String(bundle.id));
    const heuristic = bundle.heuristic !== false;
    const confidence = heuristic ? 0.62 : 0.95;
    addNode(nodes, {
      id: bundleId,
      type: "bundle",
      label: heuristic ? `Synchronous buy cluster ${bundle.id}` : `Bundle ${bundle.id}`,
      attributes: {
        size: bundle.size || bundle.wallets?.length || 0,
        totalVolumeSol: bundle.totalVolumeSol || 0,
        heuristic,
        method: bundle.method || null,
        ownershipClaim: false,
      },
    });
    for (const address of bundle.wallets || []) {
      const walletId = walletNodeByAddress.get(address.toLowerCase());
      if (!walletId) continue;
      addEdge(edges, {
        source: walletId,
        target: bundleId,
        type: "bundle_member",
        confidence,
        evidenceIds: [],
        attributes: {
          heuristic,
          method: bundle.method || null,
          verifiedAtomicBundle: !heuristic,
          ownershipClaim: false,
        },
      });
    }
  }

  const linkActorToWallets = (
    actorId: string,
    text: string,
    evidence: string,
  ) => {
    for (const address of extractAddresses(text)) {
      if (address === mint) continue;
      const walletId = walletNodeByAddress.get(address.toLowerCase());
      if (!walletId) continue;
      addEdge(edges, {
        source: actorId,
        target: walletId,
        type: "mentions_wallet",
        confidence: 1,
        evidenceIds: [evidence],
        attributes: { evidenceBasis: "direct_text_address_mention" },
      });
    }
  };

  const addSocialEvent = (
    platform: "x" | "telegram",
    nodeId: string,
    time: number | null,
    evidence: string,
    text: string,
    extraUrls: string[] = [],
  ) => {
    const normalizedText = normalizeText(text);
    const urls = new Set(
      [...extractUrls(text), ...extraUrls].map((value) => value.toLowerCase()),
    );
    const addresses = new Set(
      extractAddresses(text)
        .filter((value) => value !== mint)
        .map((value) => value.toLowerCase()),
    );
    if (time != null) {
      events.push({
        nodeId,
        time,
        evidence,
        platform,
        normalizedText,
        urls,
        addresses,
      });
    }
    if (normalizedText.length >= 20) {
      textGroups.set(normalizedText, [
        ...(textGroups.get(normalizedText) || []),
        { nodeId, time: time || 0, evidence },
      ]);
    }
    for (const url of urls) {
      const urlId = entityId("url", url);
      addNode(nodes, {
        id: urlId,
        type: "url",
        label: url,
        attributes: { url },
      });
      addEdge(edges, {
        source: nodeId,
        target: urlId,
        type: "shared_link",
        confidence: 1,
        evidenceIds: [evidence],
        attributes: { evidenceBasis: "direct_url" },
      });
    }
  };

  for (const tweet of x?.topTweets || []) {
    const handle = `@${String(tweet.author || "unknown").replace(/^@/, "")}`;
    const accountId = entityId("x_account", handle);
    addNode(nodes, {
      id: accountId,
      type: "x_account",
      label: handle,
      attributes: {
        suspiciousInRetainedSample: Boolean(tweet.isSuspicious),
        sourceSample: x?.meta?.queryMode || "unknown",
      },
    });
    const time = tweetTime(tweet);
    const timestamp = time == null ? "" : new Date(time).toISOString();
    const text = tweet.text || "";
    const evidence = evidenceId("x", handle, timestamp, text);
    addEdge(edges, {
      source: accountId,
      target: tokenId,
      type: "mentions",
      confidence: 1,
      evidenceIds: [evidence],
      attributes: { platform: "x", retainedSample: true },
    });
    linkActorToWallets(accountId, text, evidence);
    addSocialEvent("x", accountId, time, evidence, text);
  }

  for (const item of tg?.timeline || []) {
    if (item.platform && item.platform.toLowerCase() !== "telegram") continue;
    const channel = String(
      item.source_handle || item.source_name || "telegram:unknown",
    );
    const channelId = entityId("tg_channel", channel);
    addNode(nodes, {
      id: channelId,
      type: "tg_channel",
      label: channel,
      attributes: { retainedSample: true },
    });
    const time = itemTime(item);
    const text = item.text || "";
    const evidence = evidenceId(
      "telegram",
      channel,
      item.occurred_at || "",
      text,
    );
    addEdge(edges, {
      source: channelId,
      target: tokenId,
      type: explicitCall(item) ? "calls" : "mentions",
      confidence: 1,
      evidenceIds: [evidence],
      attributes: { platform: "telegram", retainedSample: true },
    });
    linkActorToWallets(channelId, text, evidence);
    addSocialEvent(
      "telegram",
      channelId,
      time,
      evidence,
      text,
      item.source_url ? [item.source_url] : [],
    );
  }

  for (const group of textGroups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((left, right) => left.time - right.time);
    const origin = sorted[0];
    for (const target of sorted.slice(1, 8)) {
      if (origin.nodeId === target.nodeId) continue;
      addEdge(edges, {
        source: origin.nodeId,
        target: target.nodeId,
        type: "copies",
        confidence: 0.92,
        evidenceIds: [origin.evidence, target.evidence],
        attributes: {
          lagSeconds: Math.max(
            0,
            Math.round((target.time - origin.time) / 1000),
          ),
          evidenceBasis: "exact_normalized_text",
          retainedEvidenceOnly: true,
        },
      });
    }
  }

  events.sort((left, right) => left.time - right.time);
  for (let index = 0; index < events.length; index += 1) {
    const source = events[index];
    for (
      let next = index + 1;
      next < Math.min(events.length, index + 15);
      next += 1
    ) {
      const target = events[next];
      const lagMs = target.time - source.time;
      if (lagMs > 5 * 60_000) break;
      if (source.nodeId === target.nodeId || source.platform === target.platform) {
        continue;
      }
      const similarity = textSimilarity(source.normalizedText, target.normalizedText);
      const sharedUrl = sharedValue(source.urls, target.urls);
      const sharedAddress = sharedValue(source.addresses, target.addresses);
      if (similarity < 0.45 && !sharedUrl && !sharedAddress) continue;
      const evidenceStrength = Math.max(
        similarity,
        sharedUrl ? 0.85 : 0,
        sharedAddress ? 0.9 : 0,
      );
      const temporalStrength = Math.max(0.5, 1 - lagMs / (10 * 60_000));
      addEdge(edges, {
        source: source.nodeId,
        target: target.nodeId,
        type: "amplifies",
        confidence: Math.min(
          0.92,
          evidenceStrength * 0.75 + temporalStrength * 0.25,
        ),
        evidenceIds: [source.evidence, target.evidence],
        attributes: {
          lagSeconds: Math.round(lagMs / 1000),
          crossPlatform: true,
          textSimilarity: Number(similarity.toFixed(4)),
          sharedUrl: sharedUrl || null,
          sharedAddress: sharedAddress || null,
          retainedEvidenceOnly: true,
          evidenceBasis: sharedAddress
            ? "shared_address+timing"
            : sharedUrl
              ? "shared_url+timing"
              : "text_similarity+timing",
        },
      });
    }
  }

  const nodeRows = [...nodes.values()];
  const edgeRows = [...edges.values()];
  return {
    version: INTELLIGENCE_GRAPH_VERSION,
    nodes: nodeRows,
    edges: edgeRows,
    stats: {
      nodes: nodeRows.length,
      edges: edgeRows.length,
      xAccounts: nodeRows.filter((node) => node.type === "x_account").length,
      tgChannels: nodeRows.filter((node) => node.type === "tg_channel").length,
      wallets: nodeRows.filter((node) => node.type === "wallet").length,
      bundles: nodeRows.filter((node) => node.type === "bundle").length,
      socialWalletLinks: edgeRows.filter(
        (edge) => edge.type === "mentions_wallet",
      ).length,
      sharedLinks: edgeRows.filter((edge) => edge.type === "shared_link").length,
      copyEdges: edgeRows.filter((edge) => edge.type === "copies").length,
      amplificationEdges: edgeRows.filter(
        (edge) => edge.type === "amplifies",
      ).length,
    },
  };
}

function featureConfidence(
  group: string,
  label: string,
  note: string | undefined,
  args: {
    x: TwitterStats | null;
    tg: SocialTimeline | null;
    market: Market | null;
    chain: ChainAnalysis | null;
  },
) {
  const text = `${group} ${label} ${note || ""}`.toLowerCase();
  if (text.includes("model confidence") || text.includes("ai-only")) return 0.5;
  if (text.includes("retained") || text.includes("sample")) return 0.56;
  if (text.includes("proxy") || text.includes("heuristic")) return 0.56;
  if (text.includes("lexicon")) return 0.52;
  if (text.includes("exact filtered") || text.includes("pre-exclusion")) return 0.84;
  if (text.includes("peak-to-subsequent-trough")) {
    return args.chain?.truncated ? 0.6 : 0.82;
  }
  if (text.includes("price") || group.toLowerCase().includes("price")) {
    return args.chain?.truncated ? 0.6 : 0.76;
  }
  if (group.startsWith("X") && args.x) return 0.72;
  if (group.startsWith("Telegram") && args.tg) return 0.78;
  if (group.includes("Cross-platform")) return 0.62;
  if (group.includes("Growth")) return 0.6;
  if (group.includes("AI Agent")) return 0.5;
  return 0.68;
}

function derivedMetricMissing(derived: DerivedSocial, label: string) {
  return derived.groups.some((group) =>
    group.rows.some((row) => row.label === label && row.value === "—"),
  );
}

export function buildAnalysisSnapshot(args: {
  mint: string;
  symbol?: string | null;
  tokenName?: string | null;
  derived: DerivedSocial;
  x: TwitterStats | null;
  tg: SocialTimeline | null;
  market: Market | null;
  chain: ChainAnalysis | null;
}): AnalysisSnapshot {
  const createdAt = new Date().toISOString();
  const features: IntelligenceFeature[] = [];
  for (const group of args.derived.groups) {
    for (const row of group.rows) {
      const missing = row.value === "—" || row.value.trim() === "";
      features.push({
        key: `${slug(group.title)}.${slug(row.label)}`,
        group: group.title,
        label: row.label,
        value: missing ? null : row.value,
        numericValue: missing ? null : numericFromDisplay(row.value),
        source: "derived",
        confidence: missing
          ? 0
          : featureConfidence(group.title, row.label, row.note, args),
        observedAt: createdAt,
        missing,
        ...(row.note ? { note: row.note } : {}),
      });
    }
  }

  const socialAvailable = Boolean(args.x || args.tg);
  const earlyMissing = derivedMetricMissing(args.derived, "Early signal score");
  const headline = [
    ["scores.social", "Social score", args.derived.socialScore, !socialAvailable, 0.66],
    ["scores.x", "X score", args.derived.xScore, !args.x, 0.68],
    ["scores.telegram", "Telegram score", args.derived.tgScore, !args.tg, 0.7],
    ["scores.organic", "Organic score", args.derived.organic, !socialAvailable, 0.58],
    ["scores.manipulation", "Manipulation score", args.derived.manipulation, !socialAvailable, 0.58],
    ["scores.social_risk", "Social risk", args.derived.socialRisk, !socialAvailable, 0.58],
    ["scores.early", "Early score", args.derived.early, earlyMissing, 0.56],
    ["scores.alpha", "Alpha score", args.derived.alpha, !socialAvailable, 0.54],
  ] as const;
  for (const [key, label, value, missing, confidence] of headline) {
    features.push({
      key,
      group: "Headline scores",
      label,
      value: missing ? null : value,
      numericValue: missing ? null : value,
      source: "derived",
      confidence: missing ? 0 : confidence,
      observedAt: createdAt,
      missing,
      note: "Deterministic heuristic composite; reliability is not an outcome probability.",
    });
  }

  const graph = buildEntityGraph(args.mint, args.x, args.tg, args.chain);
  const evidence = buildEvidence(args.x, args.tg);
  const snapshotSeed = JSON.stringify({
    mint: args.mint,
    createdAt,
    features: features.map((feature) => [feature.key, feature.value]),
    graph: graph.edges.map((edge) => edge.id),
  });
  return {
    snapshotId: `snapshot-${stableHash(snapshotSeed)}`,
    version: INTELLIGENCE_SNAPSHOT_VERSION,
    graphVersion: INTELLIGENCE_GRAPH_VERSION,
    mint: args.mint,
    symbol: args.symbol || null,
    tokenName: args.tokenName || null,
    createdAt,
    featureCount: features.length,
    missingFeatureCount: features.filter((feature) => feature.missing).length,
    features,
    graph,
    evidence,
    rawSummary: {
      xPosts: args.x?.topTweets?.length || 0,
      xRiskUniversePosts: args.x?.riskUniverse?.totalTweets || 0,
      telegramMessages: (args.tg?.timeline || []).filter(
        (item) => !item.platform || item.platform.toLowerCase() === "telegram",
      ).length,
      telegramMatchedBeforeLimit: args.tg?.meta?.matchedBeforeLimit
        ?? args.tg?.mentions
        ?? 0,
      trades: args.chain?.trades?.length || 0,
      wallets: args.chain?.wallets?.length || 0,
      bundles: args.chain?.bundles?.length || 0,
      chainTruncated: Boolean(args.chain?.truncated),
      marketAvailable: Boolean(args.market?.pair),
      marketStale: Boolean(args.market?.meta?.stale),
    },
  };
}
