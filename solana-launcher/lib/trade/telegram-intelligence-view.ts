import { clamp, type SocialTimeline } from "./social-intelligence";

export type TelegramRegistryStatus = {
  total?: number;
  validated?: number;
  rejected?: number;
  unavailable?: number;
  candidate?: number;
  due?: number;
};

export type TelegramCollectorStatusView = {
  mode?: "mtproto" | "public_web" | "unavailable" | string;
  configured?: boolean;
  mtproto_configured?: boolean;
  session_configured?: boolean;
  running?: boolean;
  background_running?: boolean;
  connected?: boolean;
  monitored_channels?: number;
  public_web_enabled?: boolean;
  public_web_configured?: boolean;
  public_web_channels?: number;
  public_web_seed_database_channels?: number;
  public_web_discovered_channels?: number;
  public_web_accepted_discovered?: number;
  public_web_rejected_discovered?: number;
  registry?: TelegramRegistryStatus;
  refresh_due?: number;
  refresh_tick_seconds?: number;
  last_scan_at?: string | null;
  last_scan_messages?: number;
  last_scan_matches?: number;
  last_error?: string | null;
};

export type TelegramCoordinationView = {
  sources: number;
  independentSources: number;
  coordinatedSources: number;
  sourceIndependenceScore: number | null;
  coordinationRisk: number | null;
  leader: string | null;
  spreadMinutes: number | null;
  burstSources5m: number;
  clusters: Array<{ leader?: string; sources?: string[]; size?: number }>;
};

export type TelegramCallerOutcomeWindowView = {
  samples: number;
  medianCloseMultiple: number | null;
  medianPeakMultiple: number | null;
  positiveCloseRate: number | null;
  twoXRate: number | null;
};

export type TelegramCallerReputationView = {
  username: string;
  calls: number;
  uniqueMints: number;
  evaluated: number;
  wins: number;
  winRate: number | null;
  rugRate: number | null;
  avgRoi: number | null;
  earlyCalls: number;
  firstCalls: number;
  top3Calls: number;
  reposts: number;
  repostRate: number | null;
  medianLeadMinutes: number | null;
  originalityScore: number | null;
  timingScore: number | null;
  outcomeScore: number | null;
  temporalOutcomeScore: number | null;
  coordinationRisk: number | null;
  reputationScore: number | null;
  outcomeWindows: Record<string, TelegramCallerOutcomeWindowView>;
};

export type TelegramTokenIntelligenceView = {
  coordination: TelegramCoordinationView | null;
  firstCall: {
    source: string;
    calledAt: string | null;
    callMarketCapUsd: number | null;
  } | null;
  callers: TelegramCallerReputationView[];
};

function finite(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value: unknown) {
  const parsed = finite(value);
  return parsed == null ? 0 : Math.max(0, parsed);
}

