import type {
  ChainAnalysis,
  DerivedSocial,
  Market,
  SocialTimeline,
  TimelineItem,
  Tweet,
  TwitterStats,
} from "@/lib/trade/social-intelligence";

export const INTELLIGENCE_SNAPSHOT_VERSION = "social-snapshot-v3";
export const INTELLIGENCE_GRAPH_VERSION = "entity-graph-v1.2";

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
    telegramMessages: number;
    trades: number;
    wallets: number;
    bundles: number;
    chainTruncated: boolean;
    marketAvailable: boolean;
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
    } else if (prior == null) {
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
  if (!map.has(id)) {
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
      attributes: {
        buys: wallet.buys || 0,
        sells: wallet.sells || 0,
        volumeSol: wallet.volumeSol || 0,
        pnlPercent: wallet.pnlPercent ?? null,
        solBalance: wallet.solBalance ?? null,
        fresh: Boolean(wallet.isFresh),
        smart: Boolean(wallet.isSmart),
        wash: Boolean(wallet.isWashTrader),
        relatedCount: wallet.relatedCount || 0,
        bundleId: wallet.bundleId == null ? null : String(wallet.bundleId),
      },
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
      },
    });
  }

  for (const bundle of chain?.bundles || []) {
    const bundleId = entityId("bundle", String(bundle.id));
    addNode(nodes, {
      id: bundleId,
      type: "bundle",
      label: `Bundle ${bundle.id}`,
      attributes: {
        size: bundle.size || bundle.wallets?.length || 0,
        totalVolumeSol: bundle.totalVolumeSol || 0,
      },
    });
    for (const address of bundle.wallets || []) {
      const walletId = walletNodeByAddress.get(address.toLowerCase());
      if (!walletId) continue;
      addEdge(edges, {
        source: walletId,
        target: bundleId,
        type: "bundle_member",
        confidence: 1,
        evidenceIds: [],
        attributes: {},
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
        attributes: {},
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
      attributes: { suspicious: Boolean(tweet.isSuspicious) },
    });
    const time = tweetTime(tweet);
    const ts = time == null ? "" : new Date(time).toISOString();
    const text = tweet.text || "";
    const ev = evidenceId("x", handle, ts, text);
    addEdge(edges, {
      source: accountId,
      target: tokenId,
      type: "mentions",
      confidence: 1,
      evidenceIds: [ev],
      attributes: { platform: "x" },
    });
    linkActorToWallets(accountId, text, ev);
    const normalizedText = normalizeText(text);
    const urls = new Set(extractUrls(text).map((value) => value.toLowerCase()));
    const addresses = new Set(
      extractAddresses(text)
        .filter((value) => value !== mint)
        .map((value) => value.toLowerCase()),
    );
    if (time != null) {
      events.push({
        nodeId: accountId,
        time,
        evidence: ev,
        platform: "x",
        normalizedText,
        urls,
        addresses,
      });
    }
    if (normalizedText.length >= 20) {
      textGroups.set(normalizedText, [
        ...(textGroups.get(normalizedText) || []),
        { nodeId: accountId, time: time || 0, evidence: ev },
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
        source: accountId,
        target: urlId,
        type: "shared_link",
        confidence: 1,
        evidenceIds: [ev],
        attributes: {},
      });
    }
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
      attributes: {},
    });
    const time = itemTime(item);
    const text = item.text || "";
    const ev = evidenceId("telegram", channel, item.occurred_at || "", text);
    addEdge(edges, {
      source: channelId,
      target: tokenId,
      type: explicitCall(item) ? "calls" : "mentions",
      confidence: 1,
      evidenceIds: [ev],
      attributes: { platform: "telegram" },
    });
    linkActorToWallets(channelId, text, ev);
    const normalizedText = normalizeText(text);
    const urls = new Set(
      [
        ...extractUrls(text),
        ...(item.source_url ? [item.source_url] : []),
      ].map((value) => value.toLowerCase()),
    );
    const addresses = new Set(
      extractAddresses(text)
        .filter((value) => value !== mint)
        .map((value) => value.toLowerCase()),
    );
    if (time != null) {
      events.push({
        nodeId: channelId,
        time,
        evidence: ev,
        platform: "telegram",
        normalizedText,
        urls,
        addresses,
      });
    }
    if (normalizedText.length >= 20) {
      textGroups.set(normalizedText, [
        ...(textGroups.get(normalizedText) || []),
        { nodeId: channelId, time: time || 0, evidence: ev },
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
        source: channelId,
        target: urlId,
        type: "shared_link",
        confidence: 1,
        evidenceIds: [ev],
        attributes: {},
      });
    }
  }

  for (const group of textGroups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.time - b.time);
    const origin = sorted[0];
    for (const target of sorted.slice(1, 8)) {
      if (origin.nodeId === target.nodeId) continue;
      addEdge(edges, {
        source: origin.nodeId,
        target: target.nodeId,
        type: "copies",
        confidence: 0.94,
        evidenceIds: [origin.evidence, target.evidence],
        attributes: {
          lagSeconds: Math.max(
            0,
            Math.round((target.time - origin.time) / 1000),
          ),
          evidenceBasis: "exact_normalized_text",
        },
      });
    }
  }

  events.sort((a, b) => a.time - b.time);
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
        confidence: Math.min(0.95, evidenceStrength * 0.75 + temporalStrength * 0.25),
        evidenceIds: [source.evidence, target.evidence],
        attributes: {
          lagSeconds: Math.round(lagMs / 1000),
          crossPlatform: true,
          textSimilarity: Number(similarity.toFixed(4)),
          sharedUrl: sharedUrl || null,
          sharedAddress: sharedAddress || null,
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
      socialWalletLinks: edgeRows.filter((edge) => edge.type === "mentions_wallet").length,
      sharedLinks: edgeRows.filter((edge) => edge.type === "shared_link").length,
      copyEdges: edgeRows.filter((edge) => edge.type === "copies").length,
      amplificationEdges: edgeRows.filter((edge) => edge.type === "amplifies").length,
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
  if (text.includes("raw model confidence")) return 0.5;
  if (text.includes("sampled") || text.includes("retained")) return 0.58;
  if (text.includes("proxy")) return 0.58;
  if (text.includes("lexicon")) return 0.55;
  if (text.includes("heuristic")) return 0.6;
  if (text.includes("price") || group.toLowerCase().includes("price")) {
    return args.chain?.truncated ? 0.62 : 0.78;
  }
  if (group.startsWith("X") && args.x) return 0.78;
  if (group.startsWith("Telegram") && args.tg) return 0.82;
  if (group.includes("Cross-platform")) return 0.68;
  if (group.includes("Growth")) return 0.65;
  if (group.includes("AI Agent")) return 0.6;
  return 0.72;
}

