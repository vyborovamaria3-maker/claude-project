interface RateLimitConfig {
  maxHits: number;
  windowMs: number;
  burstSize: number;
}

interface RateLimitState {
  hits: number;
  windowStart: number;
  burstTokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private configs = new Map<string, RateLimitConfig>();
  private states = new Map<string, RateLimitState>();

  constructor(defaultConfig?: Partial<RateLimitConfig>) {
    if (defaultConfig) {
      this.configs.set("default", {
        maxHits: defaultConfig.maxHits ?? 30,
        windowMs: defaultConfig.windowMs ?? 60000,
        burstSize: defaultConfig.burstSize ?? 5,
      });
    }
  }

  setLimit(key: string, config: RateLimitConfig): void {
    this.configs.set(key, config);
  }

  tryConsume(key: string): boolean {
    const config = this.configs.get(key) ?? this.configs.get("default");
    if (!config) return true;

    const now = Date.now();
    let state = this.states.get(key);

    if (!state || now - state.windowStart > config.windowMs) {
      state = { hits: 0, windowStart: now, burstTokens: config.burstSize, lastRefill: now };
      this.states.set(key, state);
    }

    const elapsed = now - state.lastRefill;
    const refillTokens = Math.floor((elapsed / config.windowMs) * config.burstSize);
    state.burstTokens = Math.min(config.burstSize, state.burstTokens + refillTokens);
    state.lastRefill = now;

    if (state.hits >= config.maxHits) {
      if (state.burstTokens > 0) {
        state.burstTokens--;
        state.hits++;
        return true;
      }
      return false;
    }

    state.hits++;
    return true;
  }

  getRemaining(key: string): number {
    const config = this.configs.get(key) ?? this.configs.get("default");
    if (!config) return Infinity;

    const state = this.states.get(key);
    if (!state) return config.maxHits;

    const now = Date.now();
    if (now - state.windowStart > config.windowMs) return config.maxHits;

    return Math.max(0, config.maxHits - state.hits + state.burstTokens);
  }

  getWaitTime(key: string): number {
    const config = this.configs.get(key) ?? this.configs.get("default");
    if (!config) return 0;
    const state = this.states.get(key);
    if (!state || state.hits < config.maxHits) return 0;

    const elapsed = Date.now() - state.windowStart;
    return Math.max(0, config.windowMs - elapsed);
  }

  reset(key?: string): void {
    if (key) {
      this.states.delete(key);
    } else {
      this.states.clear();
    }
  }
}

export const tginviteRateLimiter = new RateLimiter();
