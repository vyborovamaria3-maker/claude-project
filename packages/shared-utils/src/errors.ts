export class TransientError extends Error { readonly retryable = true; }
export class PermanentError extends Error { readonly retryable = false; }
export class AuthError extends PermanentError {}
export class RateLimitError extends TransientError {
  constructor(message: string, public readonly retryAfterMs?: number) { super(message); }
}
export function classifyError(error: unknown): "rate_limit" | "auth" | "permanent" | "transient" | "unknown" {
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof AuthError) return "auth";
  if (error instanceof PermanentError) return "permanent";
  if (error instanceof TransientError) return "transient";
  return "unknown";
}
