export type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export class IntelligenceCache<T = unknown> {
  private cache = new Map<string, CacheEntry<T>>();

  set(key: string, value: T, ttlMs = 60000) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  clear() {
    this.cache.clear();
  }
}