function derivedMetricMissing(
  derived: DerivedSocial,
  label: string,
) {
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
  const headline: Array<{
    key: string;
    label: string;
    value: number;
    missing: boolean;
    confidence: number;
  }> = [
    {
      key: "scores.social",
      label: "Social score",
      value: args.derived.socialScore,
      missing: !socialAvailable,
      confidence: 0.68,
    },
    {
      key: "scores.x",
      label: "X score",
      value: args.derived.xScore,
      missing: !args.x,
      confidence: 0.72,
    },
    {
      key: "scores.telegram",
      label: "Telegram score",
      value: args.derived.tgScore,
      missing: !args.tg,
      confidence: 0.74,
    },
    {
      key: "scores.organic",
      label: "Organic score",
      value: args.derived.organic,
      missing: !socialAvailable,
      confidence: 0.62,
    },
    {
      key: "scores.manipulation",
      label: "Manipulation score",
      value: args.derived.manipulation,
      missing: !socialAvailable,
      confidence: 0.62,
    },
    {
      key: "scores.social_risk",
      label: "Social risk",
      value: args.derived.socialRisk,
      missing: !socialAvailable,
      confidence: 0.62,
    },
    {
      key: "scores.early",
      label: "Early score",
      value: args.derived.early,
      missing: earlyMissing,
      confidence: 0.7,
    },
    {
      key: "scores.alpha",
      label: "Alpha score",
      value: args.derived.alpha,
      missing: !socialAvailable,
      confidence: 0.58,
    },
  ];
  for (const item of headline) {
    features.push({
      key: item.key,
      group: "Headline scores",
      label: item.label,
      value: item.missing ? null : item.value,
      numericValue: item.missing ? null : item.value,
      source: "derived",
      confidence: item.missing ? 0 : item.confidence,
      observedAt: createdAt,
      missing: item.missing,
      note: "Heuristic composite score; confidence is feature reliability, not outcome probability.",
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
      telegramMessages: (args.tg?.timeline || []).filter(
        (item) => !item.platform || item.platform.toLowerCase() === "telegram",
      ).length,
      trades: args.chain?.trades?.length || 0,
      wallets: args.chain?.wallets?.length || 0,
      bundles: args.chain?.bundles?.length || 0,
      chainTruncated: Boolean(args.chain?.truncated),
      marketAvailable: Boolean(args.market?.pair),
    },
  };
}
