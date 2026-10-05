import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const AI_BASE = (process.env.MEMECOIN_INTELLIGENCE_URL || "http://host.docker.internal:3001").replace(/\/$/, "");
const API_KEY = process.env.MEMECOIN_INTELLIGENCE_API_KEY || process.env.INTERNAL_API_KEY || "";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ROWS = 80;

type TradeInput = {
  source?: unknown;
  maker?: unknown;
  side?: unknown;
  tokenAddress?: unknown;
  symbol?: unknown;
  amountUsd?: unknown;
  tokenAmount?: unknown;
  priceUsd?: unknown;
  buyCostUsd?: unknown;
  timestamp?: unknown;
  positionAction?: unknown;
  launchpad?: unknown;
  twitterUsername?: unknown;
  twitterName?: unknown;
  tags?: unknown;
  transactionHash?: unknown;
};

type RequestBody = {
  mint?: unknown;
  kolTrades?: unknown;
  smartMoneyTrades?: unknown;
};

type CleanTrade = {
  source: "kol" | "smartmoney";
  maker: string;
  side: string;
  amountUsd: number;
  priceUsd: number | null;
  timestamp: number | null;
  positionAction: string | null;
  twitterUsername: string | null;
  tags: string[];
  transactionHash: string | null;
};

function str(value: unknown, max = 256) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tags(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 80)).slice(0, 20)
    : [];
}

function cleanRows(value: unknown, source: CleanTrade["source"]): CleanTrade[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ROWS).map((raw) => {
    const row = (raw && typeof raw === "object" ? raw : {}) as TradeInput;
    return {
      source,
      maker: str(row.maker, 64),
      side: str(row.side, 16).toLowerCase(),
      amountUsd: Math.max(0, num(row.amountUsd) || 0),
      priceUsd: num(row.priceUsd),
      timestamp: num(row.timestamp),
      positionAction: str(row.positionAction, 64) || null,
      twitterUsername: str(row.twitterUsername, 128) || null,
      tags: tags(row.tags),
      transactionHash: str(row.transactionHash, 128) || null,
    };
  }).filter((row) => row.maker || row.amountUsd > 0);
}

function sum(rows: CleanTrade[], side: string) {
  return rows.filter((row) => row.side === side).reduce((total, row) => total + row.amountUsd, 0);
}

function uniqueWallets(rows: CleanTrade[]) {
  return new Set(rows.map((row) => row.maker).filter(Boolean));
}

function feature(key: string, label: string, value: string | number, observedAt: string, note?: string) {
  return {
    key,
    group: "KOL / Smart Money",
    label,
    value,
    numericValue: typeof value === "number" ? value : null,
    source: "chain" as const,
    confidence: 0.95,
    observedAt,
    missing: false,
    ...(note ? { note } : {}),
  };
}

