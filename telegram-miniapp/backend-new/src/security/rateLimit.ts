import { NextFunction, Request, Response } from 'express';

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;
let nextCleanupAt = 0;

function cleanupExpired(now: number) {
  if (now < nextCleanupAt && buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  nextCleanupAt = now + 60_000;
}

export function fixedWindowRateLimit(options: {
  windowMs: number;
  max: number;
  namespace: string;
}) {
  if (options.windowMs <= 0 || options.max <= 0) {
    throw new Error('Rate limit window and max must be positive');
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    cleanupExpired(now);

    const client = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${options.namespace}:${client}`;
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= MAX_BUCKETS) {
        res.setHeader('Retry-After', '60');
        return res.status(503).json({ error: 'Rate limiter capacity reached' });
      }
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(options.max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests' });
    }

    return next();
  };
}
