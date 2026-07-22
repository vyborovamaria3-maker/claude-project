// Rate limiting utility for Next.js API routes
// Uses in-memory store with TTL - for production, consider Redis

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

/**
 * Check rate limit for a given identifier (IP, user ID, etc.)
 * @param identifier Unique identifier for the client
 * @param maxRequests Maximum number of requests allowed in the window
 * @param windowSeconds Time window in seconds
 * @returns Rate limit result
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowSeconds: number
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const key = `${identifier}:${Math.floor(now / windowMs)}`;
  
  const entry = rateLimitStore.get(key);
  
  if (!entry) {
    // First request in this window
    const resetTime = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetTime });
    return {
      success: true,
      limit: maxRequests,
      remaining: maxRequests - 1,
      reset: resetTime,
    };
  }
  
  if (entry.count >= maxRequests) {
    // Rate limit exceeded
    return {
      success: false,
      limit: maxRequests,
      remaining: 0,
      reset: entry.resetTime,
      retryAfter: Math.ceil((entry.resetTime - now) / 1000),
    };
  }
  
  // Increment count
  entry.count++;
  return {
    success: true,
    limit: maxRequests,
    remaining: maxRequests - entry.count,
    reset: entry.resetTime,
  };
}

/**
 * Get client IP from request, considering X-Forwarded-For
 * Note: This should be used with trusted proxy configuration
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Take the first IP if multiple are present
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp) return firstIp;
  }
  
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  
  // Fallback to a generic identifier (less reliable)
  return "unknown";
}

/**
 * Higher-order function to wrap API handlers with rate limiting
 */
export function withRateLimit(
  handler: (req: Request) => Promise<Response> | Response,
  options: {
    maxRequests: number;
    windowSeconds: number;
    getIdentifier?: (req: Request) => string;
  }
) {
  return async function rateLimitedHandler(req: Request): Promise<Response> {
    const identifier = options.getIdentifier 
      ? options.getIdentifier(req) 
      : getClientIp(req);
    
    const result = checkRateLimit(identifier, options.maxRequests, options.windowSeconds);
    
    if (!result.success) {
      return new Response(
        JSON.stringify({
          error: "Too many requests",
          retryAfter: result.retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": String(result.remaining),
            "X-RateLimit-Reset": String(result.reset),
            "Retry-After": String(result.retryAfter || 60),
          },
        }
      );
    }
    
    // Add rate limit headers to successful response
    const response = await handler(req);
    const newHeaders = new Headers(response.headers);
    newHeaders.set("X-RateLimit-Limit", String(result.limit));
    newHeaders.set("X-RateLimit-Remaining", String(result.remaining));
    newHeaders.set("X-RateLimit-Reset", String(result.reset));
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}