function score(value: unknown): number | null {
  const parsed = finite(value);
  return parsed == null ? null : clamp(parsed);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function camelOrSnake(row: Record<string, unknown>, camel: string, snake: string) {
  return row[camel] ?? row[snake];
}

function parseOutcomeWindows(value: unknown): Record<string, TelegramCallerOutcomeWindowView> {
  const raw = object(value);
  if (!raw) return {};
  const result: Record<string, TelegramCallerOutcomeWindowView> = {};
  for (const [label, candidate] of Object.entries(raw)) {
    const row = object(candidate);
    if (!row) continue;
    result[label] = {
      samples: nonNegative(row.samples),
      medianCloseMultiple: finite(camelOrSnake(row, "medianCloseMultiple", "median_close_multiple")),
      medianPeakMultiple: finite(camelOrSnake(row, "medianPeakMultiple", "median_peak_multiple")),
      positiveCloseRate: finite(camelOrSnake(row, "positiveCloseRate", "positive_close_rate")),
      twoXRate: finite(camelOrSnake(row, "twoXRate", "two_x_rate")),
    };
  }
  return result;
}

export function telegramCollectorStatus(
  timeline: SocialTimeline | null,
): TelegramCollectorStatusView | null {
  const meta = object(timeline?.meta);
  const raw = object(meta?.telegramCollector);
  return raw as TelegramCollectorStatusView | null;
}

export function telegramTokenIntelligence(
  timeline: SocialTimeline | null,
): TelegramTokenIntelligenceView | null {
  const root = object(timeline);
  const raw = object(root?.telegramIntelligence);
  if (!raw) return null;

  const coordinationRaw = object(raw.coordination);
  const coordinationSources = coordinationRaw ? nonNegative(coordinationRaw.sources) : 0;
  // An empty deterministic result means "no Telegram evidence", not "0 coordination risk".
  // Keeping it null prevents Qwen and cross-source scoring from treating absence as a clean signal.
  const coordination: TelegramCoordinationView | null = coordinationRaw && coordinationSources > 0
    ? {
        sources: coordinationSources,
        independentSources: nonNegative(camelOrSnake(coordinationRaw, "independentSources", "independent_sources")),
        coordinatedSources: nonNegative(camelOrSnake(coordinationRaw, "coordinatedSources", "coordinated_sources")),
        sourceIndependenceScore: score(camelOrSnake(coordinationRaw, "sourceIndependenceScore", "source_independence_score")),
        coordinationRisk: score(camelOrSnake(coordinationRaw, "coordinationRisk", "coordination_risk")),
        leader: text(coordinationRaw.leader),
        spreadMinutes: finite(camelOrSnake(coordinationRaw, "spreadMinutes", "spread_minutes")),
        burstSources5m: nonNegative(camelOrSnake(coordinationRaw, "burstSources5m", "burst_sources_5m")),
        clusters: Array.isArray(coordinationRaw.clusters)
          ? coordinationRaw.clusters.filter((item): item is Record<string, unknown> => Boolean(object(item))).map((item) => ({
              leader: text(item.leader) ?? undefined,
              sources: Array.isArray(item.sources) ? item.sources.filter((value): value is string => typeof value === "string").slice(0, 20) : undefined,
              size: finite(item.size) ?? undefined,
            })).slice(0, 20)
          : [],
      }
    : null;

  const firstRaw = object(camelOrSnake(raw, "firstCall", "first_call"));
  const firstCall = firstRaw && text(firstRaw.source)
    ? {
        source: text(firstRaw.source) as string,
        calledAt: text(camelOrSnake(firstRaw, "calledAt", "called_at")),
        callMarketCapUsd: finite(camelOrSnake(firstRaw, "callMarketCapUsd", "call_market_cap_usd")),
      }
    : null;

  const callers = Array.isArray(raw.callers)
    ? raw.callers
        .filter((item): item is Record<string, unknown> => Boolean(object(item)))
        .map((item): TelegramCallerReputationView | null => {
          const username = text(item.username);
          if (!username) return null;
          return {
            username,
            calls: nonNegative(item.calls),
            uniqueMints: nonNegative(camelOrSnake(item, "uniqueMints", "unique_mints")),
            evaluated: nonNegative(item.evaluated),
            wins: nonNegative(item.wins),
            winRate: finite(camelOrSnake(item, "winRate", "win_rate")),
            rugRate: finite(camelOrSnake(item, "rugRate", "rug_rate")),
            avgRoi: finite(camelOrSnake(item, "avgRoi", "avg_roi")),
            earlyCalls: nonNegative(camelOrSnake(item, "earlyCalls", "early_calls")),
            firstCalls: nonNegative(camelOrSnake(item, "firstCalls", "first_calls")),
            top3Calls: nonNegative(camelOrSnake(item, "top3Calls", "top3_calls")),
            reposts: nonNegative(item.reposts),
            repostRate: finite(camelOrSnake(item, "repostRate", "repost_rate")),
            medianLeadMinutes: finite(camelOrSnake(item, "medianLeadMinutes", "median_lead_minutes")),
            originalityScore: score(camelOrSnake(item, "originalityScore", "originality_score")),
            timingScore: score(camelOrSnake(item, "timingScore", "timing_score")),
            outcomeScore: score(camelOrSnake(item, "outcomeScore", "outcome_score")),
            temporalOutcomeScore: score(camelOrSnake(item, "temporalOutcomeScore", "temporal_outcome_score")),
            coordinationRisk: score(camelOrSnake(item, "coordinationRisk", "coordination_risk")),
            reputationScore: score(camelOrSnake(item, "reputationScore", "reputation_score")),
            outcomeWindows: parseOutcomeWindows(camelOrSnake(item, "outcomeWindows", "outcome_windows")),
          };
        })
        .filter((item): item is TelegramCallerReputationView => item != null)
        .slice(0, 25)
    : [];

  return { coordination, firstCall, callers };
}

export function telegramCoverageConfidence(timeline: SocialTimeline | null): number | null {
  // Coverage confidence describes how well our configured Telegram universe was observed.
  // It is not a bullish/bearish probability and must never be used as a token outcome probability.
  const collector = telegramCollectorStatus(timeline);
  if (!timeline || !collector || collector.configured === false || collector.mode === "unavailable") return null;

  const registry = collector.registry || {};
  const total = Math.max(0, Number(registry.total || 0));
  const validated = Math.max(0, Number(registry.validated || 0));
  const unavailable = Math.max(0, Number(registry.unavailable || 0));
  const monitored = Math.max(0, Number(collector.monitored_channels || 0));
  const publicChannels = Math.max(0, Number(collector.public_web_channels || 0));
  const universe = Math.max(total, monitored, publicChannels);

  let confidence = collector.mode === "mtproto" ? 48 : 34;
  if (collector.mode === "mtproto" && collector.connected) confidence += 12;
  if (collector.mode === "mtproto" && collector.running) confidence += 12;
  if (collector.background_running) confidence += 5;
  confidence += Math.min(18, Math.log10(Math.max(1, universe)) * 7);
  if (total > 0) {
    confidence += (validated / total) * 12;
    confidence -= (unavailable / total) * 16;
  }

  const lastScan = collector.last_scan_at ? Date.parse(collector.last_scan_at) : NaN;
  if (Number.isFinite(lastScan)) {
    const ageMinutes = Math.max(0, (Date.now() - lastScan) / 60_000);
    if (ageMinutes <= 15) confidence += 8;
    else if (ageMinutes <= 60) confidence += 4;
    else if (ageMinutes > 360) confidence -= 12;
  } else if (collector.mode === "public_web") {
    confidence -= 10;
  }

  if (collector.last_error) confidence -= 8;
  return Math.round(clamp(confidence));
}

export function firstCallerReputation(
  intelligence: TelegramTokenIntelligenceView | null,
): TelegramCallerReputationView | null {
  if (!intelligence?.firstCall) return null;
  const key = intelligence.firstCall.source.toLowerCase().replace(/^@/, "");
  return intelligence.callers.find(
    (caller) => caller.username.toLowerCase().replace(/^@/, "") === key,
  ) ?? null;
}
