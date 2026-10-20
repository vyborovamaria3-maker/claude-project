export type TgGraphNode = { id: string; label: string; kind: string };

export type TgGraphEdge = {
  id: string;
  from: string;
  to: string;
  sourceId: string;
  kind: "forward" | "mention" | "address";
  targetKind: string;
  targetKey: string;
  strength: number;
  sampleUrl: string;
  lastSeen: string | null;
};

export type TgGraphMetric = {
  source_id: string;
  identifier: string;
  posts_7d: number;
  posts_30d: number;
  avg_views_snapshot: number | null;
  mentioned_handles: number;
  observed_addresses: number;
  forward_events: number;
};

export type TgGraphEvidence = {
  identifier: string;
  message_id: string;
  posted_at: string | null;
  text: string;
};

export type TgGraphResponse = {
  nodes: TgGraphNode[];
  edges: TgGraphEdge[];
  metrics: TgGraphMetric[];
  sharedAddresses: { left_channel: string; right_channel: string; shared_addresses: number }[];
  observedAddresses: {
    target_kind: "solana_address" | "evm_address";
    target_key: string;
    observed_in_sources: number;
    occurrences: number;
    first_observed_at: string | null;
    last_observed_at: string | null;
  }[];
  sampled: boolean;
  truncated: boolean;
  total: number;
  truncated_by: "nodes" | "edges" | null;
  nodeLimit: number;
  edgeLimit: number;
  edgeOffset: number;
  nextEdgeOffset: number | null;
  days: number;
};


export type TgRuntimeMetrics = {
  messages_total: number;
  messages_per_day: number;
  links_total: number;
  links_active_total: number;
  links_per_day: number;
  jobs_pending: number;
  jobs_failed: number;
  flood_wait_active: boolean;
  metrics_updated_at: string | null;
  worker_version: string | null;
  last_error_code: string | null;
};

export type TgCollectorSource = {
  id: string;
  identifier: string;
  current_username: string | null;
  title: string | null;
  peer_id: string | null;
  enabled: boolean;
  history_partial: boolean;
  full_history: boolean;
  history_complete: boolean;
  history_low_message_id: string;
  last_message_id: string;
  last_success_at: string | null;
  message_count: number;
  entities_unverified: number;
  state: "pending" | "running" | "delayed" | "failed" | null;
  run_at: string | null;
  attempts: number | null;
  scanned_count: number | null;
  last_error: string | null;
};

export type TgCollectedMessage = {
  source_id: string;
  identifier: string;
  message_id: string;
  sender_id: string | null;
  posted_at: string | null;
  text: string;
  views: number | null;
  forwards: number | null;
  replies: number | null;
};

export type TgProxyStatus = {
  enabled: boolean;
  configured: boolean;
  proxyType: "socks5" | "socks4" | "mtproxy" | null;
  host: string | null;
  port: number | null;
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  secretConfigured: boolean;
  updatedAt: string | null;
};

export type TgCollectorSnapshot = {
  configured: boolean;
  workerOnline: boolean;
  heartbeatAt: string | null;
  collectionEnabled: boolean;
  proxy: TgProxyStatus;
  blockReason: string | null;
  pausedUntil: string | null;
  stats: { sources: number; messages: number; running: number; failed: number };
  runtimeMetrics: TgRuntimeMetrics;
  sources: TgCollectorSource[];
  messages: TgCollectedMessage[];
  page: number;
};
