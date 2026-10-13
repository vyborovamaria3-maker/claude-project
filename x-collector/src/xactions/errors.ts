import { CollectorHttpError } from "../../lib/trade/task-errors";

/** Map XActions HTTP errors into the collector's existing retry/quota policy. */
export function toCollectorError(error: unknown): Error {
  if (error instanceof CollectorHttpError) return error;
  if (!(error instanceof Error)) return new Error("XActions: unknown HTTP error");

  const details = error as Error & { status?: unknown; resetAt?: unknown };
  let status = typeof details.status === "number" ? details.status : undefined;
  if (!status) {
    if (error.name === "RateLimitError") status = 429;
    else if (error.name === "AuthError") status = 401;
    else if (error.name === "NotFoundError") status = 404;
  }
  if (status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599) {
    const resetAt = typeof details.resetAt === "number" && Number.isFinite(details.resetAt)
      ? details.resetAt : 0;
    return new CollectorHttpError(status, status === 429 ? Math.max(0, resetAt - Date.now()) : 0);
  }
  return error;
}