function sentAt(timestamp: number | null, fallback: string) {
  if (!timestamp) return fallback;
  const ms = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export async function POST(request: NextRequest) {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ available: false, error: "invalid JSON" }, { status: 400 });
  }

  const mint = str(body.mint, 64);
  if (!MINT_RE.test(mint)) {
    return NextResponse.json({ available: false, error: "invalid mint" }, { status: 400 });
  }

  const kol = cleanRows(body.kolTrades, "kol");
  const smart = cleanRows(body.smartMoneyTrades, "smartmoney");
  const all = [...kol, ...smart].slice(0, MAX_ROWS);
  if (all.length === 0) {
    return NextResponse.json({
      available: false,
      insufficient: true,
      summary: "Недостаточно свежих KOL / Smart Money данных для отдельного AI-анализа.",
      assessment: null,
    });
  }

  const now = new Date().toISOString();
  const kolBuy = sum(kol, "buy");
  const kolSell = sum(kol, "sell");
  const smartBuy = sum(smart, "buy");
  const smartSell = sum(smart, "sell");
  const kolWallets = uniqueWallets(kol);
  const smartWallets = uniqueWallets(smart);
  const riskTagSet = new Set(all.flatMap((row) => row.tags).filter((tag) => ["wash_trader", "arbitrager", "sniper", "insider", "bundler"].includes(tag)));

  const features = [
    feature("chain.kol.trade_count", "KOL trades", kol.length, now),
    feature("chain.kol.wallet_count", "Unique KOL wallets", kolWallets.size, now),
    feature("chain.kol.buy_usd", "KOL buy USD", kolBuy, now),
    feature("chain.kol.sell_usd", "KOL sell USD", kolSell, now),
    feature("chain.kol.net_flow_usd", "KOL net flow USD", kolBuy - kolSell, now, "buy USD minus sell USD"),
    feature("chain.smartmoney.trade_count", "Smart Money trades", smart.length, now),
    feature("chain.smartmoney.wallet_count", "Unique Smart Money wallets", smartWallets.size, now),
    feature("chain.smartmoney.buy_usd", "Smart Money buy USD", smartBuy, now),
    feature("chain.smartmoney.sell_usd", "Smart Money sell USD", smartSell, now),
    feature("chain.smartmoney.net_flow_usd", "Smart Money net flow USD", smartBuy - smartSell, now, "buy USD minus sell USD"),
    feature("chain.kol.risk_tag_count", "Flagged KOL risk tags", riskTagSet.size, now, Array.from(riskTagSet).join(", ") || "none"),
  ];

  const walletIds = Array.from(new Set(all.map((row) => row.maker).filter(Boolean))).slice(0, 120);
  const nodes = [
    { id: `token:${mint}`, type: "token" as const, label: mint, attributes: { mint } },
    ...walletIds.map((wallet) => ({
      id: `wallet:${wallet}`.slice(0, 160),
      type: "wallet" as const,
      label: wallet,
      attributes: { wallet },
    })),
  ];
  const walletNodeId = new Map(walletIds.map((wallet) => [wallet, `wallet:${wallet}`.slice(0, 160)]));
  const edges = all.slice(0, 140).map((row, index) => ({
    id: `kol-trade-${index}-${(row.transactionHash || row.maker || "unknown").slice(0, 80)}`.slice(0, 160),
    source: walletNodeId.get(row.maker) || `token:${mint}`,
    target: `token:${mint}`,
    type: "trades" as const,
    confidence: 0.95,
    evidenceIds: [] as string[],
    attributes: {
      side: row.side || "unknown",
      amountUsd: row.amountUsd,
      source: row.source,
      action: row.positionAction || "unknown",
    },
  }));

  const messages = all.slice(0, 60).map((row, index) => ({
    id: `gmgn-${index}-${(row.transactionHash || row.maker || "row").slice(0, 70)}`.slice(0, 128),
    channelId: row.source === "kol" ? "gmgn-kol" : "gmgn-smartmoney",
    channelUsername: row.twitterUsername,
    channelTitle: row.source === "kol" ? "GMGN KOL evidence" : "GMGN Smart Money evidence",
    senderId: row.maker || null,
    text: [
      `Structured ${row.source} trade evidence`,
      `side=${row.side || "unknown"}`,
      `amountUsd=${row.amountUsd}`,
      `wallet=${row.maker || "unknown"}`,
      `action=${row.positionAction || "unknown"}`,
      `riskTags=${row.tags.join(",") || "none"}`,
    ].join(" | "),
    sentAt: sentAt(row.timestamp, now),
    editedAt: null,
    views: 0,
    forwards: 0,
    reactions: 0,
    replyToMessageId: null,
    links: [] as string[],
  }));

  const snapshot = {
    snapshotId: `gmgn-kol-${mint}-${Date.now()}`.slice(0, 160),
    version: "gmgn-kol-v1",
    graphVersion: "gmgn-kol-graph-v1",
    mint,
    symbol: null,
    tokenName: null,
    createdAt: now,
    featureCount: features.length,
    missingFeatureCount: 0,
    features,
    graph: {
      version: "gmgn-kol-graph-v1",
      nodes,
      edges,
      stats: {
        nodes: nodes.length,
        edges: edges.length,
        xAccounts: 0,
        tgChannels: 0,
        wallets: walletIds.length,
        bundles: 0,
        socialWalletLinks: 0,
        sharedLinks: 0,
        copyEdges: 0,
        amplificationEdges: 0,
      },
    },
    evidence: [],
    rawSummary: {
      xPosts: 0,
      xRiskUniversePosts: 0,
      telegramMessages: 0,
      telegramMatchedBeforeLimit: 0,
      trades: all.length,
      wallets: walletIds.length,
      bundles: 0,
      chainTruncated: false,
      marketAvailable: false,
      marketStale: false,
    },
  };

  const messageTimes = messages.map((message) => message.sentAt).sort();
  const payload = {
    messages: [],
    context: {
      tokenAddress: mint,
      symbol: null,
      tokenName: null,
      windowStart: messageTimes[0] || now,
      windowEnd: messageTimes[messageTimes.length - 1] || now,
      analysisMode: "source_fast",
      sourceFocus: "chain",
      analysisRole: "analyst",
      intelligenceSnapshot: snapshot,
    },
    persist: false,
  };

  try {
    const response = await fetch(`${AI_BASE}/api/telegram-ai/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY, authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(50_000),
    });
    const envelope = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      result?: {
        summary?: string;
        overallConfidence?: number;
        reasoningSummary?: string[];
        sourceAssessments?: { chain?: Record<string, unknown> };
      };
      provider?: string;
      model?: string;
      error?: string;
      message?: string;
      detail?: string;
    };

    if (!response.ok) {
      const message = String(envelope.error || envelope.message || envelope.detail || `AI HTTP ${response.status}`);
      return NextResponse.json({ available: false, error: message }, { status: response.status });
    }

    return NextResponse.json({
      available: true,
      provider: envelope.provider || null,
      model: envelope.model || null,
      summary: envelope.result?.summary || null,
      confidence: envelope.result?.overallConfidence ?? null,
      assessment: envelope.result?.sourceAssessments?.chain || null,
      reasoningSummary: envelope.result?.reasoningSummary || [],
    });
  } catch (error) {
    return NextResponse.json({
      available: false,
      error: error instanceof Error ? error.message : "KOL AI request failed",
    }, { status: 502 });
  }
}
