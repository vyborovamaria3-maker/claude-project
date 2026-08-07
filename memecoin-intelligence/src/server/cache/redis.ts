import { Redis } from 'ioredis';
import { env } from '@/server/config/env.js';

let client: Redis | null = null;
let disabledUntil = 0;

function getClient(): Redis | null {
  if (Date.now() < disabledUntil) return null;
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
    });
    client.on('error', () => { disabledUntil = Date.now() + 30_000; });
  }
  return client;
}

async function ready(): Promise<Redis | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    if (redis.status === 'wait') await redis.connect();
    if (redis.status !== 'ready') return null;
    return redis;
  } catch {
    disabledUntil = Date.now() + 30_000;
    return null;
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = await ready();
  if (!redis) return null;
  try {
    const value = await redis.get(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  const redis = await ready();
  if (!redis) return;
  try { await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds); } catch { /* cache is optional */ }
}

export async function cacheDeletePattern(pattern: string): Promise<number> {
  const redis = await ready();
  if (!redis) return 0;
  let cursor = '0';
  let removed = 0;
  try {
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 250);
      cursor = next;
      if (keys.length) removed += await redis.del(...keys);
    } while (cursor !== '0');
  } catch { return removed; }
  return removed;
}

export async function cacheHealth(): Promise<'ok' | 'unavailable'> {
  const redis = await ready();
  if (!redis) return 'unavailable';
  try { return (await redis.ping()) === 'PONG' ? 'ok' : 'unavailable'; } catch { return 'unavailable'; }
}

export async function closeCache(): Promise<void> {
  if (!client) return;
  try { await client.quit(); } catch { client.disconnect(); }
  client = null;
}
