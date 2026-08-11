import type {
  ChainAnalysis,
  Channel,
  Market,
  SocialOptions,
  SocialTimeline,
  TwitterStats,
  AiEnvelope,
} from "./social-intelligence";

export async function fetchJson<T>(
  url: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal, ...init });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorData = data as { detail?: string; error?: string };
    throw new Error(errorData.detail || errorData.error || `HTTP ${response.status}`);
  }
  return data as T;
}

type StreamEvent = {
  type?: string;
  message?: string;
} & Partial<ChainAnalysis>;

export async function readChainStream(
  mint: string,
  signal: AbortSignal,
): Promise<ChainAnalysis | null> {
  const response = await fetch(
    `/api/trade/analyze-stream?mint=${encodeURIComponent(mint)}`,
    { cache: "no-store", signal },
  );
  if (!response.ok || !response.body) {
    throw new Error(`analyze-stream HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload: ChainAnalysis | null = null;

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }
    if (event.type === "error") {
      throw new Error(event.message || "on-chain analysis failed");
    }
    if (event.type === "final") {
      finalPayload = {
        trades: event.trades,
        truncated: event.truncated,
        summary: event.summary,
      };
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
    return finalPayload;
  } finally {
    reader.releaseLock();
  }
}

export type SocialSourcePayloads = {
  x: TwitterStats;
  tg: SocialTimeline;
  market: Market;
  channels: Channel[];
  ai: AiEnvelope;
};

export function buildSocialSourceParams(contract: string, options: SocialOptions) {
  const x = new URLSearchParams({
    mint: contract,
    strategy: "auto",
    scope: "mentions",
    limit: String(options.xLimit),
    excludeSuspicious: String(options.xExcludeSuspicious),
    verifiedOnly: String(options.xVerifiedOnly),
  });
  if (options.symbol) x.set("symbol", options.symbol.replace(/^\$/, ""));
  if (options.lookback !== "all") x.set("hours", options.lookback);

  const tg = new URLSearchParams({
    platform: "telegram",
    limit: String(options.tgLimit),
    min_channel_score: String(options.tgMinChannelScore),
    explicit_calls_only: String(options.tgExplicitCallsOnly),
  });
  if (options.lookback !== "all") tg.set("hours", options.lookback);
  return { x, tg };
}
