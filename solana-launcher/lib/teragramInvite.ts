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

export type TeraGramScanState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "succeeded"
  | "failed";


export type TeraGramScanJob = {
  job_id: string | null;
  status: TeraGramScanState;
  pid: number | null;
  progress_percent: number;
  stage: string;
  started_at: string | null;
  finished_at: string | null;
  last_line: string | null;
  error: string | null;
  config: {
    mode?: "preview" | "full";
    input_dir?: string;
    output_dir?: string;
    max_chats?: number | null;
    seed_limit?: number;
    signal_source?: string;
    threads?: number | null;
    memory_limit?: string;
    fetch_size?: number;
  } | null;
  summary: Record<string, unknown> | null;
  logs: string[];
};


export type TeraGramScanRequest = {
  mode: "preview" | "full";
  max_chats?: number | null;
  seed_limit: number;
  signal_source: "auto" | "content" | "entities" | "metadata";
  threads?: number | null;
  memory_limit: string;
  fetch_size: number;
};


type ScanResponse = {
  job: TeraGramScanJob;
};


const DEFAULT_BACKEND_URL = "http://localhost:8000";

function backendBaseUrl() {
  return (process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/$/, "");
}

export class TeraGramApiError extends Error {
  status: number;


  constructor(status: number, message: string) {
    super(message);
    this.name = "TeraGramApiError";
    this.status = status;
  }
}


async function apiRequest<T>(
  path: string,
  options: {
    signal?: AbortSignal;
    method?: "GET" | "POST";
    body?: unknown;
  } = {},
): Promise<T> {
  const hasBody = options.body !== undefined;


  const response = await fetch(`${backendBaseUrl()}${path}`, {
    method: options.method ?? "GET",
    headers: authHeaders({
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    }),
    cache: "no-store",
    signal: options.signal,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });


  if (!response.ok) {
    let detail = `TeraGram API error ${response.status}`;


    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload.detail) detail = payload.detail;
    } catch {
      // Keep the status-based fallback.
    }


    throw new TeraGramApiError(response.status, detail);
  }


  return (await response.json()) as T;
}


async function apiJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, { signal });
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

export async function fetchTeraGramScanStatus(signal?: AbortSignal) {
  const response = await apiRequest<ScanResponse>(
    "/api/v1/telegram/teragram/scan/status",
    { signal },
  );
  return response.job;
}


export async function startTeraGramScan(payload: TeraGramScanRequest) {
  const response = await apiRequest<ScanResponse>(
    "/api/v1/telegram/teragram/scan",
    {
      method: "POST",
      body: payload,
    },
  );
  return response.job;
}


export async function stopTeraGramScan() {
  const response = await apiRequest<ScanResponse>(
    "/api/v1/telegram/teragram/scan/stop",
    {
      method: "POST",
    },
  );
  return response.job;
}


export function uniqueInviteSources(channels: TeraGramInviteChannel[]): string[] {
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

export interface TeraGramGraphCandidate {
  teragram_chat_id: string;
  telegram_id: string;
  username: string;
  title: string;
  description: string;
  type: string;
  members_count: number;
  historical_discovery_score: number;
  reasons: string[];
  evidence: {
    linked_edges: number;
    forward_count: number;
    telegram_reference_count: number;
    audience_overlap: number;
    connected_root_count: number;
  };
  flags: {
    scam: boolean;
    fake: boolean;
    restricted: boolean;
  };
  requires_live_validation: boolean;
}

export interface TeraGramDiscoveryResponse {
  status: "ready" | "not_ready";
  generated_at?: string;
  root_candidate_count: number;
  candidate_count: number;
  candidates: TeraGramGraphCandidate[];
}

export async function fetchTeraGramDiscovery(): Promise<TeraGramDiscoveryResponse> {
  return apiRequest<TeraGramDiscoveryResponse>(
    "/api/v1/telegram/teragram/discovery",
    { method: "GET" },
  );
}

export interface TeraGramVerifiedSource {
  username: string;
  title: string;
  category: string;
  live_essence_score: number;
  verdict: string;
  messages_analyzed: number;
  can_parse_users: boolean;
  parse_mode: string;
  extractable_users: number;
  solana_messages: number;
  memecoin_messages: number;
  call_messages: number;
  pumpfun_messages: number;
  solana_contracts: string[];
  evm_contracts: string[];
  historical_discovery_score: number;
  source: string;
}

export interface TeraGramVerifiedResponse {
  status: "ready" | "not_ready";
  generated_at?: string;
  total_candidates: number;
  checked: number;
  alive: number;
  accepted: number;
  rejected: number;
  total_sources: number;
  sources: TeraGramVerifiedSource[];
}

export async function fetchTeraGramVerified(): Promise<TeraGramVerifiedResponse> {
  return apiRequest<TeraGramVerifiedResponse>(
    "/api/v1/telegram/teragram/verified",
    { method: "GET" },
  );
}
