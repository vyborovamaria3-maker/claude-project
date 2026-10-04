/**
 * HTTP-защита для dashboard и metrics-сервера: security headers, проверка
 * same-origin для изменяющих методов и in-memory per-IP rate limit.
 */

export interface HttpSecurityOptions {
  /** Разрешённый Origin/Referer для небезопасных методов. Если не задан — проверка отключена. */
  allowedOrigin?: string;
  /** Лимит запросов на IP в окно. 0 или undefined — без лимита. */
  rateLimitPerMinute?: number;
  /** Разрешить выполнение inline-скриптов/оценку (Vue runtime compiler). */
  allowUnsafeEval?: boolean;
}

export interface RequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

function headerValue(req: RequestLike, name: string): string | undefined {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  return typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
}

/** Применяет базовые security headers ко всем ответам. */
export function applySecurityHeaders(res: ResponseLike, options: HttpSecurityOptions = {}): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  const scriptSrc = options.allowUnsafeEval
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

/** Проверяет, что Origin/Referer небезопасного метода совпадает с ожидаемым. */
export function isSameOrigin(req: RequestLike, allowedOrigin?: string): boolean {
  if (!allowedOrigin) return true;
  const expected = normalizeOrigin(allowedOrigin);
  const origin = headerValue(req, "origin");
  if (origin) return normalizeOrigin(origin) === expected;
  const referer = headerValue(req, "referer");
  if (referer) return normalizeOrigin(referer) === expected;
  // Ни Origin, ни Referer нет — не можем подтвердить источник, отклоняем.
  return false;
}

export interface OriginCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkOrigin(
  req: RequestLike,
  allowedOrigin: string | undefined,
): OriginCheckResult {
  const method = (req.method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };
  if (!allowedOrigin) return { ok: true };
  if (isSameOrigin(req, allowedOrigin)) return { ok: true };
  return { ok: false, reason: "cross-origin request rejected" };
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Простой in-memory rate limiter со скользящим окном. Возвращает false, если лимит исчерпан. */
export function createRateLimiter(limitPerMinute: number) {
  const buckets = new Map<string, Bucket>();
  const windowMs = 60_000;

  return function allow(key: string, now = Date.now()): boolean {
    if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) return true;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      if (buckets.size > 10_000) {
        // Не даём карте IP расти бесконечно.
        for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      }
      return true;
    }
    if (bucket.count >= limitPerMinute) return false;
    bucket.count++;
    return true;
  };
}

export function clientIp(req: RequestLike): string {
  const forwarded = headerValue(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}
