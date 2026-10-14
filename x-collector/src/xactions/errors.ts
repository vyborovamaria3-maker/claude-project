import { CollectorHttpError } from "../../lib/trade/task-errors";
import { HttpAccountLeaseError, HttpAccountQuotaError } from "./account-http-quota";

/** 403 alone proves neither CAPTCHA nor permanent resource denial. */
export class XActionsAmbiguousForbiddenError extends Error {
  constructor() {
    super("XACTIONS_ACCESS_UNVERIFIED: HTTP 403; check session and source permission");
    this.name = "XActionsAmbiguousForbiddenError";
  }
}

/** Use only when an actual protected/forbidden resource is identified. */
export class XActionsAccessDeniedError extends Error {
  constructor() {
    super("XACTIONS_ACCESS_DENIED: protected resource is unavailable to this session");
    this.name = "XActionsAccessDeniedError";
  }
}

/** Map XActions HTTP errors into the collector's existing retry/quota policy. */
export function toCollectorError(error: unknown): Error {
  if (error instanceof CollectorHttpError) return error;
  if (!(error instanceof Error)) return new Error("XActions: unknown HTTP error");
  // Pinned TwitterHttpClient wraps non-API errors in NetworkError even with
  // maxRetries=0. Restore our internal quota/lease signals before the worker
  // chooses whether to defer or penalize the account.
  if (error.message === "XACTIONS_QUOTA_EXHAUSTED") return new HttpAccountQuotaError();
  if (error.message === "XACTIONS_ACCOUNT_LEASE_LOST") return new HttpAccountLeaseError();

  const details = error as Error & { status?: unknown; resetAt?: unknown };
  // The X GraphQL API can report a rate limit inside an error envelope
  // even when the transport response status differs from 429.
  const status = error.name === "RateLimitError" ? 429
    : typeof details.status === "number" ? details.status
    : error.name === "AuthError" ? 401
    : error.name === "NotFoundError" ? 404
    : undefined;
  if (status === 403 && !/captcha|challenge/i.test(error.message)) {
    if (/protected (?:account|resource)|private (?:account|profile)|permission denied|access forbidden/i.test(error.message)) {
      return new XActionsAccessDeniedError();
    }
    return new XActionsAmbiguousForbiddenError();
  }
  if (status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) {
    const resetAt = typeof details.resetAt === "number" && Number.isFinite(details.resetAt)
      ? details.resetAt : 0;
    return new CollectorHttpError(status, status === 429 ? Math.max(0, resetAt - Date.now()) : 0);
  }
  return error;
}
