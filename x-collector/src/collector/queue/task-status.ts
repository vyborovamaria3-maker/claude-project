export type TaskDisplayState =
  | "queued" | "waiting_account" | "retry_wait" | "running"
  | "partial" | "completed" | "failed";

export interface TaskStateInput {
  status: string;
  availableAt: number;
  now: number;
  phase?: string | null;
  lastError?: string | null;
  hasPartialCheckpoint?: boolean;
}

/** Presentation-only state: never mutates the legacy durable queue contract. */
export function deriveTaskDisplayState(input: TaskStateInput): TaskDisplayState {
  if (input.status === "done") return "completed";
  if (input.status === "failed") return "failed";
  if (input.status === "claimed") return "running";
  // Current scheduling state has priority over persisted-output evidence.
  // The latter remains an independent flag in the task snapshot.
  if (input.status === "pending" && /no available account|account ownership lost|account HTTP quota exhausted/i.test(input.lastError ?? "")) return "waiting_account";
  if (input.status === "pending" && input.availableAt > input.now) return "retry_wait";
  if (input.hasPartialCheckpoint) return "partial";
  return "queued";
}

/** Only allow known symbolic diagnostic codes, not arbitrary [] contents. */
export const SAFE_ERROR_CODES = new Set([
  "RATE_LIMIT", "AUTH_EXPIRED", "ACCESS_REQUIRED", "ACCESS_DENIED",
  "ACCESS_UNVERIFIED", "ENDPOINT_UNAVAILABLE", "SEARCH_UNCONFIRMED",
  "SEARCH_PARSE_UNCONFIRMED", "TIMELINE_UNCONFIRMED",
  "TIMELINE_PARSE_UNCONFIRMED", "BROWSER_END_UNVERIFIED",
  "PAGE_END_UNVERIFIED", "PAGINATION_STALLED", "SOURCE_SHAPE_CHANGED",
  "COLLECTION_TIMEOUT", "HTTP_RESPONSE_INVALID", "PROXY_AUTH", "PROXY_DNS",
  "PROXY_CONNECT", "PROXY_CONFIG_INVALID", "NETWORK_IO_UNVERIFIED",
  "INVALID_INPUT", "UPSTREAM_UNAVAILABLE", "TRANSIENT_FAILURE",
  "DB_COMMIT_UNCERTAIN", "WORKER_RUNTIME_FAILURE", "WAITING_ACCOUNT",
  "ACCOUNT_LEASE_LOST", "PARTIAL_PAGE_BUDGET", "ACCOUNT_QUOTA_WAIT",
  "WORKER_SHUTDOWN", "LEGACY_OR_UNKNOWN",
]);
export function safeLastErrorCode(message: string | null | undefined): string | null {
  if (!message) return null;
  const bracketed = /^\[([A-Z][A-Z0-9_]{0,47})\]/.exec(message)?.[1];
  if (bracketed) return SAFE_ERROR_CODES.has(bracketed) ? bracketed : "LEGACY_OR_UNKNOWN";
  if (/^no available account; waiting/i.test(message)) return "WAITING_ACCOUNT";
  if (/^XActions account ownership lost/i.test(message)) return "ACCOUNT_LEASE_LOST";
  if (/^XActions partial page budget/i.test(message)) return "PARTIAL_PAGE_BUDGET";
  if (/^XActions account HTTP quota exhausted/i.test(message)) return "ACCOUNT_QUOTA_WAIT";
  if (/^worker shutdown/i.test(message)) return "WORKER_SHUTDOWN";
  return "LEGACY_OR_UNKNOWN";
}
