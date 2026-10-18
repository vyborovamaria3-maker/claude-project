/** In-process local token bucket. Not a multi-process quota or provider lease. */
export class TokenBucket {
  private available: number;
  private updatedAtMs: number;
  constructor(
    public readonly tokensPerSecond: number,
    public readonly capacity: number,
    initialTimeMs = Date.now(),
  ) {
    if (!(tokensPerSecond > 0) || !(capacity > 0) || !Number.isFinite(initialTimeMs)) {
      throw new RangeError("Invalid token bucket inputs");
    }
    this.available = capacity;
    this.updatedAtMs = initialTimeMs;
  }
  tryAcquire(tokens = 1, nowMs = Date.now()): boolean {
    if (!(tokens > 0) || tokens > this.capacity || !Number.isFinite(nowMs)) {
      throw new RangeError("Invalid token request");
    }
    const elapsed = Math.max(0, nowMs - this.updatedAtMs);
    if (nowMs > this.updatedAtMs) this.updatedAtMs = nowMs;
    this.available = Math.min(this.capacity, this.available + elapsed * this.tokensPerSecond / 1000);
    if (this.available + 1e-10 < tokens) return false;
    this.available -= tokens;
    return true;
  }
}
