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
  nodeLimit: number;
  edgeLimit: number;
  edgeOffset: number;
  nextEdgeOffset: number | null;
  days: number;
};
