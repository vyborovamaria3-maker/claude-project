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
  if (input.hasPartialCheckpoint) return "partial";
  if (input.phase === "waiting" && /no available account|account ownership lost/i.test(input.lastError ?? "")) {
    return "waiting_account";
  }
  if (input.status === "pending" && input.availableAt > input.now) return "retry_wait";
  return "queued";
}

/** Use only a bounded symbolic code, never a raw upstream error string. */
export function safeLastErrorCode(message: string | null | undefined): string | null {
  if (!message) return null;
  const bracketed = /^\[([A-Z][A-Z0-9_]{0,47})\]/.exec(message)?.[1];
  if (bracketed) return bracketed;
  if (/^no available account; waiting/i.test(message)) return "WAITING_ACCOUNT";
  if (/^XActions account ownership lost/i.test(message)) return "ACCOUNT_LEASE_LOST";
  if (/^XActions partial page budget/i.test(message)) return "PARTIAL_PAGE_BUDGET";
  if (/^XActions account HTTP quota exhausted/i.test(message)) return "ACCOUNT_QUOTA_WAIT";
  if (/^worker shutdown/i.test(message)) return "WORKER_SHUTDOWN";
  return "LEGACY_OR_UNKNOWN";
}
