import { authHeaders } from "@/lib/clientAuth";

export type TeraGramClassification =
  | "crypto"
  | "memecoin"
  | "solana"
  | "caller"
  | "memecoin_calls"
  | "solana_memecoin";

export type TeraGramInviteStatus = {
  ready: boolean;
  has_summary: boolean;
  generated_at: string | null;
  signal_source: string | null;
  chats_total: number;
  prefiltered_chats: number;
  candidate_channels: number;
  seed_channels: number;
  signal_rows_exactly_scored: number;
  categories: Record<string, number>;
  output_dir: string;
  seed_database: string;
  active_for_public_discovery: boolean;
  source: {
    name: string;
    preview_record_id: number;
    preview_version: string;
    latest_preview_doi: string;
    full_dataset_doi: string;
  };
  message: string;
};

export type TeraGramInviteChannel = {
  username: string;
  seed_score: number;
  scores: Record<string, number>;
  classifications: string[];
  n_subscribers: number;
  channel_id: string;
  teragram_chat_id: string;
};

type ChannelResponse = {
  items: TeraGramInviteChannel[];
  meta: {
    limit: number;
    total: number;
    classification: string | null;
  };
};

const DEFAULT_BACKEND_URL = "http://localhost:8000";

function backendBaseUrl() {
  return (process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/$/, "");
}

async function apiJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${backendBaseUrl()}${path}`, {
    headers: authHeaders({ Accept: "application/json" }),
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    let detail = `TeraGram API error ${response.status}`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the status-based fallback.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export function fetchTeraGramInviteStatus(signal?: AbortSignal) {
  return apiJson<TeraGramInviteStatus>("/api/v1/telegram/teragram/status", signal);
}

export function fetchTeraGramInviteChannels(
  options: { limit?: number; classification?: TeraGramClassification | null } = {},
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Math.max(options.limit ?? 250, 1), 5000)));
  if (options.classification) params.set("classification", options.classification);
  return apiJson<ChannelResponse>(
    `/api/v1/telegram/teragram/channels?${params.toString()}`,
    signal,
  );
}

export function uniqueInviteTargets(channels: TeraGramInviteChannel[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const channel of channels) {
    const username = channel.username.trim().replace(/^@+/, "");
    const key = username.toLowerCase();
    if (!username || seen.has(key)) continue;
    seen.add(key);
    result.push(username);
  }
  return result;
}
